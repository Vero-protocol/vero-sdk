/**
 * Mock Horizon + Soroban RPC server for tests.
 *
 * Tests used to hand-roll `fetch` mocks per file. Each module reinvented the
 * same Horizon account body and Soroban JSON-RPC envelope, and those
 * hand-rolled shapes drifted from what the real servers return — a mock that
 * passes while the real integration fails is worse than no mock at all.
 *
 * This module is the single place that produces realistic responses:
 *
 *   - `GET /accounts/:id`       → a real-shaped Horizon account record
 *   - `POST /` (JSON-RPC)       → `getHealth`, `getNetwork`,
 *                                 `getLatestLedger`, `getEvents` results
 *   - anything else             → a Horizon problem-details 404
 *
 * Failures are scripted per-request with {@link MockServer.failNext}:
 * timeouts (never settles until the caller's `AbortSignal` fires — which is
 * what an `RpcClient` timeout does), network rejections, 5xx HTTP statuses,
 * and 200s with bodies that are not valid JSON.
 *
 * Deliberately NOT re-exported from `src/index.ts`. It exists only for tests
 * and is reachable via the `@vero-protocol/sdk/testing` subpath export, so
 * consumers' test suites can use it without the mock (or its fixtures) ever
 * entering the main bundle.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Matches a request URL: substring, RegExp, or a predicate. */
export type UrlMatcher = string | RegExp | ((url: string) => boolean);

/**
 * A one-shot scripted failure, applied to the next matching request.
 *
 * - `timeout`    — never settles; rejects with `AbortError` when the caller's
 *                  `AbortSignal` fires. Pass no signal and the request hangs
 *                  forever (an `RpcClient` always passes its timeout signal).
 * - `network`    — rejects the fetch promise like a failed connection.
 * - `http`       — resolves to a response with the given status.
 * - `malformed`  — resolves to a 200 whose body is not valid JSON, so
 *                  `response.json()` rejects.
 */
export type ScriptedFailure =
  | { type: 'timeout' }
  | { type: 'network'; error?: Error }
  | { type: 'http'; status: number; body?: unknown }
  | { type: 'malformed'; body?: string };

/** A request as observed by the mock server (for assertions and handlers). */
export interface MockRequest {
  /** Full request URL, e.g. `https://a.example/accounts/GABC`. */
  url: string;
  /** HTTP method, uppercased. */
  method: string;
  /** Parsed JSON body for requests that carried one. */
  body?: unknown;
}

/**
 * A dynamic handler. Return a plain object/array for a 200 JSON response, a
 * `Response` to control status/headers, or throw to reject the fetch promise
 * (useful for simulating repeated network failures).
 */
export type Responder = (
  req: MockRequest,
) => unknown | Response | Promise<unknown | Response>;

