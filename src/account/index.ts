/**
 * Account module for vero-sdk
 *
 * Provides typed Horizon account access with safe caching,
 * account data reading, and balance handling.
 */

// Types
export * from './types.js';

// Loader
export { AccountLoader, accountLoader } from './loader.js';

// Data
export {
  DataKey,
  readDataEntry,
  getReputation,
  getMetadata,
  getProfile,
  hasDataEntry,
  listDataEntries,
  isValidator,
} from './data.js';

// Balances
export {
  NATIVE_ASSET,
  parseBalance,
  getBalances,
  getNativeBalance,
  getAssetBalance,
  amountToStroops,
  stroopsToAmount,
  hasSufficientBalance,
  hasSufficientNativeBalance,
  compareStroops,
  addStroops,
  subtractStroops,
} from './balances.js';
