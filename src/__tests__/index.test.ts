/**
 * Root barrel regression (#67).
 *
 * Account tests imported `../index` (the account-local barrel), so the
 * module could ship in `dist` and still be unreachable from
 * `@vero-protocol/sdk`. This file imports the package root and asserts
 * every module directory is re-exported, so a new module cannot be
 * omitted the same way.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountDataKey,
  AccountLoader,
  DataKey,
  EventCursor,
  NonceManager,
  retry,
  Role,
  RpcClient,
  validateUrl,
  VeroError,
} from '../index';

/**
 * `contract` re-exports `Task`, `Vote`, and `SubmitResult`, so
 * `export * from './contract'` collides with `./types`. Resolving that
 * is outside #67.
 */
const ROOT_BARREL_EXCEPTIONS = new Set(['contract']);

describe('package root barrel', () => {
  it('exposes AccountLoader for import { AccountLoader } from "@vero-protocol/sdk"', () => {
    expect(AccountLoader).toBeDefined();
    expect(typeof AccountLoader).toBe('function');
  });

  it('keeps protocol DataKey distinct from AccountDataKey', () => {
    expect(DataKey.reputation).toBe('vero_reputation');
    expect(AccountDataKey.Reputation).toBe('reputation');
    expect(DataKey).not.toBe(AccountDataKey);
  });

  it('re-exports every module directory', () => {
    const srcDir = join(__dirname, '..');
    const barrel = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    const moduleDirs = readdirSync(srcDir).filter((name) => {
      const full = join(srcDir, name);
      return statSync(full).isDirectory() && name !== '__tests__';
    });

    for (const name of ROOT_BARREL_EXCEPTIONS) {
      expect(moduleDirs).toContain(name);
    }

    const missing = moduleDirs.filter((name) => {
      if (ROOT_BARREL_EXCEPTIONS.has(name)) {
        return false;
      }
      return !barrel.includes(`from './${name}`);
    });

    expect(missing).toEqual([]);
  });

  it('resolves a representative symbol from each public module', () => {
    expect(Role).toBeDefined();
    expect(VeroError).toBeDefined();
    expect(validateUrl).toBeDefined();
    expect(RpcClient).toBeDefined();
    expect(NonceManager).toBeDefined();
    expect(retry).toBeDefined();
    expect(EventCursor).toBeDefined();
    expect(AccountLoader).toBeDefined();
  });
});
