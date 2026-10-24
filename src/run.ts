/**
 * Review runner: `pr-review`, a Review run for a pull request, on the
 * developer's machine. It prepares the change (pull request, merge-base,
 * worktree of the head SHA, diff, size check, token) and hands it to the
 * review step (pipeline.ts): Reviewers, aggregation and posting.
 *
 * CLI:
 *
 *   pr-review [--pr <number>] [--max-lines <number>] [--dry-run]
 *
 *   - The pull request is the open one of the current branch (looked up with
 *     `gh`, as the developer), or `--pr <number>`. Its base branch and head
 *     SHA come from GitHub. The pushed head SHA is reviewed, never the working
 *     tree.
 *   - `--max-lines` raises the size limit (default 3000 changed lines, added
 *     plus deleted, after the path filters in config.ts). A bigger change
 *     stops the run; it is never truncated.
 *   - `--dry-run` runs the Reviewers and the aggregation and prints everything
 *     that would be posted (the Summary block, the Findings comment, each
 *     inline comment with its path and line, the Verdict). It makes no write
 *     and mints no token: it neither reads the credentials nor calls the
 *     GitHub App endpoints, and reads the pull request with the developer's
 *     `gh` login.
 *
 * Steps of a run, each named in the failure message: Resolve PR, Credentials
 * (not on a dry run), Fetch, Merge-base, Worktree, Diff, Size check, Token
 * (not on a dry run) and Review, which names its own stages (Read pull
 * request, Reviewers, Read diff, Aggregation, Plan, Summary block, Findings
 * comment, Inline review). The worktree of the head SHA is removed afterwards,
 * also when a step fails.
 *
 * Credentials: PR_REVIEW_APP_ID and PR_REVIEW_APP_PRIVATE_KEY are read from
 * `.env.local` (credentials.ts) only on a real run. A real run mints the
 * one-hour installation token late, after the change is prepared and the size
 * limit passed, so that a run that stops early never asks GitHub for a token,
 * and mints it once. The token lives in memory:
 * it is never stored or logged, child processes (`git`, `gh`) get a scrubbed
 * environment, and every message is redacted of the key and the token before
 * it is shown.
 */

import path from "node:path";
import { parseCliArgs, USAGE } from "./args.ts";
import { readCredentials, secretsOf, type Credentials } from "./credentials.ts";
import {
  checkSize,
  diffPullRequest,
  fetchPullRequest,
  findMergeBase,
  withWorktree,
  type DiffSummary,
  type Git,
} from "./pull-request-diff.ts";
import { defaultExec, errorMessage, StepError, type Exec } from "./exec.ts";
import {
  createGitHubClient,
  resolvePullRequest,
  type GitHubClient,
  type PullRequest,
} from "./github.ts";
import { createReviewStep } from "./pipeline.ts";
import { mintToken } from "./token.ts";

export interface RunOptions {
  /** The pull request number; undefined means the current branch's. */
  pr?: number;
  /** The current branch, empty when HEAD is detached. */
  branch: string;
  dryRun: boolean;
  maxLines: number;
  /** `.env.local` candidates, the first that exists is read. */
  credentialFiles: string[];
}

/** What a Review run has prepared, handed to the Reviewers. */
export interface PreparedReview {
  pr: PullRequest;
  mergeBase: string;
  diff: DiffSummary;
  /** Absolute path of the worktree of the head SHA; removed after the run. */
  worktree: string;
  /** Installation token of the Review bot; null on a dry run, which posts nothing. */
  token: string | null;
}

export interface RunDeps {
  git: Git;
  client: GitHubClient;
  log: (message: string) => void;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Where worktrees are created. Default: the OS temp folder. */
  tmpRoot?: string;
  /** Runs the Reviewers, aggregates and posts (see pipeline.ts). */
  review?: (prepared: PreparedReview) => Promise<void>;
}

export type Outcome =
  | { kind: "reviewed"; pr: number; files: number; changedLines: number }
  | { kind: "dry-run"; pr: number; files: number; changedLines: number }
  | { kind: "empty"; pr: number };

/** Replaces each secret in a message. */
export function redact(message: string, secrets: string[]): string {
  let out = message;
  // Longest first, so a whole key goes before its lines.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function describeDiff(summary: DiffSummary): string[] {
  return summary.files.map(
    (file) => `  ${file.path}  +${file.added} -${file.deleted}`,
  );
}

/**
 * Runs a Review run for a pull request.
 * @throws A `StepError` (message: the step, then the reason) when a step
 *   fails. Its message never holds the private key or the token.
 */
