import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { claudeArgs, claudeEnv, runClaude } from "./claude.ts";
import { createFakeClaude, tempDir } from "./test-helpers.ts";

const SCHEMA = { type: "object" };

function workdir(t: TestContext): Promise<string> {
  return tempDir(t, "claude-cwd-");
}

function options(cwd: string, command: string) {
  return {
    command,
    cwd,
    model: "sonnet",
    systemPrompt: "You are a Reviewer.",
    task: "Review it.",
    schema: SCHEMA,
    timeoutMs: 10_000,
  };
}

test("claudeEnv keeps what the subscription login needs", () => {
  const env = claudeEnv({
    PATH: "/usr/bin",
    HOME: "/home/a",
    USER: "a",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: "/home/a/.config",
    CLAUDE_CONFIG_DIR: "/home/a/.claude",
    HTTPS_PROXY: "http://proxy",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "CLAUDE_CONFIG_DIR",
    "GIT_OPTIONAL_LOCKS",
    "HOME",
    "HTTPS_PROXY",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "USER",
    "XDG_CONFIG_HOME",
  ]);
});

test("claudeEnv drops tokens, API keys, cloud, SSH and git variables", () => {
  const env = claudeEnv({
    PATH: "/usr/bin",
    PR_REVIEW_APP_ID: "1",
    PR_REVIEW_PRIVATE_KEY: "secret",
    GH_TOKEN: "t",
    GITHUB_TOKEN: "t",
    GH_ENTERPRISE_TOKEN: "t",
    ANTHROPIC_API_KEY: "k",
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    AWS_SECRET_ACCESS_KEY: "k",
    GOOGLE_APPLICATION_CREDENTIALS: "f",
    SSH_AUTH_SOCK: "/s",
    GIT_DIR: "/elsewhere",
    NPM_TOKEN: "t",
    R2_SECRET_ACCESS_KEY: "k",
  });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_OPTIONAL_LOCKS", "PATH"]);
});

test("the flags the tool relies on", () => {
  const args = claudeArgs({
    model: "opus",
    systemPrompt: "PROMPT",
    schema: SCHEMA,
  });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "--print");
  assert.equal(value("--output-format"), "json");
  assert.equal(value("--json-schema"), JSON.stringify(SCHEMA));
  assert.equal(value("--model"), "opus");
  assert.equal(value("--append-system-prompt"), "PROMPT");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--tools"), "Read,Grep,Glob,Bash");
  for (const flag of [
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ]) {
    assert.ok(args.includes(flag), flag);
  }
});

test("only read-only tools are allowed", () => {
  const args = claudeArgs({
    model: "sonnet",
    systemPrompt: "",
    schema: SCHEMA,
  });
  const list = (flag: string) => {
    const rest = args.slice(args.indexOf(flag) + 1);
    const end = rest.findIndex((a) => a.startsWith("--"));
    return end === -1 ? rest : rest.slice(0, end);
  };
  assert.deepEqual(list("--allowedTools"), [
    "Read",
    "Grep",
    "Glob",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
  ]);
  assert.deepEqual(list("--disallowedTools"), ["Bash(git * --output*)"]);
  const available = args[args.indexOf("--tools") + 1].split(",");
  for (const tool of [
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
  ]) {
    assert.ok(!available.includes(tool), tool);
  }
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--allow-dangerously-skip-permissions"));
});

test("every flag exists in the installed claude --help", (t) => {
  const help = spawnSync("claude", ["--help"], { encoding: "utf8" });
  if (help.error || help.status !== 0) {
    t.skip("claude is not installed");
    return;
  }
  const flags = claudeArgs({
    model: "m",
    systemPrompt: "p",
    schema: SCHEMA,
  }).filter((a) => /^--[a-z]/i.test(a));
  for (const flag of flags) {
    assert.ok(help.stdout.includes(flag), `${flag} is not in claude --help`);
  }
});

test("returns the structured output", async (t) => {
  const fake = await createFakeClaude(`reply({ findings: [] });`);
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" && result.output, { findings: [] });
  assert.equal(result.status === "ok" && result.costUsd, 0.01);
});

test("starts in the given directory, sends the task on stdin", async (t) => {
  const fake = await createFakeClaude(`reply({});`);
  t.after(fake.cleanup);
  const cwd = await workdir(t);
  await runClaude(options(cwd, fake.command));
  const [call] = await fake.calls();
  assert.equal(await realpath(call.cwd), await realpath(cwd));
  assert.equal(call.stdin, "Review it.");
  assert.equal(call.args[call.args.indexOf("--model") + 1], "sonnet");
});

