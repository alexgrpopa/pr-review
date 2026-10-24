import assert from "node:assert/strict";
import { test } from "node:test";
import { PATH_FILTERS } from "./config.ts";
import { anchorFinding, diffGitArgs, parseDiff } from "./diff.ts";

/** Two hunks: right lines 3-9 and 20-24. */
const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,6 +3,7 @@ function one() {
 context3
 context4
-old5
+new5
+new6
 context6
 context7
 context8
@@ -20,4 +21,5 @@ function two() {
 context21
+added22
 context22
-gone
+changed
 context24
`;

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+one
+two
+three
`;

const DELETED = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

const RENAMED_EDITED = `diff --git a/src/before.ts b/src/after.ts
similarity index 80%
rename from src/before.ts
rename to src/after.ts
index 5555555..6666666 100644
--- a/src/before.ts
+++ b/src/after.ts
@@ -1,3 +1,3 @@
 keep
-before
+after
 keep
`;

const PURE_RENAME = `diff --git a/src/x.ts b/src/y.ts
similarity index 100%
rename from src/x.ts
rename to src/y.ts
`;

const BINARY = `diff --git a/img/logo.png b/img/logo.png
index 7777777..8888888 100644
Binary files a/img/logo.png and b/img/logo.png differ
`;

const MODE_ONLY = `diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
`;

const TRICKY = `diff --git "a/src/caf\\303\\251 file.ts" "b/src/caf\\303\\251 file.ts"
index 1..2 100644
--- "a/src/caf\\303\\251 file.ts"
+++ "b/src/caf\\303\\251 file.ts"
@@ -1,3 +1,2 @@
 first
--- not a header
-- also removed
+kept
\\ No newline at end of file
`;

const ALL = [
  MODIFIED,
  ADDED,
  DELETED,
  RENAMED_EDITED,
  PURE_RENAME,
  BINARY,
  MODE_ONLY,
  TRICKY,
].join("");

const files = parseDiff(ALL);
const byPath = (path: string) => files.find((f) => f.path === path)!;

test("the diff is split into one entry per file, in order", () => {
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ["src/a.ts", "modified"],
      ["src/new.ts", "added"],
      ["src/old.ts", "deleted"],
      ["src/after.ts", "renamed"],
      ["src/y.ts", "renamed"],
      ["img/logo.png", "modified"],
      ["scripts/run.sh", "modified"],
      ["src/café file.ts", "modified"],
    ],
  );
});

test("a multi-hunk file has the right-side range of each hunk", () => {
  const { hunks, additions, deletions } = byPath("src/a.ts");
  assert.deepEqual(
    hunks.map((h) => [h.newStart, h.lines[0].line, h.lines.at(-1)!.line]),
    [
      [3, 3, 9],
      [21, 21, 25],
    ],
  );
  assert.equal(additions, 4);
  assert.equal(deletions, 2);
  assert.deepEqual(
    hunks[0].lines.map((l) => [l.line, l.kind, l.text]).slice(1, 5),
    [
      [4, "context", "context4"],
      [5, "added", "new5"],
      [6, "added", "new6"],
      [7, "context", "context6"],
    ],
  );
});

test("a renamed file is known by its new path and keeps the old one", () => {
  const renamed = byPath("src/after.ts");
  assert.equal(renamed.oldPath, "src/before.ts");
  assert.equal(renamed.hunks.length, 1);
  assert.equal(byPath("src/y.ts").oldPath, "src/x.ts");
  assert.deepEqual(byPath("src/y.ts").hunks, []);
});

test("binary files, mode changes and deleted files have no right-side lines", () => {
  assert.equal(byPath("img/logo.png").binary, true);
  assert.deepEqual(byPath("img/logo.png").hunks, []);
  assert.deepEqual(byPath("scripts/run.sh").hunks, []);
  assert.equal(byPath("src/old.ts").hunks[0].lines.length, 0);
  assert.equal(byPath("src/old.ts").deletions, 2);
});

test("hunk lines are counted, so removed lines that look like headers are not mistaken for them", () => {
  const file = byPath("src/café file.ts");
  assert.equal(file.hunks.length, 1);
  assert.deepEqual(
    file.hunks[0].lines.map((l) => l.text),
    ["first", "kept"],
  );
  assert.equal(file.deletions, 2);
});

test("a header with no count means one line", () => {
  const [file] = parseDiff(
    "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5 +5 @@\n-a\n+b\n",
  );
  assert.deepEqual(
    file.hunks.map((h) => [h.newStart, h.newLines]),
    [[5, 1]],
  );
});

test("text that is not a diff, and an empty diff, give no files", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("hello\nworld\n"), []);
});

const at = (path: string | undefined, line?: number, endLine?: number) =>
  anchorFinding({ path, line, endLine }, files);

test("lines inside a hunk are anchored: added and context lines", () => {
  assert.equal(at("src/a.ts", 5).anchored, true); // added
  assert.equal(at("src/a.ts", 4).anchored, true); // context
  assert.equal(at("src/a.ts", 3, 9).anchored, true); // whole hunk
  assert.equal(at("src/a.ts", 22).anchored, true);
  assert.equal(at("src/new.ts", 1, 3).anchored, true);
  assert.equal(at("src/after.ts", 2).anchored, true);
});

test("a path with a leading ./ is the same file", () => {
  assert.equal(at("./src/a.ts", 5).anchored, true);
});

test("lines outside every hunk are unanchored", () => {
  for (const line of [1, 2, 10, 20, 26, 100]) {
    assert.equal(at("src/a.ts", line).anchored, false, String(line));
  }
});

test("a range must lie in one hunk", () => {
  const result = at("src/a.ts", 8, 22);
  assert.equal(result.anchored, false);
  assert.match((result as { reason: string }).reason, /one changed hunk/);
  assert.equal(at("src/a.ts", 9, 10).anchored, false);
  assert.equal(at("src/new.ts", 2, 4).anchored, false);
});

test("a deleted file, a binary file, a pure rename and a mode change are unanchored", () => {
  const reason = (path: string) =>
    (at(path, 1) as { anchored: false; reason: string }).reason;
  assert.match(reason("src/old.ts"), /deleted/);
  assert.match(reason("img/logo.png"), /binary/);
  assert.match(reason("src/y.ts"), /no changed lines/);
  assert.match(reason("scripts/run.sh"), /no changed lines/);
});

test("the old path of a renamed file is not a file of the head commit", () => {
  assert.match(
    (at("src/before.ts", 1) as { reason: string }).reason,
    /not in the diff/,
  );
});

test("a file outside the diff, no path and no line are unanchored", () => {
  assert.equal(at("src/other.ts", 1).anchored, false);
  assert.match((at(undefined) as { reason: string }).reason, /whole/);
  assert.match((at("src/a.ts") as { reason: string }).reason, /no line/);
});

test("an empty diff anchors nothing", () => {
  assert.equal(anchorFinding({ path: "a", line: 1 }, []).anchored, false);
});

test("the git arguments exclude the path filters and refuse an unsafe ref", () => {
  const args = diffGitArgs("origin/main");
  assert.ok(args.includes("origin/main...HEAD"));
  for (const filter of PATH_FILTERS) {
    assert.ok(args.includes(`:(exclude)${filter}`), filter);
  }
  assert.ok(args.includes("--src-prefix=a/") && args.includes("--no-ext-diff"));
  assert.throws(() => diffGitArgs("--output=/tmp/x"), /unsafe/);
});
