import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAX_LINES, parseCliArgs } from "./args.ts";

test("no arguments: the current branch's pull request, default limit", () => {
  assert.deepEqual(parseCliArgs([]), {
    pr: undefined,
    maxLines: DEFAULT_MAX_LINES,
    dryRun: false,
    help: false,
  });
  assert.equal(DEFAULT_MAX_LINES, 3000);
});

test("--pr, --max-lines and --dry-run are parsed", () => {
  assert.deepEqual(
    parseCliArgs(["--pr", "33", "--max-lines", "5000", "--dry-run"]),
    { pr: 33, maxLines: 5000, dryRun: true, help: false },
  );
  assert.equal(parseCliArgs(["--pr=12"]).pr, 12);
});

test("--help is recognised", () => {
  assert.equal(parseCliArgs(["--help"]).help, true);
  assert.equal(parseCliArgs(["-h"]).help, true);
});

test("a bad number is rejected, naming the option and the usage", () => {
  for (const value of ["abc", "0", "1.5", "", "1e3"]) {
    assert.throws(
      () => parseCliArgs(["--pr", value]),
      /--pr needs a positive whole number[\s\S]*Usage: pr-review/,
      `--pr ${value}`,
    );
    assert.throws(
      () => parseCliArgs(["--max-lines", value]),
      /--max-lines needs a positive whole number/,
      `--max-lines ${value}`,
    );
  }
});

test("a negative number is rejected", () => {
  assert.throws(() => parseCliArgs(["--pr=-3"]), /--pr needs a positive/);
  assert.throws(
    () => parseCliArgs(["--max-lines=-3"]),
    /--max-lines needs a positive/,
  );
});

test("an unknown option or a stray argument is rejected with the usage", () => {
  assert.throws(() => parseCliArgs(["--post"]), /Usage: pr-review/);
  assert.throws(() => parseCliArgs(["33"]), /Usage: pr-review/);
  assert.throws(() => parseCliArgs(["--pr"]), /Usage: pr-review/);
});
