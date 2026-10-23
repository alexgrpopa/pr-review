/**
 * Shared helpers for the pr-review script tests: a throwaway git repository
 * with an "origin" that has a pull request ref, a generated RSA key pair, a
 * fake GitHub client and a fake `claude` executable. Nothing here touches the
 * network or a real key.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  assemble,
  type AggregationResult,
  type AggregatorStatus,
} from "./aggregate.ts";
import { parseDiff } from "./diff.ts";
import { defaultExec } from "./exec.ts";
import type { Finding } from "./finding.ts";
import type { GitHubClient, PullRequest } from "./github.ts";
import { toCandidate } from "./merge.ts";
import {
  GitHubApiError,
  type NewReview,
  type PostingClient,
  type RemoteComment,
  type RemoteReview,
} from "./posting-client.ts";
import type { Git } from "./pull-request-diff.ts";
import type { ReviewerResult } from "./reviewers.ts";

/** An empty temporary folder, removed after the test. */
export async function tempDir(
  t: TestContext,
  prefix = "worktree-",
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

let keyPair: { privateKey: string; publicKey: string } | undefined;

/** A fresh-enough RSA key pair in PEM; generated once per test process. */
export function testKeyPair(): { privateKey: string; publicKey: string } {
  keyPair ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return keyPair;
}

/** A `.env.local` text with the private key on one line, `\n` escaped. */
export function envFileText(appId = "12345"): string {
  const key = testKeyPair().privateKey.trim().replace(/\n/g, "\\n");
  return `PR_REVIEW_APP_ID=${appId}\nPR_REVIEW_APP_PRIVATE_KEY="${key}"\n`;
}

export const INSTALLATION_ID = 987654;
export const TOKEN = "ghs_FakeInstallationTokenForTests0123456789";

export interface FakeClient {
  client: GitHubClient;
  /** One entry per call, e.g. "lookupInstallation owner/name". */
  calls: string[];
  /** The JWTs the client was given. */
  jwts: string[];
}

/**
 * A GitHub client that never leaves the process.
 * @param pr What the lookup answers; null for "no pull request".
 */
export function fakeClient(
  pr: PullRequest | null,
  overrides: Partial<GitHubClient> = {},
): FakeClient {
  const calls: string[] = [];
  const jwts: string[] = [];
  const client: GitHubClient = {
    async lookupPullRequest(query) {
      calls.push(`lookupPullRequest ${JSON.stringify(query)}`);
      return pr;
    },
    async lookupInstallation(jwt, repository) {
      calls.push(`lookupInstallation ${repository}`);
      jwts.push(jwt);
      return INSTALLATION_ID;
    },
    async mintInstallationToken(jwt, installationId) {
      calls.push(`mintInstallationToken ${installationId}`);
      jwts.push(jwt);
      return TOKEN;
    },
    ...overrides,
  };
  return { client, calls, jwts };
}

const GIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

export interface RepoFixture {
  /** The clone the runner runs in; its working tree has an uncommitted file. */
  work: string;
  /** Runs git in the clone with the runner's own (scrubbed) exec. */
  git: Git;
  /** Runs git in the clone as the fixture author, for assertions. */
  raw: (...args: string[]) => string;
  pr: PullRequest;
  mergeBase: string;
  cleanup: () => void;
}

/**
 * Builds origin + clone: `main` has a commit, a branch adds files (some of
 * them covered by the path filters) and is published as `refs/pull/7/head`,
 * then `main` moves on. The clone is left on `main` with an uncommitted file
 * that a Review run must not see.
 */
export function createRepoFixture(): RepoFixture {
  const root = mkdtempSync(path.join(tmpdir(), "pr-review-fixture-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const run = (cwd: string, ...args: string[]): string =>
    execFileSync("git", [...GIT_IDENTITY, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const write = (name: string, text: string) => {
    mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    writeFileSync(path.join(work, name), text);
  };
  const lines = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i}\n`).join("");

  mkdirSync(origin);
  run(origin, "init", "--bare", "--initial-branch=main");
  mkdirSync(work);
  run(work, "init", "--initial-branch=main");
  run(work, "remote", "add", "origin", origin);

  write("README.md", "# Fixture\n");
  run(work, "add", ".");
  run(work, "commit", "-m", "base");
  const mergeBase = run(work, "rev-parse", "HEAD").trim();
  run(work, "push", "origin", "main");

  run(work, "switch", "-c", "feature");
  write("src/feature.ts", lines(10));
  write("README.md", "# Fixture\nchanged\n");
  write("pnpm-lock.yaml", lines(500));
  write("dist/out.js", lines(500));
  write("public/logo.txt", lines(500));
  run(work, "add", ".");
  run(work, "commit", "-m", "feature");
  const headSha = run(work, "rev-parse", "HEAD").trim();
  run(work, "push", "origin", "HEAD:refs/pull/7/head");

  run(work, "switch", "main");
  write("main-only.txt", lines(300));
  run(work, "add", ".");
  run(work, "commit", "-m", "main moves on");
  run(work, "push", "origin", "main");
  run(work, "branch", "-D", "feature");
  write("uncommitted.ts", lines(40));

  return {
    work,
    git: (args, cwd) => defaultExec("git", args, { cwd: cwd ?? work }),
    raw: (...args) => run(work, ...args),
    pr: {
      number: 7,
      url: "https://github.com/owner/name/pull/7",
      title: "Add the feature",
      repository: "owner/name",
      baseRef: "main",
      headSha,
    },
    mergeBase,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One run of the fake `claude`, as recorded. */
export interface FakeCall {
  id: string;
  args: string[];
  cwd: string;
  stdin: string;
  envNames: string[];
  env: Record<string, string>;
  start: number;
  end?: number;
}

export interface FakeClaude {
  dir: string;
  command: string;
  calls(): Promise<FakeCall[]>;
  /** Most calls that were running at the same moment. */
  maxConcurrent(): Promise<number>;
  cleanup(): Promise<void>;
}

/**
 * Writes an executable that stands in for `claude`. Give it
 * the body of what the fake should do and pass its `command` to the code under
 * test:
 *
 * ```js
 * const fake = await createFakeClaude(`reply({ findings: [] });`);
 * t.after(fake.cleanup);
 * await runReviewers({ worktree, base: "main", command: fake.command });
 * assert.equal((await fake.calls()).length, 5);
 * ```
 *
 * In the body, `call` holds what the process received (`args`, `cwd`, `stdin`,
 * `envNames`), `reply(structured)` prints a successful `claude -p` result,
 * `print(text)` prints raw text, and `sleep(ms)` waits. Every call is
 * recorded, and read back with `calls()`.
 */
export async function createFakeClaude(body: string): Promise<FakeClaude> {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const command = path.join(dir, "claude");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", async () => {
  const id = String(process.pid);
  const call = {
    id,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin,
    envNames: Object.keys(process.env),
    env: process.env,
    start: Date.now(),
  };
  fs.appendFileSync(log, JSON.stringify(call) + "\\n");
  const print = (text) => process.stdout.write(text);
  const reply = (structured) =>
    print(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      result: JSON.stringify(structured), structured_output: structured,
      total_cost_usd: 0.01,
    }));
  await (async () => {
${body}
  })();
  fs.appendFileSync(log, JSON.stringify({ id, end: Date.now() }) + "\\n");
});
`;
  await writeFile(command, script);
  await chmod(command, 0o755);

  const read = async (): Promise<FakeCall[]> => {
    let text: string;
    try {
      text = await readFile(log, "utf8");
    } catch {
      return [];
    }
    const calls = new Map<string, FakeCall>();
    for (const line of text.split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.args) calls.set(entry.id, entry);
      else if (calls.has(entry.id)) calls.get(entry.id)!.end = entry.end;
    }
    return [...calls.values()];
  };

  return {
    dir,
    command,
    calls: read,
    async maxConcurrent() {
      const events = (await read()).flatMap((c) => [
        { at: c.start, delta: 1 },
        { at: c.end ?? c.start, delta: -1 },
      ]);
      // An end sorts before a start at the same instant.
      events.sort((a, b) => a.at - b.at || a.delta - b.delta);
      let running = 0;
      let max = 0;
      for (const event of events) {
        running += event.delta;
        max = Math.max(max, running);
      }
      return max;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** A Finding as a Reviewer writes it (no `reviewer`). */
export function sampleModelFinding(overrides: Record<string, unknown> = {}) {
  return {
    severity: "major",
    confidence: 0.8,
    path: "src/pages/index.astro",
    line: 3,
    title: "Missing alt text",
    body: "The image has no `alt`, so a screen reader cannot describe it.",
    fixPrompt:
      "In src/pages/index.astro line 3, add an alt attribute describing the image.",
    ...overrides,
  };
}

/** Right-side lines 1-6 of src/a.ts are in the diff; src/old.ts is deleted. */
export const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,6 @@
 line1
-line2
+line2 changed
+line3 added
 line4
 line5
 line6
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

/** A Finding as the Reviewers return it, for the posting tests. */
export function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "correctness",
    severity: "major",
    confidence: 0.8,
    path: "src/a.ts",
    line: 2,
    title: "Wrong value",
    body: "The value is wrong.",
    fixPrompt: "In src/a.ts line 2, correct the value.",
    ...overrides,
  };
}

/** Every Reviewer ran and found nothing, unless a result is given. */
export function okResults(
  names: readonly string[] = ["architecture", "correctness"],
): ReviewerResult[] {
  return names.map((reviewer) => ({
    reviewer,
    status: "ok",
    findings: [],
    model: "sonnet",
    durationMs: 1,
  }));
}

/**
 * What the aggregation hands to the posting step, built with the real
 * `assemble` over {@link SAMPLE_DIFF}.
 */
export function sampleAggregation(
  options: {
    findings?: Finding[];
    results?: ReviewerResult[];
    existingFingerprints?: ReadonlySet<string>;
    maxFindings?: number;
    aggregator?: AggregatorStatus;
  } = {},
): AggregationResult {
  const results = options.results ?? okResults();
  return assemble({
    files: parseDiff(SAMPLE_DIFF),
    results,
    merged: (options.findings ?? []).map(toCandidate),
    belowThreshold: 0,
    lowConfidence: 0,
    duplicates: 0,
    existingFingerprints: options.existingFingerprints,
    maxFindings: options.maxFindings,
    aggregator: options.aggregator ?? { status: "ok", model: "sonnet" },
    summary: "Changes the value of line two.",
    walkthrough: [{ path: "src/a.ts", change: "Changes line two" }],
  });
}

export type FakeComment = RemoteComment;

export interface FakePosting {
  client: PostingClient;
  /** The pull request as the fake keeps it; tests may set or read it. */
  state: {
    body: string;
    issueComments: FakeComment[];
    reviewComments: FakeComment[];
    reviews: RemoteReview[];
    /** The reviews as submitted, with their comments. */
    submitted: {
      event: string;
      body: string;
      comments: NewReview["comments"];
    }[];
  };
  /** One entry per call that changes something, e.g. "createReview COMMENT 2". */
  writes: string[];
  /** "path:line" of the comments the fake refuses with a 422. */
  rejectLines: Set<string>;
}

/**
 * A pull request that lives in memory, behind the posting client. A review is
 * refused with a 422 when one of its comments is on a line in `rejectLines`,
 * like GitHub does for a line it cannot place; a pending review (no event) is
 * validated the same way, and only one can exist.
 */
export function fakePostingClient(
  initial: Partial<FakePosting["state"]> = {},
): FakePosting {
  let nextId = 1000;
  const state: FakePosting["state"] = {
    body: "",
    issueComments: [],
    reviewComments: [],
    reviews: [],
    submitted: [],
    ...initial,
  };
  const writes: string[] = [];
  const rejectLines = new Set<string>();
  const stateOfEvent = {
    APPROVE: "APPROVED",
    REQUEST_CHANGES: "CHANGES_REQUESTED",
    COMMENT: "COMMENTED",
  } as const;

  const client: PostingClient = {
    async getPullRequestBody() {
      return state.body;
    },
    async updatePullRequestBody(_pr, body) {
      writes.push("updatePullRequestBody");
      state.body = body;
    },
    async listIssueComments() {
      return [...state.issueComments];
    },
    async createIssueComment(_pr, body) {
      writes.push("createIssueComment");
      const id = nextId++;
      state.issueComments.push({ id, body, byBot: true });
      return id;
    },
    async updateIssueComment(id, body) {
      writes.push(`updateIssueComment ${id}`);
      const comment = state.issueComments.find((c) => c.id === id);
      if (!comment) throw new GitHubApiError(404, "no such comment");
      comment.body = body;
    },
    async listReviewComments() {
      return [...state.reviewComments];
    },
    async listReviews() {
      return [...state.reviews];
    },
    async createReview(_pr, review) {
      const refused = review.comments.find((c) =>
        rejectLines.has(`${c.path}:${c.line}`),
      );
      if (refused) {
        writes.push(`rejected ${review.event ?? "PENDING"}`);
        throw new GitHubApiError(
          422,
          "GitHub answered 422 to POST /repos/owner/name/pulls/7/reviews: Line could not be resolved",
        );
      }
      const id = nextId++;
      if (review.event === undefined) {
        if (state.reviews.some((r) => r.state === "PENDING")) {
          throw new GitHubApiError(422, "one pending review at a time");
        }
        writes.push("createPendingReview");
        state.reviews.push({ id, state: "PENDING", byBot: true });
        return id;
      }
      writes.push(`createReview ${review.event} ${review.comments.length}`);
      state.reviews.push({
        id,
        state: stateOfEvent[review.event],
        byBot: true,
      });
      for (const comment of review.comments) {
        state.reviewComments.push({
          id: nextId++,
          body: comment.body,
          byBot: true,
        });
      }
      state.submitted.push({
        event: review.event,
        body: review.body,
        comments: review.comments,
      });
      return id;
    },
    async deleteReview(_pr, id) {
      writes.push("deleteReview");
      state.reviews = state.reviews.filter((r) => r.id !== id);
    },
  };
  return { client, state, writes, rejectLines };
}
