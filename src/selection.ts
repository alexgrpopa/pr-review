/**
 * Which Findings are posted: the Threshold and confidence drops, and the cap.
 * Pure functions; the defaults come from config.ts and every limit can be
 * overridden by the caller.
 */

import { MAX_FINDINGS, MIN_CONFIDENCE, THRESHOLD } from "./config.ts";
import { SEVERITIES, type Finding, type Severity } from "./finding.ts";

export interface ThresholdOptions {
  /** Lowest Severity kept. Default: the configured Threshold. */
  threshold?: Severity;
  /** Lowest confidence kept. Default: the configured minimum. */
  minConfidence?: number;
}

export interface ThresholdResult<T> {
  kept: T[];
  /** Dropped for a Severity below the Threshold. */
  belowThreshold: number;
  /** Dropped for a confidence below the minimum (and Severity at or above). */
  lowConfidence: number;
}

/** @returns Whether `severity` is at or above `threshold`. */
export function meetsThreshold(
  severity: Severity,
  threshold: Severity = THRESHOLD,
): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold);
}

/**
 * Drops the Findings below the Threshold, then those with too little
 * confidence. A Finding that fails both counts as below the Threshold. The
 * order of the kept Findings is unchanged.
 */
export function applyThreshold<
  T extends Pick<Finding, "severity" | "confidence">,
>(findings: readonly T[], options: ThresholdOptions = {}): ThresholdResult<T> {
  const threshold = options.threshold ?? THRESHOLD;
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
  const result: ThresholdResult<T> = {
    kept: [],
    belowThreshold: 0,
    lowConfidence: 0,
  };
  for (const finding of findings) {
    if (!meetsThreshold(finding.severity, threshold)) result.belowThreshold++;
    else if (finding.confidence < minConfidence) result.lowConfidence++;
    else result.kept.push(finding);
  }
  return result;
}

type Sortable = Pick<
  Finding,
  "severity" | "confidence" | "path" | "line" | "title" | "reviewer"
>;

/**
 * Order Findings are posted in: Severity (most serious first), then higher
 * confidence, then path and line, then title and Reviewer so the order never
 * depends on the order the Reviewers finished in. A Finding without a path
 * sorts after those with one.
 */
export function compareFindings(a: Sortable, b: Sortable): number {
  return (
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    b.confidence - a.confidence ||
    Number(a.path === undefined) - Number(b.path === undefined) ||
    (a.path ?? "").localeCompare(b.path ?? "", "en") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.title.localeCompare(b.title, "en") ||
    a.reviewer.localeCompare(b.reviewer, "en")
  );
}

export interface CapResult<T> {
  /** At most `max` Findings, in posting order. */
  kept: T[];
  /** How many more there were, for the Findings comment to say so. */
  leftOut: number;
}

/** Keeps the `max` first Findings in {@link compareFindings} order. */
export function capFindings<T extends Sortable>(
  findings: readonly T[],
  max: number = MAX_FINDINGS,
): CapResult<T> {
  const sorted = [...findings].sort(compareFindings);
  const limit = Math.max(0, Math.floor(max));
  return {
    kept: sorted.slice(0, limit),
    leftOut: Math.max(0, sorted.length - limit),
  };
}
