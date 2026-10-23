/**
 * Aggregation: turns the Reviewers' Findings into what gets posted. The result
 * ({@link AggregationResult}) is the input of the posting step; nothing here
 * talks to GitHub.
 *
 *   aggregate(options)
 *     Findings of the Reviewers that ran
 *     -> Threshold + minimum confidence      (selection.ts)  counted as dropped
 *     -> merge identical Fingerprints        (merge.ts)
 *     -> Aggregator call: duplicate groups, summary, walkthrough (aggregator.ts)
 *        (on failure: fallback summary and walkthrough, no further merging)
 *     -> Verdict over everything found       (verdict.ts)
 *     -> skip Fingerprints already posted    (fingerprint.ts) counted as dropped
 *     -> cap, most serious first             (selection.ts)  rest is "left out"
 *     -> anchoring against the diff          (diff.ts)       anchored / unanchored
 *     -> Suggestion check, Fix prompts       (suggestion.ts, fix-prompt.ts)
 *
 * Everything after the Aggregator call is the pure function {@link assemble}.
 * The whole pull request is reviewed on every run: there is no incremental
 * mode, and stale threads are not resolved.
 */

import {
  fallbackSummary,
  fallbackWalkthrough,
  runAggregator,
  type WalkthroughEntry,
} from "./aggregator.ts";
import { AGGREGATOR, MAX_FINDINGS, type AggregatorConfig } from "./config.ts";
import { anchorFinding, parseDiff, type ChangedFile } from "./diff.ts";
import { SEVERITIES, type Severity } from "./finding.ts";
import { fingerprintMarkers } from "./fingerprint.ts";
import { combineFixPrompts, fixPromptFor } from "./fix-prompt.ts";
import { mergeGroups, mergeIdentical, type Candidate } from "./merge.ts";
import type { FailureReason } from "./claude.ts";
import type { ReviewerResult } from "./reviewers.ts";
import {
  applyThreshold,
  capFindings,
  type ThresholdOptions,
} from "./selection.ts";
import { checkSuggestion } from "./suggestion.ts";
import { decideVerdict, type Verdict } from "./verdict.ts";

export type SeverityCounts = Record<Severity, number>;

/** A Finding that is posted. */
export interface PostedFinding extends Candidate {
  /** Self-contained: the Reviewer's own when valid, otherwise built. */
  fixPrompt: string;
  /** Only when it is an exact single-hunk replacement (suggestion.ts). */
  suggestion?: string;
  /** Hidden markers for every Fingerprint, to put in the posted comment. */
  marker: string;
}

/** Posted as a comment on its line, inside the Inline review. */
export interface AnchoredFinding extends PostedFinding {
  path: string;
  line: number;
}

/** Posted in the Findings comment. */
export interface UnanchoredFinding extends PostedFinding {
  /** Why it has no changed line, for the Findings comment. */
  unanchoredReason: string;
}

export interface ReviewerSummary {
  reviewer: string;
  status: "ok" | "failed";
  /** For a failed Reviewer: why. */
  reason?: FailureReason;
  detail?: string;
  /** Everything it reported, by Severity. */
  reported: SeverityCounts;
  /** What it reported at or above the Threshold and minimum confidence. */
  kept: SeverityCounts;
}

export type AggregatorStatus =
  | { status: "ok"; model: string; costUsd?: number }
  | {
      status: "failed";
      reason: FailureReason;
      detail: string;
      model: string;
    };

/** What a Review run posts. The input of the posting step. */
export interface AggregationResult {
  /** Posted as Inline review comments, in posting order. */
  anchored: AnchoredFinding[];
  /** Posted in the Findings comment, in posting order. */
  unanchored: UnanchoredFinding[];
  dropped: {
    /** Below the Threshold. */
    belowThreshold: number;
    /** At or above the Threshold but below the minimum confidence. */
    lowConfidence: number;
    /** Merged into another Finding. */
    duplicates: number;
    /** Already on the pull request from an earlier run. */
    alreadyPosted: number;
  };
  /** Findings over the cap, not posted. The Findings comment says so. */
  leftOut: number;
  /** One entry per Reviewer that was run, in the order given. */
  reviewers: ReviewerSummary[];
  verdict: Verdict;
  /** One sentence explaining the Verdict. */
  verdictReason: string;
  /** One Fix prompt for all posted Findings; null when none are posted. */
  combinedFixPrompt: string | null;
  /** Markdown, from the Aggregator or the fallback line. */
  summary: string;
  walkthrough: WalkthroughEntry[];
  aggregator: AggregatorStatus;
}

