#!/usr/bin/env node
/**
 * Entry point of the `pr-review` command (see run.ts for what a run does).
 */

import { main, reportFailure } from "./run.ts";

main(process.argv.slice(2)).catch((error) => {
  process.exitCode = reportFailure(error);
});
