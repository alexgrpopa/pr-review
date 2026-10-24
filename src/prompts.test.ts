import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEWERS } from "./config.ts";
import { SEVERITIES } from "./finding.ts";
import { loadPrompt } from "./reviewers.ts";

/** What each prompt must say its category is. */
const LANES: Record<string, RegExp> = {
  architecture: /single category is \*\*architecture\*\*/,
  "coding-standards": /single category is \*\*coding standards\*\*/,
  security: /single category is \*\*security\*\*/,
  necessity: /single category is \*\*necessity/,
  correctness:
    /single category is \*\*correctness, including accessibility\*\*/,
};

for (const reviewer of REVIEWERS) {
  test(`the ${reviewer.name} prompt states its lane and the shared rules`, async () => {
    const prompt = await loadPrompt(reviewer.promptFile);

    assert.match(prompt, LANES[reviewer.name]);
    assert.match(prompt, /nothing outside it/);

    for (const source of [
      "CLAUDE.md",
      "AGENTS.md",

      "CONTEXT.md",
      "docs/adr/",
    ]) {
      assert.ok(prompt.includes(source), source);
    }
    assert.match(prompt, /respect it/);
    assert.match(prompt, /vocabulary/);

    for (const field of [
      "severity",
      "confidence",
      "path",
      "line",
      "endLine",
      "title",
      "body",
      "suggestion",
      "fixPrompt",
    ]) {
      assert.ok(prompt.includes(`\`${field}\``), field);
    }
    for (const severity of SEVERITIES) {
      assert.ok(prompt.includes(`\`${severity}\``), severity);
    }
    assert.match(prompt, /Never invent a problem/);
    assert.ok(prompt.includes('{ "findings": [] }'));
  });
}

test("each prompt leaves the other categories to the other Reviewers", async () => {
  for (const reviewer of REVIEWERS) {
    const prompt = await loadPrompt(reviewer.promptFile);
    assert.match(prompt, /Other Reviewers cover the other categories/);
  }
});

test("the lanes do not overlap on their headline topics", async () => {
  const lookFor = async (name: string) => {
    const prompt = await loadPrompt(`${name}.md`);
    return prompt.split("## What to look for")[1].split("## What not")[0];
  };
  assert.match(await lookFor("architecture"), /ADR|boundar/i);
  assert.match(await lookFor("coding-standards"), /linters are not run/i);
  assert.match(await lookFor("security"), /secrets/i);
  assert.match(await lookFor("necessity"), /dead code/i);
  assert.match(await lookFor("correctness"), /accessibility/i);
  assert.doesNotMatch(await lookFor("architecture"), /accessibility/i);
  assert.doesNotMatch(await lookFor("security"), /accessibility/i);
});
