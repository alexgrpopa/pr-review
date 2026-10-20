import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "./finding.ts";
import { fingerprint } from "./fingerprint.ts";
import {
  mergeCandidates,
  mergeGroups,
  mergeIdentical,
  toCandidate,
} from "./merge.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "correctness",
    severity: "minor",
    confidence: 0.6,
    path: "src/a.ts",
    line: 1,
    title: "Missing check",
    body: "b",
    fixPrompt: "f",
    ...overrides,
  };
}

test("a Candidate carries its Fingerprint and Reviewer", () => {
  const candidate = toCandidate(finding());
  assert.equal(candidate.fingerprint, fingerprint(finding()));
  assert.deepEqual(candidate.fingerprints, [candidate.fingerprint]);
  assert.deepEqual(candidate.reviewers, ["correctness"]);
});

test("identical Fingerprints merge: the most serious is the primary", () => {
  const merged = mergeIdentical([
    finding({ severity: "minor", confidence: 0.9, line: 4 }),
    finding({
      severity: "major",
      confidence: 0.5,
      line: 8,
      title: "missing CHECK.",
    }),
    finding({ title: "Other", reviewer: "security" }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].severity, "major");
  assert.equal(merged[0].line, 8);
  assert.equal(merged[0].confidence, 0.9);
  assert.equal(merged[0].fingerprints.length, 1);
});

test("the same title from two Reviewers is not identical", () => {
  assert.equal(
    mergeIdentical([finding(), finding({ reviewer: "security" })]).length,
    2,
  );
});

test("a merged group keeps every Fingerprint and Reviewer", () => {
  const a = toCandidate(finding({ reviewer: "security", severity: "major" }));
  const b = toCandidate(
    finding({ reviewer: "correctness", severity: "minor" }),
  );
  const merged = mergeCandidates([b, a]);
  assert.equal(merged.reviewer, "security");
  assert.equal(merged.fingerprint, a.fingerprint);
  assert.deepEqual(merged.fingerprints, [a.fingerprint, b.fingerprint]);
  assert.deepEqual(merged.reviewers, ["correctness", "security"]);
  assert.throws(() => mergeCandidates([]), /empty/);
});

test("groups are merged in place of their first member", () => {
  const list = [
    toCandidate(finding({ title: "one" })),
    toCandidate(finding({ title: "two", reviewer: "security" })),
    toCandidate(finding({ title: "three" })),
    toCandidate(finding({ title: "four", reviewer: "architecture" })),
  ];
  const result = mergeGroups(list, [[3, 1]]);
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((c) => c.title),
    ["one", "four", "three"], // equal Findings: the order of compareFindings
  );
  assert.deepEqual(result[1].reviewers, ["architecture", "security"]);
  assert.equal(mergeGroups(list, []).length, 4);
});
