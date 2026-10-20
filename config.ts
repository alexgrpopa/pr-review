/**
 * Shared configuration for the PR review tool: the Reviewers, the path filters
 * and instructions, the Threshold and the limits. Everything specific to this
 * repository lives here and in `prompts/`, so the tool stays extractable.
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
 * Paths no Reviewer looks at: build output, dependencies, static assets and
 * the lockfile. Directories end in a slash. Used as pathspec exclusions.
 */
export const PATH_FILTERS: readonly string[] = Object.freeze([
  "dist/",
  ".astro/",
  "node_modules/",
  "public/",
  "pnpm-lock.yaml",
]);

export interface PathInstruction {
  /** Glob of the files it applies to, as written for the Reviewer to read. */
  path: string;
  /** Reviewers it is handed to. */
  reviewers: readonly ReviewerName[];
  instructions: string;
}

export const PATH_INSTRUCTIONS: readonly PathInstruction[] = Object.freeze([
  {
    path: "src/**/*.astro",
    reviewers: ["architecture", "coding-standards"],
    instructions:
      "Follow Astro conventions: keep frontmatter logic minimal, prefer static output, and only hydrate components that need interactivity.",
  },
  {
    path: "src/**/*.astro",
    reviewers: ["correctness"],
    instructions:
      "Check accessibility: semantic HTML, alt text, labels and focus states.",
  },
  {
    path: "src/**/*.{css,astro}",
    reviewers: ["coding-standards"],
    instructions:
      "Styles are linted with stylelint-config-standard. Prefer logical properties over physical ones and avoid CSS features unsupported by the browserslist in package.json.",
  },
  {
    path: "src/pages/**",
    reviewers: ["architecture"],
    instructions: "Verify routing follows Astro file-based conventions.",
  },
  {
    path: "src/pages/**",
    reviewers: ["correctness"],
    instructions:
      "Verify every page sets a title and a meta description through the shared layout.",
  },
]);

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
