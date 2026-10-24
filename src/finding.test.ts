import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEWER_OUTPUT_SCHEMA,
  SEVERITIES,
  validateFinding,
  validateReviewerOutput,
} from "./finding.ts";

const valid = {
  reviewer: "correctness",
  severity: "major",
  confidence: 0.9,
  path: "src/a.astro",
  line: 4,
  endLine: 6,
  title: "Title",
  body: "Body",
  suggestion: "replacement",
  fixPrompt: "In src/a.astro lines 4-6, change X to Y.",
};

function without(value: Record<string, unknown>, ...keys: string[]) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

function errorsOf(value: unknown): string[] {
  const result = validateFinding(value);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors;
}

test("accepts a full Finding and returns it typed", () => {
  const result = validateFinding(valid);
  assert.deepEqual(result, { ok: true, value: valid });
});

test("accepts a Finding about the change as a whole", () => {
  const unanchored = without(valid, "path", "line", "endLine", "suggestion");
  assert.equal(validateFinding(unanchored).ok, true);
});

test("accepts every Severity and the edges of confidence", () => {
  for (const severity of SEVERITIES) {
    for (const confidence of [0, 1]) {
      assert.equal(
        validateFinding({ ...valid, severity, confidence }).ok,
        true,
      );
    }
  }
});

test("drops unknown properties", () => {
  const result = validateFinding({ ...valid, extra: 1 });
  assert.equal(result.ok && "extra" in result.value, false);
});

test("rejects what is not an object", () => {
  for (const value of [null, undefined, "x", 3, [], [valid]]) {
    assert.match(errorsOf(value)[0], /must be an object/);
  }
});

test("rejects a missing or empty required text", () => {
  for (const name of ["reviewer", "title", "body", "fixPrompt"]) {
    assert.match(
      errorsOf({ ...valid, [name]: undefined }).join(),
      new RegExp(`${name} must be a non-empty string`),
    );
    assert.match(
      errorsOf({ ...valid, [name]: "  " }).join(),
      new RegExp(`${name} must be`),
    );
    assert.match(errorsOf({ ...valid, [name]: 5 }).join(), new RegExp(name));
  }
});

test("rejects an unknown severity", () => {
  assert.match(errorsOf({ ...valid, severity: "blocker" })[0], /severity/);
  assert.match(errorsOf({ ...valid, severity: undefined })[0], /severity/);
});

test("rejects a confidence outside 0 to 1 or not a number", () => {
  for (const confidence of [-0.1, 1.1, NaN, Infinity, "0.5", undefined]) {
    assert.match(errorsOf({ ...valid, confidence })[0], /confidence/);
  }
});

test("rejects lines that are not positive integers", () => {
  for (const line of [0, -1, 1.5, "3", null]) {
    assert.match(errorsOf({ ...valid, line }).join(), /line must be/);
  }
  assert.match(errorsOf({ ...valid, endLine: 0 }).join(), /endLine must be/);
});

test("rejects an endLine before the line", () => {
  assert.match(errorsOf({ ...valid, line: 5, endLine: 4 })[0], /before line/);
});

test("rejects a line without a path, an endLine without a line", () => {
  assert.match(errorsOf(without(valid, "path")).join(), /line needs a path/);
  assert.match(errorsOf(without(valid, "line")).join(), /endLine needs a line/);
});

test("rejects an empty path", () => {
  assert.match(errorsOf({ ...valid, path: "" })[0], /path/);
});

test("rejects a suggestion that is not a string or has no line", () => {
  assert.match(errorsOf({ ...valid, suggestion: 3 })[0], /suggestion/);
  assert.match(
    errorsOf(without(valid, "path", "line", "endLine")).join(),
    /suggestion needs a line/,
  );
});

test("collects every error", () => {
  const errors = errorsOf({
    ...valid,
    severity: "x",
    confidence: 2,
    title: "",
  });
  assert.equal(errors.length, 3);
});

test("validateReviewerOutput stamps the Reviewer on every Finding", () => {
  const modelFinding = without(valid, "reviewer");
  const result = validateReviewerOutput("security", {
    findings: [modelFinding, { ...modelFinding, reviewer: "lying" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.map((f) => f.reviewer), [
    "security",
    "security",
  ]);
});

test("validateReviewerOutput accepts no Findings", () => {
  assert.deepEqual(validateReviewerOutput("security", { findings: [] }), {
    ok: true,
    value: [],
  });
});

test("validateReviewerOutput rejects output of the wrong shape", () => {
  for (const output of [null, [], "x", {}, { findings: "x" }]) {
    assert.equal(validateReviewerOutput("security", output).ok, false);
  }
});

test("validateReviewerOutput names the Finding that is invalid", () => {
  const result = validateReviewerOutput("security", {
    findings: [{ ...valid, severity: "x" }, 3],
  });
  assert.equal(result.ok, false);
  const errors = result.ok ? [] : result.errors;
  assert.match(errors[0], /^findings\[0\]: severity/);
  assert.match(errors[1], /^findings\[1\]: a Finding must be an object/);
});

test("the output schema requires what the validator requires", () => {
  const item = REVIEWER_OUTPUT_SCHEMA.properties.findings.items;
  assert.deepEqual(item.required, [
    "severity",
    "confidence",
    "title",
    "body",
    "fixPrompt",
  ]);
  assert.deepEqual(item.properties.severity.enum, [...SEVERITIES]);
  assert.equal("reviewer" in item.properties, false);
});
