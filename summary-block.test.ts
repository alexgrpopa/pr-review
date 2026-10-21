import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewerSummary } from "./aggregate.ts";
import { GITHUB_BODY_LIMIT } from "./markdown.ts";
import {
  SUMMARY_END,
  SUMMARY_START,
  applySummaryBlock,
  renderSummaryBlock,
  type SummaryBlockInput,
} from "./summary-block.ts";

const counts = (critical = 0, major = 0, minor = 0, nit = 0) => ({
  critical,
  major,
  minor,
  nit,
});

const REVIEWERS: ReviewerSummary[] = [
  {
    reviewer: "correctness",
    status: "ok",
    reported: counts(0, 2, 1),
    kept: counts(0, 2, 1),
  },
  {
    reviewer: "security",
    status: "failed",
    reason: "timeout",
    detail: "Reviewer security: ran out of time",
    reported: counts(),
    kept: counts(),
  },
];

function input(overrides: Partial<SummaryBlockInput> = {}): SummaryBlockInput {
  return {
    summary: "Adds the feature.",
    walkthrough: [{ path: "src/feature.ts", change: "New feature module" }],
    reviewers: REVIEWERS,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    ...overrides,
  };
}

test("the block holds the summary, a walkthrough table and a Reviewer status table", () => {
  const block = renderSummaryBlock(input());
  assert.ok(block.startsWith(SUMMARY_START));
  assert.ok(block.endsWith(SUMMARY_END));
  assert.match(block, /Adds the feature\./);
  assert.match(block, /\| File \| What changed \|/);
  assert.match(block, /\| `src\/feature\.ts` \| New feature module \|/);
  assert.match(
    block,
    /\| Reviewer \| Status \| Critical \| Major \| Minor \| Nit \|/,
  );
  assert.match(block, /\| correctness \| ran \| 0 \| 2 \| 1 \| 0 \|/);
  assert.match(
    block,
    /\| security \| did not run \(timeout: Reviewer security: ran out of time\) \| – \| – \| – \| – \|/,
  );
  assert.match(block, /Reviewed `0123456`/);
});

test("model text cannot forge a marker or break a table", () => {
  const block = renderSummaryBlock(
    input({
      summary: "x <!-- pr-review:end --> y",
      walkthrough: [{ path: "a|b.ts", change: "one | two\nthree <!-- z -->" }],
    }),
  );
  // Only the block's own two markers are real comments.
  assert.equal(block.match(/<!--/g)?.length, 2);
  assert.match(block, /one \\\| two three &lt;!-- z -->/);
});

test("the markers are replaced in place and text outside them is untouched", () => {
  const before = "Intro with **markdown**.\n\n";
  const after = "\n\n## Notes\n- keep me\n";
  const body = `${before}${SUMMARY_START}\nold block\n${SUMMARY_END}${after}`;
  const next = applySummaryBlock(body, input());
  assert.ok(next.startsWith(before + SUMMARY_START));
  assert.ok(next.endsWith(SUMMARY_END + after));
  assert.ok(!next.includes("old block"));
  assert.equal(next.split(SUMMARY_START).length, 2);
});

test("without markers the block is appended after the description", () => {
  const next = applySummaryBlock("My description.\n", input());
  assert.ok(next.startsWith("My description.\n\n" + SUMMARY_START));
  assert.ok(next.endsWith(SUMMARY_END));
  assert.equal(applySummaryBlock("", input()).startsWith(SUMMARY_START), true);
});

test("applying twice changes nothing the second time", () => {
  const once = applySummaryBlock("Description", input());
  assert.equal(applySummaryBlock(once, input()), once);
});

test("a stray start marker in the description is not mistaken for the block", () => {
  const body = `text ${SUMMARY_START} more text\n\n${SUMMARY_START}\nold\n${SUMMARY_END}\ntail`;
  const next = applySummaryBlock(body, input());
  assert.ok(next.startsWith(`text ${SUMMARY_START} more text\n\n`));
  assert.ok(next.endsWith(`${SUMMARY_END}\ntail`));
  assert.ok(!next.includes("old"));
});

test("a start marker without an end is left alone and the block is appended", () => {
  const body = `text ${SUMMARY_START} dangling`;
  const next = applySummaryBlock(body, input());
  assert.ok(next.startsWith(body));
  // The next run still finds the block it appended, not the dangling marker.
  const again = applySummaryBlock(next, input({ summary: "Changed." }));
  assert.ok(again.startsWith(body));
  assert.match(again, /Changed\./);
  assert.ok(!again.includes("Adds the feature."));
});

test("a long walkthrough is cut to fit with a visible note; the outside text survives", () => {
  const files = Array.from({ length: 2_000 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    change: "A change described at some length so the table is large",
  }));
  const outside = "Hand-written description.\n\n";
  const next = applySummaryBlock(outside, input({ walkthrough: files }));
  assert.ok(next.length <= GITHUB_BODY_LIMIT);
  assert.ok(next.startsWith(outside + SUMMARY_START));
  assert.ok(next.endsWith(SUMMARY_END));
  assert.match(next, /\d+ more files not shown/);
  assert.match(next, /\| `src\/file-0\.ts` \|/);
  // The Reviewer table is still there.
  assert.match(next, /\| correctness \| ran \|/);
});

test("a huge summary is cut with a note", () => {
  const block = renderSummaryBlock(
    input({ summary: "word ".repeat(30_000) }),
    10_000,
  );
  assert.ok(block.length <= 10_000);
  assert.match(block, /summary cut/);
  assert.match(block, /### Reviewers/);
});

test("a description with no room left fails with a clear message instead of a bad write", () => {
  assert.throws(
    () => applySummaryBlock("x".repeat(GITHUB_BODY_LIMIT - 100), input()),
    /too little/,
  );
});
