/**
 * Anchoring: reads the diff of the pull request (merge-base to head, path
 * filters applied) and decides, for each Finding, whether it is an Anchored
 * finding or an Unanchored finding. The tool decides this, never a Reviewer.
 *
 * A Finding is anchored only when its `line` (and `endLine`, if any) lie in the
 * right-hand side (the head commit's version of the file) of ONE hunk of the
 * diff. That is what GitHub accepts for an inline comment: the added and the
 * unchanged lines shown in a hunk, and for a range, both ends in the same
 * hunk. Everything else is unanchored, which covers:
 *
 *   - a file the diff does not contain, or a line outside every hunk;
 *   - a range that starts in one hunk and ends in another;
 *   - a deleted file (nothing on the right side), a binary file, and a file
 *     with no hunks (a pure rename or a mode change);
 *   - a Finding with no `path`, or a `path` with no `line`.
 *
 * A renamed file is known by its new path (the one the head commit has, and
 * the one Reviewers are told to use).
 *
 * Pure: the caller runs `git` with {@link diffGitArgs} and passes the text.
 */

import { PATH_FILTERS } from "./config.ts";
import type { Finding } from "./finding.ts";
import { SAFE_REF } from "./reviewers.ts";

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  /** Line number in the head commit's version of the file. */
  line: number;
  text: string;
  /** Added by the pull request, or unchanged context around a change. */
  kind: "added" | "context";
}

export interface Hunk {
  /** First right-side line of the hunk (as in `+start,count`). */
  newStart: number;
  newLines: number;
  oldStart: number;
  oldLines: number;
  /** The right-side lines of the hunk, in order. Removed lines are not here. */
  lines: DiffLine[];
}

export interface ChangedFile {
  /** Path in the head commit; for a deleted file, the path it had. */
  path: string;
  /** Path before the change, for a renamed file. */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  /** Lines added and removed, for the walkthrough. */
  additions: number;
  deletions: number;
}

/**
 * @returns The arguments to give `git` (run in the worktree) for the diff
 *   {@link parseDiff} reads: merge-base of `base` and HEAD to HEAD, path
 *   filters excluded, with fixed prefixes and no user diff configuration.
 */
