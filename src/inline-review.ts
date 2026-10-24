/**
 * The Inline review: how an Anchored finding becomes a comment of the one
 * GitHub review a Review run submits, and what the review body says.
 *
 * A comment shows the Severity and title, the body, the Suggestion block when
 * the Finding has one (an exact single-hunk replacement, already checked by
 * suggestion.ts), a collapsed "Prompt for AI agents" section with the
 * Finding's Fix prompt, and the hidden Fingerprint marker the next run reads
 * back to skip it.
 */

import type { AnchoredFinding } from "./aggregate.ts";
import { fence, neutralise, plural } from "./markdown.ts";
import type { Verdict } from "./verdict.ts";

/** A comment as the review API takes it. */
export interface ReviewComment {
  path: string;
  /** Last line of the comment's range, or the only line. */
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

/** @returns The Markdown of one inline comment. */
export function renderInlineComment(finding: AnchoredFinding): string {
  const parts = [
    `**${finding.severity}** · ${neutralise(finding.title.trim())}`,
    neutralise(finding.body.trim()),
  ];
  if (finding.suggestion !== undefined) {
    parts.push(`\`\`\`suggestion\n${finding.suggestion}\n\`\`\``);
  }
  parts.push(
    [
      "<details>",
      "<summary>Prompt for AI agents</summary>",
      "",
      fence(neutralise(finding.fixPrompt.trim())),
      "",
      "</details>",
    ].join("\n"),
    finding.marker,
  );
  return parts.join("\n\n");
}

/** @returns The comment, on the right side of the diff, with its range. */
export function toReviewComment(finding: AnchoredFinding): ReviewComment {
  const last = finding.endLine ?? finding.line;
  const comment: ReviewComment = {
    path: finding.path,
    line: last,
    side: "RIGHT",
    body: renderInlineComment(finding),
  };
  if (last !== finding.line) {
    comment.start_line = finding.line;
    comment.start_side = "RIGHT";
  }
  return comment;
}

const VERDICT_TITLE: Record<Verdict, string> = {
  REQUEST_CHANGES: "Changes requested",
  APPROVE: "Approved",
  COMMENT: "Comments",
};

/** @returns The text of the review itself, above its comments. */
export function renderReviewBody(options: {
  verdict: Verdict;
  verdictReason: string;
  /** Comments the review carries. */
  comments: number;
  /** Comments GitHub rejected, left for the Findings comment. */
  fellBack?: number;
}): string {
  const lines = [
    `**${VERDICT_TITLE[options.verdict]}.** ${neutralise(options.verdictReason)}`,
  ];
  if (options.comments > 0) {
    lines.push(
      `${plural(options.comments, "new inline comment", "new inline comments")} below. The Findings comment lists everything that has no line to attach to.`,
    );
  }
  if (options.fellBack) {
    lines.push(
      `${plural(options.fellBack, "inline comment", "inline comments")} could not be placed on a line and ${options.fellBack === 1 ? "is" : "are"} in the Findings comment instead.`,
    );
  }
  return lines.join("\n\n");
}