export interface MockServerOptions {
  /**
   * Base latency applied to every response, in milliseconds.
   * @default 0
   */
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Fixtures — based on real Horizon / Soroban RPC response shapes
// ---------------------------------------------------------------------------

/** The zero-account address (valid Stellar format, clearly a fixture). */
export const DEFAULT_ACCOUNT_ID =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Base sequence for newly-seen accounts. Realistic Horizon sequence numbers
 * are large monotonically increasing integers.
 */
export const ACCOUNT_BASE_SEQUENCE = 22305791749488643n;

/**
 * A realistic Horizon `/accounts/:id` record, mirroring the fields Horizon
 * actually returns: `_links`, `id`, `sequence`, `subentry_count`,
 * `last_modified_ledger`, `thresholds`, `flags`, `balances` (native + a
 * credit asset), `signers`, `data`, and paging metadata. The loader's
 * `normalizeAccount` consumes this shape directly.
 */
export function horizonAccountFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const accountId = (overrides.account_id as string | undefined) ?? DEFAULT_ACCOUNT_ID;
  return {
    _links: {
      self: { href: `https://horizon-testnet.stellar.org/accounts/${accountId}` },
    },
    id: accountId,
    account_id: accountId,
    sequence: '22305791749488643',
    subentry_count: 2,
    last_modified_ledger: 3541234,
    last_modified_time: '2024-06-01T12:34:56Z',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    balances: [
      {
        balance: '9999.9999900',
        limit: '922337203685.4775807',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
        last_modified_ledger: 3541234,
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer:
          'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
      {
        balance: '100.0000000',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
        asset_type: 'native',
      },
    ],
    signers: [{ weight: 1, key: accountId, type: 'ed25519_public_key' }],
    data: {},
    num_sponsored: 0,
    num_sponsoring: 0,
    paging_token: '3541234-3',
    ...overrides,
  };
}

/**
 * Base64 XDR `ScVal` symbol — what Soroban RPC returns for event `topic`
 * entries (int32 tag 15, u32 length, UTF-8 bytes). The event decoder
 * (`src/events/decoder.ts`) recognises these, so fixtures built with this
 * helper decode to real event types instead of `unknown`.
 */
export function scValSymbol(name: string): string {
  const bytes = Buffer.byteLength(name, 'utf8');
  const buf = Buffer.alloc(8 + bytes);
  buf.writeInt32BE(15, 0); // SCV_SYMBOL
  buf.writeUInt32BE(bytes, 4);
  buf.write(name, 8, 'utf8');
  return buf.toString('base64');
}

/** Base64 XDR `ScVal` u64 (int32 tag 5). Useful as a non-symbol topic entry. */
export function scValU64(value: bigint): string {
  const buf = Buffer.alloc(12);
  buf.writeInt32BE(5, 0); // SCV_U64
  buf.writeBigUInt64BE(value, 4);
  return buf.toString('base64');
}

/** A single `ScVal` vec (int32 tag 10) from element XDR buffers. */
function scValVec(...elements: Buffer[]): Buffer {
  const head = Buffer.alloc(8);
  head.writeInt32BE(10, 0); // SCV_VEC
  head.writeUInt32BE(elements.length, 4);
  return Buffer.concat([head, ...elements]);
}

/** Realistic but opaque `value.xdr` — a vec of two u64s, valid ScVal XDR. */
function eventValueXdr(): string {
  const u64 = (v: bigint): Buffer => {
    const buf = Buffer.alloc(12);
    buf.writeInt32BE(5, 0); // SCV_U64
    buf.writeBigUInt64BE(v, 4);
    return buf;
  };
  return scValVec(u64(42n), u64(7n)).toString('base64');
}

/**
 * A realistic Soroban RPC contract event record, mirroring `getEvents` event
 * objects: `type`, `ledger`, `ledgerClosedAt`, `contractId`, `id`,
 * `pagingToken`, a `topic` array of base64 ScVal XDR (topic[0] is the event
 * name symbol — the only field the SDK decodes), an opaque `value.xdr`, and
 * `inSuccessfulContractCall`.
 */
export function sorobanContractEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'contract',
    ledger: 3541234,
    ledgerClosedAt: '2024-06-01T12:34:56Z',
    contractId:
      'CDLZFC3SYJYDZT7K3V6KZ4Y3XK4XK4XK4XK4XK4XK4XK4XK4XK4XK4XK4X',
    id: '0000000000000000-0000000000',
    pagingToken: '3541234-0000000000',
    topic: [scValSymbol('reg'), scValU64(42n), scValU64(7n)],
    value: { xdr: eventValueXdr() },
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

/**
 * The three Vero contract events (`reg`, `wt_vote`, `resolved` — see
 * `vero-core-contracts/src/events.rs`), so `getEvents` fixtures exercise the
 * full decoder surface.
 */
export function defaultSorobanEvents(): Record<string, unknown>[] {
  return [
    sorobanContractEvent({ topic: [scValSymbol('reg'), scValU64(42n)] }),
    sorobanContractEvent({
      id: '0000000000000001-0000000000',
      pagingToken: '3541234-0000000001',
      topic: [scValSymbol('wt_vote'), scValU64(42n), scValU64(250n)],
    }),
    sorobanContractEvent({
      id: '0000000000000002-0000000000',
      pagingToken: '3541234-0000000002',
      topic: [scValSymbol('resolved'), scValU64(42n), scValU64(250n)],
    }),
  ];
}

/** Realistic `getEvents` result body (events + latest/oldest ledger info). */
export function sorobanEventsResult(
  events: Record<string, unknown>[] = defaultSorobanEvents(),
): Record<string, unknown> {
  return {
    events,
    latestLedger: 3541234,
    latestLedgerCloseTime: '2024-06-01T12:34:56Z',
    oldestLedger: 3540000,
    oldestLedgerCloseTime: '2024-06-01T00:00:00Z',
    cursor: '3541234-0000000000',
  };
}

/** Realistic `getHealth` result body. */
export function sorobanHealthResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'healthy',
    latestLedger: 3541234,
    oldestLedger: 3540000,
    ledgerRetentionWindow: 129600,
    ...overrides,
  };
}

