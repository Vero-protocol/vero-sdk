/**
 * Tests for the account balances module
 */

import {
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
  NATIVE_ASSET,
} from '../balances';

describe('Balances', () => {
  describe('amountToStroops', () => {
    it('should convert integer amounts to stroops', () => {
      expect(amountToStroops('1')).toBe(10000000n);
      expect(amountToStroops('10')).toBe(100000000n);
      expect(amountToStroops('0')).toBe(0n);
    });

    it('should convert decimal amounts to stroops', () => {
      expect(amountToStroops('1.5')).toBe(15000000n);
      expect(amountToStroops('0.1234567')).toBe(1234567n);
      expect(amountToStroops('0.0000001')).toBe(1n);
    });

    it('should handle amounts with more than 7 decimal places', () => {
      expect(amountToStroops('1.123456789')).toBe(11234567n);
    });

    it('should handle invalid amounts gracefully', () => {
      expect(amountToStroops('invalid')).toBe(0n);
    });
  });

  describe('stroopsToAmount', () => {
    it('should convert stroops to decimal string', () => {
      expect(stroopsToAmount(10000000n)).toBe('1');
      expect(stroopsToAmount(15000000n)).toBe('1.5');
      expect(stroopsToAmount(1234567n)).toBe('0.1234567');
      expect(stroopsToAmount(1n)).toBe('0.0000001');
      expect(stroopsToAmount(0n)).toBe('0');
    });

    it('should round-trip correctly', () => {
      const amount = '123.456789';
      const stroops = amountToStroops(amount);
      expect(stroopsToAmount(stroops)).toBe(amount);
    });
  });

  describe('parseBalance', () => {
    it('should parse native balance', () => {
      const balance = {
        asset_type: 'native' as const,
        balance: '100.5',
        limit: '1000',
        buying_liabilities: '0',
        selling_liabilities: '0',
        last_modified_ledger: 100,
      };
      const result = parseBalance(balance);
      expect(result.assetCode).toBe(NATIVE_ASSET);
      expect(result.assetIssuer).toBeNull();
      expect(result.isNative).toBe(true);
      expect(result.amount).toBe(1005000000n);
      expect(result.amountUnits).toBe('100.5');
    });

    it('should parse issued asset balance', () => {
      const balance = {
        asset_type: 'credit_alphanum4' as const,
        asset_code: 'USDC',
        asset_issuer: 'GABC123',
        balance: '50.25',
        limit: '1000',
        buying_liabilities: '0',
        selling_liabilities: '0',
        last_modified_ledger: 100,
      };
      const result = parseBalance(balance);
      expect(result.assetCode).toBe('USDC');
      expect(result.assetIssuer).toBe('GABC123');
      expect(result.isNative).toBe(false);
      expect(result.amount).toBe(502500000n);
      expect(result.amountUnits).toBe('50.25');
    });
  });

  describe('getBalances', () => {
    it('should parse all balances', () => {
      const balances = [
        {
          asset_type: 'native' as const,
          balance: '100',
          limit: '1000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          last_modified_ledger: 100,
        },
        {
          asset_type: 'credit_alphanum4' as const,
          asset_code: 'USDC',
          asset_issuer: 'GABC123',
          balance: '50',
          limit: '1000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          last_modified_ledger: 100,
        },
      ];
      const results = getBalances(balances);
      expect(results).toHaveLength(2);
      expect(results[0]?.assetCode).toBe(NATIVE_ASSET);
      expect(results[1]?.assetCode).toBe('USDC');
    });
  });

  describe('hasSufficientBalance', () => {
    const balances = [
      {
        asset_type: 'native' as const,
        balance: '100',
        limit: '1000',
        buying_liabilities: '0',
        selling_liabilities: '0',
        last_modified_ledger: 100,
      },
      {
        asset_type: 'credit_alphanum4' as const,
        asset_code: 'USDC',
        asset_issuer: 'GABC123',
        balance: '50',
        limit: '1000',
        buying_liabilities: '0',
        selling_liabilities: '0',
        last_modified_ledger: 100,
      },
    ];

    it('should return true when balance is sufficient', () => {
      expect(hasSufficientBalance(balances, NATIVE_ASSET, 500000000n)).toBe(true);
      expect(hasSufficientBalance(balances, 'USDC', 250000000n, 'GABC123')).toBe(true);
    });

    it('should return false when balance is insufficient', () => {
      expect(hasSufficientBalance(balances, NATIVE_ASSET, 2000000000n)).toBe(false);
      expect(hasSufficientBalance(balances, 'USDC', 1000000000n, 'GABC123')).toBe(false);
    });

    it('should return false for missing asset', () => {
      expect(hasSufficientBalance(balances, 'MISSING', 100n)).toBe(false);
    });
  });

  describe('compareStroops', () => {
    it('should compare correctly', () => {
      expect(compareStroops(10n, 5n)).toBe(1);
      expect(compareStroops(5n, 10n)).toBe(-1);
      expect(compareStroops(10n, 10n)).toBe(0);
    });
  });

  describe('getNativeBalance', () => {
    it('should return native balance', () => {
      const balances = [
        {
          asset_type: 'native' as const,
          balance: '100',
          limit: '1000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          last_modified_ledger: 100,
        },
      ];
      const result = getNativeBalance(balances);
      expect(result).toBeDefined();
      expect(result?.assetCode).toBe(NATIVE_ASSET);
    });

    it('should return null if no native balance', () => {
      const balances: any[] = [];
      const result = getNativeBalance(balances);
      expect(result).toBeNull();
    });
  });

  describe('getAssetBalance', () => {
    it('should return specific asset balance', () => {
      const balances = [
        {
          asset_type: 'native' as const,
          balance: '100',
          limit: '1000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          last_modified_ledger: 100,
        },
        {
          asset_type: 'credit_alphanum4' as const,
          asset_code: 'USDC',
          asset_issuer: 'GABC123',
          balance: '50',
          limit: '1000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          last_modified_ledger: 100,
        },
      ];
      const result = getAssetBalance(balances, 'USDC', 'GABC123');
      expect(result).toBeDefined();
      expect(result?.assetCode).toBe('USDC');
    });

    it('should return null if asset not found', () => {
      const balances: any[] = [];
      const result = getAssetBalance(balances, 'MISSING');
      expect(result).toBeNull();
    });
  });

  describe('addStroops and subtractStroops', () => {
    it('should add stroops', () => {
      expect(addStroops(10n, 5n)).toBe(15n);
    });

    it('should subtract stroops', () => {
      expect(subtractStroops(10n, 5n)).toBe(5n);
    });
  });

  describe('hasSufficientNativeBalance', () => {
    it('should return true when native balance is sufficient', () => {
      const balances = [
        {
          asset_type: 'native' as const,
          balance: '100',
          limit: '1000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          last_modified_ledger: 100,
        },
      ];
      expect(hasSufficientNativeBalance(balances, 500000000n)).toBe(true);
    });

    it('should return false when native balance is insufficient', () => {
      const balances = [
        {
          asset_type: 'native' as const,
          balance: '1',
          limit: '1000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          last_modified_ledger: 100,
        },
      ];
      expect(hasSufficientNativeBalance(balances, 500000000n)).toBe(false);
    });
  });
});
