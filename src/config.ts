/**
 * Shared configuration for the PR review tool: the Reviewers, the path filters
 * and instructions, the Threshold and the limits. The defaults are generic:
 * nothing here is specific to one repository.
 */

import { SEVERITIES, type Severity } from "./finding.ts";

const MINUTE = 60_000;

/** Model every Reviewer uses unless its entry overrides it. */
export const DEFAULT_MODEL = "sonnet";

export const REVIEWER_NAMES = Object.freeze([
  "architecture",
  "coding-standards",
  "security",
  "necessity",
  "correctness",
] as const);

export type ReviewerName = (typeof REVIEWER_NAMES)[number];

export interface ReviewerConfig {
  name: ReviewerName;
  /** File name in `prompts/`, read from the checkout the tool runs from. */
  promptFile: string;
  /** Alias or full model name given to `claude --model`. */
  model: string;
  enabled: boolean;
}

export const REVIEWERS: readonly ReviewerConfig[] = Object.freeze(
  REVIEWER_NAMES.map((name) =>
    Object.freeze({
      name,
      promptFile: `${name}.md`,
      model: DEFAULT_MODEL,
      enabled: true,
    }),
  ),
);

/**
 * Paths no Reviewer looks at: build output, dependencies and lockfiles.
 * Directories end in a slash. Used as pathspec exclusions.
 */
export const PATH_FILTERS: readonly string[] = Object.freeze([
  "dist/",
  "build/",
  "coverage/",
  "node_modules/",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
]);

export interface PathInstruction {
  /** Glob of the files it applies to, as written for the Reviewer to read. */
  path: string;
  /** Reviewers it is handed to. */
  reviewers: readonly ReviewerName[];
  instructions: string;
}

/** Extra instructions for files matching a glob. None by default. */
export const PATH_INSTRUCTIONS: readonly PathInstruction[] = Object.freeze([]);

/** Lowest Severity that is posted ("chill": minor and above). */
export const THRESHOLD: Severity = "minor";

/** Severities at or above the Threshold, most serious first. */
export const SEVERITIES_FROM_THRESHOLD: readonly Severity[] = Object.freeze(
  SEVERITIES.slice(0, SEVERITIES.indexOf(THRESHOLD) + 1),
);

/**
 * Lowest confidence (0 to 1) a Finding may have and still be posted. Findings
 * below it are dropped like those below the Threshold.
 */
export const MIN_CONFIDENCE = 0.5;

/** Most Findings one Review run posts. */
export const MAX_FINDINGS = 15;

/** Largest diff, in changed lines, a Review run accepts. */
export const MAX_DIFF_LINES = 3000;

/** How long one Reviewer may run before it is stopped and marked failed. */
export const REVIEWER_TIMEOUT_MS = 10 * MINUTE;

/** The Aggregator: one Claude call after the Reviewers. */
export interface AggregatorConfig {
  /** File name in `prompts/`, read from the checkout the tool runs from. */
  promptFile: string;
  /** Alias or full model name given to `claude --model`. */
  model: string;
  timeoutMs: number;
}

export const AGGREGATOR: AggregatorConfig = Object.freeze({
  promptFile: "aggregator.md",
  model: DEFAULT_MODEL,
  timeoutMs: 5 * MINUTE,
});

/** Reviewers running at the same time. */
export const CONCURRENCY = 5;
