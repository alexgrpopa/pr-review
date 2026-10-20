/**
 * Fix prompts: a self-contained instruction a developer can paste into a
 * coding agent, one per Finding and one combined for every posted Finding.
 *
 * A Finding's own `fixPrompt` is used only when it is self-contained:
 *
 *   - it is not empty;
 *   - when the Finding has a `path`, the prompt contains that path;
 *   - it never refers to something the agent cannot see ("the comment above",
 *     "this finding", "as mentioned above").
 *
 * Otherwise the prompt is built from the Finding: where, what is wrong and,
 * when there is one, the exact replacement.
 */

import type { Finding } from "./finding.ts";

type Located = Pick<
  Finding,
  "path" | "line" | "endLine" | "title" | "body" | "fixPrompt"
>;

/** Phrases that only make sense next to the comment the prompt came from. */
const DANGLING_REFERENCE =
  /\b(?:comment|finding|thread)\s+(?:above|below)\b|\bthis\s+(?:comment|finding)\b|\b(?:above|previous|preceding)\s+(?:comment|finding)\b|\b(?:mentioned|described|noted|discussed|stated)\s+(?:above|earlier|before)\b|\bsee\s+(?:above|below)\b/i;

export type FixPromptCheck = { ok: true } | { ok: false; reason: string };

/** @returns Whether a Finding's `fixPrompt` stands on its own. */
export function checkFixPrompt(
  finding: Pick<Finding, "path" | "fixPrompt">,
): FixPromptCheck {
  const prompt = finding.fixPrompt?.trim() ?? "";
  if (prompt === "") return { ok: false, reason: "the Fix prompt is empty" };
  if (finding.path !== undefined && !prompt.includes(finding.path)) {
    return {
      ok: false,
      reason: `the Fix prompt does not contain the path ${finding.path}`,
    };
  }
  const reference = DANGLING_REFERENCE.exec(prompt);
  if (reference) {
    return {
      ok: false,
      reason: `the Fix prompt refers to "${reference[0]}"`,
    };
  }
  return { ok: true };
}

/** @returns `path:line`, `path:line-endLine`, `path` or "the change". */
export function locationOf(
  finding: Pick<Finding, "path" | "line" | "endLine">,
): string {
  if (finding.path === undefined) return "the change as a whole";
  if (finding.line === undefined) return finding.path;
  return finding.endLine !== undefined && finding.endLine !== finding.line
    ? `${finding.path}:${finding.line}-${finding.endLine}`
    : `${finding.path}:${finding.line}`;
}

/**
 * @returns A Fix prompt built from the Finding. `suggestion` is the exact
 *   replacement, when the Finding has an eligible one.
 */
export function buildFixPrompt(
  finding: Pick<Finding, "path" | "line" | "endLine" | "title" | "body">,
  suggestion?: string,
): string {
  const where =
    finding.path === undefined
      ? "In this repository, concerning the whole change"
      : `In ${locationOf(finding)}`;
  const parts = [`${where}: ${finding.title.trim()}`, "", finding.body.trim()];
  if (suggestion !== undefined) {
    const span =
      finding.endLine !== undefined && finding.endLine !== finding.line
        ? `lines ${finding.line} to ${finding.endLine}`
        : `line ${finding.line}`;
    parts.push(
      "",
      `Replace ${span} of ${finding.path} with exactly:`,
      "",
      "~~~",
      suggestion,
      "~~~",
    );
  }
  parts.push(
    "",
    "Make the smallest change that resolves this, and nothing else.",
  );
  return parts.join("\n");
}

/**
 * @returns The Fix prompt to attach to a Finding: its own when it is
 *   self-contained, otherwise one built from the Finding.
 */
export function fixPromptFor(finding: Located, suggestion?: string): string {
  return checkFixPrompt(finding).ok
    ? finding.fixPrompt.trim()
    : buildFixPrompt(finding, suggestion);
}

/**
 * @returns One prompt for all the Findings, in the order given, ready to paste
 *   into a coding agent; null when there are none. Each part is already
 *   self-contained, so they are numbered and joined.
 */
export function combineFixPrompts(
  findings: readonly (Pick<Finding, "severity" | "title"> & {
    path?: string;
    line?: number;
    endLine?: number;
    fixPrompt: string;
  })[],
): string | null {
  if (findings.length === 0) return null;
  const count = findings.length === 1 ? "1 issue" : `${findings.length} issues`;
  const sections = findings.map(
    (f, i) =>
      `## ${i + 1}. [${f.severity}] ${f.title.trim()} (${locationOf(f)})\n\n${f.fixPrompt.trim()}`,
  );
  return [
    `Resolve the following ${count} found in a review of this repository. They are independent: handle each one on its own, in order, and keep every change minimal. Run the project's tests and linters when you are done.`,
    ...sections,
  ].join("\n\n");
}
