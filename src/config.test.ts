import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  CONCURRENCY,
  DEFAULT_MODEL,
  MAX_DIFF_LINES,
  MAX_FINDINGS,
  PATH_FILTERS,
  PATH_INSTRUCTIONS,
  REVIEWERS,
  REVIEWER_TIMEOUT_MS,
  SEVERITIES_FROM_THRESHOLD,
  THRESHOLD,
} from "./config.ts";
import { SEVERITIES } from "./finding.ts";
import { PROMPTS_DIR } from "./reviewers.ts";

test("the five Reviewers use Sonnet and are enabled", () => {
  assert.deepEqual(
    REVIEWERS.map((r) => r.name),
    [
      "architecture",
      "coding-standards",
      "security",
      "necessity",
      "correctness",
    ],
  );
  for (const reviewer of REVIEWERS) {
    assert.equal(reviewer.model, DEFAULT_MODEL);
    assert.equal(reviewer.enabled, true);
  }
  assert.equal(DEFAULT_MODEL, "sonnet");
});

test("every Reviewer has a prompt file in prompts/", async () => {
  for (const reviewer of REVIEWERS) {
    assert.equal(reviewer.promptFile, path.basename(reviewer.promptFile));
    await access(path.join(PROMPTS_DIR, reviewer.promptFile));
  }
});

test("path filters ignore build output, dependencies and lockfiles", () => {
  assert.deepEqual(
    [...PATH_FILTERS],
    [
      "dist/",
      "build/",
      "coverage/",
      "node_modules/",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lock",
    ],
  );
});

test("there are no path instructions by default", () => {
  assert.deepEqual([...PATH_INSTRUCTIONS], []);
});

test("the Threshold is minor, so minor and above are posted", () => {
  assert.equal(THRESHOLD, "minor");
  assert.deepEqual(
    [...SEVERITIES_FROM_THRESHOLD],
    ["critical", "major", "minor"],
  );
  assert.ok(SEVERITIES.includes(THRESHOLD));
});

test("limits", () => {
  assert.equal(MAX_FINDINGS, 15);
  assert.equal(MAX_DIFF_LINES, 3000);
  assert.equal(REVIEWER_TIMEOUT_MS, 10 * 60 * 1000);
  assert.ok(Number.isInteger(CONCURRENCY) && CONCURRENCY >= 1);
});
