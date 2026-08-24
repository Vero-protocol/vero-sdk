/**
 * Account balances module
 *
 * Handles parsing and comparing account balances.
 * Amounts are always in stroops (bigint), never floats.
 */

import { BalanceLine, AccountBalance } from './types.js';

/**
 * Native asset code for Stellar
 */
export const NATIVE_ASSET = 'XLM';

/**
 * Parse a balance line from Horizon.
 *
 * @param balance - The balance line from Horizon
 * @returns The parsed account balance
 */
export function parseBalance(balance: BalanceLine): AccountBalance {
  const isNative = balance.asset_type === 'native';
  const code = isNative ? NATIVE_ASSET : balance.asset_code || '';
  const issuer = isNative ? null : balance.asset_issuer || null;

  // Parse amount as bigint (stroops)
  const amountStr = balance.balance || '0';
  const stroops = amountToStroops(amountStr);

  return {
    assetCode: code,
    assetIssuer: issuer,
    amount: stroops,
    amountUnits: amountStr,
    isNative,
  };
}

/**
 * Get all balances for an account.
 *
 * @param balances - The balances array from Horizon
 * @returns Array of parsed account balances
 */
export function getBalances(balances: BalanceLine[]): AccountBalance[] {
  return balances.map(parseBalance);
}

/**
 * Get the native balance (XLM) from an account.
 *
 * @param balances - The balances array from Horizon
 * @returns The native balance, or null if not found
 */
export function getNativeBalance(balances: BalanceLine[]): AccountBalance | null {
  const native = balances.find((b) => b.asset_type === 'native');
  return native ? parseBalance(native) : null;
}

/**
 * Get a specific asset balance from an account.
 *
 * @param balances - The balances array from Horizon
 * @param assetCode - The asset code to find
 * @param assetIssuer - The asset issuer (optional)
 * @returns The asset balance, or null if not found
 */
export function getAssetBalance(
  balances: BalanceLine[],
  assetCode: string,
  assetIssuer?: string
): AccountBalance | null {
  const balance = balances.find((b) => {
    if (assetCode === NATIVE_ASSET && b.asset_type === 'native') {
      return true;
    }
    if (b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') {
      const match = b.asset_code === assetCode;
      if (assetIssuer) {
        return match && b.asset_issuer === assetIssuer;
      }
      return match;
    }
    return false;
  });
  return balance ? parseBalance(balance) : null;
}

/**
 * Convert a decimal amount string to stroops (bigint).
 *
 * @param amount - The amount as a decimal string
 * @returns The amount in stroops as a bigint
 */
export function amountToStroops(amount: string): bigint {
  try {
    const parts = amount.split('.');
    const integerPart = parts[0] || '0';
    const fractionalPart = (parts[1] || '').padEnd(7, '0').slice(0, 7);
    
    const normalized = integerPart + fractionalPart;
    return BigInt(normalized);
  } catch {
    return 0n;
  }
}

/**
 * Convert stroops back to a decimal string.
 *
 * @param stroops - The amount in stroops
 * @returns The amount as a decimal string
 */
export function stroopsToAmount(stroops: bigint): string {
  const str = stroops.toString().padStart(8, '0');
  const integerPart = str.slice(0, -7) || '0';
  const fractionalPart = str.slice(-7).replace(/0+$/, '');
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}

/**
 * Check if an account has sufficient balance for a transaction.
 *
 * @param balances - The balances array from Horizon
 * @param assetCode - The asset code to check
 * @param requiredAmount - The required amount in stroops
 * @param assetIssuer - The asset issuer (optional)
 * @returns True if the balance is sufficient
 */
export function hasSufficientBalance(
  balances: BalanceLine[],
  assetCode: string,
  requiredAmount: bigint,
  assetIssuer?: string
): boolean {
  const balance = getAssetBalance(balances, assetCode, assetIssuer);
  if (!balance) {
    return false;
  }
  return balance.amount >= requiredAmount;
}

/**
 * Check if an account has sufficient native balance (XLM).
 *
 * @param balances - The balances array from Horizon
 * @param requiredAmount - The required amount in stroops
 * @returns True if the balance is sufficient
 */
export function hasSufficientNativeBalance(
  balances: BalanceLine[],
  requiredAmount: bigint
): boolean {
  return hasSufficientBalance(balances, NATIVE_ASSET, requiredAmount);
}

/**
 * Compare two amounts in stroops.
 *
 * @param a - First amount in stroops
 * @param b - Second amount in stroops
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareStroops(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Add two amounts in stroops.
 */
export function addStroops(a: bigint, b: bigint): bigint {
  return a + b;
}

/**
 * Subtract two amounts in stroops.
 */
export function subtractStroops(a: bigint, b: bigint): bigint {
  return a - b;
}
