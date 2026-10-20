/**
 * The Aggregator: the one Claude call after the Reviewers. It finds Findings
 * that describe the same issue, and writes the summary and a walkthrough of the
 * changed files. It runs like a Reviewer (claude.ts: `claude -p`, read-only
 * tools, scrubbed environment, the worktree, a timeout, JSON checked against a
 * schema) with the prompt `prompts/aggregator.md` of this checkout.
 *
 * It does not choose what is posted: the Threshold, the cap, anchoring and the
 * Verdict are code (see aggregate.ts). It only returns groups of duplicates,
 * which code then merges, so a wrong answer can cost a missed merge or a wrong
 * merge but never an invented or hidden Finding. A group that mixes files is
 * rejected as invalid output.
 *
 * It never throws. When it fails (or answers invalid JSON), the run goes on
 * with {@link fallbackSummary}: no merge beyond identical Fingerprints, and a
 * summary line saying the Aggregator did not run and why.
 */

import { runClaude, type FailureReason } from "./claude.ts";
import { AGGREGATOR, type AggregatorConfig } from "./config.ts";
import type { ChangedFile } from "./diff.ts";
import type { Candidate } from "./merge.ts";
import { PROMPTS_DIR, diffCommand, loadPrompt } from "./reviewers.ts";

export interface WalkthroughEntry {
  path: string;
  /** What changed in the file, in one line. */
  change: string;
}

export interface AggregatorOutput {
  summary: string;
  walkthrough: WalkthroughEntry[];
  /** Groups of indexes into the Candidates given, 2 or more each. */
  duplicateGroups: number[][];
}

export type AggregatorResult =
  | {
      status: "ok";
      output: AggregatorOutput;
      model: string;
      costUsd?: number;
      durationMs: number;
    }
  | {
      status: "failed";
      reason: FailureReason;
      /** What failed. Safe to show to the developer. */
      detail: string;
      model: string;
      durationMs: number;
    };

export interface RunAggregatorOptions {
  /** Worktree of the head commit. The Aggregator starts here. */
  worktree: string;
  /** Commit or ref the change is compared with (the merge-base). */
  base: string;
  /** The Findings that survived the Threshold, in the order they are numbered. */
  candidates: readonly Candidate[];
  /** Files of the diff, to drop walkthrough rows for files not in it. */
  files?: readonly ChangedFile[];
  config?: AggregatorConfig;
  /** Executable to start instead of `claude`. Tests give a fake. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  promptsDir?: string;
}

export const AGGREGATOR_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    summary: { type: "string" },
    walkthrough: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          change: { type: "string" },
        },
        required: ["path", "change"],
        additionalProperties: false,
      },
    },
    duplicateGroups: {
      type: "array",
      items: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        minItems: 2,
      },
    },
  },
  required: ["summary", "walkthrough", "duplicateGroups"],
  additionalProperties: false,
});

/** Longest Finding body handed to the Aggregator, in characters. */
const BODY_LENGTH = 600;

/** Longest list of validation errors quoted in a failure detail. */
const MAX_ERRORS_SHOWN = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks what the Aggregator returned against the Candidates it was given.
 * Walkthrough rows for files that are not in `files` (when given) are dropped
 * rather than failing the output.
 */
export function validateAggregatorOutput(
  output: unknown,
  candidates: readonly Pick<Candidate, "path">[],
  files?: readonly Pick<ChangedFile, "path">[],
): { ok: true; value: AggregatorOutput } | { ok: false; errors: string[] } {
  if (!isRecord(output)) {
    return { ok: false, errors: ["output must be an object"] };
  }
  const errors: string[] = [];

  const { summary } = output;
  if (typeof summary !== "string" || summary.trim() === "") {
    errors.push("summary must be a non-empty string");
  }

  const walkthrough: WalkthroughEntry[] = [];
  if (!Array.isArray(output.walkthrough)) {
    errors.push("walkthrough must be an array");
  } else {
    const known = files && new Set(files.map((f) => f.path));
    output.walkthrough.forEach((row: unknown, index) => {
      if (
        !isRecord(row) ||
        typeof row.path !== "string" ||
        row.path.trim() === "" ||
        typeof row.change !== "string" ||
        row.change.trim() === ""
      ) {
        errors.push(`walkthrough[${index}]: needs a path and a change`);
      } else if (!known || known.has(row.path)) {
        walkthrough.push({ path: row.path, change: row.change.trim() });
      }
    });
  }

  const duplicateGroups: number[][] = [];
  if (!Array.isArray(output.duplicateGroups)) {
    errors.push("duplicateGroups must be an array");
  } else {
    const used = new Set<number>();
    output.duplicateGroups.forEach((group: unknown, index) => {
      const label = `duplicateGroups[${index}]`;
      if (
        !Array.isArray(group) ||
        group.length < 2 ||
        !group.every(
          (i) => Number.isInteger(i) && i >= 0 && i < candidates.length,
        )
      ) {
        errors.push(
          `${label}: needs 2 or more indexes between 0 and ${candidates.length - 1}`,
        );
        return;
      }
      const ids = group as number[];
      if (new Set(ids).size !== ids.length || ids.some((i) => used.has(i))) {
        errors.push(`${label}: an index is repeated or already in a group`);
        return;
      }
      if (new Set(ids.map((i) => candidates[i].path)).size !== 1) {
        errors.push(`${label}: Findings of different files cannot be merged`);
        return;
      }
      ids.forEach((i) => used.add(i));
      duplicateGroups.push([...ids]);
    });
  }

  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          summary: (summary as string).trim(),
          walkthrough,
          duplicateGroups,
        },
      };
}

