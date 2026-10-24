import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readCredentials, secretsOf } from "./credentials.ts";
import { envFileText, testKeyPair } from "./test-helpers.ts";

function envFile(t: { after: (fn: () => void) => void }, text: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-review-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env.local");
  writeFileSync(file, text);
  return file;
}

const PEM = testKeyPair().privateKey.trim();

test("a double-quoted key with escaped newlines becomes a real PEM", (t) => {
  const credentials = readCredentials([envFile(t, envFileText("4242"))]);
  assert.equal(credentials.appId, "4242");
  assert.equal(credentials.privateKey, PEM);
  assert.ok(credentials.privateKey.includes("\n"));
});

test("an unquoted or single-quoted key with a literal \\n is unescaped", (t) => {
  const escaped = PEM.replace(/\n/g, "\\n");
  for (const value of [escaped, `'${escaped}'`]) {
    const file = envFile(
      t,
      `PR_REVIEW_APP_ID=1\nPR_REVIEW_APP_PRIVATE_KEY=${value}\n`,
    );
    assert.equal(readCredentials([file]).privateKey, PEM);
  }
});

test("a multi-line quoted key is read as is", (t) => {
  const file = envFile(
    t,
    `PR_REVIEW_APP_ID='1'\nPR_REVIEW_APP_PRIVATE_KEY="${PEM}"\n`,
  );
  assert.equal(readCredentials([file]).privateKey, PEM);
});

test("comments, export and other variables are ignored and not returned", (t) => {
  const file = envFile(
    t,
    `# comment\nR2_SECRET_ACCESS_KEY=abc\nexport PR_REVIEW_APP_ID=" 77 "\n${envFileText().split("\n")[1]}\n`,
  );
  const credentials = readCredentials([file]);
  assert.deepEqual(Object.keys(credentials).sort(), ["appId", "privateKey"]);
  assert.equal(credentials.appId, "77");
});

test("a missing variable is named, with a pointer to the README", (t) => {
  const noId = envFile(t, envFileText().split("\n")[1] + "\n");
  assert.throws(
    () => readCredentials([noId]),
    /PR_REVIEW_APP_ID is not set.*README of @alexgrpopa\/pr-review/,
  );
  const noKey = envFile(t, "PR_REVIEW_APP_ID=1\nPR_REVIEW_APP_PRIVATE_KEY=\n");
  assert.throws(
    () => readCredentials([noKey]),
    /PR_REVIEW_APP_PRIVATE_KEY is not set.*README of @alexgrpopa\/pr-review/,
  );
});

test("a missing file names both variables and the README", () => {
  assert.throws(
    () => readCredentials(["/nonexistent/.env.local"]),
    /PR_REVIEW_APP_ID and PR_REVIEW_APP_PRIVATE_KEY.*README of @alexgrpopa\/pr-review/,
  );
});

test("the first existing candidate is used", (t) => {
  const file = envFile(t, envFileText("5"));
  assert.equal(readCredentials(["/nonexistent/.env.local", file]).appId, "5");
});

test("a value that is not a PEM key is rejected without being printed", (t) => {
  const file = envFile(
    t,
    "PR_REVIEW_APP_ID=1\nPR_REVIEW_APP_PRIVATE_KEY=hunter2-not-a-key\n",
  );
  assert.throws(
    () => readCredentials([file]),
    (error: Error) =>
      /not a PEM private key/.test(error.message) &&
      !error.message.includes("hunter2"),
  );
});

test("secretsOf lists the key and its long lines, not the App ID", () => {
  const secrets = secretsOf({ appId: "12345", privateKey: PEM });
  assert.ok(secrets.includes(PEM));
  assert.ok(secrets.includes(PEM.split("\n")[1]));
  assert.ok(!secrets.includes("12345"));
});
