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
  REVIEWER_NAMES,
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

test("path filters ignore build output, dependencies, assets and the lockfile", () => {
  assert.deepEqual(
    [...PATH_FILTERS],
    ["dist/", ".astro/", "node_modules/", "public/", "pnpm-lock.yaml"],
  );
});

test("the ported path instructions are all handed to known Reviewers", () => {
  const paths = new Set(PATH_INSTRUCTIONS.map((i) => i.path));
  assert.deepEqual(
    [...paths].sort(),
    ["src/**/*.astro", "src/**/*.{css,astro}", "src/pages/**"].sort(),
  );
  for (const instruction of PATH_INSTRUCTIONS) {
    assert.ok(instruction.instructions.length > 0);
    assert.ok(instruction.reviewers.length > 0);
    for (const name of instruction.reviewers) {
      assert.ok(REVIEWER_NAMES.includes(name), name);
    }
  }
});

test("path instructions keep the content of .coderabbit.yaml", () => {
  const text = PATH_INSTRUCTIONS.map((i) => i.instructions).join(" ");
  for (const phrase of [
    "frontmatter logic minimal",
    "hydrate components that need interactivity",
    "accessibility",
    "stylelint-config-standard",
    "logical properties",
    "browserslist in package.json",
    "file-based",
    "title and a meta description",
  ]) {
    assert.ok(text.includes(phrase), `missing: ${phrase}`);
  }
});

test("accessibility goes to correctness, styles to coding standards", () => {
  const handedTo = (needle: string) =>
    PATH_INSTRUCTIONS.filter((i) => i.instructions.includes(needle)).flatMap(
      (i) => i.reviewers,
    );
  assert.deepEqual(handedTo("accessibility"), ["correctness"]);
  assert.deepEqual(handedTo("stylelint-config-standard"), ["coding-standards"]);
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
