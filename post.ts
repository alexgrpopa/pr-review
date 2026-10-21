/**
 * Posting: turns an {@link AggregationResult} into the three writes of a Review
 * run, as the Review bot, in this order: the Summary block, the Findings
 * comment, the Inline review. Nothing here talks to a network: it uses a
 * {@link PostingClient}.
 *
 *   readExistingState   what is already on the pull request (reads only)
 *   buildPlan           what to write, and what not to (pure)
 *   describePlan        prints the plan, for `--dry-run`
 *   executePlan         makes the writes
 *
 * Dedupe. The Fingerprints already on the pull request are read from the
 * Review bot's own inline comments and its Findings comment (anyone else can
 * type a marker, so nobody else's are read) and given to the aggregation,
 * which does not return a Finding that is on the pull request.
 *
 * The Inline review. One review per run, with the Verdict as its event and the
 * new Anchored findings as its comments, on the head commit that was reviewed.
 *
 *   - No new comment and nothing to say: no review is created. That is the case
 *     for `COMMENT` with no comments, and for any Verdict that equals the one
 *     of the Review bot's last review (the second run on an unchanged pull
 *     request). The terminal says so.
 *   - An `APPROVE` that follows a `REQUEST_CHANGES` is posted as a new review
 *     with the event `APPROVE`, with no comments and the reason as its body.
 *     GitHub counts a reviewer's latest approving or requesting review, so it
 *     supersedes the earlier one; nothing is dismissed. A later plain `COMMENT`
 *     does not supersede a `REQUEST_CHANGES`: that stays until an `APPROVE`
 *     (or a dismissal in GitHub), because a comment-only Verdict is not a
 *     decision.
 *   - GitHub rejects the whole review (422) when one comment is on a line it
 *     cannot place. The poster then finds the rejected comments by trying
 *     halves of the comments as pending reviews (which nobody sees, and are
 *     deleted), submits the review with the comments that were accepted, and
 *     reports the others in the Findings comment, which is edited once more
 *     after the review. It never fails the run for it.
 *
 * Every step of the writes names itself in its error: "Summary block",
 * "Findings comment" or "Inline review".
 */

import type { AggregationResult, AnchoredFinding } from "./aggregate.ts";
import { StepError } from "./exec.ts";
import {
  FINDINGS_MARKER,
  renderFindingsComment,
  type FellBackFinding,
  type FindingsCommentInput,
} from "./findings-comment.ts";
import { extractFingerprints } from "./fingerprint.ts";
import { renderReviewBody, toReviewComment } from "./inline-review.ts";
import { plural } from "./markdown.ts";
import {
  isRejected,
  type PostingClient,
  type ReviewState,
} from "./posting-client.ts";
import { applySummaryBlock, findSummaryBlock } from "./summary-block.ts";
import type { Verdict } from "./verdict.ts";

export interface ExistingState {
  /** The pull request description. */
  body: string;
  /** The Review bot's sticky comment, when an earlier run made one. */
  findingsComment: { id: number; body: string } | null;
  /** Fingerprints in the Review bot's comments. */
  fingerprints: Set<string>;
  /** What the Review bot's last review said; null when it made none. */
  previousVerdict: Verdict | null;
}

const VERDICT_OF_STATE: Partial<Record<ReviewState, Verdict>> = {
  APPROVED: "APPROVE",
  CHANGES_REQUESTED: "REQUEST_CHANGES",
  COMMENTED: "COMMENT",
};

/** Reads what a Review run needs to know about the pull request. */
export async function readExistingState(
  client: PostingClient,
  pr: number,
): Promise<ExistingState> {
  const [body, issueComments, reviewComments, reviews] = await Promise.all([
    client.getPullRequestBody(pr),
    client.listIssueComments(pr),
    client.listReviewComments(pr),
    client.listReviews(pr),
  ]);
  const sticky =
    issueComments
      .filter((c) => c.byBot && c.body.includes(FINDINGS_MARKER))
      .sort((a, b) => a.id - b.id)[0] ?? null;
  const fingerprints = extractFingerprints([
    ...reviewComments.filter((c) => c.byBot).map((c) => c.body),
    ...(sticky ? [sticky.body] : []),
  ]);
  // A dismissed or pending review says nothing about the last Verdict.
  const last = reviews.filter((r) => r.byBot).at(-1);
  return {
    body,
    findingsComment: sticky && { id: sticky.id, body: sticky.body },
    fingerprints,
    previousVerdict: (last && VERDICT_OF_STATE[last.state]) ?? null,
  };
}

