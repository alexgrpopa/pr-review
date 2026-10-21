import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { redact, runReview, type RunDeps, type RunOptions } from "./run.ts";
import {
  createRepoFixture,
  envFileText,
  fakeClient,
  INSTALLATION_ID,
  testKeyPair,
  TOKEN,
  type RepoFixture,
} from "./test-helpers.ts";

/** Fixture repo, empty temp folder for worktrees, credentials file. */
function setup(t: { after: (fn: () => void) => void }) {
  const repo = createRepoFixture();
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pr-review-run-"));
  const envFile = path.join(tmpRoot, ".env.local");
  writeFileSync(envFile, envFileText());
  t.after(() => {
    repo.cleanup();
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  return { repo, tmpRoot, envFile };
}

function run(
  repo: RepoFixture,
  tmpRoot: string,
  envFile: string,
  options: Partial<RunOptions> = {},
  deps: Partial<RunDeps> = {},
) {
  const logs: string[] = [];
  const fake = fakeClient(repo.pr);
  const promise = runReview(
    {
      branch: "feature",
      dryRun: false,
      maxLines: 3000,
      credentialFiles: [envFile],
      ...options,
    },
    {
      git: repo.git,
      client: fake.client,
      log: (message) => logs.push(message),
      now: () => 1_700_000_000_000,
      tmpRoot: path.join(tmpRoot, "worktrees"),
      ...deps,
    },
  );
  return { promise, logs, fake };
}

/** Worktrees git knows about, and folders left behind in the temp root. */
function leftovers(repo: RepoFixture, tmpRoot: string) {
  const registered = repo
    .raw("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  let folders: string[] = [];
  try {
    folders = readdirSync(path.join(tmpRoot, "worktrees"));
  } catch {
    // Never created.
  }
  return { registered: registered.length, folders };
}

test("a dry run prints the pull request, base, head SHA and filtered diff", async (t) => {
  const { repo, tmpRoot } = setup(t);
  const { promise, logs, fake } = run(repo, tmpRoot, "/nonexistent/.env", {
    dryRun: true,
  });
  const outcome = await promise;

  assert.deepEqual(outcome, {
    kind: "dry-run",
    pr: 7,
    files: 2,
    changedLines: 11,
  });
  const text = logs.join("\n");
  assert.match(text, /#7: Add the feature/);
  assert.match(
    text,
    new RegExp(`Base: main \\(merge-base ${repo.mergeBase}\\)`),
  );
  assert.match(text, new RegExp(`Head SHA: ${repo.pr.headSha}`));
  assert.match(
    text,
    /Files: 2 \(11 changed lines, 3 ignored by the path filters\)/,
  );
  assert.match(text, /src\/feature\.ts {2}\+10 -0/);
  assert.match(text, /README\.md {2}\+1 -0/);
  assert.doesNotMatch(text, /pnpm-lock|dist\/|public\/|uncommitted|main-only/);
  assert.match(text, /Dry run: nothing was posted/);

  // A dry run reads no credentials and never calls the App endpoints.
  assert.deepEqual(fake.calls, ['lookupPullRequest {"branch":"feature"}']);
  assert.deepEqual(leftovers(repo, tmpRoot), {
    registered: 1,
    folders: [],
  });
});

test("--pr is passed to the lookup instead of the branch", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const { promise, fake } = run(repo, tmpRoot, envFile, {
    dryRun: true,
    pr: 7,
  });
  await promise;
  assert.deepEqual(fake.calls, ['lookupPullRequest {"number":7}']);
});

test("a change over the limit stops, naming the size and --max-lines", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const { promise } = run(repo, tmpRoot, envFile, { maxLines: 10 });
  await assert.rejects(promise, (error: Error & { step?: string }) => {
    assert.equal(error.step, "Size check");
    assert.match(
      error.message,
      /^Size check failed: The filtered diff changes 11 lines in 2 files, over the limit of 10 lines.*--max-lines 11/,
    );
    return true;
  });
  assert.deepEqual(leftovers(repo, tmpRoot), { registered: 1, folders: [] });
});

test("--max-lines at the size lets the run through", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const { promise } = run(repo, tmpRoot, envFile, {
    maxLines: 11,
    dryRun: true,
  });
  assert.equal((await promise).kind, "dry-run");
});

test("the pushed head is reviewed, not the working tree or main's newer commits", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const { promise, logs } = run(repo, tmpRoot, envFile, { dryRun: true });
  await promise;
  assert.doesNotMatch(logs.join("\n"), /uncommitted\.ts|main-only\.txt/);
});

test("a real run mints one token, hands it to the review step, and never logs it", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  let handed: { token: string | null; worktree: string } | undefined;
  const { promise, logs, fake } = run(
    repo,
    tmpRoot,
    envFile,
    {},
    {
      review: async (prepared) => {
        handed = { token: prepared.token, worktree: prepared.worktree };
        // The worktree holds the head SHA while the review runs.
        assert.equal(
          repo.raw("-C", prepared.worktree, "rev-parse", "HEAD").trim(),
          prepared.pr.headSha,
        );
      },
    },
  );
  const outcome = await promise;

  assert.equal(outcome.kind, "reviewed");
  assert.equal(handed?.token, TOKEN);
  assert.deepEqual(fake.calls, [
    'lookupPullRequest {"branch":"feature"}',
    "lookupInstallation owner/name",
    `mintInstallationToken ${INSTALLATION_ID}`,
  ]);
  const text = logs.join("\n");
  assert.match(text, /Minted an installation token/);
  assert.match(text, /Review run finished/);
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(testKeyPair().privateKey.split("\n")[1]));
  assert.deepEqual(leftovers(repo, tmpRoot), { registered: 1, folders: [] });
});

