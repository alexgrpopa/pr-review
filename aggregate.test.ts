import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { aggregate, type AggregateOptions } from "./aggregate.ts";
import type { Finding } from "./finding.ts";
import { extractFingerprints, fingerprint } from "./fingerprint.ts";
import type { ReviewerResult } from "./reviewers.ts";
import {
  SAMPLE_DIFF,
  createFakeClaude,
  sampleFinding as finding,
  tempDir,
} from "./test-helpers.ts";

function ok(reviewer: string, findings: Finding[]): ReviewerResult {
  return {
    reviewer,
    status: "ok",
    findings: findings.map((f) => ({ ...f, reviewer })),
    model: "sonnet",
    durationMs: 1,
  };
}

function failedReviewer(reviewer: string): ReviewerResult {
  return {
    reviewer,
    status: "failed",
    reason: "timeout",
    detail: `Reviewer ${reviewer}: claude -p did not finish`,
    model: "sonnet",
    durationMs: 1,
  };
}

const GOOD_ANSWER = {
  summary: "Changes a value.",
  walkthrough: [{ path: "src/a.ts", change: "Changes line 2" }],
  duplicateGroups: [],
};

async function run(
  t: TestContext,
  results: ReviewerResult[],
  answer: unknown,
  extra: Partial<AggregateOptions> = {},
) {
  const fake = await createFakeClaude(
    answer === undefined
      ? `process.exit(1);`
      : `reply(${JSON.stringify(answer)});`,
  );
  t.after(fake.cleanup);
  const result = await aggregate({
    worktree: await tempDir(t),
    base: "main",
    diff: SAMPLE_DIFF,
    results,
    command: fake.command,
    ...extra,
  });
  return { result, fake };
}

test("Findings are split into Anchored and Unanchored, with Suggestions, Fix prompts and markers", async (t) => {
  const { result } = await run(
    t,
    [
      ok("correctness", [
        finding({ suggestion: "line2 fixed" }),
        finding({ title: "Outside", line: 40, suggestion: "ignored" }),
        finding({
          title: "Whole change",
          path: undefined,
          line: undefined,
          severity: "minor",
        }),
        finding({
          title: "In a deleted file",
          path: "src/old.ts",
          line: 1,
          severity: "minor",
        }),
        finding({
          title: "Range over two hunks",
          line: 3,
          endLine: 40,
          severity: "minor",
        }),
      ]),
      ok("security", []),
    ],
    GOOD_ANSWER,
  );

  assert.deepEqual(
    result.anchored.map((f) => f.title),
    ["Wrong value"],
  );
  const [anchored] = result.anchored;
  assert.equal(anchored.path, "src/a.ts");
  assert.equal(anchored.line, 2);
  assert.equal(anchored.suggestion, "line2 fixed");
  assert.equal(anchored.fixPrompt, "In src/a.ts line 2, correct the value.");
  assert.deepEqual(
    [...extractFingerprints([anchored.marker])],
    [fingerprint(anchored)],
  );

  assert.deepEqual(result.unanchored.map((f) => f.title).sort(), [
    "In a deleted file",
    "Outside",
    "Range over two hunks",
    "Whole change",
  ]);
  const outside = result.unanchored.find((f) => f.title === "Outside")!;
  assert.equal("suggestion" in outside, false);
  assert.match(outside.unanchoredReason, /one changed hunk/);
  assert.match(outside.fixPrompt, /correct the value/);
  assert.equal(result.summary, "Changes a value.");
  assert.deepEqual(result.walkthrough, GOOD_ANSWER.walkthrough);
  assert.equal(result.aggregator.status, "ok");
  assert.match(result.combinedFixPrompt!, /^Resolve the following 5 issues/);
});

test("an ineligible Suggestion is dropped but the Finding is kept", async (t) => {
  const { result } = await run(
    t,
    [ok("correctness", [finding({ line: 2, endLine: 40, suggestion: "x" })])],
    GOOD_ANSWER,
  );
  assert.equal(result.anchored.length, 0);
  assert.equal(result.unanchored.length, 1);
  assert.equal(result.unanchored[0].suggestion, undefined);
});

test("an invalid Fix prompt is rebuilt from the Finding", async (t) => {
  const { result } = await run(
    t,
    [
      ok("correctness", [
        finding({ fixPrompt: "Do what the comment above says." }),
      ]),
    ],
    GOOD_ANSWER,
  );
  assert.match(result.anchored[0].fixPrompt, /^In src\/a\.ts:2: Wrong value/);
});