export async function runReview(
  options: RunOptions,
  deps: RunDeps,
): Promise<Outcome> {
  const { log } = deps;
  const secrets: string[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      // A step that names its own stages keeps its name.
      throw error instanceof StepError ? error : new StepError(name, error);
    }
  };

  try {
    const pr = await step("Resolve PR", () =>
      resolvePullRequest(deps.client, {
        number: options.pr,
        branch: options.branch,
      }),
    );
    log(`Pull request #${pr.number}: ${pr.title}`);

    let credentials: Credentials | null = null;
    if (!options.dryRun) {
      credentials = await step("Credentials", async () =>
        readCredentials(options.credentialFiles),
      );
      secrets.push(...secretsOf(credentials));
    }

    await step("Fetch", () => fetchPullRequest(deps.git, pr));
    const mergeBase = await step("Merge-base", () =>
      findMergeBase(deps.git, pr),
    );

    try {
      return await withWorktree(
        deps.git,
        pr.headSha,
        async ({ dir }) => {
          const diff = await step("Diff", () =>
            diffPullRequest(deps.git, dir, mergeBase, pr.headSha),
          );
          await step("Size check", async () =>
            checkSize(diff, options.maxLines),
          );
          log(`Base: ${pr.baseRef} (merge-base ${mergeBase})`);
          log(`Head SHA: ${pr.headSha}`);
          log(
            `Files: ${diff.files.length} (${diff.changedLines} changed lines${diff.ignoredFiles ? `, ${diff.ignoredFiles} ignored by the path filters` : ""})`,
          );
          for (const line of describeDiff(diff)) log(line);

          if (diff.files.length === 0) {
            log("Nothing to review.");
            return { kind: "empty", pr: pr.number } as const;
          }
          const outcome = {
            pr: pr.number,
            files: diff.files.length,
            changedLines: diff.changedLines,
          };

          // A dry run mints no token and posts nothing.
          let token: string | null = null;
          if (credentials) {
            const minted = await step("Token", async () =>
              mintToken(
                deps.client,
                credentials,
                pr.repository,
                Math.floor(deps.now() / 1000),
              ),
            );
            secrets.push(minted);
            token = minted;
            log("Minted an installation token for the Review bot.");
          }
          await step("Review", async () =>
            deps.review?.({ pr, mergeBase, diff, worktree: dir, token }),
          );
          if (options.dryRun) {
            log("Dry run: nothing was posted.");
            return { kind: "dry-run", ...outcome } as const;
          }
          log("Review run finished.");
          return { kind: "reviewed", ...outcome } as const;
        },
        deps.tmpRoot,
      );
    } catch (error) {
      // Steps inside the worktree name themselves; anything else is the
      // worktree failing to be created or removed.
      throw error instanceof StepError
        ? error
        : new StepError("Worktree", error);
    }
  } catch (error) {
    // Rebuilt without `cause`, which could hold an unredacted message.
    const failure = new Error(redact(errorMessage(error), secrets));
    if (error instanceof StepError) {
      throw Object.assign(failure, { step: error.step });
    }
    throw failure;
  }
}

/** The `.env.local` candidates: this checkout's, then the main one's. */
async function credentialFiles(git: Git): Promise<string[]> {
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  const common = (
    await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  return [
    path.join(root, ".env.local"),
    path.join(path.dirname(common), ".env.local"),
  ];
}

/** Runs the command line: parses `argv` and does a Review run. */
export async function main(argv: string[]): Promise<void> {
  const args = parseCliArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const exec: Exec = defaultExec;
  const log = (message: string) => console.log(message);
  const git: Git = (gitArgs, cwd) => exec("git", gitArgs, { cwd });
  const branch = (
    await git(["branch", "--show-current"]).catch(() => "")
  ).trim();
  await runReview(
    {
      pr: args.pr,
      branch,
      dryRun: args.dryRun,
      maxLines: args.maxLines,
      credentialFiles: await credentialFiles(git),
    },
    {
      git,
      client: createGitHubClient({ exec }),
      log,
      now: Date.now,
      review: createReviewStep({ git, exec, log }),
    },
  );
}

/**
 * Prints why a run failed: the message, which names the step and never holds
 * a secret (see {@link runReview}). Nothing else, so no stack or cause.
 * @returns The exit code: non-zero.
 */
export function reportFailure(
  error: unknown,
  print: (message: string) => void = (message) => console.error(message),
): number {
  print(errorMessage(error));
  return 1;
}
