import { VeroError, VeroErrorCode, normalizeError } from '../errors';

describe('normalizeError', () => {
  it('passes a VeroError through unchanged', () => {
    const original = new VeroError(VeroErrorCode.BadSequence, 'stale');
    expect(normalizeError(original)).toBe(original);

  });

  it.each([
    'User declined the request',
    'User rejected the transaction',
    'The request was rejected by the user',
    'User denied the signature',
  ])('classifies wallet cancellation: %s', (msg) => {
    expect(normalizeError(new Error(msg)).code).toBe(VeroErrorCode.UserRejected);
  });

  it.each([
    'permission denied',
    'access denied',
  ])('does not classify infrastructure failures as wallet cancellation: %s', (msg) => {
    expect(normalizeError(new Error(msg)).code).not.toBe(VeroErrorCode.UserRejected);
  });

  it('classifies a stale sequence number', () => {
    expect(normalizeError(new Error('tx_bad_seq')).code).toBe(VeroErrorCode.BadSequence);
    expect(normalizeError(new Error('Bad sequence number')).code).toBe(VeroErrorCode.BadSequence);
  });

  it('classifies a missing account', () => {
    expect(normalizeError(new Error('Account not found')).code).toBe(VeroErrorCode.AccountNotFound);
  });

  it('classifies a timeout', () => {
    expect(normalizeError(new Error('Request timed out')).code).toBe(VeroErrorCode.RpcTimeout);
  });

  it('falls back to Unknown for unrecognised errors', () => {
    expect(normalizeError(new Error('something odd')).code).toBe(VeroErrorCode.Unknown);
  });

  it('accepts a caller-supplied fallback code', () => {
    expect(normalizeError(new Error('odd'), VeroErrorCode.RpcRequestFailed).code).toBe(
      VeroErrorCode.RpcRequestFailed,
    );
  });

  it('handles non-Error thrown values', () => {
    expect(normalizeError('a string').message).toBe('a string');
    expect(normalizeError(null).message).toBe('An unknown error occurred');
    expect(normalizeError(undefined).code).toBe(VeroErrorCode.Unknown);
  });

  it('preserves the original value as cause', () => {
    const original = new Error('boom');
    expect(normalizeError(original).cause).toBe(original);
  });

  it('supports instanceof', () => {
    expect(normalizeError(new Error('x'))).toBeInstanceOf(VeroError);
    expect(normalizeError(new Error('x'))).toBeInstanceOf(Error);
  });
  
});
