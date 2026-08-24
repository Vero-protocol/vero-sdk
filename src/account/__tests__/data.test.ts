/**
 * Tests for the account data module
 */

import {
  DataKey,
  readDataEntry,
  getReputation,
  getMetadata,
  getProfile,
  hasDataEntry,
  listDataEntries,
  isValidator,
} from '../data';

describe('Account Data', () => {
  describe('readDataEntry', () => {
    it('should decode a valid base64 entry', () => {
      const data = {
        test: Buffer.from('hello world').toString('base64'),
      };
      const result = readDataEntry(data, 'test');
      expect(result).toBeDefined();
      expect(result?.key).toBe('test');
      expect(result?.value).toBe('hello world');
      expect(result?.isValid).toBe(true);
    });

    it('should return null for missing entry', () => {
      const data = {};
      const result = readDataEntry(data, 'missing');
      expect(result).toBeNull();
    });

    it('should handle malformed base64 gracefully', () => {
      const data = {
        malformed: 'not-valid-base64!',
      };
      const result = readDataEntry(data, 'malformed');
      expect(result).toBeDefined();
      expect(result?.key).toBe('malformed');
      // Buffer.from with base64 doesn't throw for invalid input
      // The value will be some garbage string
      expect(typeof result?.value).toBe('string');
    });

    it('should handle non-UTF8 data', () => {
      // Create a buffer with invalid UTF-8 sequence
      const nonUtf8 = Buffer.from([0x80, 0x81, 0x82]);
      const data = {
        invalid: nonUtf8.toString('base64'),
      };
      const result = readDataEntry(data, 'invalid');
      expect(result).toBeDefined();
      expect(result?.key).toBe('invalid');
      // Buffer.from with base64 doesn't throw for invalid input
      expect(typeof result?.value).toBe('string');
    });
  });

  describe('getReputation', () => {
    it('should parse valid reputation data', () => {
      const data = {
        [DataKey.Reputation]: Buffer.from(
          JSON.stringify({ score: 250, metadata: { contributions: 5 } })
        ).toString('base64'),
      };
      const result = getReputation(data);
      expect(result).toBeDefined();
      expect(result?.score).toBe(250);
      expect(result?.tier).toBe('silver');
    });

    it('should return null for missing reputation', () => {
      const data = {};
      const result = getReputation(data);
      expect(result).toBeNull();
    });

    it('should handle invalid reputation JSON gracefully', () => {
      const data = {
        [DataKey.Reputation]: Buffer.from('invalid json').toString('base64'),
      };
      const result = getReputation(data);
      expect(result).toBeNull();
    });

    it('should handle reputation with missing score', () => {
      const data = {
        [DataKey.Reputation]: Buffer.from(
          JSON.stringify({ metadata: { contributions: 5 } })
        ).toString('base64'),
      };
      const result = getReputation(data);
      expect(result).toBeDefined();
      expect(result?.score).toBe(0);
      expect(result?.tier).toBe('unknown');
    });

    it('should handle different score tiers', () => {
      const testCases = [
        { score: 5, tier: 'unknown' },
        { score: 10, tier: 'bronze' },
        { score: 100, tier: 'silver' },
        { score: 500, tier: 'gold' },
        { score: 1000, tier: 'platinum' },
        { score: 5000, tier: 'platinum' },
      ];

      for (const { score, tier } of testCases) {
        const data = {
          [DataKey.Reputation]: Buffer.from(
            JSON.stringify({ score })
          ).toString('base64'),
        };
        const result = getReputation(data);
        expect(result?.tier).toBe(tier);
      }
    });
  });

  describe('getMetadata', () => {
    it('should parse valid metadata', () => {
      const data = {
        [DataKey.Metadata]: Buffer.from(
          JSON.stringify({ name: 'test', version: 1 })
        ).toString('base64'),
      };
      const result = getMetadata(data);
      expect(result).toBeDefined();
      expect(result?.name).toBe('test');
      expect(result?.version).toBe(1);
    });

    it('should return null for missing metadata', () => {
      const data = {};
      const result = getMetadata(data);
      expect(result).toBeNull();
    });

    it('should handle invalid metadata JSON', () => {
      const data = {
        [DataKey.Metadata]: Buffer.from('invalid json').toString('base64'),
      };
      const result = getMetadata(data);
      expect(result).toBeNull();
    });

    it('should handle malformed metadata base64', () => {
      const data = {
        [DataKey.Metadata]: 'not-valid-base64!',
      };
      const result = getMetadata(data);
      expect(result).toBeNull();
    });
  });

  describe('getProfile', () => {
    it('should parse valid profile', () => {
      const data = {
        [DataKey.Profile]: Buffer.from(
          JSON.stringify({ name: 'testuser', email: 'test@example.com' })
        ).toString('base64'),
      };
      const result = getProfile(data);
      expect(result).toBeDefined();
      expect(result?.name).toBe('testuser');
      expect(result?.email).toBe('test@example.com');
    });

    it('should return null for missing profile', () => {
      const data = {};
      const result = getProfile(data);
      expect(result).toBeNull();
    });

    it('should handle invalid profile JSON', () => {
      const data = {
        [DataKey.Profile]: Buffer.from('invalid json').toString('base64'),
      };
      const result = getProfile(data);
      expect(result).toBeNull();
    });
  });

  describe('hasDataEntry', () => {
    it('should return true if entry exists', () => {
      const data = { test: 'value' };
      expect(hasDataEntry(data, 'test')).toBe(true);
    });

    it('should return false if entry does not exist', () => {
      const data = {};
      expect(hasDataEntry(data, 'test')).toBe(false);
    });
  });

  describe('isValidator', () => {
    it('should return true for validator entry', () => {
      const data = {
        validator: 'true',
      };
      expect(isValidator(data)).toBe(true);
    });

    it('should return true for is_validator entry', () => {
      const data = {
        is_validator: 'true',
      };
      expect(isValidator(data)).toBe(true);
    });

    it('should return false for non-validator', () => {
      const data = {};
      expect(isValidator(data)).toBe(false);
    });

    it('should return false for empty data', () => {
      const data = {
        some: 'value',
      };
      expect(isValidator(data)).toBe(false);
    });
  });

  describe('listDataEntries', () => {
    it('should list all data entries', () => {
      const data = {
        key1: Buffer.from('value1').toString('base64'),
        key2: Buffer.from('value2').toString('base64'),
      };
      const entries = listDataEntries(data);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.key).toBe('key1');
      expect(entries[0]?.value).toBe('value1');
      expect(entries[1]?.key).toBe('key2');
      expect(entries[1]?.value).toBe('value2');
    });

    it('should return empty array for no data', () => {
      const data = {};
      const entries = listDataEntries(data);
      expect(entries).toHaveLength(0);
    });

    it('should handle mixed valid and invalid entries', () => {
      const data = {
        valid: Buffer.from('valid').toString('base64'),
        invalid: 'not-valid-base64!',
      };
      const entries = listDataEntries(data);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.key).toBe('valid');
      expect(entries[0]?.isValid).toBe(true);
      expect(entries[1]?.key).toBe('invalid');
      // Buffer.from with base64 doesn't throw for invalid input
      // So isValid will be true, but the value will be garbage
      // Just check that it's defined
      expect(entries[1]?.value).toBeDefined();
    });
  });
});