/** Realistic `getNetwork` result body. */
export function sorobanNetworkResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    friendbotUrl: 'https://friendbot.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    protocolVersion: 22,
    ...overrides,
  };
}

/** Realistic `getLatestLedger` result body. */
export function sorobanLatestLedgerResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '7ec0be6a4a014d9f9f1e34f9e1b0a4f5c3d2e1b0a9f8e7d6c5b4a39281706',
    protocolVersion: 22,
    sequence: 3541234,
    ...overrides,
  };
}

/** Wrap a method result in the Soroban RPC JSON-RPC envelope, echoing `id`. */
export function sorobanRpcResponse(
  method: string,
  result: unknown,
  id: unknown = 1,
): Record<string, unknown> {
  void method; // documented for clarity; the envelope does not echo it
  return { jsonrpc: '2.0', id, result };
}

/** Horizon problem-details body for a 404, matching Horizon's error shape. */
export function horizonNotFound(): Record<string, unknown> {
  return {
    type: 'https://horizon-testnet.stellar.org/problem/not_found',
    title: 'Resource Missing',
    status: 404,
    detail: 'The resource at the url requested was not found.',
  };
}

// ---------------------------------------------------------------------------
// The mock server
// ---------------------------------------------------------------------------

interface ScriptEntry {
  matcher: UrlMatcher;
  failure: ScriptedFailure;
}

interface HandlerEntry {
  matcher: UrlMatcher;
  responder: Responder | unknown;
}

/**
 * A fake Horizon + Soroban RPC server.
 *
 * Create one per test (or per suite), hand {@link MockServer.fetch} to an
 * `RpcClient` as `fetchImpl` or assign it to `global.fetch`, and script
 * failures with {@link MockServer.failNext}.
 */
export class MockServer {
  private readonly latencyMs: number;
  private readonly scripts: ScriptEntry[] = [];
  private readonly handlers: HandlerEntry[] = [];
  private readonly log: MockRequest[] = [];
  /** Per-account sequence, bumped on every fetch like the real ledger. */
  private readonly sequences = new Map<string, bigint>();

  constructor(opts: MockServerOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
  }

  /**
   * Drop-in `fetch` implementation. Use as `fetchImpl` on `RpcClient`, or
   * assign to `global.fetch` for code that calls `fetch` directly.
   */
  get fetch(): typeof fetch {
    return (input, init) => this.respond(input, init);
  }

  /** Requests received so far, oldest first. For call-count assertions. */
  get requests(): readonly MockRequest[] {
    return [...this.log];
  }

  /**
   * Script a one-shot failure for the next request whose URL matches
   * `matcher`. The script is consumed by the first matching request and does
   * not affect non-matching URLs, so a failover test can script a failure on
   * the primary endpoint while the backup responds normally.
   */
  failNext(matcher: UrlMatcher, failure: ScriptedFailure): this {
    this.scripts.push({ matcher, failure });
    return this;
  }

  /**
   * Register a custom response for requests whose URL matches `matcher`.
   * `responder` may be:
   *
   *   - a function returning a plain value → 200 JSON;
   *   - a function returning a `Response` → used as-is (custom status/body);
   *   - a function that throws → the fetch promise rejects (handy for
   *     simulating a persistently-down endpoint);
   *   - a plain value → 200 JSON for every matching request.
   *
   * Handlers run after scripted failures and before the built-in routes, in
   * registration order.
   */
  handle(matcher: UrlMatcher, responder: Responder | unknown): this {
    this.handlers.push({ matcher, responder });
    return this;
  }

  /** Clear scripted failures, custom handlers, the request log, and
   *  per-account sequence state. */
  reset(): void {
    this.scripts.length = 0;
    this.handlers.length = 0;
    this.log.length = 0;
    this.sequences.clear();
  }

