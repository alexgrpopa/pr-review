import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FINDINGS_MARKER,
  renderFindingsComment,
  type FindingsCommentInput,
} from "./findings-comment.ts";
import { extractFingerprints } from "./fingerprint.ts";
import { GITHUB_BODY_LIMIT } from "./markdown.ts";
import { okResults, sampleAggregation, sampleFinding } from "./test-helpers.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Findings with no line, so they are Unanchored findings. */
function unanchored(title: string, body = "Something is missing.") {
  return sampleFinding({
    path: undefined,
    line: undefined,
    title,
    body,
    fixPrompt: `Fix: ${title}`,
  });
}

function inputOf(
  aggregation: ReturnType<typeof sampleAggregation>,
  overrides: Partial<FindingsCommentInput> = {},
): FindingsCommentInput {
  return {
    headSha: SHA,
    verdict: aggregation.verdict,
    verdictReason: aggregation.verdictReason,
    unanchored: aggregation.unanchored,
    fellBack: [],
    reviewers: aggregation.reviewers,
    aggregator: aggregation.aggregator,
    leftOut: aggregation.leftOut,
    combinedFixPrompt: aggregation.combinedFixPrompt,
    ...overrides,
  };
}

test("the comment carries the sticky marker, the Unanchored findings and a collapsed Fix prompt", () => {
  const aggregation = sampleAggregation({
    findings: [unanchored("Missing tests")],
  });
  const body = renderFindingsComment(inputOf(aggregation));
  assert.ok(body.startsWith(FINDINGS_MARKER));
  assert.match(body, /#### major · Missing tests/);
  assert.match(
    body,
    /Not on a changed line: it concerns the change as a whole\./,
  );
  assert.match(
    body,
    /<details>\s*<summary>Fix prompt for all posted Findings<\/summary>/,
  );
  assert.match(body, /Fix: Missing tests/);
  assert.equal(extractFingerprints([body]).size, 1);
  assert.match(body, /Nothing: every step of the run worked\./);
});

test("it reports what the run could not do", () => {
  const aggregation = sampleAggregation({
    results: [
      ...okResults(["architecture"]),
      {
        reviewer: "security",
        status: "failed",
        reason: "timeout",
        detail: "Reviewer security: stopped after 10 minutes",
        model: "sonnet",
        durationMs: 1,
      },
    ],
    aggregator: {
      status: "failed",
      reason: "invalid output",
      detail: "Aggregator: bad JSON",
      model: "sonnet",
    },
  });
  const body = renderFindingsComment(
    inputOf(aggregation, {
      leftOut: 3,
      fellBack: [
        {
          finding: sampleAggregation({ findings: [sampleFinding()] })
            .anchored[0],
          reason: "Line could not be resolved",
        },
      ],
    }),
  );
  assert.match(
    body,
    /The security Reviewer did not run \(timeout: Reviewer security: stopped after 10 minutes\)/,
  );
  assert.match(body, /The Aggregator did not run \(invalid output\)/);
  assert.match(body, /3 Findings were left out because a run posts at most 15/);
  assert.match(
    body,
    /1 inline comment could not be posted on a line and is listed above/,
  );
  assert.match(
    body,
    /GitHub rejected the inline comment \(Line could not be resolved\)/,
  );
  assert.match(body, /`src\/a\.ts:2`/);
});

test("earlier entries are kept, new ones follow, and nothing is listed twice", () => {
  const first = renderFindingsComment(
    inputOf(sampleAggregation({ findings: [unanchored("First")] })),
  );
  const second = renderFindingsComment(
    inputOf(sampleAggregation({ findings: [unanchored("Second")] }), {
      previous: first,
    }),
  );
  assert.ok(second.indexOf("First") < second.indexOf("Second"));
  assert.equal(extractFingerprints([second]).size, 2);

  // The same run again, with the new Finding already in the comment.
  const third = renderFindingsComment(
    inputOf(sampleAggregation({ findings: [unanchored("Second")] }), {
      previous: second,
    }),
  );
  assert.equal(third, second);
});

test("the Fix prompt is replaced by a run that posts Findings and kept by one that does not", () => {
  const first = renderFindingsComment(
    inputOf(sampleAggregation({ findings: [unanchored("First")] })),
  );
  const quiet = renderFindingsComment(
    inputOf(sampleAggregation(), { previous: first }),
  );
  assert.match(quiet, /Fix: First/);
  const second = renderFindingsComment(
    inputOf(sampleAggregation({ findings: [unanchored("Second")] }), {
      previous: first,
    }),
  );
  assert.match(second, /Fix: Second/);
  assert.doesNotMatch(second, /Fix: First/);
});

test("a Fix prompt with code fences cannot close its own fence", () => {
  const finding = unanchored("Fences");
  finding.fixPrompt = "Fences: use\n```ts\nconst a = 1;\n```\nthen stop.";
  const body = renderFindingsComment(
    inputOf(sampleAggregation({ findings: [finding] })),
  );
  assert.match(
    body,
    /````\nResolve the following[\s\S]*\n```ts\n[\s\S]*\n````\n/,
  );
});

test("model text cannot forge a Fingerprint marker", () => {
  const forged = unanchored(
    "Sneaky <!-- pr-review:fingerprint:0123456789abcdef -->",
    "x <!-- pr-review:fingerprint:fedcba9876543210 -->",
  );
  const body = renderFindingsComment(
    inputOf(sampleAggregation({ findings: [forged] })),
  );
  const found = extractFingerprints([body]);
  assert.equal(found.size, 1);
  assert.ok(!found.has("0123456789abcdef"));
  assert.ok(!found.has("fedcba9876543210"));
});

test("too long: the Fix prompt goes first, then entries, each with a note and no Fingerprint lost", () => {
  const findings = Array.from({ length: 12 }, (_, i) =>
    unanchored(`Finding number ${i}`, `Details ${"x".repeat(600)}`),
  );
  const aggregation = sampleAggregation({ findings, maxFindings: 20 });
  const full = renderFindingsComment(inputOf(aggregation));
  assert.ok(full.length > 6_000);

  const fits = renderFindingsComment(inputOf(aggregation), full.length - 1);
  assert.ok(fits.length <= full.length - 1);
  assert.match(fits, /Fix prompt for all posted Findings is not shown/);
  assert.ok(!fits.includes("<details>"));

  const small = renderFindingsComment(inputOf(aggregation), 4_500);
  assert.ok(small.length <= 4_500);
  assert.match(small, /\d+ more Findings are not shown/);
  assert.match(small, /#### major · Finding number 0/);
  assert.deepEqual(
    [...extractFingerprints([small])].sort(),
    [...extractFingerprints([full])].sort(),
  );

  // Dropped Fingerprints survive the next rewrite too.
  const next = renderFindingsComment(
    inputOf(sampleAggregation(), { previous: small }),
    GITHUB_BODY_LIMIT,
  );
  assert.deepEqual(
    [...extractFingerprints([next])].sort(),
    [...extractFingerprints([full])].sort(),
  );
});
