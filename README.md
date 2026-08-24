# Vero SDK

[![codecov](https://codecov.io/gh/Vero-protocol/vero-sdk/branch/main/graph/badge.svg)](https://codecov.io/gh/Vero-protocol/vero-sdk)

Shared Stellar client library for the [Vero Protocol](https://github.com/Vero-protocol).

## Why this exists

The relayer, engine, and dashboard each grew their own copy of the same three
concerns — RPC failover, sequence/nonce management, and Stellar interaction —
and they drifted. That drift produced real, separately-filed bugs:

| Bug | Repo | Cause |
| --- | --- | --- |
| [#164](https://github.com/Vero-protocol/vero-core-engine/issues/164) | core-engine | `NonceManager.reserve()` check-then-act race |
| [#183](https://github.com/Vero-protocol/vero-core-engine/issues/183) | core-engine | `refresh()` bypasses the per-account lock |
| [#198](https://github.com/Vero-protocol/vero-relayer-service/issues/198) | relayer-service | Cached sequence defeats the advisory lock |
| [#182](https://github.com/Vero-protocol/vero-core-engine/issues/182) | core-engine | RPC client quarantines healthy endpoints |
| [#288](https://github.com/Vero-protocol/vero-guardian-dashboard/issues/288) | guardian-dashboard | Endpoint URL validation accepts plaintext `http://` |

Three implementations means fixing each bug three times — or, more realistically,
fixing it once and leaving the other two broken. This package is where that
logic lives now.

## Status

**Pre-1.0, under active construction.** Implemented today:

- `types` — shared protocol types (`Role`, `DataKey`, `Task`, `Vote`)
- `errors` — `VeroError` with stable, switchable `VeroErrorCode`s
- `network` — network config and HTTPS-enforcing endpoint validation
- `rpc` — RPC client with failover, health tracking, and origin-safe URL building

Nonce management, transaction building, wallet adapters, and the typed contract
client are tracked as open issues. Contributions welcome — see below.

## Install

```bash
npm install @vero-protocol/sdk
```

## Usage

### Configuring a network

```ts
import { createNetworkConfig, TESTNET, isCustomEndpoint } from '@vero-protocol/sdk';

const config = createNetworkConfig(TESTNET);

// Overrides are validated, not trusted:
const custom = createNetworkConfig(TESTNET, {
  horizonUrl: 'https://my-horizon.example',
});

if (isCustomEndpoint(custom)) {
  // Surface this to the user before they sign anything.
}
```

Plaintext `http://` is rejected. On-chain role and consensus data flows through
these endpoints and feeds signing decisions, so an interceptable endpoint is a
real risk — not a theoretical one. Loopback HTTP is available for local
development, but only via an explicit opt-in:

```ts
validateUrl('http://localhost:8000', { allowInsecureLocalhost: true });
```

### Making RPC calls with failover

```ts
import { RpcClient } from '@vero-protocol/sdk';

const rpc = new RpcClient({
  endpoints: [
    { url: 'https://primary.example', priority: 0 },
    { url: 'https://backup.example', priority: 1 },
  ],
  timeoutMs: 10_000,
});

const account = await rpc.request('/accounts/GABC...');
console.table(rpc.health());
```

Endpoints are penalised for *transport* failures only — unreachable, timeout,
5xx. A 404 for a missing account tells you nothing about endpoint health, and
treating it as a failure is how a single bad request could knock every healthy
endpoint out of rotation.

### Handling errors

```ts
import { VeroError, VeroErrorCode } from '@vero-protocol/sdk';

try {
  await rpc.request('/accounts/GABC...');
} catch (err) {
  if (err instanceof VeroError) {
    switch (err.code) {
      case VeroErrorCode.AccountNotFound:
        // ...
        break;
      case VeroErrorCode.AllEndpointsFailed:
        // ...
        break;
    }
  }
}
```

Switch on `code`, never on message text — messages change, codes don't.

## Error Code Reference

| Code | Cause | Retryable | Recommended Handling |
|------|-------|-----------|----------------------|
| `VeroErrorCode.InvalidUrl` | Endpoint URL fails validation — bad scheme or unparseable | ❌ No | Correct the URL; verify `https://` scheme before retrying |
| `VeroErrorCode.AllEndpointsFailed` | Every configured RPC endpoint returned an error or timed out | ⚠️ Conditional | Wait for endpoint recovery; check `rpc.health()` before retrying |
| `VeroErrorCode.RpcRequestFailed` | A single RPC request returned a non-success HTTP status | ⚠️ Conditional | Retry only on transient errors (429, 5xx); fix request payload for 4xx |
| `VeroErrorCode.RpcTimeout` | The RPC request did not respond within the configured timeout | ✅ Yes | Retry immediately or with short backoff; consider increasing `timeoutMs` |
| `VeroErrorCode.AccountNotFound` | The Stellar account does not exist on the specified network | ❌ No | Fund or create the account on-chain before retrying |
| `VeroErrorCode.UserRejected` | The user declined the signature prompt in their wallet | ❌ No | Surface the cancellation to the user; let them re-initiate when ready |
| `VeroErrorCode.WalletUnavailable` | No browser wallet extension was detected | ⚠️ Conditional | Prompt user to install the wallet extension; retry after it is available |
| `VeroErrorCode.TransactionFailed` | The Stellar network rejected the submitted transaction | ❌ No | Decode the transaction result XDR to diagnose before resubmitting |
| `VeroErrorCode.BadSequence` | The transaction's sequence number is stale | ⚠️ Conditional | Fetch a fresh sequence number and rebuild the transaction before retrying |
| `VeroErrorCode.Unknown` | Error does not match any known SDK error shape | ❌ No | Log the full error and `cause`; investigate before deciding on recovery |

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run docs
```

Requires Node.js 20+.

`npm run docs` generates a browsable API reference from the source comments into `docs/` (gitignored). CI runs the same command so broken doc comments fail the build.

After merge to `main`, the generated reference can be published to GitHub Pages once Pages is set to deploy from GitHub Actions.

## Bundle-size budget

This SDK is intended for browser applications, so consumer bundle size is a
public API concern. It deliberately has **zero runtime dependencies**: a
dependency added for convenience can otherwise silently add code to every
dashboard bundle.

After building, `npm run size` checks the public `@vero-protocol/sdk` entry
point as a browser library. The **5 kB brotli-compressed** budget in
[`.size-limit.json`](.size-limit.json) covers the current SDK with room for
small, intentional changes. CI runs this check for every push and pull request;
an increase beyond the budget fails the build. Raise the budget only when the
added browser cost is understood, justified in the pull request, and reviewed.

## Contributing

Work here is funded through [GrantFox](https://contribute.grantfox.xyz/). Claim
an issue, get assigned, then open a PR referencing `Closes #<issue-number>`.
Full details in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
