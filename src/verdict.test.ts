import assert from "node:assert/strict";
import { test } from "node:test";
import { decideVerdict } from "./verdict.ts";

const healthy = { reviewersOk: 5, reviewersFailed: 0 };

test("a critical or major Finding requests changes", () => {
  for (const severity of ["critical", "major"] as const) {
    const result = decideVerdict({
      ...healthy,
      foundSeverities: ["minor", severity],
    });
    assert.equal(result.verdict, "REQUEST_CHANGES", severity);
    assert.match(result.reason, /critical or major/);
  }
});

test("no Finding at or above the Threshold approves", () => {
  const result = decideVerdict({ ...healthy, foundSeverities: [] });
  assert.equal(result.verdict, "APPROVE");
});

test("minor Findings only give a plain comment", () => {
  const result = decideVerdict({
    ...healthy,
    foundSeverities: ["minor", "minor"],
  });
  assert.equal(result.verdict, "COMMENT");
  assert.match(result.reason, /2 Findings/);
});

test("Findings below the Threshold do not count", () => {
  assert.equal(
    decideVerdict({ ...healthy, foundSeverities: ["nit", "nit"] }).verdict,
    "APPROVE",
  );
  assert.equal(
    decideVerdict({
      ...healthy,
      foundSeverities: ["minor"],
      threshold: "major",
    }).verdict,
    "APPROVE",
  );
});

test("a failed Reviewer never approves, even with no Findings", () => {
  const result = decideVerdict({
    foundSeverities: [],
    reviewersOk: 4,
    reviewersFailed: 1,
  });
  assert.equal(result.verdict, "COMMENT");
  assert.match(result.reason, /1 Reviewer did not complete/);
});

test("a failed Reviewer still requests changes for a major Finding of the others", () => {
  assert.equal(
    decideVerdict({
      foundSeverities: ["major"],
      reviewersOk: 4,
      reviewersFailed: 1,
    }).verdict,
    "REQUEST_CHANGES",
  );
});

test("no Reviewer that completed, or none run, never approves", () => {
  for (const input of [
    { reviewersOk: 0, reviewersFailed: 5 },
    { reviewersOk: 0, reviewersFailed: 0 },
  ]) {
    const result = decideVerdict({ ...input, foundSeverities: [] });
    assert.equal(result.verdict, "COMMENT");
    assert.match(result.reason, /No Reviewer completed/);
  }
});

test("the Verdict follows the Findings found, whether or not they are new", () => {
  // The caller passes every Finding found in the run, including those already
  // posted earlier and those left out by the cap: a remaining major Finding
  // keeps the changes requested.
  assert.equal(
    decideVerdict({ ...healthy, foundSeverities: ["major", "minor"] }).verdict,
    "REQUEST_CHANGES",
  );
});
