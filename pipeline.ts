/**
 * The stages of a Review run after the runner has prepared the change:
 *
 *   Read pull request -> Reviewers -> Read diff -> Aggregation -> Post
 *
 * 1. Read what is already on the pull request (Fingerprints, the Findings
 *    comment, the Review bot's last Verdict). On a dry run this uses the
 *    developer's `gh` login; on a real run, the Review bot's token.
 * 2. Run the Reviewers (claude.ts, reviewers.ts). If every one of them fails
 *    there is nothing to report: the run stops, posts nothing and fails.
 * 3. Aggregate their Findings (aggregate.ts), skipping those already posted.
 * 4. Post as the Review bot (post.ts), or on a dry run print what would be
 *    posted and make no write.
 *
 * Each stage names itself in its error. Claude never holds a credential and
 * never posts: the token goes only to the posting client made here.
 */

import { aggregate } from "./aggregate.ts";
import { diffGitArgs } from "./diff.ts";
import { StepError, type Exec } from "./exec.ts";
import {
  buildPlan,
  describePlan,
  executePlan,
  readExistingState,
} from "./post.ts";
import {
  createFetchTransport,
  createGhTransport,
  createPostingClient,
  type PostingClient,
} from "./posting-client.ts";
import type { Git } from "./pull-request-diff.ts";
import { allFailed, runReviewers } from "./reviewers.ts";
import type { PreparedReview } from "./run.ts";

export interface PipelineDeps {
  git: Git;
  exec: Exec;
  log: (message: string) => void;
  /** Replaces the real posting client. Tests give a fake. */
  postingClient?: (prepared: PreparedReview) => PostingClient;
  /** Executable to start instead of `claude`. Tests give a fake. */
  claudeCommand?: string;
  promptsDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/**
 * @returns The review step of {@link runReview}: runs the Reviewers, aggregates
 *   and posts (or, with no token, prints what would be posted).
 */
export function createReviewStep(
  deps: PipelineDeps,
): (prepared: PreparedReview) => Promise<void> {
  const { log } = deps;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw new StepError(name, error);
    }
  };

  return async (prepared) => {
    const { pr, mergeBase, worktree, token } = prepared;
    const dryRun = token === null;
    const client =
      deps.postingClient?.(prepared) ??
      createPostingClient(
        pr.repository,
        token === null
          ? createGhTransport(deps.exec)
          : createFetchTransport({ token, fetch: deps.fetch }),
      );

    const existing = await step("Read pull request", () =>
      readExistingState(client, pr.number),
    );
    log(
      `Already on the pull request: ${existing.fingerprints.size} Fingerprint${existing.fingerprints.size === 1 ? "" : "s"}${existing.previousVerdict ? `, last Verdict ${existing.previousVerdict}` : ""}.`,
    );

    log("Running the Reviewers...");
    const results = await step("Reviewers", async () => {
      const done = await runReviewers({
        worktree,
        base: mergeBase,
        command: deps.claudeCommand,
        promptsDir: deps.promptsDir,
        env: deps.env,
        onResult: (result) =>
          log(
            result.status === "ok"
              ? `  Reviewer ${result.reviewer}: ${result.findings.length} Finding${result.findings.length === 1 ? "" : "s"}`
              : `  Reviewer ${result.reviewer}: did not run (${result.reason})`,
          ),
      });
      if (allFailed(done)) {
        throw new Error(
          `every Reviewer failed, so nothing is posted. ${done
            .map((r) => (r.status === "failed" ? r.detail : ""))
            .filter(Boolean)
            .join(" ")}`,
        );
      }
      return done;
    });

    const diff = await step("Read diff", () =>
      deps.git(diffGitArgs(mergeBase), worktree),
    );

    log("Aggregating...");
    const aggregation = await step("Aggregation", () =>
      aggregate({
        worktree,
        base: mergeBase,
        diff,
        results,
        existingFingerprints: existing.fingerprints,
        command: deps.claudeCommand,
        promptsDir: deps.promptsDir,
        env: deps.env,
      }),
    );
    log(
      `Findings to post: ${aggregation.anchored.length} anchored, ${aggregation.unanchored.length} unanchored (${aggregation.dropped.alreadyPosted} already posted, ${aggregation.leftOut} over the cap). Verdict: ${aggregation.verdict}.`,
    );

    const plan = await step("Plan", async () =>
      buildPlan({ headSha: pr.headSha, aggregation, existing }),
    );
    if (dryRun) {
      describePlan(plan, log);
      return;
    }
    await executePlan(plan, client, { pr: pr.number, log });
  };
}
