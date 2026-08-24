/**
 * Tests for the mock Horizon + Soroban RPC server.
 *
 * Two things are pinned here:
 *   1. The built-in routes return *realistic* shapes — the Horizon account
 *      record the loader consumes, and JSON-RPC results that match Soroban
 *      RPC (echoed `id`, `jsonrpc: "2.0"`).
 *   2. The fixtures align with the SDK itself — a fixture event's `topic[0]`
 *      must decode via `decodeEvent` to the event type its symbol names.
 */

import {
  createMockServer,
  horizonAccountFixture,
  sorobanContractEvent,
  sorobanEventsResult,
  sorobanRpcResponse,
  scValSymbol,
  DEFAULT_ACCOUNT_ID,
  type MockServer,
  type ScriptedFailure,
} from '../mock-server';
import { decodeEvent, normalizeTopic, type TaskRegisteredEvent } from '../../events';

describe('fixtures', () => {
  it('horizonAccountFixture matches the real Horizon account shape', () => {
    const account = horizonAccountFixture();

    expect(account.account_id).toBe(DEFAULT_ACCOUNT_ID);
    expect(typeof account.sequence).toBe('string');
    expect(account.thresholds).toEqual({
      low_threshold: 0,
      med_threshold: 0,
      high_threshold: 0,
    });
    expect(account.flags).toMatchObject({ auth_required: false });
    // Real accounts always carry a native balance line.
    const native = (account.balances as { asset_type: string }[]).find(
      (b) => b.asset_type === 'native',
    );
    expect(native).toBeDefined();
    expect(account.signers).toHaveLength(1);
  });

  it('sorobanContractEvent topics decode through the SDK event decoder', () => {
    const event = sorobanContractEvent({
      topic: [scValSymbol('reg'), scValSymbol('admin-address')],
    });
    const topics = event.topic as string[];

    // The raw RPC event carries `value.xdr` (opaque to this SDK), so topic[0]
    // is what the decoder consumes; give it an already-decoded payload to
    // exercise the full pipeline.
    expect(normalizeTopic(topics[0] ?? '')).toBe('task_registered');
    const decoded = decodeEvent({
      topic: [topics[0] ?? ''],
      data: ['GADMIN', '42'],
    }) as TaskRegisteredEvent;
    expect(decoded.type).toBe('task_registered');
    expect(decoded.taskId).toBe(42n);
  });

  it('sorobanRpcResponse wraps results in the JSON-RPC envelope', () => {
    expect(sorobanRpcResponse('getHealth', { status: 'healthy' }, 7)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { status: 'healthy' },
    });
  });

  it('sorobanEventsResult carries the three Vero contract events', () => {
    const result = sorobanEventsResult();
    const events = result.events as { topic: string[] }[];
    const names = events.map((e) => e.topic[0]).map((t) => t ?? '');
    expect(normalizeTopic(names[0] ?? '')).toBe('task_registered');
    expect(normalizeTopic(names[1] ?? '')).toBe('vote_cast');
    expect(normalizeTopic(names[2] ?? '')).toBe('consensus_resolved');
    expect(result.latestLedger).toBeGreaterThan(0);
    expect(result.cursor).toBeDefined();
  });
});

describe('MockServer — Horizon routes', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it('serves a realistic account for GET /accounts/:id', async () => {
    const res = await server.fetch('https://horizon.example/accounts/GABC');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);

    const body = (await res.json()) as { account_id: string; sequence: string };
    expect(body.account_id).toBe('GABC');
    expect(typeof body.sequence).toBe('string');
  });

  it('bumps the account sequence on each fetch, like the real ledger', async () => {
    const first = (await (
      await server.fetch('https://horizon.example/accounts/GABC')
    ).json()) as { sequence: string };
    const second = (await (
      await server.fetch('https://horizon.example/accounts/GABC')
    ).json()) as { sequence: string };

    expect(BigInt(second.sequence)).toBe(BigInt(first.sequence) + 1n);
  });

  it('returns a Horizon problem-details 404 for unknown paths', async () => {
    const res = await server.fetch('https://horizon.example/ledgers/1');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { title: string; status: number };
    expect(body.title).toBe('Resource Missing');
    expect(body.status).toBe(404);
  });
});

describe('MockServer — Soroban RPC routes', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
  });

  const rpc = (method: string, id = 1) =>
    server.fetch('https://soroban.example/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method }),
    });

  it('answers getHealth', async () => {
    const body = (await (await rpc('getHealth')).json()) as {
      jsonrpc: string;
      id: number;
      result: { status: string };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.status).toBe('healthy');
  });

  it('answers getNetwork with the testnet passphrase', async () => {
    const body = (await (await rpc('getNetwork', 2)).json()) as {
      id: number;
      result: { passphrase: string };
    };
    expect(body.id).toBe(2);
    expect(body.result.passphrase).toBe('Test SDF Network ; September 2015');
  });

  it('answers getLatestLedger', async () => {
    const body = (await (await rpc('getLatestLedger')).json()) as {
      result: { sequence: number };
    };
    expect(body.result.sequence).toBeGreaterThan(0);
  });

  it('answers getEvents with decodable Vero events', async () => {
    const body = (await (await rpc('getEvents')).json()) as {
      result: { events: { topic: string[] }[] };
    };
    const topics = body.result.events.map((e) => e.topic[0] ?? '');
    expect(normalizeTopic(topics[0] ?? '')).toBe('task_registered');
  });

  it('reports JSON-RPC errors for unknown methods and bad bodies', async () => {
    const unknown = (await (await rpc('bogusMethod')).json()) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);

    const badBody = (await (
      await server.fetch('https://soroban.example/', {
        method: 'POST',
        body: 'not json',
      })
    ).json()) as { error: { code: number } };
    expect(badBody.error.code).toBe(-32700);
  });
});

