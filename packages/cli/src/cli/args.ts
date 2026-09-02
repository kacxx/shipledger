import { parseArgs, type ParseArgsConfig } from 'node:util';
import { usageError } from '../errors.js';

export function parseOrUsage<T>(config: ParseArgsConfig): T {
  try {
    return parseArgs(config).values as T;
  } catch (err) {
    throw usageError((err as Error).message);
  }
}
