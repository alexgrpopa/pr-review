import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv, defaultExec, StepError } from "./exec.ts";

test("children get a scrubbed environment", () => {
  const env = childEnv({
    PATH: "/usr/bin",
    HOME: "/home/dev",
    LC_ALL: "C",
    GH_TOKEN: "gh-login",
    PR_REVIEW_APP_PRIVATE_KEY: "key",
    PR_REVIEW_APP_ID: "1",
    AWS_SECRET_ACCESS_KEY: "aws",
    R2_SECRET_ACCESS_KEY: "r2",
    ANTHROPIC_API_KEY: "anthropic",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "GH_TOKEN",
    "GIT_TERMINAL_PROMPT",
    "HOME",
    "LC_ALL",
    "PATH",
  ]);
});

test("a failing command rejects with its exit code and stderr", async () => {
  await assert.rejects(
    defaultExec(process.execPath, [
      "-e",
      "console.error('went wrong'); process.exit(3)",
    ]),
    /exited with code 3: went wrong/,
  );
});

test("a command sees no PR_REVIEW variable even if the parent has one", async () => {
  process.env.PR_REVIEW_TEST_ONLY = "visible?";
  try {
    const out = await defaultExec(process.execPath, [
      "-e",
      "console.log(Object.keys(process.env).filter((k) => k.startsWith('PR_REVIEW')).length)",
    ]);
    assert.equal(out.trim(), "0");
  } finally {
    delete process.env.PR_REVIEW_TEST_ONLY;
  }
});

test("a StepError names the step", () => {
  const error = new StepError("Fetch", new Error("no route to host"));
  assert.equal(error.message, "Fetch failed: no route to host");
  assert.equal(error.step, "Fetch");
});
