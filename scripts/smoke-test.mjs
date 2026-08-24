import { createRequire } from 'node:module';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const REQUIRED_EXPORTS = [
  'VeroError',
  'VeroErrorCode',
  'RpcClient',
  'NonceManager',
  'validateUrl',
  'createNetworkConfig',
  'isCustomEndpoint',
  'TESTNET',
  'MAINNET',
  'retry',
  'defaultIsRetryable',
];

const DECLARATION_CHECKS = [
  ['cjs', 'index.d.ts', /export \* from '\.\/(types|errors|network|rpc|nonce)\/index\.js'/],
  ['cjs', 'index.d.ts', /export \* from '\.\/resilience\/backoff\.js'/],
  ['cjs', 'errors/index.d.ts', 'VeroError'],
  ['cjs', 'rpc/index.d.ts', 'RpcClient'],
  ['cjs', 'nonce/index.d.ts', 'NonceManager'],
  ['esm', 'index.d.ts', /export \* from '\.\/(types|errors|network|rpc|nonce)\/index\.js'/],
  ['esm', 'index.d.ts', /export \* from '\.\/resilience\/backoff\.js'/],
  ['esm', 'errors/index.d.ts', 'VeroError'],
  ['esm', 'rpc/index.d.ts', 'RpcClient'],
  ['esm', 'nonce/index.d.ts', 'NonceManager'],
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`smoke-test: ${message}`);
  }
}

function checkApi(mod, label) {
  for (const name of REQUIRED_EXPORTS) {
    assert(
      mod[name] !== undefined,
      `${label} is missing expected export "${name}"`
    );
  }

  const err = new mod.VeroError(mod.VeroErrorCode.Unknown, 'boom');
  assert(err instanceof Error && err.code === mod.VeroErrorCode.Unknown,
    `${label}: VeroError does not behave as expected`);

  const url = mod.validateUrl('https://horizon.example');
  assert(url.protocol === 'https:',
    `${label}: validateUrl returned an unexpected URL`);

  assert(typeof mod.TESTNET.horizonUrl === 'string',
    `${label}: TESTNET config shape looks wrong`);
}

checkApi(require(join(root, 'dist', 'cjs', 'index.js')), 'CJS direct require');

const esm = await import(pathToFileURL(join(root, 'dist', 'esm', 'index.js')));
checkApi(esm, 'ESM direct import');

for (const [format, relPath, symbol] of DECLARATION_CHECKS) {
  const dts = join(root, 'dist', format, relPath);
  accessSync(dts, constants.R_OK);
  const decls = readFileSync(dts, 'utf8');
  const found = typeof symbol === 'string' ? decls.includes(symbol) : symbol.test(decls);
  assert(found, `dist/${format}/${relPath} is missing ${JSON.stringify(symbol)}`);
}

const viaMapRequire = require('@vero-protocol/sdk');
assert(viaMapRequire.RpcClient !== undefined,
  'exports map: require("@vero-protocol/sdk") did not resolve to the CJS build');

const viaMapImport = await import('@vero-protocol/sdk');
assert(viaMapImport.RpcClient !== undefined,
  'exports map: import("@vero-protocol/sdk") did not resolve to the ESM build');

console.log(`smoke-test: OK — ${REQUIRED_EXPORTS.length} exports verified in both CJS and ESM (direct + exports map), declarations present`);
