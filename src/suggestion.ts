/**
 * Suggestions: an exact replacement for the lines a Finding concerns, which
 * GitHub lets the developer commit in one click. A Reviewer's `suggestion` is
 * carried through only when it can be one; otherwise it is dropped and the
 * Finding is posted as prose (its body and Fix prompt are unchanged).
 *
 * A `suggestion` is eligible when all of these hold:
 *
 *   - the Finding is anchored, and `line`..`endLine` (just `line` when there
 *     is no `endLine`) lie in a single hunk, so the replacement is one
 *     contiguous change to lines the pull request shows;
 *   - it is not empty (deleting lines is described in prose, not suggested);
 *   - it contains no ``` fence, which would end the suggestion block early;
 *   - it differs from the lines it replaces.
 *
 * One trailing newline and Windows line endings are normalised away.
 */

import { anchorFinding, type ChangedFile } from "./diff.ts";
import type { Finding } from "./finding.ts";

export type SuggestionCheck =
  { ok: true; suggestion: string } | { ok: false; reason: string };

/**
 * @returns The text to put in the suggestion block, or why the Finding's
 *   suggestion cannot be one.
 */
export function checkSuggestion(
  finding: Pick<Finding, "path" | "line" | "endLine" | "suggestion">,
  files: readonly ChangedFile[],
): SuggestionCheck {
  if (finding.suggestion === undefined) {
    return { ok: false, reason: "the Finding has no suggestion" };
  }
  const anchor = anchorFinding(finding, files);
  if (!anchor.anchored) {
    return {
      ok: false,
      reason: `the Finding is not anchored: ${anchor.reason}`,
    };
  }
  const suggestion = finding.suggestion
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "");
  if (suggestion.trim() === "") {
    return { ok: false, reason: "the suggestion is empty" };
  }
  if (suggestion.includes("```")) {
    return { ok: false, reason: "the suggestion contains a code fence" };
  }
  const first = finding.line!;
  const last = finding.endLine ?? first;
  const current = anchor.hunk.lines
    .filter((l) => l.line >= first && l.line <= last)
    .map((l) => l.text)
    .join("\n");
  if (current === suggestion) {
    return { ok: false, reason: "the suggestion equals the current lines" };
  }
  return { ok: true, suggestion };
}