test("missing credentials stop a real run before any network write, naming the variable", async (t) => {
  const { repo, tmpRoot } = setup(t);
  const noKey = path.join(tmpRoot, "partial.env");
  writeFileSync(noKey, "PR_REVIEW_APP_ID=1\n");
  const { promise, fake } = run(repo, tmpRoot, noKey);
  await assert.rejects(promise, (error: Error & { step?: string }) => {
    assert.equal(error.step, "Credentials");
    assert.match(
      error.message,
      /^Credentials failed: PR_REVIEW_APP_PRIVATE_KEY is not set/,
    );
    assert.match(error.message, /scripts\/pr-review\/README\.md/);
    return true;
  });
  assert.deepEqual(fake.calls, ['lookupPullRequest {"branch":"feature"}']);
});

test("no pull request fails in the Resolve PR step", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const logs: string[] = [];
  await assert.rejects(
    runReview(
      {
        branch: "feature",
        dryRun: true,
        maxLines: 3000,
        credentialFiles: [envFile],
      },
      {
        git: repo.git,
        client: fakeClient(null).client,
        log: (message) => logs.push(message),
        now: Date.now,
        tmpRoot,
      },
    ),
    /Resolve PR failed: No open pull request for the branch feature/,
  );
});

test("each failing step is named", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  // A head SHA the remote does not have.
  const missingHead = { ...repo.pr, headSha: "f".repeat(40) };
  const result = runReview(
    {
      branch: "feature",
      dryRun: true,
      maxLines: 3000,
      credentialFiles: [envFile],
    },
    {
      git: repo.git,
      client: fakeClient(missingHead).client,
      log: () => undefined,
      now: Date.now,
      tmpRoot: path.join(tmpRoot, "worktrees"),
    },
  );
  await assert.rejects(result, /Fetch failed: .*pushed to meanwhile/);

  const token = run(
    repo,
    tmpRoot,
    envFile,
    {},
    {
      client: fakeClient(repo.pr, {
        lookupInstallation: async () => {
          throw new Error("The GitHub App is not installed on owner/name");
        },
      }).client,
    },
  );
  await assert.rejects(token.promise, /Token failed: .*not installed/);
  assert.deepEqual(leftovers(repo, tmpRoot), { registered: 1, folders: [] });
});

test("the worktree is removed when a step after it fails", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const { promise } = run(
    repo,
    tmpRoot,
    envFile,
    {},
    {
      review: async () => {
        throw new Error("reviewer exploded");
      },
    },
  );
  await assert.rejects(promise, /Review failed: reviewer exploded/);
  assert.deepEqual(leftovers(repo, tmpRoot), { registered: 1, folders: [] });
});

test("the diff step failing removes the worktree and names the step", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const { promise } = run(
    repo,
    tmpRoot,
    envFile,
    { dryRun: true },
    {
      git: async (args, cwd) => {
        if (args[0] === "diff")
          throw new Error("git diff exited with code 128");
        return repo.git(args, cwd);
      },
    },
  );
  await assert.rejects(promise, /Diff failed: git diff exited with code 128/);
  assert.deepEqual(leftovers(repo, tmpRoot), { registered: 1, folders: [] });
});

test("no secret appears in an error message, whatever the step echoes", async (t) => {
  const { repo, tmpRoot, envFile } = setup(t);
  const keyLine = testKeyPair().privateKey.split("\n")[1];
  const leaky = [
    // The key echoed by a failing API call.
    {
      lookupInstallation: async () => {
        throw new Error(`rejected key ${testKeyPair().privateKey.trim()}`);
      },
    },
    // One line of the key.
    {
      lookupInstallation: async () => {
        throw new Error(`bad line ${keyLine}`);
      },
    },
    // The token echoed by a failing review step.
    {},
  ];
  for (const overrides of leaky) {
    const { promise } = run(
      repo,
      tmpRoot,
      envFile,
      {},
      {
        client: fakeClient(repo.pr, overrides).client,
        review: async ({ token }) => {
          throw new Error(`failed with ${token}`);
        },
      },
    );
    await assert.rejects(promise, (error: Error) => {
      assert.ok(!error.message.includes(keyLine), "key line leaked");
      assert.ok(!error.message.includes(TOKEN), "token leaked");
      assert.match(error.message, /\[redacted\]|failed:/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("redact replaces the longest secret first and ignores empty ones", () => {
  assert.equal(
    redact("key abcdefgh-ijklmnop and abcdefgh", [
      "abcdefgh",
      "abcdefgh-ijklmnop",
      "",
    ]),
    "key [redacted] and [redacted]",
  );
});
