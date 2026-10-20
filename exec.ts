/**
 * Running child processes for a Review run: `git` and `gh` only, in a
 * scrubbed environment, and the error type that names the step that failed.
 */

import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

/** Runs a command; resolves with stdout, rejects on failure. */
export type Exec = (
  file: string,
  args: string[],
  options?: ExecOptions,
) => Promise<string>;

/**
 * Environment variables `git` and `gh` may see. Everything else is left out,
 * so a `PR_REVIEW_*` value or an unrelated token that happens to be exported
 * never reaches a child process.
 */
const CHILD_ENV_ALLOWLIST =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|LANG|LC_[A-Z]+|TZ|XDG_[A-Z_]+|SSH_AUTH_SOCK|GH_TOKEN|GITHUB_TOKEN|GH_HOST|GH_CONFIG_DIR|GIT_SSH_COMMAND|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|(?:HTTPS?|NO|ALL)_PROXY|(?:https?|no|all)_proxy)$/;

/**
 * @returns Only the variables of `env` that `git` and `gh` need.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => CHILD_ENV_ALLOWLIST.test(name)),
    ),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** How much of a command's stderr goes into its error message. */
const STDERR_LIMIT = 400;

export const defaultExec: Exec = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: childEnv(process.env),
      timeout: options.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim().slice(-STDERR_LIMIT);
      reject(
        new Error(
          `${file} ${args.slice(0, 2).join(" ")} ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });

/** A failure that names the step of the Review run it happened in. */
export class StepError extends Error {
  step: string;
  constructor(step: string, cause: unknown) {
    super(
      `${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.step = step;
  }
}
