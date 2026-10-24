import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultExec } from "./exec.ts";
import { createReviewStep } from "./pipeline.ts";
import { reportFailure, runReview } from "./run.ts";
import {
  createFakeClaude,
  createRepoFixture,
  envFileText,
  fakeClient,
  fakePostingClient,
  INSTALLATION_ID,
  TOKEN,
  type FakeClaude,
} from "./test-helpers.ts";

/** The `correctness` Reviewer finds one problem; the rest find nothing. */
const REPLIES = `
  const reviewer = /as the ([a-z-]+) Reviewer/.exec(call.stdin)?.[1];
  if (reviewer === undefined) {
    reply({
      summary: "Adds the feature module.",
      walkthrough: [
        { path: "src/feature.ts", change: "New feature module" },
        { path: "README.md", change: "Mentions it" },
      ],
      duplicateGroups: [],
    });
  } else if (reviewer === "correctness") {
    reply({ findings: [{
      severity: "major", confidence: 0.9, path: "src/feature.ts", line: 3,
      title: "Off by one", body: "The loop stops one early.",
      fixPrompt: "In src/feature.ts line 3, fix the off by one.",
    }] });
  } else {
    reply({ findings: [] });
  }
`;

async function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  claudeBody = REPLIES,
) {
  const repo = createRepoFixture();
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pr-review-pipeline-"));
  const envFile = path.join(tmpRoot, ".env.local");
  writeFileSync(envFile, envFileText());
  const claude: FakeClaude = await createFakeClaude(claudeBody);
  t.after(async () => {
    repo.cleanup();
    rmSync(tmpRoot, { recursive: true, force: true });
    await claude.cleanup();
  });
  const posting = fakePostingClient({ body: "My description." });
  const github = fakeClient(repo.pr);
  const logs: string[] = [];
  const tokens: (string | null)[] = [];

  const run = (dryRun: boolean) =>
    runReview(
      {
        branch: "feature",
        dryRun,
        maxLines: 3000,
        credentialFiles: [envFile],
      },
      {
        git: repo.git,
        client: github.client,
        log: (message) => logs.push(message),
        now: () => 1_700_000_000_000,
        tmpRoot: path.join(tmpRoot, "worktrees"),
        review: createReviewStep({
          git: repo.git,
          exec: defaultExec,
          log: (message) => logs.push(message),
          postingClient: (prepared) => {
            tokens.push(prepared.token);
            return posting.client;
          },
          claudeCommand: claude.command,
        }),
      },
    );
  return { run, claude, posting, github, logs, tokens };
}

test("a real run reviews, aggregates and posts as the Review bot: Summary block, Findings comment, one Inline review", async (t) => {
  const { run, claude, posting, github, tokens, logs } = await setup(t);

  const outcome = await run(false);

  assert.equal(outcome.kind, "reviewed");
  // Five Reviewers and the Aggregator: six Claude invocations.
  assert.equal((await claude.calls()).length, 6);
  assert.deepEqual(tokens, [TOKEN]);
  // The token is minted once, for the posting; the developer's login only
  // finds the pull request.
  assert.deepEqual(github.calls, [
    'lookupPullRequest {"branch":"feature"}',
    "lookupInstallation owner/name",
    `mintInstallationToken ${INSTALLATION_ID}`,
  ]);
  assert.deepEqual(posting.writes, [
    "updatePullRequestBody",
    "createIssueComment",
    "createReview REQUEST_CHANGES 1",
  ]);
  assert.ok(posting.state.body.startsWith("My description."));
  assert.match(posting.state.body, /Adds the feature module\./);
  assert.match(
    posting.state.body,
    /\| `src\/feature\.ts` \| New feature module \|/,
  );
  assert.match(
    posting.state.body,
    /\| correctness \| ran \| 0 \| 1 \| 0 \| 0 \|/,
  );
  const [comment] = posting.state.submitted[0].comments;
  assert.equal(comment.path, "src/feature.ts");
  assert.equal(comment.line, 3);
  assert.match(comment.body, /Off by one/);
  assert.match(logs.join("\n"), /Review run finished/);
});

