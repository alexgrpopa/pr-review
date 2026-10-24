import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FINDINGS, MIN_CONFIDENCE } from "./config.ts";
import type { Finding, Severity } from "./finding.ts";
import {
  applyThreshold,
  capFindings,
  compareFindings,
  meetsThreshold,
} from "./selection.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "correctness",
    severity: "minor",
    confidence: 0.8,
    path: "src/a.ts",
    line: 1,
    title: "t",
    body: "b",
    fixPrompt: "f",
    ...overrides,
  };
}

test("meetsThreshold compares Severities", () => {
  assert.equal(meetsThreshold("critical"), true);
  assert.equal(meetsThreshold("major"), true);
  assert.equal(meetsThreshold("minor"), true);
  assert.equal(meetsThreshold("nit"), false);
  assert.equal(meetsThreshold("minor", "major"), false);
  assert.equal(meetsThreshold("nit", "nit"), true);
});

test("by default nit and low-confidence Findings are dropped, minor and above kept", () => {
  const input = [
    finding({ title: "critical", severity: "critical" }),
    finding({ title: "major", severity: "major" }),
    finding({ title: "minor", severity: "minor" }),
    finding({ title: "nit", severity: "nit" }),
    finding({ title: "unsure", severity: "major", confidence: 0.2 }),
    finding({ title: "edge", severity: "minor", confidence: MIN_CONFIDENCE }),
    finding({ title: "just below", confidence: MIN_CONFIDENCE - 0.01 }),
  ];
  const result = applyThreshold(input);
  assert.deepEqual(
    result.kept.map((f) => f.title),
    ["critical", "major", "minor", "edge"],
  );
  assert.equal(result.belowThreshold, 1);
  assert.equal(result.lowConfidence, 2);
});

test("a nit with low confidence counts once, as below the Threshold", () => {
  const result = applyThreshold([
    finding({ severity: "nit", confidence: 0.1 }),
  ]);
  assert.deepEqual(
    [result.kept.length, result.belowThreshold, result.lowConfidence],
    [0, 1, 0],
  );
});

test("the Threshold and the minimum confidence are configurable", () => {
  const input = [
    finding({ severity: "nit", confidence: 0.3 }),
    finding({ severity: "minor", confidence: 0.3 }),
    finding({ severity: "major", confidence: 0.3 }),
  ];
  assert.equal(
    applyThreshold(input, { threshold: "nit", minConfidence: 0 }).kept.length,
    3,
  );
  const strict = applyThreshold(input, {
    threshold: "major",
    minConfidence: 0.2,
  });
  assert.deepEqual(
    strict.kept.map((f) => f.severity),
    ["major"],
  );
  assert.equal(strict.belowThreshold, 2);
});

test("the cap keeps the most serious first, then the most confident", () => {
  const severities: Severity[] = ["minor", "critical", "major", "minor"];
  const input = severities.map((severity, i) =>
    finding({ severity, title: `f${i}`, confidence: 0.5 + i / 10 }),
  );
  const { kept, leftOut } = capFindings(input, 3);
  assert.deepEqual(
    kept.map((f) => f.title),
    ["f1", "f2", "f3"],
  );
  assert.equal(leftOut, 1);
});

test("equal Severity and confidence are ordered by path, line, title and Reviewer", () => {
  const input = [
    finding({ path: "b.ts", line: 1, title: "z" }),
    finding({ path: "a.ts", line: 9, title: "z" }),
    finding({ path: "a.ts", line: 2, title: "z" }),
    finding({ path: "a.ts", line: 2, title: "a", reviewer: "security" }),
    finding({ path: "a.ts", line: 2, title: "a", reviewer: "architecture" }),
    finding({ path: undefined, line: undefined, title: "whole" }),
  ];
  const order = (list: Finding[]) =>
    capFindings(list, 100).kept.map(
      (f) => `${f.path}:${f.line}:${f.title}:${f.reviewer}`,
    );
  const expected = [
    "a.ts:2:a:architecture",
    "a.ts:2:a:security",
    "a.ts:2:z:correctness",
    "a.ts:9:z:correctness",
    "b.ts:1:z:correctness",
    "undefined:undefined:whole:correctness",
  ];
  assert.deepEqual(order(input), expected);
  assert.deepEqual(order([...input].reverse()), expected);
});

test("the default cap is 15 and the number left out is returned", () => {
  const input = Array.from({ length: 20 }, (_, i) =>
    finding({ title: `f${i}`, line: i + 1 }),
  );
  const { kept, leftOut } = capFindings(input);
  assert.equal(MAX_FINDINGS, 15);
  assert.equal(kept.length, 15);
  assert.equal(leftOut, 5);
  assert.equal(capFindings(input.slice(0, 15)).leftOut, 0);
  assert.equal(capFindings([]).leftOut, 0);
});

test("the cap is configurable and never mutates its input", () => {
  const input = [
    finding({ severity: "minor" }),
    finding({ severity: "major" }),
  ];
  const copy = structuredClone(input);
  assert.equal(capFindings(input, 1).kept[0].severity, "major");
  assert.deepEqual(input, copy);
  assert.deepEqual(capFindings(input, 0), { kept: [], leftOut: 2 });
});

test("compareFindings is a consistent order", () => {
  const a = finding({ severity: "major" });
  const b = finding({ severity: "minor" });
  assert.ok(compareFindings(a, b) < 0);
  assert.ok(compareFindings(b, a) > 0);
  assert.equal(compareFindings(a, { ...a }), 0);
});
