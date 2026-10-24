import assert from "node:assert/strict";
import { test } from "node:test";
import { FINDINGS_MARKER } from "./findings-comment.ts";
import { extractFingerprints } from "./fingerprint.ts";
import { GITHUB_BODY_LIMIT } from "./markdown.ts";
import {
  buildPlan,
  describePlan,
  executePlan,
  readExistingState,
  type PostingPlan,
} from "./post.ts";
import { SUMMARY_END, SUMMARY_START } from "./summary-block.ts";
import {
  fakePostingClient,
  okResults,
  sampleAggregation,
  sampleFinding,
  type FakePosting,
} from "./test-helpers.ts";
import type { Verdict } from "./verdict.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

/** A Finding on a changed line, with a Suggestion. */
const anchoredFinding = (line: number, title = `Problem on line ${line}`) =>
  sampleFinding({
    line,
    title,
    suggestion: `fixed line ${line}`,
    fixPrompt: `In src/a.ts line ${line}, fix it.`,
  });

/** A Finding with no line to attach to. */
const loose = (title: string) =>
  sampleFinding({
    path: undefined,
    line: undefined,
    title,
    fixPrompt: `Resolve: ${title}`,
  });

/** One whole run, as the pipeline does it after the aggregation. */
async function run(
  fake: FakePosting,
  options: Parameters<typeof sampleAggregation>[0] = {},
  headSha = SHA,
) {
  const existing = await readExistingState(fake.client, 7);
  const aggregation = sampleAggregation({
    ...options,
    existingFingerprints: existing.fingerprints,
  });
  const plan = buildPlan({ headSha, aggregation, existing });
  const logs: string[] = [];
  await executePlan(plan, fake.client, { pr: 7, log: (m) => logs.push(m) });
  return { plan, logs, aggregation };
}

test("a first run writes the Summary block, the Findings comment and one Inline review, in that order", async () => {
  const fake = fakePostingClient({ body: "My description." });
  const { logs } = await run(fake, {
    findings: [anchoredFinding(2), loose("Missing tests")],
  });

  assert.deepEqual(fake.writes, [
    "updatePullRequestBody",
    "createIssueComment",
    "createReview REQUEST_CHANGES 1",
  ]);
  assert.ok(fake.state.body.startsWith("My description.\n\n" + SUMMARY_START));
  assert.ok(fake.state.body.endsWith(SUMMARY_END));

  const [sticky] = fake.state.issueComments;
  assert.ok(sticky.body.includes(FINDINGS_MARKER));
  assert.match(sticky.body, /Missing tests/);

  assert.equal(fake.state.submitted.length, 1);
  const [review] = fake.state.submitted;
  assert.equal(review.event, "REQUEST_CHANGES");
  assert.equal(review.comments.length, 1);
  const [comment] = review.comments;
  assert.equal(comment.path, "src/a.ts");
  assert.equal(comment.line, 2);
  assert.equal(comment.side, "RIGHT");
  assert.match(comment.body, /^\*\*major\*\* · Problem on line 2/);
  assert.match(comment.body, /```suggestion\nfixed line 2\n```/);
  assert.match(comment.body, /<summary>Prompt for AI agents<\/summary>/);
  assert.match(comment.body, /In src\/a\.ts line 2, fix it\./);
  assert.equal(extractFingerprints([comment.body]).size, 1);
  assert.ok(
    logs.some((l) => /Inline review: REQUEST_CHANGES with 1 comment/.test(l)),
  );
});

test("a range becomes a multi-line comment", async () => {
  const fake = fakePostingClient();
  await run(fake, {
    findings: [{ ...anchoredFinding(2), endLine: 3, suggestion: "a\nb" }],
  });
  const [comment] = fake.state.submitted[0].comments;
  assert.equal(comment.start_line, 2);
  assert.equal(comment.line, 3);
  assert.equal(comment.start_side, "RIGHT");
});

