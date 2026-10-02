import { describe, it, expect, afterEach, vi } from 'vitest';
import { main } from '../../src/cli/index.js';
import { CLI_VERSION } from '../../src/cli/version.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('main', () => {
  it.each(['--version', '-v'])('prints the version for %s', async (flag) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main([flag])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(`shipledger ${CLI_VERSION}\n`);
  });

  it('lists --version in the usage text', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['--help'])).toBe(0);
    expect(String(stdout.mock.calls[0]?.[0])).toContain('--version');
  });
});
