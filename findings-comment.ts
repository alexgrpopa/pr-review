/**
 * The Findings comment: the one sticky pull request comment of a Review run,
 * found by a hidden marker and edited in place, never duplicated. It reports
 * the Unanchored findings and anything the run could not do (Reviewers that
 * failed, Findings over the cap, an Aggregator that failed, inline comments
 * GitHub rejected), and holds one collapsed Fix prompt for the Findings the
 * run posted.
 *
 * Earlier runs' contents are carried over, because the next run skips a
 * Finding whose Fingerprint is already on the pull request, and a Finding that
 * was dropped from this comment would be posted again:
 *
 *   - Each Finding is an entry between `pr-review:entry` markers that holds
 *     its Fingerprint markers. Entries found in the previous comment are kept,
 *     the run's new ones follow. Nothing is resolved or removed (the whole
 *     pull request is reviewed again on every run and stale entries stay).
 *   - The Fix prompt block is replaced when the run posted Findings, and kept
 *     when it posted none.
 *   - Everything else is written afresh from this run.
 *
 * Too long for GitHub: the Fix prompt is dropped first, then entries from the
 * end (their Fingerprint markers stay, so they are still not posted again),
 * each with a visible note.
 */

import {
  type AggregatorStatus,
  type AnchoredFinding,
  type ReviewerSummary,
  type UnanchoredFinding,
} from "./aggregate.ts";
import { MAX_FINDINGS } from "./config.ts";
import { extractFingerprints, fingerprintMarkers } from "./fingerprint.ts";
import { locationOf } from "./fix-prompt.ts";
import {
  GITHUB_BODY_LIMIT,
  fence,
  inlineCode,
  neutralise,
  plural,
  truncate,
} from "./markdown.ts";
import type { Verdict } from "./verdict.ts";

export const FINDINGS_MARKER = "<!-- pr-review:findings -->";
const ENTRY_START = "<!-- pr-review:entry -->";
const ENTRY_END = "<!-- /pr-review:entry -->";
const FIX_START = "<!-- pr-review:fix-prompt -->";
const FIX_END = "<!-- /pr-review:fix-prompt -->";

const ENTRY_PATTERN = new RegExp(`${ENTRY_START}[\\s\\S]*?${ENTRY_END}`, "g");
const FIX_PATTERN = new RegExp(`${FIX_START}[\\s\\S]*?${FIX_END}`);

/** An Anchored finding whose inline comment GitHub rejected. */
export interface FellBackFinding {
  finding: AnchoredFinding;
  /** What GitHub said. */
  reason: string;
}

export interface FindingsCommentInput {
  headSha: string;
  verdict: Verdict;
  verdictReason: string;
  /** Posted by this run, in the comment. */
  unanchored: readonly UnanchoredFinding[];
  /** Posted by this run, and reported here because the inline comment failed. */
  fellBack: readonly FellBackFinding[];
  reviewers: readonly ReviewerSummary[];
  aggregator: AggregatorStatus;
  /** Findings over the cap, not posted. */
  leftOut: number;
  combinedFixPrompt: string | null;
  /** Body of the comment this one replaces, from an earlier run. */
  previous?: string | null;
}

function entryText(
  finding: AnchoredFinding | UnanchoredFinding,
  why: string,
): string {
  const lines = [
    ENTRY_START,
    fingerprintMarkers(finding.fingerprints),
    `#### ${finding.severity} · ${neutralise(finding.title.trim())}`,
    `${inlineCode(neutralise(locationOf(finding)))} · ${neutralise(why)}`,
    neutralise(finding.body.trim()),
  ];
  if (finding.suggestion !== undefined) {
    lines.push("Suggested replacement:", fence(finding.suggestion));
  }
  lines.push(ENTRY_END);
  return lines.join("\n\n");
}

function newEntries(input: FindingsCommentInput): string[] {
  return [
    ...input.unanchored.map((f) =>
      entryText(f, `Not on a changed line: ${f.unanchoredReason}.`),
    ),
    ...input.fellBack.map(({ finding, reason }) =>
      entryText(
        finding,
        `GitHub rejected the inline comment (${reason}), so it is reported here.`,
      ),
    ),
  ];
}

/** @returns The entries of an earlier Findings comment, in order. */
function earlierEntries(previous: string | null | undefined): string[] {
  return previous?.match(ENTRY_PATTERN) ?? [];
}

