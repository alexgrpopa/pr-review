import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRepoFixture, tempDir } from "./test-helpers.ts";
import {
  checkSize,
  fetchPullRequest,
  isIgnored,
  summarizeNumstat,
  withWorktree,
  type DiffSummary,
} from "./pull-request-diff.ts";

/** Builds `git diff --numstat -z` output. */
const numstat = (...records: string[][]) =>
  records.map((fields) => fields.join("\0")).join("\0") + "\0";

test("the path filters ignore generated and vendored paths", () => {
  for (const ignored of [
    "dist/index.html",
    "build/index.js",
    "node_modules/x/index.js",
    "coverage/lcov.info",
    "pnpm-lock.yaml",
  ]) {
    assert.equal(isIgnored(ignored), true, ignored);
  }
  for (const kept of [
    "src/pages/dist.astro",
    "src/build/x.ts",
    "package.json",
    "docs/pnpm-lock.yaml",
    "distillery.ts",
  ]) {
    assert.equal(isIgnored(kept), false, kept);
  }
});

test("the numstat is summed and the filtered files are counted apart", () => {
  const summary = summarizeNumstat(
    numstat(
      ["10\t2\tsrc/a.ts"],
      ["500\t0\tpnpm-lock.yaml"],
      ["-\t-\tsrc/image.png"],
      ["3\t4\tdist/x.js"],
    ),
  );
  assert.deepEqual(summary, {
    files: [{ path: "src/a.ts", added: 10, deleted: 2 }],
    changedLines: 12,
    ignoredFiles: 3,
  });
});

test("a rename is listed under its new path", () => {
  const summary = summarizeNumstat(
    "1\t1\t\0src/old.ts\0src/new.ts\0" + "2\t0\tsrc/b.ts\0",
  );
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["src/new.ts", "src/b.ts"],
  );
  assert.equal(summary.changedLines, 4);
});

test("a path with a tab or newline is kept whole", () => {
  const summary = summarizeNumstat(numstat(["1\t0\tsrc/we\tird\nname.ts"]));
  assert.equal(summary.files[0].path, "src/we\tird\nname.ts");
});

test("an empty diff has no files and no lines", () => {
  assert.deepEqual(summarizeNumstat(""), {
    files: [],
    changedLines: 0,
    ignoredFiles: 0,
  });
});

const sized = (changedLines: number, files = 3): DiffSummary => ({
  files: Array.from({ length: files }, (_, i) => ({
    path: `f${i}`,
    added: 0,
    deleted: 0,
  })),
  changedLines,
  ignoredFiles: 0,
});

test("a diff at the limit passes, one line over stops with the override", () => {
  checkSize(sized(3000), 3000);
  assert.throws(
    () => checkSize(sized(3001), 3000),
    /3001 lines in 3 files.*limit of 3000.*--max-lines/,
  );
  checkSize(sized(3001), 4000);
});

test("the message uses the singular for one file", () => {
  assert.throws(() => checkSize(sized(11, 1), 10), /11 lines in 1 file,/);
});

/** A fake git that records its calls and can fail one command. */
function fakeGit(failOn?: string) {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    if (failOn && args[0] === failOn) throw new Error(`git ${failOn} failed`);
    return "";
  };
  return { git, calls };
}

test("the worktree is added, used and removed", async (t) => {
  const tmpRoot = await tempDir(t, "pr-review-test-");
  const { git, calls } = fakeGit();
  let seen = "";
  await withWorktree(
    git,
    "abc",
    async ({ dir }) => {
      seen = dir;
    },
    tmpRoot,
  );
  assert.deepEqual(calls[0].slice(0, 3), ["worktree", "add", "--detach"]);
  assert.equal(calls[0][4], "abc");
  assert.deepEqual(calls[1].slice(0, 3), ["worktree", "remove", "--force"]);
  assert.equal(calls[1][3], seen);
  assert.deepEqual(calls[2], ["worktree", "prune"]);
  assert.equal(existsSync(path.dirname(seen)), false);
});

test("the worktree is removed when the work in it fails", async (t) => {
  const tmpRoot = await tempDir(t, "pr-review-test-");
  const { git, calls } = fakeGit();
  let seen = "";
  await assert.rejects(
    withWorktree(
      git,
      "abc",
      async ({ dir }) => {
        seen = dir;
        throw new Error("boom");
      },
      tmpRoot,
    ),
    /boom/,
  );
  assert.ok(calls.some((args) => args[1] === "remove"));
  assert.equal(existsSync(path.dirname(seen)), false);
});

test("the folder is removed even when adding the worktree fails", async (t) => {
  const tmpRoot = await tempDir(t, "pr-review-test-");
  const { git } = fakeGit("worktree");
  await assert.rejects(
    withWorktree(git, "abc", async () => undefined, tmpRoot),
    /git worktree failed/,
  );
  assert.deepEqual(readdirSync(tmpRoot), [], "no leftover folder");
});

test("a head that moved since GitHub was read stops the fetch", async (t) => {
  const repo = createRepoFixture();
  t.after(repo.cleanup);
  await fetchPullRequest(repo.git, repo.pr);
  await assert.rejects(
    fetchPullRequest(repo.git, { ...repo.pr, headSha: "0".repeat(40) }),
    /not 0{40}: the pull request was pushed to meanwhile/,
  );
});

test("fetching creates no tags", async (t) => {
  const repo = createRepoFixture();
  t.after(repo.cleanup);
  repo.raw("tag", "-a", "v1", "-m", "v1", repo.mergeBase);
  repo.raw("push", "origin", "v1");
  repo.raw("tag", "-d", "v1");
  await fetchPullRequest(repo.git, repo.pr);
  assert.equal(repo.raw("tag", "--list").trim(), "");
});
