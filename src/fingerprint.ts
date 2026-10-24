/**
 * Fingerprints: what identifies a Finding across Review runs, so one already
 * posted is not posted again.
 *
 * A Fingerprint is a hash of the path, the Reviewer category and a normalised
 * title. The line is left out on purpose: it moves whenever code above it
 * changes. The title is normalised (see {@link normaliseTitle}) so that
 * rewording that does not change the meaning (case, spacing, punctuation, a
 * trailing "(line 12)") gives the same Fingerprint. Two Findings of one
 * Reviewer in one file with the same title therefore count as one Finding.
 *
 * Every posted comment carries its Fingerprints in a hidden marker
 * ({@link fingerprintMarker}); the next run reads them back from the pull
 * request's existing comments with {@link extractFingerprints} and skips any
 * Finding it finds there. Only pass bodies written by the Review bot: anyone
 * else can type a marker.
 */

import { createHash } from "node:crypto";
import type { Finding } from "./finding.ts";

const FINGERPRINT_LENGTH = 16;

/** A line reference at the end of a title: "(line 12)", "at L12-L14", ":12". */
const TRAILING_LINE_REFERENCE = [
  /[\s([]*(?<![\p{L}\p{N}])(?:(?:at|on|in|near)\s+)?lines?\s*\d+(?:\s*(?:-|–|—|to)\s*(?:lines?\s*)?\d+)?[)\]]*\s*$/u,
  /[\s([]*(?<![\p{L}\p{N}])(?:(?:at|on|in|near)\s+)?l\d+(?:\s*(?:-|–|—)\s*l?\d+)?[)\]]*\s*$/u,
  /:\d+(?:\s*(?:-|–|—)\s*\d+)?\s*$/u,
];

/**
 * @returns The title in the form that is hashed: lower case, without a
 *   trailing line reference, punctuation turned into spaces, spaces collapsed.
 */
export function normaliseTitle(title: string): string {
  let text = title.normalize("NFKC").toLowerCase().trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const pattern of TRAILING_LINE_REFERENCE) {
      const stripped = text.replace(pattern, "");
      if (stripped !== text) {
        text = stripped.trimEnd();
        changed = true;
      }
    }
  }
  return text.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** @returns The Fingerprint of a Finding (16 hexadecimal characters). */
export function fingerprint(
  finding: Pick<Finding, "path" | "reviewer" | "title">,
): string {
  const path = (finding.path ?? "").replace(/^\.\//, "");
  return createHash("sha256")
    .update(
      [path, finding.reviewer, normaliseTitle(finding.title)].join("\u0000"),
    )
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

const MARKER = /<!--\s*pr-review:fingerprint:([0-9a-f]{16})\s*-->/g;

/** @returns The hidden marker to put in a posted comment for a Fingerprint. */
export function fingerprintMarker(fp: string): string {
  if (!/^[0-9a-f]{16}$/.test(fp)) throw new Error(`not a Fingerprint: ${fp}`);
  return `<!-- pr-review:fingerprint:${fp} -->`;
}

/** @returns The markers for every Fingerprint, one per line. */
export function fingerprintMarkers(fps: readonly string[]): string {
  return fps.map(fingerprintMarker).join("\n");
}

/**
 * @returns Every Fingerprint marked in the given comment bodies (any number of
 *   markers per body).
 */
export function extractFingerprints(bodies: Iterable<string>): Set<string> {
  const found = new Set<string>();
  for (const body of bodies) {
    for (const match of body.matchAll(MARKER)) found.add(match[1]);
  }
  return found;
}