/** @returns What the Aggregator is asked to do this run. */
export function buildAggregatorTask(
  base: string,
  candidates: readonly Candidate[],
): string {
  const findings = candidates.map((c, id) => ({
    id,
    reviewer: c.reviewers.join(", "),
    severity: c.severity,
    confidence: c.confidence,
    path: c.path,
    line: c.line,
    endLine: c.endLine,
    title: c.title,
    body:
      c.body.length > BODY_LENGTH
        ? `${c.body.slice(0, BODY_LENGTH)}...`
        : c.body,
  }));
  return [
    "Aggregate the review of a pull request. Its head commit is checked out in the current directory.",
    "",
    `List its changes with: ${diffCommand(base)}`,
    "",
    "The Reviewers reported these Findings (JSON; `id` is the index to use in `duplicateGroups`):",
    "",
    JSON.stringify(findings, null, 2),
  ].join("\n");
}

/**
 * Runs the Aggregator once. Never throws: every problem is a `failed` result.
 */
export async function runAggregator(
  options: RunAggregatorOptions,
): Promise<AggregatorResult> {
  const config = options.config ?? AGGREGATOR;
  const started = Date.now();
  const failed = (reason: FailureReason, detail: string): AggregatorResult => ({
    status: "failed",
    reason,
    detail: `Aggregator: ${detail}`,
    model: config.model,
    durationMs: Date.now() - started,
  });

  let systemPrompt: string;
  let task: string;
  try {
    systemPrompt = await loadPrompt(
      config.promptFile,
      options.promptsDir ?? PROMPTS_DIR,
    );
    task = buildAggregatorTask(options.base, options.candidates);
  } catch (error) {
    return failed(
      "process error",
      `could not prepare the run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const run = await runClaude({
    command: options.command,
    cwd: options.worktree,
    model: config.model,
    systemPrompt,
    task,
    schema: AGGREGATOR_OUTPUT_SCHEMA,
    timeoutMs: config.timeoutMs,
    env: options.env,
  });
  if (run.status === "failed") return failed(run.reason, run.detail);

  const checked = validateAggregatorOutput(
    run.output,
    options.candidates,
    options.files,
  );
  if (!checked.ok) {
    const shown = checked.errors.slice(0, MAX_ERRORS_SHOWN).join("; ");
    const more = checked.errors.length - MAX_ERRORS_SHOWN;
    return failed(
      "invalid output",
      `output does not match the schema: ${shown}${more > 0 ? ` (and ${more} more)` : ""}`,
    );
  }
  return {
    status: "ok",
    output: checked.value,
    model: config.model,
    costUsd: run.costUsd,
    durationMs: Date.now() - started,
  };
}

/** @returns The summary used when the Aggregator did not run. */
export function fallbackSummary(
  failure: Extract<AggregatorResult, { status: "failed" }>,
): string {
  return `The Aggregator did not run (${failure.reason}), so there is no summary of the change and duplicate Findings were merged only when identical.`;
}

/** @returns A walkthrough built from the diff, for when the Aggregator failed. */
export function fallbackWalkthrough(
  files: readonly ChangedFile[],
): WalkthroughEntry[] {
  return files.map((file) => {
    const counts = file.binary
      ? "binary file"
      : `+${file.additions} -${file.deletions}`;
    const what: Record<ChangedFile["status"], string> = {
      added: "Added",
      modified: "Modified",
      deleted: "Deleted",
      renamed: `Renamed from ${file.oldPath}`,
    };
    return { path: file.path, change: `${what[file.status]} (${counts})` };
  });
}
