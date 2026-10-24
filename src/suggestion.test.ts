import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "./diff.ts";
import { checkSuggestion } from "./suggestion.ts";

const files = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
@@ -20,2 +21,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`);

const check = (
  suggestion: string | undefined,
  line: number | undefined,
  endLine?: number,
  path = "src/a.ts",
) => checkSuggestion({ path, line, endLine, suggestion }, files);

test("a replacement for one line of a hunk is eligible", () => {
  assert.deepEqual(check("const b = 30;", 2), {
    ok: true,
    suggestion: "const b = 30;",
  });
});

test("a replacement for a range inside one hunk is eligible, with any number of lines", () => {
  assert.deepEqual(check("const b = 3;\nconst c = 40;\nconst z = 0;", 2, 3), {
    ok: true,
    suggestion: "const b = 3;\nconst c = 40;\nconst z = 0;",
  });
});

test("a trailing newline and Windows line endings are normalised", () => {
  assert.deepEqual(check("const b = 30;\r\nconst c = 40;\r\n", 2, 3), {
    ok: true,
    suggestion: "const b = 30;\nconst c = 40;",
  });
});

test("a range across two hunks is not eligible", () => {
  const result = check("x", 4, 22);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not anchored/);
});

test("a Finding outside the changed hunks is not eligible", () => {
  assert.equal(check("x", 10).ok, false);
  assert.equal(check("x", 2, undefined, "src/other.ts").ok, false);
  assert.equal(check("x", 1, undefined, "src/old.ts").ok, false);
});

test("no suggestion, no line, or no path is not eligible", () => {
  assert.equal(check(undefined, 2).ok, false);
  assert.equal(check("x", undefined).ok, false);
  assert.equal(checkSuggestion({ suggestion: "x" } as never, files).ok, false);
});

test("an empty suggestion is described in prose, not suggested", () => {
  for (const empty of ["", "\n", "  \n  "]) {
    assert.deepEqual(check(empty, 2), {
      ok: false,
      reason: "the suggestion is empty",
    });
  }
});

test("a suggestion with a code fence would end the block early", () => {
  const result = check("a\n```\nb", 2);
  assert.deepEqual(result, {
    ok: false,
    reason: "the suggestion contains a code fence",
  });
});

test("a suggestion equal to the current lines is not a change", () => {
  const result = check("const b = 3;\nconst c = 4;", 2, 3);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /equals/);
});
