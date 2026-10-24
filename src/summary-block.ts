/**
 * The Summary block: the section of the pull request description, between two
 * hidden markers, that every Review run rewrites. It holds a short summary of
 * the change, a walkthrough table (file | what changed) and the status of each
 * Reviewer (ran, or did not run and why, with counts by Severity).
 *
 * Text outside the markers is never touched. When the markers are absent the
 * block is appended. When the description would pass GitHub's size limit, the
 * walkthrough loses rows (and then the summary loses its tail), each with a
 * visible note: the text outside the markers is what has to survive.
 */

import type { ReviewerSummary } from "./aggregate.ts";
import type { WalkthroughEntry } from "./aggregator.ts";
import { SEVERITIES } from "./finding.ts";
import {
  GITHUB_BODY_LIMIT,
  cell,
  inlineCode,
  neutralise,
  plural,
  truncate,
} from "./markdown.ts";

export const SUMMARY_START = "<!-- pr-review:start -->";
export const SUMMARY_END = "<!-- pr-review:end -->";

export interface SummaryBlockInput {
  /** Markdown from the Aggregator, or the fallback line. */
  summary: string;
  walkthrough: readonly WalkthroughEntry[];
  reviewers: readonly ReviewerSummary[];
  headSha: string;
}

/** Longest reason of a failed Reviewer quoted in the table. */
const REASON_LENGTH = 160;

function reviewerRow(reviewer: ReviewerSummary): string {
  if (reviewer.status === "failed") {
    const why = reviewer.detail
      ? `${reviewer.reason}: ${reviewer.detail}`
      : String(reviewer.reason);
    const dashes = SEVERITIES.map(() => "–").join(" | ");
    return `| ${cell(reviewer.reviewer)} | did not run (${cell(truncate(why, REASON_LENGTH, "…"))}) | ${dashes} |`;
  }
  const counts = SEVERITIES.map((s) => reviewer.kept[s]).join(" | ");
  return `| ${cell(reviewer.reviewer)} | ran | ${counts} |`;
}

function reviewerTable(reviewers: readonly ReviewerSummary[]): string {
  const titles = SEVERITIES.map((s) => s[0].toUpperCase() + s.slice(1));
  return [
    `| Reviewer | Status | ${titles.join(" | ")} |`,
    `| --- | --- | ${SEVERITIES.map(() => "---:").join(" | ")} |`,
    ...reviewers.map(reviewerRow),
  ].join("\n");
}

function walkthroughRow(entry: WalkthroughEntry): string {
  return `| ${inlineCode(neutralise(entry.path))} | ${cell(entry.change)} |`;
}

/** @returns The walkthrough heading, table and note; none when it is empty. */
function walkthroughSection(
  rows: readonly string[],
  omitted: number,
): string[] {
  if (rows.length === 0 && omitted === 0) return [];
  const section = [
    "### Walkthrough",
    ["| File | What changed |", "| --- | --- |", ...rows].join("\n"),
  ];
  if (omitted > 0) {
    section.push(
      `_${plural(omitted, "more file", "more files")} not shown: the description would pass GitHub's size limit._`,
    );
  }
  return section;
}

function assemble(
  input: SummaryBlockInput,
  summary: string,
  rows: readonly string[],
  omitted: number,
): string {
  const sections = [
    SUMMARY_START,
    "## PR review",
    summary,
    ...walkthroughSection(rows, omitted),
    "### Reviewers",
    reviewerTable(input.reviewers),
    `<sub>Reviewed \`${input.headSha.slice(0, 7)}\`. Everything between the markers is rewritten on every review run.</sub>`,
    SUMMARY_END,
  ];
  return sections.join("\n\n");
}

/** Room kept for a longer "N more files" note than the one measured. */
const NOTE_SLACK = 20;

const SUMMARY_CUT_NOTE = "… (summary cut: it would pass GitHub's size limit)";

/**
 * @param maxLength Longest block allowed, in characters.
 * @throws When even a block without walkthrough and summary does not fit.
 */
export function renderSummaryBlock(
  input: SummaryBlockInput,
  maxLength: number = GITHUB_BODY_LIMIT,
): string {
  const summary = neutralise(input.summary.trim());
  const rows = input.walkthrough.map(walkthroughRow);

  const full = assemble(input, summary, rows, 0);
  if (full.length <= maxLength) return full;

  // Too long: the summary keeps its place, the walkthrough gives up rows, and
  // only when the summary alone does not fit is it cut.
  const bare = assemble(input, "", [], 1).length + NOTE_SLACK;
  let room = maxLength - bare;
  if (room < SUMMARY_CUT_NOTE.length) {
    throw new Error(
      `the pull request description leaves ${Math.max(0, maxLength)} characters for the Summary block, which is too little`,
    );
  }
  if (summary.length > room) {
    return assemble(
      input,
      truncate(summary, room, SUMMARY_CUT_NOTE),
      [],
      rows.length,
    );
  }
  room -= summary.length;
  const kept: string[] = [];
  for (const row of rows) {
    // Each row costs its own length and a newline.
    if (row.length + 1 > room) break;
    kept.push(row);
    room -= row.length + 1;
  }
  return assemble(input, summary, kept, rows.length - kept.length);
}

/**
 * @returns Where the Summary block is in a description: from the start of its
 *   first marker to the end of its last, or null when there is none. The block
 *   is found from the last end marker backwards, so a stray start marker in
 *   the description's own text is left alone.
 */
export function findSummaryBlock(
  body: string,
): { start: number; end: number } | null {
  const closing = body.lastIndexOf(SUMMARY_END);
  const start = closing === -1 ? -1 : body.lastIndexOf(SUMMARY_START, closing);
  return start === -1 ? null : { start, end: closing + SUMMARY_END.length };
}

/**
 * @returns The description with its Summary block replaced, or appended when
 *   the markers are absent. Never changes a character outside the markers.
 * @throws When the description has no room for the block.
 */
export function applySummaryBlock(
  body: string,
  input: SummaryBlockInput,
): string {
  const found = findSummaryBlock(body);
  if (found) {
    const before = body.slice(0, found.start);
    const after = body.slice(found.end);
    const block = renderSummaryBlock(
      input,
      GITHUB_BODY_LIMIT - before.length - after.length,
    );
    return `${before}${block}${after}`;
  }
  const lead = body.trim() === "" ? "" : `${body.trimEnd()}\n\n`;
  return `${lead}${renderSummaryBlock(input, GITHUB_BODY_LIMIT - lead.length)}`;
}