test("nit and low-confidence Findings are dropped and counted, per Reviewer counts are kept", async (t) => {
  const { result } = await run(
    t,
    [
      ok("correctness", [
        finding(),
        finding({ title: "n", severity: "nit" }),
        finding({ title: "u", confidence: 0.1 }),
      ]),
      ok("security", [finding({ title: "s", severity: "minor" })]),
      failedReviewer("necessity"),
    ],
    GOOD_ANSWER,
  );
  assert.deepEqual(result.dropped, {
    belowThreshold: 1,
    lowConfidence: 1,
    duplicates: 0,
    alreadyPosted: 0,
  });
  assert.deepEqual(
    result.reviewers.map((r) => [r.reviewer, r.status]),
    [
      ["correctness", "ok"],
      ["security", "ok"],
      ["necessity", "failed"],
    ],
  );
  assert.deepEqual(result.reviewers[0].reported, {
    critical: 0,
    major: 2,
    minor: 0,
    nit: 1,
  });
  assert.deepEqual(result.reviewers[0].kept, {
    critical: 0,
    major: 1,
    minor: 0,
    nit: 0,
  });
  assert.equal(result.reviewers[2].reason, "timeout");
  assert.match(result.reviewers[2].detail!, /necessity/);
});

test("the Aggregator's duplicate groups are merged, keeping every Fingerprint", async (t) => {
  const results = [
    ok("correctness", [finding({ severity: "minor", line: 3 })]),
    ok("security", [
      finding({ title: "Unvalidated value", severity: "major" }),
    ]),
  ];
  const { result } = await run(t, results, {
    ...GOOD_ANSWER,
    duplicateGroups: [[0, 1]],
  });
  assert.equal(result.anchored.length, 1);
  assert.equal(result.anchored[0].severity, "major");
  assert.equal(result.anchored[0].fingerprints.length, 2);
  assert.deepEqual(result.anchored[0].reviewers, ["correctness", "security"]);
  assert.equal(extractFingerprints([result.anchored[0].marker]).size, 2);
  assert.equal(result.dropped.duplicates, 1);
});

test("the Aggregator failing falls back: identical Fingerprints only, a summary line, a walkthrough from the diff", async (t) => {
  const results = [
    ok("correctness", [
      finding(),
      finding({ title: "wrong value.", line: 4 }),
      finding({ title: "Other" }),
    ]),
    ok("security", [finding({ title: "Wrong value" })]),
  ];
  const { result } = await run(t, results, undefined);

  assert.equal(result.aggregator.status, "failed");
  assert.ok(result.aggregator.status === "failed");
  assert.equal(result.aggregator.reason, "process error");
  assert.match(result.summary, /Aggregator did not run \(process error\)/);
  // Identical within correctness, not across Reviewers.
  assert.equal(result.dropped.duplicates, 1);
  assert.equal(result.anchored.length, 3);
  assert.deepEqual(result.walkthrough, [
    { path: "src/a.ts", change: "Modified (+2 -1)" },
    { path: "src/old.ts", change: "Deleted (+0 -1)" },
  ]);
  assert.equal(result.verdict, "REQUEST_CHANGES");
});

test("an Aggregator answer that fails validation falls back the same way", async (t) => {
  const { result } = await run(t, [ok("correctness", [finding()])], {
    summary: "",
    walkthrough: [],
    duplicateGroups: [],
  });
  assert.ok(result.aggregator.status === "failed");
  assert.equal(result.aggregator.reason, "invalid output");
  assert.equal(result.anchored.length, 1);
});

test("a Finding already on the pull request is not posted again", async (t) => {
  const posted = finding();
  const existing = extractFingerprints([
    `<!-- pr-review:fingerprint:${fingerprint({ ...posted, reviewer: "correctness" })} -->`,
  ]);
  const { result } = await run(
    t,
    [ok("correctness", [posted, finding({ title: "New", line: 3 })])],
    GOOD_ANSWER,
    { existingFingerprints: existing },
  );
  assert.deepEqual(
    result.anchored.map((f) => f.title),
    ["New"],
  );
  assert.equal(result.dropped.alreadyPosted, 1);
});

