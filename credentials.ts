/**
 * The Review bot's credentials, read from the untracked `.env.local`.
 *
 * Only the `PR_REVIEW_*` variables are looked at: nothing else in the file is
 * kept, and nothing is written to `process.env`, so no child process sees
 * them. Messages here name a variable, never its value.
 */

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export const APP_ID_VARIABLE = "PR_REVIEW_APP_ID";
export const PRIVATE_KEY_VARIABLE = "PR_REVIEW_APP_PRIVATE_KEY";

const SETUP_HINT = "see scripts/pr-review/README.md";

export interface Credentials {
  /** The GitHub App's ID. */
  appId: string;
  /** PEM private key of the App, with real newlines. */
  privateKey: string;
}

/**
 * Reads the credentials from the first of `files` that exists. Quotes are
 * handled by `util.parseEnv`; a literal `\n` in the key (the usual way to keep
 * a PEM on one line) becomes a real newline.
 * @throws When no file exists or a variable is missing or empty.
 */
export function readCredentials(files: string[]): Credentials {
  let text: string | undefined;
  let found = "";
  for (const file of files) {
    try {
      text = readFileSync(file, "utf8");
      found = file;
      break;
    } catch {
      // Try the next candidate.
    }
  }
  if (text === undefined) {
    throw new Error(
      `${APP_ID_VARIABLE} and ${PRIVATE_KEY_VARIABLE} must be set in .env.local, which was not found (${SETUP_HINT})`,
    );
  }
  const parsed = parseEnv(text);
  const read = (name: string): string => {
    const value = parsed[name]?.trim();
    if (!value) {
      throw new Error(`${name} is not set in ${found} (${SETUP_HINT})`);
    }
    return value;
  };
  const appId = read(APP_ID_VARIABLE);
  const privateKey = read(PRIVATE_KEY_VARIABLE).replace(/\\n/g, "\n");
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n/.test(privateKey)) {
    throw new Error(
      `${PRIVATE_KEY_VARIABLE} in ${found} is not a PEM private key (${SETUP_HINT})`,
    );
  }
  return { appId, privateKey };
}

/**
 * @returns Every piece of the private key that must never appear in output:
 *   the whole key and each long line of it. The App ID is public.
 */
export function secretsOf(credentials: Credentials): string[] {
  return [
    credentials.privateKey,
    ...credentials.privateKey.split("\n").filter((line) => line.length >= 16),
  ];
}
