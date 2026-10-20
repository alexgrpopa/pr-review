/**
 * Shared helpers for the pr-review script tests.
 *
 * `createFakeClaude` writes an executable that stands in for `claude`. Give it
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
 * `print(text)` prints raw text, and `sleep(ms)` waits. Every call is recorded,
 * including when it started and ended.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