export interface PostingPlan {
  headSha: string;
  prBody: {
    /** The whole description after the write. */
    next: string;
    /** The Summary block inside it. */
    block: string;
    changed: boolean;
    /** The markers were absent, so the block is appended. */
    appended: boolean;
  };
  findings: {
    /** The comment to edit; null to create it. */
    existingId: number | null;
    input: FindingsCommentInput;
    /** What the comment says, before any fallback of the Inline review. */
    body: string;
    changed: boolean;
  };
  review: {
    event: Verdict;
    reason: string;
    findings: AnchoredFinding[];
  } | null;
  /** Why there is no review, when there is none. */
  skipReason: string | null;
}

export function buildPlan(options: {
  headSha: string;
  aggregation: AggregationResult;
  existing: ExistingState;
}): PostingPlan {
  const { aggregation: a, existing, headSha } = options;

  const next = applySummaryBlock(existing.body, {
    summary: a.summary,
    walkthrough: a.walkthrough,
    reviewers: a.reviewers,
    headSha,
  });
  const written = findSummaryBlock(next) as { start: number; end: number };
  const block = next.slice(written.start, written.end);

  const input: FindingsCommentInput = {
    headSha,
    verdict: a.verdict,
    verdictReason: a.verdictReason,
    unanchored: a.unanchored,
    fellBack: [],
    reviewers: a.reviewers,
    aggregator: a.aggregator,
    leftOut: a.leftOut,
    combinedFixPrompt: a.combinedFixPrompt,
  };
  const body = renderFindingsComment({
    ...input,
    previous: existing.findingsComment?.body,
  });

  let skipReason: string | null = null;
  if (a.anchored.length === 0) {
    if (a.verdict === "COMMENT") {
      skipReason = "no new inline comments, and a plain comment says nothing";
    } else if (existing.previousVerdict === a.verdict) {
      skipReason = `no new inline comments, and the Verdict is unchanged (${a.verdict})`;
    }
  }

  return {
    headSha,
    prBody: {
      next,
      block,
      changed: next !== existing.body,
      appended: findSummaryBlock(existing.body) === null,
    },
    findings: {
      existingId: existing.findingsComment?.id ?? null,
      input,
      body,
      changed: body !== existing.findingsComment?.body,
    },
    review:
      skipReason === null
        ? { event: a.verdict, reason: a.verdictReason, findings: a.anchored }
        : null,
    skipReason,
  };
}

/** Prints everything a real run would write, for `--dry-run`. */
export function describePlan(
  plan: PostingPlan,
  log: (message: string) => void,
): void {
  const rule = (title: string) => log(`\n===== ${title} =====`);

  rule(
    `Summary block (${plan.prBody.appended ? "appended to" : "replaces the block in"} the pull request description${plan.prBody.changed ? "" : ", unchanged"})`,
  );
  log(plan.prBody.block);

  rule(
    `Findings comment (${plan.findings.existingId === null ? "created" : `edits comment ${plan.findings.existingId}`}${plan.findings.changed ? "" : ", unchanged"})`,
  );
  log(plan.findings.body);

  if (plan.review === null) {
    rule("Inline review (not posted)");
    log(plan.skipReason ?? "");
    return;
  }
  const { event, reason, findings } = plan.review;
  rule(
    `Inline review: ${event} with ${plural(findings.length, "comment", "comments")}`,
  );
  log(
    renderReviewBody({
      verdict: event,
      verdictReason: reason,
      comments: findings.length,
    }),
  );
  for (const finding of findings) {
    const comment = toReviewComment(finding);
    log(
      `\n----- ${comment.path}:${comment.start_line ? `${comment.start_line}-` : ""}${comment.line} -----`,
    );
    log(comment.body);
  }
}

/** What the poster tells the developer, one line per write. */
export interface PostContext {
  pr: number;
  log: (message: string) => void;
}

async function inStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new StepError(step, error);
  }
}

interface Submitted {
  posted: number;
  fellBack: FellBackFinding[];
}

/**
 * Submits the Inline review. When GitHub rejects it (422) the rejected
 * comments are found and left out; see the module comment.
 */
