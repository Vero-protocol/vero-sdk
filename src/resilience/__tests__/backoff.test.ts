import { retry, defaultIsRetryable } from '../backoff';
import { VeroError, VeroErrorCode } from '../../errors';

describe('backoff retry', () => {
  beforeEach(() => {
    jest.spyOn(global.Math, 'random').mockReturnValue(0.5); // Predictable jitter
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves immediately if the function succeeds on the first try', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await retry(fn);
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transport errors and eventually succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.RpcTimeout, 'Timeout'))
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.AllEndpointsFailed, 'Failed'))
      .mockResolvedValue('success');

    const result = await retry(fn, { maxRetries: 3, baseDelayMs: 10 });
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails after max retries', async () => {
    const error = new Error('Network error');
    const fn = jest.fn().mockRejectedValue(error);

    await expect(retry(fn, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow('Network error');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does not retry non-retryable errors', async () => {
    const error = new VeroError(VeroErrorCode.AccountNotFound, 'Not found');
    const fn = jest.fn().mockRejectedValue(error);

    await expect(retry(fn, { maxRetries: 3, baseDelayMs: 10 })).rejects.toThrow('Not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when explicitly aborted', async () => {
    const controller = new AbortController();
    const error = new Error('Network error');
    const fn = jest.fn().mockRejectedValue(error);

    const promise = retry(fn, { maxRetries: 5, signal: controller.signal, baseDelayMs: 50 });

    // Abort shortly after
    setTimeout(() => {
      controller.abort(new Error('Manual abort'));
    }, 10);

    await expect(promise).rejects.toThrow('Manual abort');
    // It should have tried at least once before aborting
    expect(fn).toHaveBeenCalledTimes(1);
  });
  
  it('aborts even before the first attempt if already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Pre-abort'));
    const fn = jest.fn().mockResolvedValue('success');

    await expect(retry(fn, { signal: controller.signal })).rejects.toThrow('Pre-abort');
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it('caps delay at maxDelayMs', async () => {
    const error = new Error('Network error');
    const fn = jest.fn().mockRejectedValue(error);
    jest.spyOn(global.Math, 'random').mockReturnValue(1); // max jitter

    // Using real timers, just small values
    // min(2 * 2^x, 5) -> max delay is 5ms
    await expect(retry(fn, { maxRetries: 3, baseDelayMs: 2, maxDelayMs: 5 })).rejects.toThrow('Network error');
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  describe('defaultIsRetryable', () => {
    it('returns true for transport VeroErrors', () => {
      expect(defaultIsRetryable(new VeroError(VeroErrorCode.RpcTimeout, ''))).toBe(true);
      expect(defaultIsRetryable(new VeroError(VeroErrorCode.AllEndpointsFailed, ''))).toBe(true);
    });

    it('returns false for other VeroErrors', () => {
      expect(defaultIsRetryable(new VeroError(VeroErrorCode.AccountNotFound, ''))).toBe(false);
      expect(defaultIsRetryable(new VeroError(VeroErrorCode.InvalidUrl, ''))).toBe(false);
    });

    it('returns false for AbortError', () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      expect(defaultIsRetryable(abortError)).toBe(false);
    });

    it('returns true for general Errors (assuming network/fetch error)', () => {
      expect(defaultIsRetryable(new TypeError('Failed to fetch'))).toBe(true);
      expect(defaultIsRetryable(new Error('ECONNRESET'))).toBe(true);
    });
    
    it('returns false for non-error types', () => {
      expect(defaultIsRetryable('string error')).toBe(false);
      expect(defaultIsRetryable({ code: 123 })).toBe(false);
      expect(defaultIsRetryable(null)).toBe(false);
    });
  });
});
