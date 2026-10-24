import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractFingerprints,
  fingerprint,
  fingerprintMarker,
  fingerprintMarkers,
  normaliseTitle,
} from "./fingerprint.ts";

const base = {
  path: "src/pages/index.astro",
  reviewer: "correctness",
  title: "Missing alt text on the hero image",
};

test("a Fingerprint is 16 hex characters and stable", () => {
  const fp = fingerprint(base);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fingerprint({ ...base }), fp);
  // Pinned: changing the algorithm would re-post every Finding already posted.
  assert.equal(fp, "d80fe4f023af8650");
  assert.equal(fp, fingerprint({ ...base, path: "./src/pages/index.astro" }));
});

test("titles that normalise equal give the same Fingerprint", () => {
  const same = [
    "missing ALT text on the hero image",
    "  Missing   alt text on the hero image  ",
    "Missing alt-text on the hero image.",
    "Missing alt text on the hero image!!",
    "Missing alt text on the hero image (line 12)",
    "Missing alt text on the hero image at line 12",
    "Missing alt text on the hero image on lines 12-14",
    "Missing alt text on the hero image (L12-L14)",
    "Missing alt text on the hero image: line 7",
    "Missing alt text on the hero image :12",
  ];
  const expected = fingerprint(base);
  for (const title of same) {
    assert.equal(fingerprint({ ...base, title }), expected, title);
  }
});

test("a different path, category or title gives a different Fingerprint", () => {
  const fp = fingerprint(base);
  assert.notEqual(fingerprint({ ...base, reviewer: "security" }), fp);
  assert.notEqual(fingerprint({ ...base, path: "src/pages/about.astro" }), fp);
  assert.notEqual(fingerprint({ ...base, path: undefined }), fp);
  assert.notEqual(
    fingerprint({ ...base, title: "Missing alt text on the logo" }),
    fp,
  );
});

test("fields cannot run into each other", () => {
  assert.notEqual(
    fingerprint({ path: "a", reviewer: "bc", title: "d" }),
    fingerprint({ path: "ab", reviewer: "c", title: "d" }),
  );
});

test("normalisation strips only a trailing line reference", () => {
  assert.equal(normaliseTitle("Line 3 is wrong"), "line 3 is wrong");
  assert.equal(normaliseTitle("Uses html5 and sha1"), "uses html5 and sha1");
  assert.equal(normaliseTitle("Rename pixel2"), "rename pixel2");
  assert.equal(normaliseTitle("Offline mode (line 3)"), "offline mode");
  assert.equal(normaliseTitle("Fix it (line 3) (L4)"), "fix it");
  assert.equal(normaliseTitle("Café: déjà vu?"), "café déjà vu");
  assert.equal(normaliseTitle("?!"), "");
});

test("the marker is hidden and round-trips through extraction", () => {
  const fp = fingerprint(base);
  const marker = fingerprintMarker(fp);
  assert.equal(marker, `<!-- pr-review:fingerprint:${fp} -->`);
  assert.deepEqual([...extractFingerprints([`text\n\n${marker}\n`])], [fp]);
});

test("a marker for something that is not a Fingerprint is refused", () => {
  assert.throws(() => fingerprintMarker("not-a-hash"), /not a Fingerprint/);
  assert.throws(
    () => fingerprintMarker("ABCDEF0123456789"),
    /not a Fingerprint/,
  );
});

test("extraction reads every marker of every body and ignores the rest", () => {
  const a = fingerprint(base);
  const b = fingerprint({ ...base, reviewer: "security" });
  const c = fingerprint({ ...base, reviewer: "necessity" });
  const bodies = [
    `A comment\n${fingerprintMarkers([a, b])}`,
    "No marker here, just <!-- some other comment --> text",
    `<!--pr-review:fingerprint:${c}-->`,
    "<!-- pr-review:fingerprint:zzzzzzzzzzzzzzzz -->",
    "<!-- pr-review:fingerprint:abc -->",
    `${a} without the marker`,
  ];
  assert.deepEqual([...extractFingerprints(bodies)].sort(), [a, b, c].sort());
  assert.equal(extractFingerprints([]).size, 0);
});
