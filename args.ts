/**
 * Command line of `pnpm pr-review`.
 */

import { parseArgs } from "node:util";

/** Changed lines (added plus deleted) above which a Review run stops. */
export const DEFAULT_MAX_LINES = 3000;

export const USAGE =
  "Usage: pnpm pr-review [--pr <number>] [--max-lines <number>] [--dry-run]";

export interface Args {
  /** The pull request to review; undefined means the current branch's. */
  pr: number | undefined;
  maxLines: number;
  dryRun: boolean;
  help: boolean;
}

function positiveInteger(name: string, value: string): number {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} needs a positive whole number, got "${value}"`);
  }
  const number = Number(value);
  if (number < 1) throw new Error(`${name} needs a positive whole number`);
  return number;
}

/**
 * @throws When an option is unknown or has a bad value; the message ends with
 *   the usage.
 */
export function parseCliArgs(argv: string[]): Args {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        pr: { type: "string" },
        "max-lines": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    return {
      pr:
        values.pr === undefined
          ? undefined
          : positiveInteger("--pr", values.pr),
      maxLines:
        values["max-lines"] === undefined
          ? DEFAULT_MAX_LINES
          : positiveInteger("--max-lines", values["max-lines"]),
      dryRun: values["dry-run"],
      help: values.help,
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
      { cause: error },
    );
  }
}
