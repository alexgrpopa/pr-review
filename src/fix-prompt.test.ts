import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFixPrompt,
  checkFixPrompt,
  combineFixPrompts,
  fixPromptFor,
  locationOf,
} from "./fix-prompt.ts";

const finding = {
  path: "src/pages/index.astro",
  line: 3,
  endLine: 5,
  title: "Missing alt text",
  body: "The image has no `alt`, so a screen reader cannot describe it.",
  fixPrompt:
    "In src/pages/index.astro lines 3-5, add an alt attribute describing the image.",
};

test("a prompt with the path and no dangling reference is self-contained", () => {
  assert.deepEqual(checkFixPrompt(finding), { ok: true });
});

test("an empty or missing prompt is not", () => {
  assert.equal(checkFixPrompt({ ...finding, fixPrompt: "  " }).ok, false);
  assert.equal(
    checkFixPrompt({ path: "a", fixPrompt: undefined as never }).ok,
    false,
  );
});

test("a prompt without the path is not", () => {
  const result = checkFixPrompt({
    ...finding,
    fixPrompt: "Add an alt attribute to the image.",
  });
  assert.equal(result.ok, false);
  assert.match(
    (result as { reason: string }).reason,
    /src\/pages\/index\.astro/,
  );
});

test("a prompt that points at the comment it came from is not", () => {
  for (const reference of [
    "Do what the comment above says.",
    "Fix this finding.",
    "Apply the finding above.",
    "As mentioned above, add an alt.",
    "See above.",
    "Address the previous comment.",
    "Resolve the thread below.",
  ]) {
    const result = checkFixPrompt({
      ...finding,
      fixPrompt: `In src/pages/index.astro: ${reference}`,
    });
    assert.equal(result.ok, false, reference);
  }
});

test("everyday words are not mistaken for a reference", () => {
  assert.deepEqual(
    checkFixPrompt({
      ...finding,
      fixPrompt:
        "In src/pages/index.astro, fix the review summary and the comment parser so they run above the fold.",
    }),
    { ok: true },
  );
});

test("a change-wide Finding needs no path in its prompt", () => {
  assert.deepEqual(
    checkFixPrompt({ fixPrompt: "Add a test for the new Verdict rules." }),
    { ok: true },
  );
});

test("locationOf", () => {
  assert.equal(locationOf(finding), "src/pages/index.astro:3-5");
  assert.equal(locationOf({ path: "a.ts", line: 4, endLine: 4 }), "a.ts:4");
  assert.equal(locationOf({ path: "a.ts" }), "a.ts");
  assert.equal(locationOf({}), "the change as a whole");
});

test("a valid prompt is kept as it is", () => {
  assert.equal(fixPromptFor(finding), finding.fixPrompt);
});

test("a missing or invalid prompt is built from the Finding", () => {
  const built = fixPromptFor({
    ...finding,
    fixPrompt: "Do the comment above.",
  });
  assert.match(built, /^In src\/pages\/index\.astro:3-5: Missing alt text/);
  assert.ok(built.includes(finding.body));
  assert.equal(
    checkFixPrompt({ path: finding.path, fixPrompt: built }).ok,
    true,
  );
});

test("a built prompt includes the exact replacement when there is a Suggestion", () => {
  const built = buildFixPrompt(
    { ...finding, endLine: undefined },
    '<img src="a.png" alt="A logo">',
  );
  assert.match(
    built,
    /Replace line 3 of src\/pages\/index\.astro with exactly:/,
  );
  assert.ok(built.includes('~~~\n<img src="a.png" alt="A logo">\n~~~'));
  assert.match(
    buildFixPrompt(finding, "x"),
    /Replace lines 3 to 5 of src\/pages\/index\.astro/,
  );
});

test("a built prompt for a change-wide Finding says so", () => {
  const built = buildFixPrompt({
    title: "No tests",
    body: "Nothing tests it.",
  });
  assert.match(
    built,
    /^In this repository, concerning the whole change: No tests/,
  );
});

test("the combined prompt numbers every Finding and keeps each prompt whole", () => {
  const second = {
    severity: "minor" as const,
    title: "Unused import",
    path: "src/b.ts",
    line: 1,
    fixPrompt: "In src/b.ts line 1, remove the unused import.",
  };
  const combined = combineFixPrompts([
    { ...finding, severity: "major" },
    second,
  ])!;
  assert.match(combined, /^Resolve the following 2 issues/);
  assert.ok(
    combined.includes(
      "## 1. [major] Missing alt text (src/pages/index.astro:3-5)",
    ),
  );
  assert.ok(combined.includes("## 2. [minor] Unused import (src/b.ts:1)"));
  assert.ok(combined.includes(finding.fixPrompt));
  assert.ok(combined.includes(second.fixPrompt));
  assert.ok(combined.indexOf("## 1.") < combined.indexOf("## 2."));
});

test("there is no combined prompt without Findings", () => {
  assert.equal(combineFixPrompts([]), null);
});
