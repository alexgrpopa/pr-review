/**
 * Runs one `claude -p` process and returns its structured output. Used for
 * every Claude call of a Review run (the Reviewers and the Aggregator), so the
 * safety rules are in one place:
 *
 *   - Subscription login only. `ANTHROPIC_*` variables are not passed on, so an
 *     API key can never turn a run into per-token billing.
 *   - Read-only tools: Read, Grep, Glob and `git diff` / `git log` / `git show`.
 *     No general shell, no network, no write tools, no MCP servers, and
 *     `--restricted` keeps the file tools inside the worktree.
 *   - A scrubbed environment (see `claudeEnv`). The reviewed code is untrusted.
 *
 * A failure never throws: it comes back as `status: "failed"` with a reason,
 * so one bad process cannot stop a run. The environment is never logged.
 */

import { spawn } from "node:child_process";

export type FailureReason =
  "timeout" | "invalid output" | "usage limit" | "process error";

export interface ClaudeRunOptions {
  /** Executable to start. Tests give a fake. */
  command?: string;
  /** Directory the process starts in: the worktree of the head commit. */
  cwd: string;
  /** Alias or full model name for `--model`. */
  model: string;
  /** Instructions appended to Claude Code's system prompt. */
  systemPrompt: string;
  /** What to do this time, sent on stdin. */
  task: string;
  /** JSON Schema of the output (`--json-schema`). Must describe an object. */
  schema: object;
  timeoutMs: number;
  /** Environment to scrub and pass on. Default: the current process's. */
  env?: NodeJS.ProcessEnv;
}

export type ClaudeRunResult =
  | { status: "ok"; output: unknown; costUsd?: number; durationMs: number }
  | {
      status: "failed";
      reason: FailureReason;
      detail: string;
      durationMs: number;
    };

/** Tools the process may use. Bash exists only to be narrowed to git below. */
const TOOLS = "Read,Grep,Glob,Bash";

/** Permission rules that auto-approve, anything else is denied (`dontAsk`). */
const ALLOWED_TOOLS = Object.freeze([
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
]);

/** `--output=<file>` makes git write a file. */
const DISALLOWED_TOOLS = Object.freeze(["Bash(git * --output*)"]);

/** Time between asking a timed-out process to stop and killing it. */
const KILL_GRACE_MS = 5_000;

/** Longest piece of process output quoted in a failure detail. */
const DETAIL_LENGTH = 300;

/**
 * Variables a `claude -p` process may see. HOME and USER are what the logged-in
 * subscription (keychain or config directory) needs. Everything else is left
 * out on purpose: `PR_REVIEW_*`, `GH_TOKEN` and other tokens, `ANTHROPIC_*`,
 * `GIT_*`, cloud and SSH agent variables.
 */
const CLAUDE_ENV_ALLOWLIST =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|LANG|LC_[A-Z]+|TZ|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|(?:HTTPS?|NO|ALL)_PROXY|(?:https?|no|all)_proxy)$/;

/** Matches the message Claude Code prints when the subscription limit is hit. */
const USAGE_LIMIT =
  /usage limit|hit your (?:\w+ )?limit|limit reached|rate.?limit/i;

/**
 * @returns Only the variables of `env` that a `claude -p` process needs.
 */
export function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = Object.fromEntries(
    Object.entries(env).filter(([name]) => CLAUDE_ENV_ALLOWLIST.test(name)),
  );
  // Parallel Reviewers read the same worktree: do not let `git` take locks.
  scrubbed.GIT_OPTIONAL_LOCKS = "0";
  return scrubbed;
}

/**
 * @returns The arguments of the process. The task goes on stdin, because
 *   `--tools` and `--allowedTools` take a list and would swallow a prompt
 *   argument.
 */
export function claudeArgs(
  options: Pick<ClaudeRunOptions, "model" | "systemPrompt" | "schema">,
): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(options.schema),
    "--model",
    options.model,
    "--append-system-prompt",
    options.systemPrompt,
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--tools",
    TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--allowedTools",
    ...ALLOWED_TOOLS,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_LENGTH
    ? `${flat.slice(0, DETAIL_LENGTH)}...`
    : flat;
}

/** The `result` message of the JSON `claude -p` printed, if there is one. */
function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    parsed = parsed.findLast((m) => isRecord(m) && m.type === "result");
  }
  return isRecord(parsed) ? parsed : undefined;
}

interface Exit {
  spawnError?: Error;
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function execute(
  command: string,
  args: string[],
  options: Pick<ClaudeRunOptions, "cwd" | "task" | "timeoutMs" | "env">,
): Promise<Exit> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exit: Partial<Exit>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        timedOut,
        code: null,
        signal: null,
        stdout,
        stderr,
        ...exit,
      });
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: claudeEnv(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so a timeout stops what the process started too.
      detached: true,
    });
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);

    // Decode as UTF-8 so a multi-byte character split across chunks survives.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.on("error", (spawnError) => finish({ spawnError }));
    child.on("close", (code, signal) => finish({ code, signal }));
    child.stdin.end(options.task);
  });
}

/**
 * Runs `claude -p` once with the safety rules above and parses its output.
 * Never throws.
 */
export async function runClaude(
  options: ClaudeRunOptions,
): Promise<ClaudeRunResult> {
  const command = options.command ?? "claude";
  const started = Date.now();
  const failed = (reason: FailureReason, detail: string): ClaudeRunResult => ({
    status: "failed",
    reason,
    detail,
    durationMs: Date.now() - started,
  });

  const exit = await execute(command, claudeArgs(options), options);

  if (exit.spawnError) {
    return failed(
      "process error",
      `could not start ${command}: ${exit.spawnError.message}`,
    );
  }
  if (exit.timedOut) {
    return failed(
      "timeout",
      `claude -p did not finish within ${Math.round(options.timeoutMs / 1000)}s and was stopped`,
    );
  }

  const envelope = parseEnvelope(exit.stdout);
  const resultText =
    typeof envelope?.result === "string" ? envelope.result : exit.stdout;
  const errored = exit.code !== 0 || envelope?.is_error === true;

  if (errored) {
    const message = `${resultText} ${exit.stderr}`;
    if (envelope?.api_error_status === 429 || USAGE_LIMIT.test(message)) {
      return failed(
        "usage limit",
        `claude -p hit the usage limit: ${quote(message)}`,
      );
    }
    const how = exit.signal
      ? `was stopped by ${exit.signal}`
      : exit.code !== 0
        ? `exited with code ${exit.code}`
        : "reported an error";
    return failed("process error", `claude -p ${how}: ${quote(message)}`);
  }

  if (!envelope) {
    return failed("invalid output", "claude -p did not print a JSON result");
  }

  let output: unknown = envelope.structured_output;
  if (output === undefined || output === null) {
    try {
      output = JSON.parse(resultText);
    } catch {
      return failed(
        "invalid output",
        "claude -p returned no structured output and the text is not JSON",
      );
    }
  }
  return {
    status: "ok",
    output,
    costUsd:
      typeof envelope.total_cost_usd === "number"
        ? envelope.total_cost_usd
        : undefined,
    durationMs: Date.now() - started,
  };
}