function couldNotDo(input: FindingsCommentInput): string[] {
  const lines: string[] = [];
  for (const reviewer of input.reviewers) {
    if (reviewer.status === "failed") {
      lines.push(
        `- The ${neutralise(reviewer.reviewer)} Reviewer did not run (${reviewer.reason}${reviewer.detail ? `: ${neutralise(truncate(reviewer.detail, 300, "…"))}` : ""}). Nothing was checked in that category.`,
      );
    }
  }
  if (input.aggregator.status === "failed") {
    lines.push(
      `- The Aggregator did not run (${input.aggregator.reason}). The summary is a fallback line, the walkthrough comes from the diff, and Findings were merged only when identical.`,
    );
  }
  if (input.leftOut > 0) {
    lines.push(
      `- ${plural(input.leftOut, "Finding was", "Findings were")} left out because a run posts at most ${MAX_FINDINGS}. The most serious came first; run again after resolving these to see the rest.`,
    );
  }
  if (input.fellBack.length > 0) {
    lines.push(
      `- ${plural(input.fellBack.length, "inline comment", "inline comments")} could not be posted on a line and ${input.fellBack.length === 1 ? "is" : "are"} listed above instead.`,
    );
  }
  return lines;
}

function fixPromptBlock(prompt: string): string {
  return [
    FIX_START,
    "<details>",
    "<summary>Fix prompt for all posted Findings</summary>",
    fence(neutralise(prompt)),
    "</details>",
    FIX_END,
  ].join("\n\n");
}

/**
 * @param maxLength Longest comment allowed, in characters.
 */
export function renderFindingsComment(
  input: FindingsCommentInput,
  maxLength: number = GITHUB_BODY_LIMIT,
): string {
  const entries = [
    ...new Set([...earlierEntries(input.previous), ...newEntries(input)]),
  ];
  const fixBlock =
    input.combinedFixPrompt !== null
      ? fixPromptBlock(input.combinedFixPrompt)
      : (input.previous?.match(FIX_PATTERN)?.[0] ?? null);

  const todo = couldNotDo(input);
  const head = [
    FINDINGS_MARKER,
    "## Review findings",
    `Last review run on ${inlineCode(input.headSha.slice(0, 7))}. Verdict: **${input.verdict}**. ${neutralise(input.verdictReason)}`,
    "### Unanchored findings",
  ];
  const report = [
    "### Not done in this run",
    todo.length > 0
      ? todo.join("\n")
      : "Nothing: every step of the run worked.",
  ];
  // Fingerprints that an earlier run kept only as markers (see droppedNote)
  // stay as markers, so they are still not posted again.
  const inEntries = extractFingerprints(entries);
  const orphans = [...extractFingerprints([input.previous ?? ""])].filter(
    (fp) => !inEntries.has(fp),
  );

  const build = (
    shown: readonly string[],
    dropped: readonly string[],
    withFix: boolean,
  ): string => {
    const hidden = [...orphans, ...extractFingerprints(dropped)];
    return [
      ...head,
      shown.length > 0 ? shown.join("\n\n") : dropped.length > 0 ? "" : "None.",
      ...(dropped.length > 0
        ? [
            `_${plural(dropped.length, "more Finding is", "more Findings are")} not shown: the comment would pass GitHub's size limit. They were posted before and are not posted again._`,
          ]
        : []),
      ...report,
      ...(fixBlock && withFix
        ? [fixBlock]
        : fixBlock
          ? [
              "_The Fix prompt for all posted Findings is not shown: the comment would pass GitHub's size limit. Each inline comment has its own._",
            ]
          : []),
      ...(hidden.length > 0 ? [fingerprintMarkers(hidden)] : []),
    ]
      .filter((part) => part !== "")
      .join("\n\n");
  };

  const everything = build(entries, [], true);
  if (everything.length <= maxLength) return everything;

  // Drop the Fix prompt first, then entries from the end.
  for (let keep = entries.length; keep >= 0; keep--) {
    const text = build(entries.slice(0, keep), entries.slice(keep), false);
    if (text.length <= maxLength) return text;
  }
  return truncate(
    build([], entries, false),
    maxLength,
    "\n\n_(cut: size limit)_",
  );
}