export function diffGitArgs(base: string): string[] {
  if (!SAFE_REF.test(base)) throw new Error(`unsafe base ref: ${base}`);
  return [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${base}...HEAD`,
    "--",
    ".",
    ...PATH_FILTERS.map((p) => `:(exclude)${p}`),
  ];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Decodes the C-style quoting git uses for unusual paths. */
function unquote(text: string): string {
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) {
    return text;
  }
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
    '"': 34,
    "\\": 92,
  };
  const inner = text.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(inner.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (inner[i + 1] in simple) {
      bytes.push(simple[inner[i + 1]]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A path from a `---` / `+++` line: no prefix, no timestamp, or null. */
function headerPath(text: string): string | null {
  const raw = text.split("\t")[0];
  if (raw === "/dev/null") return null;
  return unquote(raw).replace(/^[ab]\//, "");
}

/**
 * Path of a file that has no `---` / `+++` lines (mode change, binary file),
 * from `diff --git a/P b/P`. Renames are read from `rename from/to` instead.
 */
function pathFromGitHeader(rest: string): string {
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0) {
    const left = rest.slice(2, 2 + half);
    if (rest.slice(2 + half) === ` b/${left}`) return left;
  }
  const match = /^(?:"a\/.*?"|a\/.*?) ("b\/.*"|b\/.*)$/.exec(rest);
  return match ? (headerPath(match[1]) ?? rest) : rest;
}

/**
 * Reads a unified diff as `git diff` prints it (see {@link diffGitArgs}).
 *
 * @returns One entry per changed file, in diff order. Never throws; text that
 *   is not a diff gives an empty list.
 */
export function parseDiff(diff: string): ChangedFile[] {
  const lines = diff.split("\n");
  const files: ChangedFile[] = [];
  let file: ChangedFile | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;

  /** Closes the file in progress: settles its path and status. */
  const closeFile = () => {
    if (!file) return;
    if (renameTo !== undefined && renameFrom !== undefined) {
      file.path = renameTo;
      file.oldPath = renameFrom;
      file.status = "renamed";
    }
    files.push(file);
    file = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];

    if (text.startsWith("diff --git ")) {
      closeFile();
      renameFrom = undefined;
      renameTo = undefined;
      file = {
        path: pathFromGitHeader(text.slice("diff --git ".length)),
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!file) continue;

    if (text.startsWith("new file mode")) file.status = "added";
    else if (text.startsWith("deleted file mode")) file.status = "deleted";
    else if (text.startsWith("rename from ")) {
      renameFrom = unquote(text.slice("rename from ".length));
    } else if (text.startsWith("rename to ")) {
      renameTo = unquote(text.slice("rename to ".length));
    } else if (
      text.startsWith("Binary files ") ||
      text.startsWith("GIT binary patch")
    ) {
      file.binary = true;
    } else if (text.startsWith("+++ ") && file.hunks.length === 0) {
      const target = headerPath(text.slice(4));
      if (target !== null) file.path = target;
    } else if (text.startsWith("--- ") && file.hunks.length === 0) {
      const source = headerPath(text.slice(4));
      // A deleted file only names its path on the `---` line.
      if (source !== null && file.status === "deleted") file.path = source;
    } else {
      const header = HUNK_HEADER.exec(text);
      if (!header) continue;
      const hunk: Hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      // Count-driven, so a removed line that looks like `--- x` is not
      // mistaken for a header.
      let oldLeft = hunk.oldLines;
      let newLeft = hunk.newLines;
      let right = hunk.newStart;
      while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
        const body = lines[i + 1];
        const mark = body[0];
        if (mark === "+") {
          hunk.lines.push({
            line: right++,
            text: body.slice(1),
            kind: "added",
          });
          newLeft--;
          file.additions++;
        } else if (mark === "-") {
          oldLeft--;
          file.deletions++;
        } else if (mark === " " || body === "") {
          hunk.lines.push({
            line: right++,
            text: body.slice(1),
            kind: "context",
          });
          oldLeft--;
          newLeft--;
        } else if (mark !== "\\") {
          break;
        }
        i++;
      }
      file.hunks.push(hunk);
    }
  }
  closeFile();
  return files;
}

export type Anchor =
  | { anchored: true; file: ChangedFile; hunk: Hunk }
  | { anchored: false; reason: string };

/** Removes the leading `./` a Reviewer may write. */
function normalisePath(path: string): string {
  return path.replace(/^\.\//, "");
}

/**
 * @returns The file and hunk a Finding's lines fall in, or why it has none.
 */
export function anchorFinding(
  finding: Pick<Finding, "path" | "line" | "endLine">,
  files: readonly ChangedFile[],
): Anchor {
  if (finding.path === undefined) {
    return { anchored: false, reason: "it concerns the change as a whole" };
  }
  if (finding.line === undefined) {
    return { anchored: false, reason: "it names a file but no line" };
  }
  const wanted = normalisePath(finding.path);
  const file = files.find((f) => f.path === wanted);
  if (!file) {
    return { anchored: false, reason: "the file is not in the diff" };
  }
  if (file.status === "deleted") {
    return { anchored: false, reason: "the file is deleted" };
  }
  if (file.binary) {
    return { anchored: false, reason: "the file is binary" };
  }
  if (file.hunks.length === 0) {
    return { anchored: false, reason: "the file has no changed lines" };
  }
  const first = finding.line;
  const last = finding.endLine ?? finding.line;
  const hunk = file.hunks.find(
    (h) =>
      h.lines.length > 0 &&
      first >= h.lines[0].line &&
      last <= h.lines[h.lines.length - 1].line,
  );
  if (!hunk) {
    return {
      anchored: false,
      reason: "the lines are not inside one changed hunk",
    };
  }
  return { anchored: true, file, hunk };
}