test("a second run on the same head posts nothing new", async () => {
  const fake = fakePostingClient({ body: "My description." });
  const options = { findings: [anchoredFinding(2), loose("Missing tests")] };
  await run(fake, options);
  const bodyAfterFirst = fake.state.body;
  const commentAfterFirst = fake.state.issueComments[0].body;
  fake.writes.length = 0;

  const second = await run(fake, options);

  assert.deepEqual(fake.writes, []);
  assert.equal(fake.state.submitted.length, 1);
  assert.equal(fake.state.body, bodyAfterFirst);
  assert.equal(fake.state.issueComments.length, 1);
  assert.equal(fake.state.issueComments[0].body, commentAfterFirst);
  assert.equal(second.aggregation.dropped.alreadyPosted, 2);
  assert.match(
    second.logs.join("\n"),
    /Inline review: not posted \(no new inline comments, and the Verdict is unchanged \(REQUEST_CHANGES\)\)/,
  );
});

test("a run on a new head edits the Summary block and the Findings comment in place", async () => {
  const fake = fakePostingClient();
  await run(fake, { findings: [loose("Missing tests")] });
  fake.writes.length = 0;

  await run(fake, { findings: [loose("Missing tests")] }, OTHER_SHA);

  assert.equal(fake.state.issueComments.length, 1);
  assert.equal(fake.state.body.split(SUMMARY_START).length, 2);
  assert.deepEqual(fake.writes, [
    "updatePullRequestBody",
    `updateIssueComment ${fake.state.issueComments[0].id}`,
  ]);
  assert.match(fake.state.issueComments[0].body, /`fedcba9`/);
  // The Finding from the first run is still in the comment.
  assert.match(fake.state.issueComments[0].body, /Missing tests/);
});

test("a Finding already on the pull request is not posted again; a new one is", async () => {
  const fake = fakePostingClient();
  await run(fake, { findings: [anchoredFinding(2, "Old problem")] });
  fake.writes.length = 0;

  await run(fake, {
    findings: [
      anchoredFinding(2, "Old problem"),
      anchoredFinding(3, "New problem"),
    ],
  });

  assert.equal(fake.state.submitted.length, 2);
  const [comment, ...rest] = fake.state.submitted[1].comments;
  assert.equal(rest.length, 0);
  assert.match(comment.body, /New problem/);
  assert.ok(fake.writes.includes("createReview REQUEST_CHANGES 1"));
});

test("only the Review bot's markers count for dedupe, and only its Findings comment is edited", async () => {
  const fake = fakePostingClient({
    issueComments: [
      {
        id: 1,
        byBot: false,
        body: `${FINDINGS_MARKER}\n<!-- pr-review:fingerprint:0123456789abcdef -->`,
      },
    ],
    reviewComments: [
      {
        id: 2,
        byBot: false,
        body: "<!-- pr-review:fingerprint:fedcba9876543210 -->",
      },
      {
        id: 3,
        byBot: true,
        body: "<!-- pr-review:fingerprint:aaaaaaaaaaaaaaaa -->",
      },
    ],
  });
  const existing = await readExistingState(fake.client, 7);
  assert.deepEqual([...existing.fingerprints], ["aaaaaaaaaaaaaaaa"]);
  assert.equal(existing.findingsComment, null);

  await run(fake, { findings: [loose("Missing tests")] });
  // A new sticky comment, next to the person's.
  assert.equal(fake.state.issueComments.length, 2);
  assert.equal(
    fake.state.issueComments[0].body.includes("Missing tests"),
    false,
  );
});

