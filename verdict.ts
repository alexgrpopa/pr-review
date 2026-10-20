/**
 * The Verdict: what the Inline review says about the pull request as a whole.
 * Its values are the events GitHub's review API takes.
 *
 * Rules, in order:
 *
 *   1. `REQUEST_CHANGES` when a `critical` or `major` Finding is found.
 *   2. `COMMENT` when the review is not complete enough to approve: no
 *      Reviewer ran, or a Reviewer failed. An incomplete review never says
 *      "approved", even when the Reviewers that did run found nothing.
 *   3. `APPROVE` when no Finding at or above the Threshold is found. This also
 *      supersedes an earlier "changes requested" from the Review bot.
 *   4. `COMMENT` otherwise (only `minor` Findings, with the default Threshold).
 *
 * Edge cases, decided here:
 *
 *   - The Verdict follows every Finding at or above the Threshold (and the
 *     minimum confidence) FOUND IN THIS RUN, not only the newly posted ones. A
 *     run where every Finding was already posted in an earlier run therefore
 *     keeps `REQUEST_CHANGES` while a `critical` or `major` one remains in the
 *     code, and does not turn into `APPROVE` just because there is nothing new
 *     to post. Findings left out by the cap count too (the cap sorts by
 *     Severity, so they are never more serious than the posted ones).
 *   - Findings dropped for being below the Threshold or for low confidence do
 *     not count: a run that only has those approves.
 *   - A failed Aggregator does not affect the Verdict: its fallback keeps
 *     every Finding, so nothing that could change the Verdict is lost.
 *   - The Verdict is separate from whether anything new is posted. The poster
 *     decides how to submit a Verdict when there are no new Inline comments.
 */

import { THRESHOLD } from "./config.ts";
import type { Severity } from "./finding.ts";
import { meetsThreshold } from "./selection.ts";

export type Verdict = "REQUEST_CHANGES" | "APPROVE" | "COMMENT";

export interface VerdictInput {
  /** Severities of every Finding found at or above the Threshold. */
  foundSeverities: readonly Severity[];
  /** Reviewers that ran and returned valid output. */
  reviewersOk: number;
  /** Reviewers that failed. */
  reviewersFailed: number;
  threshold?: Severity;
}

export interface VerdictResult {
  verdict: Verdict;
  /** One sentence for the review body. */
  reason: string;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export function decideVerdict(input: VerdictInput): VerdictResult {
  const threshold = input.threshold ?? THRESHOLD;
  const found = input.foundSeverities.filter((s) =>
    meetsThreshold(s, threshold),
  );
  const blocking = found.filter((s) => s === "critical" || s === "major");

  if (blocking.length > 0) {
    return {
      verdict: "REQUEST_CHANGES",
      reason: `${plural(blocking.length, "critical or major Finding", "critical or major Findings")} found.`,
    };
  }
  if (input.reviewersOk === 0) {
    return {
      verdict: "COMMENT",
      reason: "No Reviewer completed, so the change cannot be approved.",
    };
  }
  if (input.reviewersFailed > 0) {
    return {
      verdict: "COMMENT",
      reason: `${plural(input.reviewersFailed, "Reviewer", "Reviewers")} did not complete, so the change cannot be approved.`,
    };
  }
  if (found.length === 0) {
    return {
      verdict: "APPROVE",
      reason: `No Finding at or above ${threshold} severity.`,
    };
  }
  return {
    verdict: "COMMENT",
    reason: `${plural(found.length, "Finding", "Findings")} found, none critical or major.`,
  };
}