async function submitReview(
  client: PostingClient,
  ctx: PostContext,
  headSha: string,
  review: NonNullable<PostingPlan["review"]>,
): Promise<Submitted> {
  const entries = review.findings.map((finding) => ({
    finding,
    comment: toReviewComment(finding),
  }));
  const submit = (
    accepted: typeof entries,
    fellBack: number,
  ): Promise<number> =>
    client.createReview(ctx.pr, {
      commit_id: headSha,
      event: review.event,
      body: renderReviewBody({
        verdict: review.event,
        verdictReason: review.reason,
        comments: accepted.length,
        fellBack,
      }),
      comments: accepted.map((e) => e.comment),
    });

  try {
    await submit(entries, 0);
    return { posted: entries.length, fellBack: [] };
  } catch (error) {
    if (!isRejected(error) || entries.length === 0) throw error;
    ctx.log(
      "GitHub rejected the Inline review (422). Looking for the comments it cannot place.",
    );
  }

  // A pending review is validated like a real one and is seen by nobody.
  const reasons = new Map<(typeof entries)[number], string>();
  const accepts = async (group: typeof entries): Promise<boolean> => {
    try {
      const id = await client.createReview(ctx.pr, {
        commit_id: headSha,
        body: "",
        comments: group.map((e) => e.comment),
      });
      await client.deleteReview(ctx.pr, id);
      return true;
    } catch (error) {
      if (!isRejected(error)) throw error;
      for (const entry of group) {
        reasons.set(
          entry,
          error.message.replace(/^GitHub answered \d+ to [^:]*:\s*/, ""),
        );
      }
      return false;
    }
  };
  const isolate = async (
    group: typeof entries,
  ): Promise<{ good: typeof entries; bad: typeof entries }> => {
    if (group.length === 0) return { good: [], bad: [] };
    if (await accepts(group)) return { good: group, bad: [] };
    if (group.length === 1) return { good: [], bad: group };
    const middle = Math.ceil(group.length / 2);
    const left = await isolate(group.slice(0, middle));
    const right = await isolate(group.slice(middle));
    return {
      good: [...left.good, ...right.good],
      bad: [...left.bad, ...right.bad],
    };
  };

  const { good, bad } = await isolate(entries);
  const describe = (e: (typeof entries)[number]): FellBackFinding => ({
    finding: e.finding,
    reason: reasons.get(e) ?? "rejected",
  });
  try {
    await submit(good, bad.length);
    return { posted: good.length, fellBack: bad.map(describe) };
  } catch (error) {
    if (!isRejected(error) || good.length === 0) throw error;
  }
  // Accepted one by one, rejected together: post the Verdict alone.
  await submit([], entries.length);
  return {
    posted: 0,
    fellBack: entries.map((e) => ({
      finding: e.finding,
      reason: "rejected when posted together",
    })),
  };
}

/**
 * Makes the writes, in order. Each step is named in its error.
 */
export async function executePlan(
  plan: PostingPlan,
  client: PostingClient,
  ctx: PostContext,
): Promise<void> {
  const { log } = ctx;

  await inStep("Summary block", async () => {
    if (!plan.prBody.changed) {
      log("Summary block: unchanged.");
      return;
    }
    await client.updatePullRequestBody(ctx.pr, plan.prBody.next);
    log(
      `Summary block: ${plan.prBody.appended ? "added to" : "updated in"} the pull request description.`,
    );
  });

  let commentId = plan.findings.existingId;
  let commentBody = plan.findings.body;
  await inStep("Findings comment", async () => {
    if (commentId === null) {
      commentId = await client.createIssueComment(ctx.pr, commentBody);
      log("Findings comment: created.");
    } else if (plan.findings.changed) {
      await client.updateIssueComment(commentId, commentBody);
      log("Findings comment: edited in place.");
    } else {
      log("Findings comment: unchanged.");
    }
  });

  if (plan.review === null) {
    log(`Inline review: not posted (${plan.skipReason}).`);
    return;
  }
  const review = plan.review;
  const submitted = await inStep("Inline review", () =>
    submitReview(client, ctx, plan.headSha, review),
  );
  log(
    `Inline review: ${review.event} with ${plural(submitted.posted, "comment", "comments")}.`,
  );

  if (submitted.fellBack.length > 0) {
    log(
      `${plural(submitted.fellBack.length, "inline comment", "inline comments")} could not be placed on a line: reported in the Findings comment.`,
    );
    await inStep("Findings comment", async () => {
      commentBody = renderFindingsComment({
        ...plan.findings.input,
        fellBack: submitted.fellBack,
        previous: commentBody,
      });
      await client.updateIssueComment(commentId as number, commentBody);
    });
  }
}