test("nothing Claude is given or prints carries the token", async (t) => {
  const { run, claude, logs } = await setup(t);
  await run(false);
  assert.ok(!JSON.stringify(await claude.calls()).includes(TOKEN));
  assert.ok(!logs.join("\n").includes(TOKEN));
});

test("a second run on the same head posts nothing new", async (t) => {
  const { run, posting } = await setup(t);
  await run(false);
  const state = JSON.stringify(posting.state);
  posting.writes.length = 0;

  await run(false);

  assert.deepEqual(posting.writes, []);
  assert.equal(JSON.stringify(posting.state), state);
  assert.equal(posting.state.submitted.length, 1);
  assert.equal(posting.state.issueComments.length, 1);
});

test("--dry-run prints what would be posted, makes no write and mints no token", async (t) => {
  const { run, claude, posting, github, tokens, logs } = await setup(t);

  const outcome = await run(true);

  assert.equal(outcome.kind, "dry-run");
  assert.deepEqual(posting.writes, []);
  assert.equal(posting.state.body, "My description.");
  assert.deepEqual(tokens, [null]);
  assert.deepEqual(github.calls, ['lookupPullRequest {"branch":"feature"}']);
  // The Reviewers do run: the content is the real one.
  assert.equal((await claude.calls()).length, 6);
  const text = logs.join("\n");
  assert.match(
    text,
    /Summary block \(appended to the pull request description\)/,
  );
  assert.match(text, /Adds the feature module\./);
  assert.match(text, /Findings comment \(created\)/);
  assert.match(text, /Inline review: REQUEST_CHANGES with 1 comment/);
  assert.match(text, /----- src\/feature\.ts:3 -----/);
  assert.match(text, /Off by one/);
  assert.match(text, /Dry run: nothing was posted/);
});

test("a Reviewer that failed is reported as did not run, and the run goes on", async (t) => {
  const { run, posting } = await setup(
    t,
    `
    if (/as the security Reviewer/.test(call.stdin)) process.exit(1);
    ${REPLIES}`,
  );

  await run(false);

  assert.match(posting.state.body, /\| security \| did not run \(/);
  assert.match(
    posting.state.issueComments[0].body,
    /The security Reviewer did not run/,
  );
  assert.equal(posting.state.submitted[0].event, "REQUEST_CHANGES");
});

test("every Reviewer failing posts nothing, names the step and exits non-zero", async (t) => {
  for (const dryRun of [false, true]) {
    const { run, claude, posting } = await setup(
      t,
      `if (/as the [a-z-]+ Reviewer/.test(call.stdin)) process.exit(1);
       ${REPLIES}`,
    );

    const printed: string[] = [];
    let code = 0;
    await run(dryRun).catch((error: Error & { step?: string }) => {
      assert.equal(error.step, "Reviewers");
      code = reportFailure(error, (m) => printed.push(m));
    });

    assert.equal(code, 1, `dryRun ${dryRun}`);
    assert.match(
      printed.join("\n"),
      /^Reviewers failed: every Reviewer failed, so nothing is posted\./,
    );
    assert.deepEqual(posting.writes, []);
    assert.equal(posting.state.body, "My description.");
    // No Aggregator call after the five Reviewers.
    assert.equal((await claude.calls()).length, 5);
  }
});

test("reading the pull request fails before any Reviewer is paid for, naming the step", async (t) => {
  const { run, claude, posting } = await setup(t);
  posting.client.listReviews = async () => {
    throw new Error(
      "GitHub answered 403 to GET /repos/owner/name/pulls/7/reviews",
    );
  };

  await assert.rejects(run(false), (error: Error & { step?: string }) => {
    assert.equal(error.step, "Read pull request");
    assert.match(
      error.message,
      /^Read pull request failed: GitHub answered 403/,
    );
    return true;
  });
  assert.equal((await claude.calls()).length, 0);
  assert.deepEqual(posting.writes, []);
});