test("a merged Finding is already posted when any of its Fingerprints is", async (t) => {
  const results = [
    ok("correctness", [finding()]),
    ok("security", [finding({ title: "Unvalidated value" })]),
  ];
  const existing = new Set([
    fingerprint({
      ...finding(),
      reviewer: "security",
      title: "Unvalidated value",
    }),
  ]);
  const { result } = await run(
    t,
    results,
    { ...GOOD_ANSWER, duplicateGroups: [[0, 1]] },
    { existingFingerprints: existing },
  );
  assert.equal(result.anchored.length, 0);
  assert.equal(result.dropped.alreadyPosted, 1);
});

test("everything already posted: nothing new, and the Verdict still follows the Findings found", async (t) => {
  const major = finding();
  const existing = new Set([
    fingerprint({ ...major, reviewer: "correctness" }),
  ]);
  const { result } = await run(t, [ok("correctness", [major])], GOOD_ANSWER, {
    existingFingerprints: existing,
  });
  assert.equal(result.anchored.length + result.unanchored.length, 0);
  assert.equal(result.combinedFixPrompt, null);
  assert.equal(result.verdict, "REQUEST_CHANGES");
});

test("the cap keeps the most serious Findings, counts the rest, and ignores already posted ones", async (t) => {
  const many = Array.from({ length: 20 }, (_, i) =>
    finding({
      title: `Finding ${String(i).padStart(2, "0")}`,
      severity: i < 3 ? "critical" : i < 10 ? "major" : "minor",
      confidence: 0.9 - i / 100,
      path: undefined,
      line: undefined,
    }),
  );
  const { result } = await run(t, [ok("correctness", many)], GOOD_ANSWER);
  assert.equal(result.unanchored.length, 15);
  assert.equal(result.leftOut, 5);
  assert.deepEqual(
    result.unanchored.slice(0, 4).map((f) => f.title),
    ["Finding 00", "Finding 01", "Finding 02", "Finding 03"],
  );
  assert.ok(result.unanchored.every((f) => f.title < "Finding 15"));

  const posted = new Set(
    many.slice(0, 5).map((f) => fingerprint({ ...f, reviewer: "correctness" })),
  );
  const again = await run(t, [ok("correctness", many)], GOOD_ANSWER, {
    existingFingerprints: posted,
  });
  assert.equal(again.result.dropped.alreadyPosted, 5);
  assert.equal(again.result.unanchored.length, 15);
  assert.equal(again.result.leftOut, 0);
});

test("the cap is configurable", async (t) => {
  const { result } = await run(
    t,
    [
      ok("correctness", [
        finding(),
        finding({ title: "b" }),
        finding({ title: "c" }),
      ]),
    ],
    GOOD_ANSWER,
    { maxFindings: 2 },
  );
  assert.equal(result.anchored.length, 2);
  assert.equal(result.leftOut, 1);
});

test("the Verdict: approve, comment, request changes, and never approve after a failed Reviewer", async (t) => {
  const verdictOf = async (results: ReviewerResult[]) =>
    (await run(t, results, GOOD_ANSWER)).result.verdict;

  assert.equal(
    await verdictOf([ok("correctness", []), ok("security", [])]),
    "APPROVE",
  );
  assert.equal(
    await verdictOf([
      ok("correctness", [finding({ severity: "nit" })]),
      ok("security", [finding({ confidence: 0.1 })]),
    ]),
    "APPROVE",
  );
  assert.equal(
    await verdictOf([ok("correctness", [finding({ severity: "minor" })])]),
    "COMMENT",
  );
  assert.equal(
    await verdictOf([ok("correctness", [finding({ severity: "critical" })])]),
    "REQUEST_CHANGES",
  );
  assert.equal(
    await verdictOf([ok("correctness", []), failedReviewer("security")]),
    "COMMENT",
  );
  assert.equal(await verdictOf([failedReviewer("security")]), "COMMENT");
  assert.equal(await verdictOf([]), "COMMENT");
});

test("no Findings at all still gives a summary and a walkthrough", async (t) => {
  const { result, fake } = await run(t, [ok("correctness", [])], GOOD_ANSWER);
  assert.equal((await fake.calls()).length, 1);
  assert.equal(result.summary, "Changes a value.");
  assert.equal(result.combinedFixPrompt, null);
  assert.equal(result.leftOut, 0);
});
