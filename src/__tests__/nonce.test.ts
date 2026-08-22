import { reserve, release, withReservation, isReserved, _resetPoolForTesting } from '../nonce';
import { VeroError, VeroErrorCode } from '../errors';

describe('nonce', () => {
  const account = 'GABC1234567890';
  const sequence = 12345n;

  beforeEach(() => {
    // Clear any existing reservations before each test
    _resetPoolForTesting();
  });

  describe('reserve', () => {
    it('reserves a sequence for an account', () => {
      reserve(account, sequence);
      expect(isReserved(account, sequence)).toBe(true);
    });

    it('allows reserving multiple sequences for the same account', () => {
      reserve(account, 1n);
      reserve(account, 2n);
      reserve(account, 3n);

      expect(isReserved(account, 1n)).toBe(true);
      expect(isReserved(account, 2n)).toBe(true);
      expect(isReserved(account, 3n)).toBe(true);
    });

    it('allows reserving sequences for different accounts', () => {
      const account2 = 'GXYZ9876543210';

      reserve(account, 1n);
      reserve(account2, 1n);

      expect(isReserved(account, 1n)).toBe(true);
      expect(isReserved(account2, 1n)).toBe(true);
    });
  });

  describe('release', () => {
    beforeEach(() => {
      _resetPoolForTesting();
    });

    it('releases a reserved sequence', () => {
      reserve(account, sequence);
      expect(isReserved(account, sequence)).toBe(true);

      release(account, sequence);
      expect(isReserved(account, sequence)).toBe(false);
    });

    it('throws when releasing a sequence that was not reserved', () => {
      // First reserve something to create the account in the map
      reserve(account, 1n);
      expect(() => release(account, sequence)).toThrow(VeroError);
      try {
        release(account, sequence);
      } catch (e) {
        expect((e as VeroError).code).toBe(VeroErrorCode.BadSequence);
        expect((e as VeroError).message).toContain('was not reserved');
      }
    });

    it('throws when releasing for an account with no reservations', () => {
      _resetPoolForTesting(); // Ensure clean state
      const account2 = 'GXYZ9876543210';
      expect(() => release(account2, sequence)).toThrow(VeroError);
      try {
        release(account2, sequence);
      } catch (e) {
        expect((e as VeroError).code).toBe(VeroErrorCode.BadSequence);
        expect((e as VeroError).message).toContain('No reservations found');
      }
    });

    it('allows releasing after reserving', () => {
      reserve(account, 1n);
      reserve(account, 2n);

      release(account, 1n);
      expect(isReserved(account, 1n)).toBe(false);
      expect(isReserved(account, 2n)).toBe(true); // Other reservation intact
    });
  });

  describe('withReservation', () => {
    it('releases the sequence when the callback throws', async () => {
      const seq = 100n;

      await expect(
        withReservation(account, seq, async () => {
          throw new Error('Network error');
        }),
      ).rejects.toThrow('Network error');

      // Sequence should be released after the error
      expect(isReserved(account, seq)).toBe(false);
    });

    it('keeps the sequence reserved when the callback succeeds', async () => {
      const seq = 200n;

      const result = await withReservation(account, seq, async () => {
        return 'success';
      });

      expect(result).toBe('success');
      // Sequence should remain reserved after success
      expect(isReserved(account, seq)).toBe(true);
    });

    it('releases on network error simulation', async () => {
      const seq = 300n;

      await expect(
        withReservation(account, seq, async () => {
          throw new Error('ETIMEDOUT');
        }),
      ).rejects.toThrow('ETIMEDOUT');

      expect(isReserved(account, seq)).toBe(false);
    });

    it('releases on user rejection simulation', async () => {
      const seq = 400n;

      await expect(
        withReservation(account, seq, async () => {
          throw new Error('User rejected signature');
        }),
      ).rejects.toThrow('User rejected signature');

      expect(isReserved(account, seq)).toBe(false);
    });

    it('passes through the return value on success', async () => {
      const seq = 500n;
      const expectedValue = { hash: 'abc123', ledger: 12345 };

      const result = await withReservation(account, seq, async () => {
        return expectedValue;
      });

      expect(result).toEqual(expectedValue);
      expect(isReserved(account, seq)).toBe(true);
    });

    it('handles async errors properly', async () => {
      const seq = 600n;

      await expect(
        withReservation(account, seq, async () => {
          await Promise.resolve();
          throw new Error('Async error');
        }),
      ).rejects.toThrow('Async error');

      expect(isReserved(account, seq)).toBe(false);
    });
  });

  describe('isReserved', () => {
    it('returns false for unreserved sequences', () => {
      expect(isReserved(account, 999n)).toBe(false);
    });

    it('returns true for reserved sequences', () => {
      reserve(account, 999n);
      expect(isReserved(account, 999n)).toBe(true);
    });

    it('returns false after release', () => {
      reserve(account, 999n);
      release(account, 999n);
      expect(isReserved(account, 999n)).toBe(false);
    });

    it('handles different accounts independently', () => {
      const account2 = 'GXYZ9876543210';

      reserve(account, 1n);
      expect(isReserved(account, 1n)).toBe(true);
      expect(isReserved(account2, 1n)).toBe(false);

      reserve(account2, 2n); // Use different sequence to avoid cross-contamination
      expect(isReserved(account, 1n)).toBe(true);
      expect(isReserved(account2, 2n)).toBe(true);
      expect(isReserved(account2, 1n)).toBe(false); // account2 shouldn't have account's sequence
    });
  });
});
