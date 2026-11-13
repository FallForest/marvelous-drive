/**
 * Error taxonomy for the mdrive CLI.
 *
 * Exit codes are fixed by docs/CONTRACT.md ("CLI rules"):
 *   0 success, 1 runtime failure (network, server, auth, conflict, missing),
 *   2 usage error (unknown command, unknown option, missing argument).
 */
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2 });

export class CliError extends Error {
  /**
   * @param {string} message human readable, printed as "mdrive: <message>"
   * @param {number} [exitCode] 0 | 1 | 2
   * @param {{code?: string, status?: number, hint?: string}} [details]
   */
  constructor(message, exitCode = EXIT.ERROR, details = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = details.code;
    this.status = details.status;
    this.hint = details.hint;
  }
}

export function usageError(message) {
  return new CliError(message, EXIT.USAGE, { code: 'USAGE' });
}

export function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