describe('MockServer — scripted failures', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
  });

  const scenarios: [string, ScriptedFailure, (res: Response) => Promise<void> | void][] = [
    [
      'http status',
      { type: 'http', status: 503 },
      (res) => {
        expect(res.status).toBe(503);
        expect(res.ok).toBe(false);
      },
    ],
  ];

  for (const [label, failure, assert] of scenarios) {
    it(`applies a scripted ${label} failure`, async () => {
      server.failNext('a.example', failure);
      await assert(await server.fetch('https://a.example/accounts/GABC'));
    });
  }

  it('scripts a malformed body (200 with invalid JSON)', async () => {
    server.failNext('a.example', { type: 'malformed' });
    const res = await server.fetch('https://a.example/accounts/GABC');
    expect(res.status).toBe(200);
    // Match on the message: undici rejects with a cross-realm SyntaxError, so
    // `instanceof SyntaxError` (what toThrow uses) is unreliable.
    await expect(res.json()).rejects.toThrow(/not valid JSON/);
  });

  it('scripts a network rejection', async () => {
    server.failNext('a.example', { type: 'network', error: new Error('ECONNREFUSED') });
    await expect(server.fetch('https://a.example/accounts/GABC')).rejects.toThrow(
      'ECONNREFUSED',
    );

    server.failNext('a.example', { type: 'network' });
    await expect(server.fetch('https://a.example/accounts/GABC')).rejects.toThrow(
      TypeError,
    );
  });

  it('scripts a timeout that rejects with AbortError on abort', async () => {
    server.failNext('a.example', { type: 'timeout' });

    const controller = new AbortController();
    const pending = server.fetch('https://a.example/accounts/GABC', {
      signal: controller.signal,
    });

    let settled = false;
    void pending.catch(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false); // still hanging before the abort

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('applies a scripted failure only to matching URLs, once', async () => {
    server.failNext('a.example', { type: 'http', status: 500 });

    const primary = await server.fetch('https://a.example/accounts/GABC');
    expect(primary.status).toBe(500);

    // Non-matching URL is unaffected, and the script is now consumed.
    const backup = await server.fetch('https://b.example/accounts/GABC');
    expect(backup.status).toBe(200);

    const retry = await server.fetch('https://a.example/accounts/GABC');
    expect(retry.status).toBe(200);
  });
});

describe('MockServer — custom handlers', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it('serves a plain-value body as 200 JSON', async () => {
    server.handle((url) => url.includes('custom'), { ok: 'custom' });
    const body = (await (await server.fetch('https://a.example/custom')).json()) as {
      ok: string;
    };
    expect(body.ok).toBe('custom');
  });

  it('passes through a Response for full control', async () => {
    server.handle('teapot', () => new Response('short and stout', { status: 418 }));
    const res = await server.fetch('https://a.example/teapot');
    expect(res.status).toBe(418);
    await expect(res.text()).resolves.toBe('short and stout');
  });

  it('lets a handler throw to simulate a persistently-down endpoint', async () => {
    server.handle('down', () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(server.fetch('https://a.example/down')).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

describe('MockServer — bookkeeping', () => {
  it('records every request for assertions', async () => {
    const server = createMockServer();
    await server.fetch('https://a.example/accounts/GABC');
    await server.fetch('https://soroban.example/', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    });

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.method).toBe('GET');
    expect(server.requests[0]?.url).toContain('/accounts/GABC');
    expect(server.requests[1]?.body).toMatchObject({ method: 'getHealth' });
  });

  it('reset() clears scripts, handlers, and the request log', async () => {
    const server = createMockServer();
    server.failNext('a.example', { type: 'http', status: 500 });
    server.handle('x', { ok: true });

    await server.fetch('https://a.example/x');
    expect(server.requests).toHaveLength(1);

    server.reset();
    await server.fetch('https://a.example/x');
    expect(server.requests).toHaveLength(1);

    // The previously-scripted failure is gone — this returned 200 (default route).
    const res = await server.fetch('https://a.example/accounts/GABC');
    expect(res.status).toBe(200);
  });

  it('applies the configured latency to responses', async () => {
    jest.useFakeTimers();
    try {
      const server = createMockServer({ latencyMs: 500 });
      const pending = server.fetch('https://a.example/accounts/GABC');
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