  private async respond(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const req: MockRequest = {
      url: toUrl(input),
      method: (init?.method ?? 'GET').toUpperCase(),
    };
    if (typeof init?.body === 'string') {
      try {
        req.body = JSON.parse(init.body);
      } catch {
        // Leave body unset — the JSON-RPC route reports a parse error.
      }
    }

    this.log.push(req);

    if (this.latencyMs > 0) {
      await delay(this.latencyMs);
    }

    const scriptIdx = this.scripts.findIndex((s) => matches(s.matcher, req.url));
    if (scriptIdx !== -1) {
      const [script] = this.scripts.splice(scriptIdx, 1);
      return this.respondFailure(
        script?.failure ?? { type: 'network' },
        init?.signal ?? undefined,
      );
    }

    for (const { matcher, responder } of this.handlers) {
      if (matches(matcher, req.url)) {
        return toResponse(await invokeResponder(responder, req));
      }
    }

    return this.routeDefault(req);
  }

  private async respondFailure(
    failure: ScriptedFailure,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    switch (failure.type) {
      case 'timeout':
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(abortError());
            return;
          }
          signal?.addEventListener('abort', () => reject(abortError()), {
            once: true,
          });
          // No signal: never settle — the request simply hangs.
        });
      case 'network':
        throw failure.error ?? new TypeError('fetch failed');
      case 'http':
        return jsonResponse(failure.body ?? null, failure.status);
      case 'malformed':
        return new Response(failure.body ?? '<html><body>not json</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
    }
  }

  /** Built-in routes: Horizon accounts, Soroban JSON-RPC, else 404. */
  private routeDefault(req: MockRequest): Response {
    const { pathname } = new URL(req.url);

    // Horizon: GET /accounts/:id
    const accountMatch = /^\/accounts\/([^/]+)$/.exec(pathname);
    if (accountMatch?.[1] && req.method === 'GET') {
      return jsonResponse(this.accountBody(decodeURIComponent(accountMatch[1])));
    }

    // Soroban RPC: JSON-RPC POST to the endpoint root.
    if (req.method === 'POST' && (pathname === '/' || pathname === '')) {
      return this.rpcResponse(req);
    }

    return jsonResponse(horizonNotFound(), 404);
  }

  private accountBody(id: string): Record<string, unknown> {
    const seq = this.sequences.get(id) ?? ACCOUNT_BASE_SEQUENCE;
    // Sequence advances on every fetch, mirroring the real ledger after a
    // transaction — a second fetch of the same account returns a bumped value.
    this.sequences.set(id, seq + 1n);
    return horizonAccountFixture({ account_id: id, sequence: seq.toString() });
  }

  private rpcResponse(req: MockRequest): Response {
    const body = req.body;
    if (body === null || typeof body !== 'object') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }

    const { id, method, params } = body as Record<string, unknown>;
    const rpcId = id ?? null;

    switch (method) {
      case 'getHealth':
        return jsonResponse(sorobanRpcResponse('getHealth', sorobanHealthResult(), rpcId));
      case 'getNetwork':
        return jsonResponse(sorobanRpcResponse('getNetwork', sorobanNetworkResult(), rpcId));
      case 'getLatestLedger':
        return jsonResponse(
          sorobanRpcResponse('getLatestLedger', sorobanLatestLedgerResult(), rpcId),
        );
      case 'getEvents':
        return jsonResponse(sorobanRpcResponse('getEvents', sorobanEventsResult(), rpcId));
      default:
        void params;
        return jsonResponse({
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32601, message: `Method not found: ${String(method)}` },
        });
    }
  }
}

/** Create a {@link MockServer}. */
export function createMockServer(opts: MockServerOptions = {}): MockServer {
  return new MockServer(opts);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function matches(matcher: UrlMatcher, url: string): boolean {
  if (typeof matcher === 'function') return matcher(url);
  if (matcher instanceof RegExp) return matcher.test(url);
  return url.includes(matcher);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function invokeResponder(
  responder: Responder | unknown,
  req: MockRequest,
): Promise<unknown | Response> {
  return typeof responder === 'function'
    ? (responder as Responder)(req)
    : responder;
}

async function toResponse(result: unknown | Response): Promise<Response> {
  if (result instanceof Response) return result;
  return jsonResponse(result);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'AbortError');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
