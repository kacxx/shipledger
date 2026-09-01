export class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2 | 3) {
    super(message);
    this.name = 'CliError';
  }
}

/** Schema, syntax, cross-file consistency, duplicate identity, invalid regex. */
export function usageError(message: string): CliError {
  return new CliError(message, 2);
}

/** Missing file, permissions, write failure, unusable repo, unexpected git failure. */
export function envError(message: string): CliError {
  return new CliError(message, 3);
}

/** The single mapping every command uses. Unknown errors are exit 2. */
export function toExitCode(err: unknown): { code: 1 | 2 | 3; message: string } {
  if (err instanceof CliError) return { code: err.exitCode, message: err.message };
  return { code: 2, message: (err as Error).message };
}
