#!/usr/bin/env node
import { main } from '../src/cli.js';

// Exit codes: 0 success, 1 runtime failure, 2 usage error.
main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    process.stderr.write('mdrive: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
);
