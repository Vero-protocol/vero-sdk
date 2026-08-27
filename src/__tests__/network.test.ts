import {
  validateUrl,
  createNetworkConfig,
  isCustomEndpoint,
  TESTNET,
  MAINNET,
  PASSPHRASE,
} from '../network';
import { VeroError, VeroErrorCode } from '../errors';

describe('validateUrl', () => {
  it('accepts https endpoints', () => {
    expect(validateUrl('https://horizon-testnet.stellar.org').protocol).toBe('https:');
  });

  it('rejects plaintext http for a remote host', () => {
    expect(() => validateUrl('http://evil.example')).toThrow(VeroError);
    try {
      validateUrl('http://evil.example');
    } catch (e) {
      expect((e as VeroError).code).toBe(VeroErrorCode.InvalidUrl);
      expect((e as VeroError).message).toContain('must use https://');
    }
  });

  it('rejects http on localhost unless explicitly opted in', () => {
    expect(() => validateUrl('http://localhost:8000')).toThrow(VeroError);
  });

  it('permits http on localhost when opted in', () => {
    expect(validateUrl('http://localhost:8000', { allowInsecureLocalhost: true }).hostname).toBe(
      'localhost',
    );
    expect(validateUrl('http://127.0.0.1:8000', { allowInsecureLocalhost: true }).hostname).toBe(
      '127.0.0.1',
    );
    // Full 127.0.0.0/8 range — not just .1
    expect(validateUrl('http://127.0.0.2:8000', { allowInsecureLocalhost: true }).hostname).toBe(
      '127.0.0.2',
    );
    // IPv6 loopback — WHATWG URL parser always returns the bracketed form
    expect(validateUrl('http://[::1]:8000', { allowInsecureLocalhost: true }).hostname).toBe(
      '[::1]',
    );
  });

  it('rejects http on loopback addresses unless opted in', () => {
    expect(() => validateUrl('http://127.0.0.2:8000')).toThrow(VeroError);
    expect(() => validateUrl('http://[::1]:8000')).toThrow(VeroError);
  });

  it('does not permit http on a remote host even when localhost is opted in', () => {
    expect(() => validateUrl('http://evil.example', { allowInsecureLocalhost: true })).toThrow(
      VeroError,
    );
  });

  it('rejects non-http protocols', () => {
    for (const url of ['ftp://a.example', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(() => validateUrl(url)).toThrow(VeroError);
    }
  });

  it('rejects unparseable input', () => {
    expect(() => validateUrl('not a url')).toThrow(VeroError);
    expect(() => validateUrl('')).toThrow(VeroError);
  });
});

describe('createNetworkConfig', () => {
  it('returns the base config when given no overrides', () => {
    expect(createNetworkConfig(TESTNET)).toEqual(TESTNET);
  });

  it('marks overridden endpoints as custom', () => {
    const cfg = createNetworkConfig(TESTNET, { horizonUrl: 'https://my-horizon.example' });
    expect(cfg.network).toBe('custom');
    expect(isCustomEndpoint(cfg)).toBe(true);
  });

  it('does not mark defaults as custom', () => {
    expect(isCustomEndpoint(createNetworkConfig(MAINNET))).toBe(false);
  });

  it('throws rather than silently falling back on an invalid override', () => {
    expect(() => createNetworkConfig(TESTNET, { horizonUrl: 'http://evil.example' })).toThrow(
      VeroError,
    );
  });

  it('treats a changed passphrase as custom', () => {
    const cfg = createNetworkConfig(TESTNET, { networkPassphrase: PASSPHRASE.mainnet });
    expect(cfg.network).toBe('custom');
  });
});
