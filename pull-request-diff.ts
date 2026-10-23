/**
 * Getting the change of a pull request ready: fetch, merge-base, the diff
 * with the path filters applied, and the size limit. The worktree is created
 * and removed by `withWorktree`.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATH_FILTERS } from "./config.ts";
import type { PullRequest } from "./github.ts";
import { plural } from "./markdown.ts";

/** Runs `git <args>` in the repository and resolves with stdout. */
export type Git = (args: string[], cwd?: string) => Promise<string>;

const SHA = /^[0-9a-f]{40}$/;

/**
 * Fetches the base branch and the pull request's head (also works for a
 * branch from a fork) and checks the fetched head is the commit read from
 * GitHub. Nothing is written to the local branches or tags.
 */
export async function fetchPullRequest(
  git: Git,
  pr: PullRequest,
): Promise<void> {
  const headRef = `refs/remotes/origin/pull/${pr.number}/head`;
  await git([
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/heads/${pr.baseRef}:refs/remotes/origin/${pr.baseRef}`,
    `+refs/pull/${pr.number}/head:${headRef}`,
  ]);
  const fetchedSha = (
    await git(["rev-parse", "--verify", `${headRef}^{commit}`])
  ).trim();
  if (fetchedSha !== pr.headSha) {
    throw new Error(
      `The head of #${pr.number} is ${fetchedSha}, not ${pr.headSha}: the pull request was pushed to meanwhile, run again`,
    );
  }
}

/** @returns The commit where the head branched off the base branch. */
export async function findMergeBase(
  git: Git,
  pr: PullRequest,
): Promise<string> {
  const mergeBase = (
    await git(["merge-base", pr.headSha, `refs/remotes/origin/${pr.baseRef}`])
  ).trim();
  if (!SHA.test(mergeBase)) {
    throw new Error("Unexpected output from git while finding the merge-base");
  }
  return mergeBase;
}

export interface Worktree {
  /** Absolute path of the checkout of the head SHA. */
  dir: string;
}

/**
 * Checks the head SHA out into a fresh git worktree (detached, outside the
 * working tree) for the duration of `use`, and always removes it afterwards,
 * also when creating it or `use` fails.
 */
export async function withWorktree<T>(
  git: Git,
  headSha: string,
  use: (worktree: Worktree) => Promise<T>,
  tmpRoot: string = tmpdir(),
): Promise<T> {
  await mkdir(tmpRoot, { recursive: true });
  const parent = await mkdtemp(path.join(tmpRoot, "pr-review-"));
  const dir = path.join(parent, "head");
  try {
    await git(["worktree", "add", "--detach", dir, headSha]);
    return await use({ dir });
  } finally {
    await git(["worktree", "remove", "--force", dir]).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
    await git(["worktree", "prune"]).catch(() => undefined);
  }
}

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
}

export interface DiffSummary {
  /** Files that survived the path filters. */
  files: ChangedFile[];
  /** Added plus deleted lines of those files. */
  changedLines: number;
  /** Number of files the path filters left out. */
  ignoredFiles: number;
}

/** Whether a path is covered by the path filters. */
export function isIgnored(
  filePath: string,
  ignored: readonly string[] = PATH_FILTERS,
): boolean {
  return ignored.some((entry) =>
    entry.endsWith("/") ? filePath.startsWith(entry) : filePath === entry,
  );
}

/**
 * Parses `git diff --numstat -z -M` and applies the path filters. A renamed
 * file counts under its new path.
 */
export function summarizeNumstat(
  output: string,
  ignored: readonly string[] = PATH_FILTERS,
): DiffSummary {
  const tokens = output.split("\0");
  const files: ChangedFile[] = [];
  let ignoredFiles = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^([0-9]+|-)\t([0-9]+|-)\t(.*)$/s.exec(tokens[i]);
    if (!match) continue;
    let filePath = match[3];
    if (filePath === "") {
      // A rename: the old and the new path follow as separate entries.
      filePath = tokens[i + 2] ?? "";
      i += 2;
    }
    // Binary records have no line counts, so they are left out like the
    // filtered paths.
    if (match[1] === "-" || isIgnored(filePath, ignored)) {
      ignoredFiles += 1;
      continue;
    }
    files.push({
      path: filePath,
      added: Number(match[1]),
      deleted: Number(match[2]),
    });
  }
  return {
    files,
    changedLines: files.reduce((sum, f) => sum + f.added + f.deleted, 0),
    ignoredFiles,
  };
}

/**
 * The diff from the merge-base to the head SHA, filtered.
 * @param cwd The worktree of the head SHA.
 */
export async function diffPullRequest(
  git: Git,
  cwd: string,
  mergeBase: string,
  headSha: string,
): Promise<DiffSummary> {
  return summarizeNumstat(
    await git(["diff", "--numstat", "-z", "-M", mergeBase, headSha], cwd),
  );
}

/**
 * @throws When the filtered diff is bigger than `maxLines`. The diff is never
 *   cut down to fit.
 */
export function checkSize(summary: DiffSummary, maxLines: number): void {
  if (summary.changedLines > maxLines) {
    const files = plural(summary.files.length, "file", "files");
    throw new Error(
      `The filtered diff changes ${summary.changedLines} lines in ${files}, over the limit of ${maxLines} lines. Nothing is reviewed or truncated. Run again with --max-lines ${summary.changedLines} (or more) to review it anyway.`,
    );
  }
}