export interface AggregateOptions extends ThresholdOptions {
  /** Worktree of the head commit. The Aggregator starts here. */
  worktree: string;
  /** Commit or ref the change is compared with (the merge-base). */
  base: string;
  /** The diff, as printed by `git` with `diffGitArgs(base)` (diff.ts). */
  diff: string;
  results: readonly ReviewerResult[];
  /** Fingerprints already on the pull request (`extractFingerprints`). */
  existingFingerprints?: ReadonlySet<string>;
  /** Most Findings posted. Default: the configured cap. */
  maxFindings?: number;
  aggregator?: AggregatorConfig;
  /** Executable to start instead of `claude`. Tests give a fake. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  promptsDir?: string;
}

function emptyCounts(): SeverityCounts {
  return Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as SeverityCounts;
}

function countBySeverity(
  findings: readonly { severity: Severity }[],
): SeverityCounts {
  const counts = emptyCounts();
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

export interface AssembleInput extends ThresholdOptions {
  files: readonly ChangedFile[];
  results: readonly ReviewerResult[];
  /** Findings at or above the Threshold, after merging, in any order. */
  merged: readonly Candidate[];
  /** How many Findings the Reviewers reported below Threshold, by kind. */
  belowThreshold: number;
  lowConfidence: number;
  /** Merged away before this step. */
  duplicates: number;
  existingFingerprints?: ReadonlySet<string>;
  maxFindings?: number;
  aggregator: AggregatorStatus;
  summary: string;
  walkthrough: WalkthroughEntry[];
}

/**
 * Pure part of the aggregation: Verdict, already-posted check, cap, anchoring,
 * Suggestions and Fix prompts.
 */
export function assemble(input: AssembleInput): AggregationResult {
  const existing = input.existingFingerprints ?? new Set<string>();

  const fresh = input.merged.filter(
    (c) => !c.fingerprints.some((fp) => existing.has(fp)),
  );
  const alreadyPosted = input.merged.length - fresh.length;
  const capped = capFindings(fresh, input.maxFindings ?? MAX_FINDINGS);

  const anchored: AnchoredFinding[] = [];
  const unanchored: UnanchoredFinding[] = [];
  const posted: PostedFinding[] = [];
  for (const candidate of capped.kept) {
    const anchor = anchorFinding(candidate, input.files);
    const check = anchor.anchored
      ? checkSuggestion(candidate, input.files)
      : undefined;
    const suggestion = check?.ok ? check.suggestion : undefined;

    const finding: PostedFinding = {
      ...candidate,
      fixPrompt: fixPromptFor(candidate, suggestion),
      marker: fingerprintMarkers(candidate.fingerprints),
    };
    if (suggestion !== undefined) finding.suggestion = suggestion;
    else delete finding.suggestion;
    posted.push(finding);

    if (anchor.anchored) {
      anchored.push(finding as AnchoredFinding);
    } else {
      unanchored.push({ ...finding, unanchoredReason: anchor.reason });
    }
  }

  const reviewersOk = input.results.filter((r) => r.status === "ok").length;
  const { verdict, reason } = decideVerdict({
    foundSeverities: input.merged.map((c) => c.severity),
    reviewersOk,
    reviewersFailed: input.results.length - reviewersOk,
    threshold: input.threshold,
  });

  const reviewers = input.results.map((result): ReviewerSummary => {
    if (result.status === "failed") {
      return {
        reviewer: result.reviewer,
        status: "failed",
        reason: result.reason,
        detail: result.detail,
        reported: emptyCounts(),
        kept: emptyCounts(),
      };
    }
    return {
      reviewer: result.reviewer,
      status: "ok",
      reported: countBySeverity(result.findings),
      kept: countBySeverity(applyThreshold(result.findings, input).kept),
    };
  });

  return {
    anchored,
    unanchored,
    dropped: {
      belowThreshold: input.belowThreshold,
      lowConfidence: input.lowConfidence,
      duplicates: input.duplicates,
      alreadyPosted,
    },
    leftOut: capped.leftOut,
    reviewers,
    verdict,
    verdictReason: reason,
    combinedFixPrompt: combineFixPrompts(posted),
    summary: input.summary,
    walkthrough: input.walkthrough,
    aggregator: input.aggregator,
  };
}

/**
 * Runs the aggregation for one Review run. Never throws for a failed
 * Aggregator: it falls back and the run continues.
 */
export async function aggregate(
  options: AggregateOptions,
): Promise<AggregationResult> {
  const files = parseDiff(options.diff);
  const reported = options.results.flatMap((r) =>
    r.status === "ok" ? r.findings : [],
  );
  const thresholded = applyThreshold(reported, options);
  const identical = mergeIdentical(thresholded.kept);

  const run = await runAggregator({
    worktree: options.worktree,
    base: options.base,
    candidates: identical,
    files,
    config: options.aggregator ?? AGGREGATOR,
    command: options.command,
    env: options.env,
    promptsDir: options.promptsDir,
  });

  const merged =
    run.status === "ok"
      ? mergeGroups(identical, run.output.duplicateGroups)
      : identical;

  return assemble({
    ...options,
    files,
    merged,
    belowThreshold: thresholded.belowThreshold,
    lowConfidence: thresholded.lowConfidence,
    duplicates: thresholded.kept.length - merged.length,
    aggregator:
      run.status === "ok"
        ? { status: "ok", model: run.model, costUsd: run.costUsd }
        : {
            status: "failed",
            reason: run.reason,
            detail: run.detail,
            model: run.model,
          },
    summary: run.status === "ok" ? run.output.summary : fallbackSummary(run),
    walkthrough:
      run.status === "ok" && run.output.walkthrough.length > 0
        ? run.output.walkthrough
        : fallbackWalkthrough(files),
  });
}
