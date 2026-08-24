/**
 * Tests for the account module index
 */

import * as account from '../index';

describe('Account module index', () => {
  it('should export all expected functions', () => {
    // Check that all expected exports exist
    expect(account.AccountLoader).toBeDefined();
    expect(account.accountLoader).toBeDefined();
    expect(account.DataKey).toBeDefined();
    expect(account.readDataEntry).toBeDefined();
    expect(account.getReputation).toBeDefined();
    expect(account.getMetadata).toBeDefined();
    expect(account.getProfile).toBeDefined();
    expect(account.hasDataEntry).toBeDefined();
    expect(account.listDataEntries).toBeDefined();
    expect(account.isValidator).toBeDefined();
    expect(account.NATIVE_ASSET).toBeDefined();
    expect(account.parseBalance).toBeDefined();
    expect(account.getBalances).toBeDefined();
    expect(account.getNativeBalance).toBeDefined();
    expect(account.getAssetBalance).toBeDefined();
    expect(account.amountToStroops).toBeDefined();
    expect(account.stroopsToAmount).toBeDefined();
    expect(account.hasSufficientBalance).toBeDefined();
    expect(account.hasSufficientNativeBalance).toBeDefined();
    expect(account.compareStroops).toBeDefined();
    expect(account.addStroops).toBeDefined();
    expect(account.subtractStroops).toBeDefined();
  });

  it('should export error classes', () => {
    expect(account.AccountNotFoundError).toBeDefined();
    expect(account.StaleCacheError).toBeDefined();
    expect(account.MalformedAccountDataError).toBeDefined();
  });

  it('should export type interfaces', () => {
    // Just verify the module has types defined
    // The actual types are compile-time only
    expect(account).toBeDefined();
  });
});
