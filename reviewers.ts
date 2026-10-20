/**
 * Runs the Reviewers: one `claude -p` process each (see claude.ts), started in
 * the worktree of the head commit, in parallel up to the configured
 * concurrency. A Reviewer that fails does not stop the others; every Reviewer
 * comes back as a result, `ok` with its Findings or `failed` with a reason.
 *
 * Prompts are read from the checkout the tool runs from, never from the
 * reviewed worktree, so a pull request cannot rewrite its own Reviewer.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaude, type FailureReason } from "./claude.ts";
import {
  CONCURRENCY,
  PATH_FILTERS,
  PATH_INSTRUCTIONS,
  REVIEWERS,
  REVIEWER_TIMEOUT_MS,
  SEVERITIES_FROM_THRESHOLD,
  type ReviewerConfig,
} from "./config.ts";
import {
  REVIEWER_OUTPUT_SCHEMA,
  validateReviewerOutput,
  type Finding,
} from "./finding.ts";

/** Folder of the Reviewers' prompts, next to this file. */
export const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "prompts",
);

export type ReviewerResult =
  | {
      reviewer: string;
      status: "ok";
      findings: Finding[];
      model: string;
      costUsd?: number;
      durationMs: number;
    }
  | {
      reviewer: string;
      status: "failed";
      reason: FailureReason;
      /** What failed, naming the Reviewer. Safe to show to the developer. */
      detail: string;
      model: string;
      durationMs: number;
    };

export interface RunReviewersOptions {
  /** Worktree of the head commit. Reviewers start here. */
  worktree: string;
  /** Commit or ref the change is compared with (the merge-base). */
  base: string;
  reviewers?: readonly ReviewerConfig[];
  concurrency?: number;
  timeoutMs?: number;
  /** Executable to start instead of `claude`. Tests give a fake. */
  command?: string;
  /** Environment to scrub and pass on. Default: the current process's. */
  env?: NodeJS.ProcessEnv;
  promptsDir?: string;
  /** Called as each Reviewer finishes. */
  onResult?: (result: ReviewerResult) => void;
}

/** Longest list of validation errors quoted in a failure detail. */
const MAX_ERRORS_SHOWN = 5;

/** Refs that are safe to hand to `git diff` and to put in a prompt. */
export const SAFE_REF = /^[\w][\w./~^@-]*$/;

/**
 * @returns The text of a prompt in `promptsDir` (default: this checkout's).
 */
export function loadPrompt(
  promptFile: string,
  promptsDir: string = PROMPTS_DIR,
): Promise<string> {
  if (promptFile !== path.basename(promptFile)) {
    throw new Error(`prompt file must be a plain file name: ${promptFile}`);
  }
  return readFile(path.join(promptsDir, promptFile), "utf8");
}

/**
 * @returns The `git diff` command, as text for a prompt, that lists the change
 *   from the merge-base with `base` to HEAD, without the filtered paths.
 */
export function diffCommand(base: string): string {
  if (!SAFE_REF.test(base)) throw new Error(`unsafe base ref: ${base}`);
  const excludes = PATH_FILTERS.map((p) => `':(exclude)${p}'`).join(" ");
  return `git diff ${base}...HEAD -- . ${excludes}`;
}

/**
 * @returns What a Reviewer is asked to do this run: where the change is, what
 *   to skip and the path instructions that concern it.
 */
export function buildTask(reviewer: ReviewerConfig, base: string): string {
  const command = diffCommand(base);
  const instructions = PATH_INSTRUCTIONS.filter((i) =>
    i.reviewers.includes(reviewer.name),
  );
  return [
    `Review a pull request as the ${reviewer.name} Reviewer. Its head commit is checked out in the current directory.`,
    "",
    `List its changes with: ${command}`,
    `Never report anything in these paths: ${PATH_FILTERS.join(", ")}.`,
    "",
    `Report only Findings of severity ${SEVERITIES_FROM_THRESHOLD.join(", ")}.`,
    ...(instructions.length > 0
      ? [
          "",
          "Path instructions for your category:",
          ...instructions.map((i) => `- \`${i.path}\`: ${i.instructions}`),
        ]
      : []),
  ].join("\n");
}

/**
 * Runs one Reviewer. Never throws: every problem is a `failed` result.
 */
export async function runReviewer(
  reviewer: ReviewerConfig,
  options: RunReviewersOptions,
): Promise<ReviewerResult> {
  const started = Date.now();
  const failed = (reason: FailureReason, detail: string): ReviewerResult => ({
    reviewer: reviewer.name,
    status: "failed",
    reason,
    detail: `Reviewer ${reviewer.name}: ${detail}`,
    model: reviewer.model,
    durationMs: Date.now() - started,
  });

  let systemPrompt: string;
  let task: string;
  try {
    systemPrompt = await loadPrompt(reviewer.promptFile, options.promptsDir);
    task = buildTask(reviewer, options.base);
  } catch (error) {
    return failed(
      "process error",
      `could not prepare the run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const run = await runClaude({
    command: options.command,
    cwd: options.worktree,
    model: reviewer.model,
    systemPrompt,
    task,
    schema: REVIEWER_OUTPUT_SCHEMA,
    timeoutMs: options.timeoutMs ?? REVIEWER_TIMEOUT_MS,
    env: options.env,
  });
  if (run.status === "failed") return failed(run.reason, run.detail);

  const checked = validateReviewerOutput(reviewer.name, run.output);
  if (!checked.ok) {
    const shown = checked.errors.slice(0, MAX_ERRORS_SHOWN).join("; ");
    const more = checked.errors.length - MAX_ERRORS_SHOWN;
    return failed(
      "invalid output",
      `output does not match the Finding schema: ${shown}${more > 0 ? ` (and ${more} more)` : ""}`,
    );
  }
  return {
    reviewer: reviewer.name,
    status: "ok",
    findings: checked.value,
    model: reviewer.model,
    costUsd: run.costUsd,
    durationMs: Date.now() - started,
  };
}

/**
 * Runs every enabled Reviewer against the worktree, at most `concurrency` at a
 * time.
 *
 * @returns One result per enabled Reviewer, in the order of the list.
 */
export async function runReviewers(
  options: RunReviewersOptions,
): Promise<ReviewerResult[]> {
  const enabled = (options.reviewers ?? REVIEWERS).filter((r) => r.enabled);
  const results: ReviewerResult[] = new Array(enabled.length);
  const limit = Math.max(1, options.concurrency ?? CONCURRENCY);
  let next = 0;
  const worker = async () => {
    while (next < enabled.length) {
      const index = next++;
      const result = await runReviewer(enabled[index], options);
      results[index] = result;
      options.onResult?.(result);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, enabled.length) }, worker),
  );
  return results;
}

/**
 * @returns Whether there were Reviewers and every one of them failed, in which
 *   case a Review run has nothing to report.
 */
export function allFailed(results: readonly ReviewerResult[]): boolean {
  return results.length > 0 && results.every((r) => r.status === "failed");
}