test("the Verdict is the review's event, and a plain COMMENT with nothing new is not posted", async () => {
  const cases: [
    string,
    Parameters<typeof sampleAggregation>[0],
    Verdict,
    number,
  ][] = [
    [
      "a critical Finding",
      { findings: [anchoredFinding(2)] },
      "REQUEST_CHANGES",
      1,
    ],
    ["no Finding", {}, "APPROVE", 0],
    [
      "a minor Finding",
      { findings: [{ ...anchoredFinding(2), severity: "minor" }] },
      "COMMENT",
      1,
    ],
  ];
  for (const [name, options, verdict, comments] of cases) {
    const fake = fakePostingClient();
    await run(fake, options);
    assert.equal(fake.state.submitted[0]?.event, verdict, name);
    assert.equal(fake.state.submitted[0]?.comments.length, comments, name);
  }

  // A minor Finding that is not anchored: COMMENT with nothing to put in it.
  const quiet = fakePostingClient();
  const { logs } = await run(quiet, {
    findings: [{ ...loose("Minor and loose"), severity: "minor" }],
  });
  assert.equal(quiet.state.submitted.length, 0);
  assert.match(
    logs.join("\n"),
    /not posted \(no new inline comments, and a plain comment says nothing\)/,
  );
});

test("a Reviewer that failed never approves", async () => {
  const fake = fakePostingClient();
  await run(fake, {
    results: [
      ...okResults(["architecture"]),
      {
        reviewer: "security",
        status: "failed",
        reason: "timeout",
        detail: "Reviewer security: timed out",
        model: "sonnet",
        durationMs: 1,
      },
    ],
  });
  // COMMENT with nothing to say: no review, but the gap is in the Summary block.
  assert.equal(fake.state.submitted.length, 0);
  assert.match(fake.state.body, /\| security \| did not run \(timeout/);
  assert.match(
    fake.state.issueComments[0].body,
    /The security Reviewer did not run/,
  );
});

test("an APPROVE after a REQUEST_CHANGES is a new review that supersedes it; the same Verdict again is not posted", async () => {
  const fake = fakePostingClient();
  await run(fake, { findings: [anchoredFinding(2)] });
  assert.equal(fake.state.reviews.at(-1)?.state, "CHANGES_REQUESTED");

  // The problem is fixed: nothing found.
  const { plan } = await run(fake, {}, OTHER_SHA);
  assert.equal(plan.review?.event, "APPROVE");
  assert.equal(fake.state.submitted.length, 2);
  const approval = fake.state.submitted[1];
  assert.equal(approval.event, "APPROVE");
  assert.deepEqual(approval.comments, []);
  assert.match(
    approval.body,
    /^\*\*Approved\.\*\* No Finding at or above minor severity\./,
  );
  assert.equal(fake.state.reviews.at(-1)?.state, "APPROVED");

  const again = await run(fake, {}, OTHER_SHA);
  assert.equal(again.plan.review, null);
  assert.equal(fake.state.submitted.length, 2);
});

test("a dismissed review says nothing about the last Verdict", async () => {
  const fake = fakePostingClient({
    reviews: [{ id: 1, state: "DISMISSED", byBot: true }],
  });
  assert.equal((await readExistingState(fake.client, 7)).previousVerdict, null);
  await run(fake);
  assert.equal(fake.state.submitted[0].event, "APPROVE");
});

test("a rejected line is isolated: the rest is posted in one review and the Findings comment reports it", async () => {
  const fake = fakePostingClient();
  fake.rejectLines.add("src/a.ts:3");
  const findings = [anchoredFinding(2), anchoredFinding(3), anchoredFinding(4)];

  const { logs } = await run(fake, { findings });

  assert.equal(fake.state.submitted.length, 1);
  const [review] = fake.state.submitted;
  assert.equal(review.event, "REQUEST_CHANGES");
  assert.deepEqual(
    review.comments.map((c) => c.line),
    [2, 4],
  );
  assert.match(
    review.body,
    /1 inline comment could not be placed on a line and is in the Findings comment/,
  );
  // Probes are pending reviews, and none is left behind.
  assert.ok(fake.writes.includes("createPendingReview"));
  assert.ok(!fake.state.reviews.some((r) => r.state === "PENDING"));

  const [sticky] = fake.state.issueComments;
  assert.match(sticky.body, /#### major · Problem on line 3/);
  assert.match(
    sticky.body,
    /GitHub rejected the inline comment \(Line could not be resolved\)/,
  );
  assert.match(sticky.body, /1 inline comment could not be posted on a line/);
  assert.match(
    logs.join("\n"),
    /could not be placed on a line: reported in the Findings comment/,
  );
  // Created before the review, then edited once with the fallback.
  assert.deepEqual(
    fake.writes.filter((w) => /IssueComment|^createReview/.test(w)),
    [
      "createIssueComment",
      "createReview REQUEST_CHANGES 2",
      `updateIssueComment ${sticky.id}`,
    ],
  );

  // The next run posts none of the three again. It may edit the Findings
  // comment, whose report of what failed is about that run only.
  fake.writes.length = 0;
  await run(fake, { findings });
  assert.ok(fake.writes.every((w) => w.startsWith("updateIssueComment")));
  assert.equal(fake.state.submitted.length, 1);
  assert.equal(fake.state.issueComments.length, 1);
  assert.match(fake.state.issueComments[0].body, /Problem on line 3/);
});

test("when every comment is rejected the Verdict is still posted, alone", async () => {
  const fake = fakePostingClient();
  fake.rejectLines.add("src/a.ts:2");
  fake.rejectLines.add("src/a.ts:3");

  await run(fake, { findings: [anchoredFinding(2), anchoredFinding(3)] });

  assert.equal(fake.state.submitted.length, 1);
  assert.equal(fake.state.submitted[0].event, "REQUEST_CHANGES");
  assert.deepEqual(fake.state.submitted[0].comments, []);
  assert.match(fake.state.issueComments[0].body, /Problem on line 2/);
  assert.match(fake.state.issueComments[0].body, /Problem on line 3/);
});

test("a failing write names its step", async () => {
  const fake = fakePostingClient();
  const failing = {
    ...fake.client,
    createIssueComment: async () => {
      throw new Error("GitHub answered 403");
    },
  };
  const existing = await readExistingState(failing, 7);
  const plan = buildPlan({
    headSha: SHA,
    aggregation: sampleAggregation(),
    existing,
  });
  await assert.rejects(
    executePlan(plan, failing, { pr: 7, log: () => undefined }),
    (error: Error & { step?: string }) => {
      assert.equal(error.step, "Findings comment");
      assert.match(
        error.message,
        /^Findings comment failed: GitHub answered 403/,
      );
      return true;
    },
  );
  // The Summary block was written before it.
  assert.deepEqual(fake.writes, ["updatePullRequestBody"]);
});

test("a long description keeps its own text and a Summary block within GitHub's limit", async () => {
  const outside = `${"A paragraph of the author's own words. ".repeat(1_000)}\n`;
  const fake = fakePostingClient({ body: outside });
  const files = Array.from({ length: 1_500 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    change: "Changes something about the file in a sentence",
  }));
  const existing = await readExistingState(fake.client, 7);
  const aggregation = {
    ...sampleAggregation(),
    walkthrough: files,
  };
  const plan = buildPlan({ headSha: SHA, aggregation, existing });
  assert.ok(plan.prBody.next.length <= GITHUB_BODY_LIMIT);
  assert.ok(plan.prBody.next.startsWith(outside.trimEnd()));
  assert.match(plan.prBody.block, /more files not shown/);
});

test("describePlan prints everything and has no client to write with", async () => {
  const fake = fakePostingClient({ body: "Description" });
  const existing = await readExistingState(fake.client, 7);
  const aggregation = sampleAggregation({
    findings: [anchoredFinding(2), loose("Missing tests")],
  });
  const plan: PostingPlan = buildPlan({ headSha: SHA, aggregation, existing });
  const lines: string[] = [];
  describePlan(plan, (m) => lines.push(m));
  const text = lines.join("\n");

  assert.match(
    text,
    /Summary block \(appended to the pull request description\)/,
  );
  assert.match(text, /Findings comment \(created\)/);
  assert.match(text, /Missing tests/);
  assert.match(text, /Inline review: REQUEST_CHANGES with 1 comment/);
  assert.match(text, /----- src\/a\.ts:2 -----/);
  assert.match(text, /```suggestion\nfixed line 2\n```/);
  assert.deepEqual(fake.writes, []);
});