test("falls back to the text result when there is no structured output", async (t) => {
  const fake = await createFakeClaude(
    `print(JSON.stringify({ type: "result", is_error: false, result: '{"findings":[]}' }));`,
  );
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.deepEqual(result.status === "ok" && result.output, { findings: [] });
});

test("accepts a result inside a list of messages", async (t) => {
  const fake = await createFakeClaude(
    `print(JSON.stringify([{ type: "system" }, { type: "result", is_error: false, structured_output: { a: 1 } }]));`,
  );
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.deepEqual(result.status === "ok" && result.output, { a: 1 });
});

test("invalid output: stdout is not JSON", async (t) => {
  const fake = await createFakeClaude(`print("not json at all");`);
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.reason, "invalid output");
});

test("invalid output: no structured output and the text is not JSON", async (t) => {
  const fake = await createFakeClaude(
    `print(JSON.stringify({ type: "result", is_error: false, result: "I found nothing" }));`,
  );
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.equal(result.status === "failed" && result.reason, "invalid output");
});

test("process error: non-zero exit, with a quote of stderr", async (t) => {
  const fake = await createFakeClaude(
    `process.stderr.write("boom happened"); process.exit(3);`,
  );
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.equal(result.status === "failed" && result.reason, "process error");
  assert.match(
    result.status === "failed" ? result.detail : "",
    /exited with code 3: boom happened/,
  );
});

test("process error: the result says error", async (t) => {
  const fake = await createFakeClaude(
    `print(JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "it broke" }));`,
  );
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.equal(result.status === "failed" && result.reason, "process error");
  assert.match(result.status === "failed" ? result.detail : "", /it broke/);
});

test("process error: the command cannot be started", async (t) => {
  const result = await runClaude(
    options(await workdir(t), "/nonexistent/claude"),
  );
  assert.equal(result.status === "failed" && result.reason, "process error");
  assert.match(
    result.status === "failed" ? result.detail : "",
    /could not start \/nonexistent\/claude/,
  );
});

test("usage limit: reported in the result", async (t) => {
  const fake = await createFakeClaude(
    `print(JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit. Resets at 5pm" })); process.exit(1);`,
  );
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.equal(result.status === "failed" && result.reason, "usage limit");
});

test("usage limit: reported on stderr, or as a 429", async (t) => {
  const onStderr = await createFakeClaude(
    `process.stderr.write("Claude AI usage limit reached|1760000000"); process.exit(1);`,
  );
  t.after(onStderr.cleanup);
  const cwd = await workdir(t);
  const a = await runClaude(options(cwd, onStderr.command));
  assert.equal(a.status === "failed" && a.reason, "usage limit");

  const as429 = await createFakeClaude(
    `print(JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "slow down" })); process.exit(1);`,
  );
  t.after(as429.cleanup);
  const b = await runClaude(options(cwd, as429.command));
  assert.equal(b.status === "failed" && b.reason, "usage limit");
});

test("a model that mentions limits in a good result is not a usage limit", async (t) => {
  const fake = await createFakeClaude(
    `reply({ note: "rate limit handling is missing" });`,
  );
  t.after(fake.cleanup);
  const result = await runClaude(options(await workdir(t), fake.command));
  assert.equal(result.status, "ok");
});

test("timeout: the process is stopped and the result says so", async (t) => {
  const fake = await createFakeClaude(`await sleep(30000); reply({});`);
  t.after(fake.cleanup);
  const started = Date.now();
  const result = await runClaude({
    ...options(await workdir(t), fake.command),
    timeoutMs: 300,
  });
  assert.equal(result.status === "failed" && result.reason, "timeout");
  assert.ok(Date.now() - started < 5_000);
});

test("the child sees a scrubbed environment", async (t) => {
  const fake = await createFakeClaude(`reply({});`);
  t.after(fake.cleanup);
  await runClaude({
    ...options(await workdir(t), fake.command),
    env: {
      PATH: process.env.PATH,
      HOME: "/home/a",
      PR_REVIEW_PRIVATE_KEY: "secret",
      GH_TOKEN: "token",
      ANTHROPIC_API_KEY: "key",
    },
  });
  const [call] = await fake.calls();
  assert.deepEqual(
    call.envNames.filter((n) => /^(PR_REVIEW_|GH_|ANTHROPIC_)/.test(n)),
    [],
  );
  assert.equal(call.env.HOME, "/home/a");
});
