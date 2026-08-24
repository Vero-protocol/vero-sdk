/**
 * Network configuration and endpoint URL validation.
 *
 * The validation here exists because a permissive check caused a real problem:
 * `vero-guardian-dashboard` accepted any parseable URL for its Horizon/Soroban
 * endpoints, including plaintext `http://`. Since role, reputation and consensus
 * data all flow through that endpoint and feed signing decisions, a hostile
 * endpoint could lie about who is an admin. See vero-guardian-dashboard#288.
 */

import { VeroError, VeroErrorCode } from '../errors/index.js';
import type { NetworkName } from '../types/index.js';

export interface NetworkConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  network: NetworkName;
}

/** Well-known Stellar network passphrases. These are public constants, not secrets. */
export const PASSPHRASE = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
} as const;

export const TESTNET: NetworkConfig = {
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: PASSPHRASE.testnet,
  network: 'testnet',
};

export const MAINNET: NetworkConfig = {
  horizonUrl: 'https://horizon.stellar.org',
  sorobanRpcUrl: 'https://soroban.stellar.org',
  networkPassphrase: PASSPHRASE.mainnet,
  network: 'mainnet',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface ValidateUrlOptions {
  /**
   * Permit plaintext `http://` for loopback hosts. Intended for local
   * development against a quickstart container. Never enable in production.
   * @default false
   */
  allowInsecureLocalhost?: boolean;
}

/**
 * Validate an RPC or Horizon endpoint URL.
 *
 * Enforces HTTPS. Plaintext HTTP is rejected unless the host is loopback *and*
 * `allowInsecureLocalhost` is explicitly set — an opt-in, so a misconfigured
 * deployment fails loudly instead of silently downgrading.
 *
 * @throws {VeroError} with code `INVALID_URL` if the URL is unusable.
 */
export function validateUrl(url: string, opts: ValidateUrlOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VeroError(VeroErrorCode.InvalidUrl, `Not a valid URL: ${url}`);
  }

  if (parsed.protocol === 'https:') return parsed;

  if (parsed.protocol === 'http:') {
    const isLocal = LOCAL_HOSTS.has(parsed.hostname);
    if (isLocal && opts.allowInsecureLocalhost) return parsed;

    throw new VeroError(
      VeroErrorCode.InvalidUrl,
      isLocal
        ? `Refusing plaintext http:// for ${parsed.hostname}. Pass allowInsecureLocalhost to permit this in local development.`
        : `Endpoint must use https://, got http:// for ${parsed.hostname}. A plaintext endpoint can be intercepted and can misreport on-chain state.`,
    );
  }

  throw new VeroError(
    VeroErrorCode.InvalidUrl,
    `Unsupported protocol "${parsed.protocol}" — endpoints must be https://`,
  );
}

/**
 * Build a validated `NetworkConfig`, starting from a known network and applying
 * overrides. Every supplied URL is validated; invalid input throws rather than
 * silently falling back to a default.
 */
export function createNetworkConfig(
  base: NetworkConfig = TESTNET,
  overrides: Partial<Pick<NetworkConfig, 'horizonUrl' | 'sorobanRpcUrl' | 'networkPassphrase'>> = {},
  opts: ValidateUrlOptions = {},
): NetworkConfig {
  const horizonUrl = overrides.horizonUrl ?? base.horizonUrl;
  const sorobanRpcUrl = overrides.sorobanRpcUrl ?? base.sorobanRpcUrl;

  validateUrl(horizonUrl, opts);
  validateUrl(sorobanRpcUrl, opts);

  const isCustom =
    horizonUrl !== base.horizonUrl ||
    sorobanRpcUrl !== base.sorobanRpcUrl ||
    (overrides.networkPassphrase !== undefined &&
      overrides.networkPassphrase !== base.networkPassphrase);

  return {
    horizonUrl,
    sorobanRpcUrl,
    networkPassphrase: overrides.networkPassphrase ?? base.networkPassphrase,
    network: isCustom ? 'custom' : base.network,
  };
}

/**
 * Whether a config points somewhere other than a known-good default.
 *
 * Callers should surface this in the UI — a user pointed at an unfamiliar
 * endpoint deserves to know before they sign anything.
 */
export function isCustomEndpoint(config: NetworkConfig): boolean {
  return config.network === 'custom';
}
