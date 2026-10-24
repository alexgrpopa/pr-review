/**
 * Merging Findings that describe the same issue. A merged Finding keeps every
 * Fingerprint of the Findings it absorbed, so it counts as already posted when
 * any of them was, and its comment carries all of their markers. Whichever
 * Reviewer's category the Aggregator picks as the primary, the next run still
 * recognises it.
 */

import type { Finding } from "./finding.ts";
import { fingerprint } from "./fingerprint.ts";
import { compareFindings } from "./selection.ts";

export interface Candidate extends Finding {
  /** Fingerprint of this Finding (the primary one when merged). */
  fingerprint: string;
  /** Every Fingerprint merged into it, `fingerprint` first. */
  fingerprints: string[];
  /** Every Reviewer that reported it, sorted. */
  reviewers: string[];
}

/** Wraps a Finding with its Fingerprint. */
export function toCandidate(finding: Finding): Candidate {
  const fp = fingerprint(finding);
  return {
    ...finding,
    fingerprint: fp,
    fingerprints: [fp],
    reviewers: [finding.reviewer],
  };
}

/**
 * Merges Candidates into one. The primary is the most serious (ties: higher
 * confidence, then the posting order of compareFindings); the others only add
 * their Fingerprints and Reviewers, and the highest confidence is kept.
 *
 * @throws When the list is empty.
 */
export function mergeCandidates(group: readonly Candidate[]): Candidate {
  if (group.length === 0) throw new Error("cannot merge an empty group");
  const [primary, ...others] = [...group].sort(compareFindings);
  const fingerprints = [primary.fingerprint];
  const reviewers = new Set(primary.reviewers);
  let confidence = primary.confidence;
  for (const other of others) {
    for (const fp of other.fingerprints) {
      if (!fingerprints.includes(fp)) fingerprints.push(fp);
    }
    other.reviewers.forEach((r) => reviewers.add(r));
    confidence = Math.max(confidence, other.confidence);
  }
  return {
    ...primary,
    confidence,
    fingerprints,
    reviewers: [...reviewers].sort(),
  };
}

/**
 * Merges Findings with identical Fingerprints (same path, Reviewer and
 * normalised title). This is all the fallback does when the Aggregator fails.
 *
 * @returns One Candidate per Fingerprint, in order of first appearance.
 */
export function mergeIdentical(findings: readonly Finding[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const finding of findings) {
    const candidate = toCandidate(finding);
    const group = groups.get(candidate.fingerprint);
    if (group) group.push(candidate);
    else groups.set(candidate.fingerprint, [candidate]);
  }
  return [...groups.values()].map(mergeCandidates);
}

/**
 * Merges the groups of indexes the Aggregator reported. A merged Candidate
 * takes the place of the first member of its group; indexes in no group are
 * kept as they are. The groups must already be valid (see
 * validateAggregatorOutput).
 */
export function mergeGroups(
  candidates: readonly Candidate[],
  groups: readonly (readonly number[])[],
): Candidate[] {
  const groupOf = new Map<number, readonly number[]>();
  for (const group of groups) {
    for (const index of group) groupOf.set(index, group);
  }
  const result: Candidate[] = [];
  const done = new Set<readonly number[]>();
  candidates.forEach((candidate, index) => {
    const group = groupOf.get(index);
    if (!group) {
      result.push(candidate);
    } else if (!done.has(group)) {
      done.add(group);
      result.push(mergeCandidates(group.map((i) => candidates[i])));
    }
  });
  return result;
}
