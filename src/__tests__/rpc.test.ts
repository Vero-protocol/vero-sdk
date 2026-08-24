import { RpcClient } from '../rpc';
import { VeroError, VeroErrorCode } from '../errors';
import { createMockServer, type MockServer } from '../testing';

describe('RpcClient', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it('requires at least one endpoint', () => {
    expect(() => new RpcClient({ endpoints: [], fetchImpl: jest.fn() })).toThrow(VeroError);
  });

  it('validates endpoint URLs at construction', () => {
    expect(() => new RpcClient({ endpoints: ['http://evil.example'], fetchImpl: jest.fn() })).toThrow(
      VeroError,
    );
  });

  it('returns the parsed body on success', async () => {
    const client = new RpcClient({ endpoints: ['https://a.example'], fetchImpl: server.fetch });
    await expect(client.request('/accounts/GABC')).resolves.toMatchObject({
      account_id: 'GABC',
    });
  });

  it('falls over to the next endpoint on transport failure', async () => {
    server.failNext('a.example', { type: 'network', error: new Error('ECONNREFUSED') });

    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl: server.fetch,
    });

    await expect(client.request('/accounts/GABC')).resolves.toMatchObject({
      account_id: 'GABC',
    });
    expect(server.requests).toHaveLength(2);
  });

  it('treats 5xx as a transport failure and fails over', async () => {
    server.failNext('a.example', { type: 'http', status: 503 });

    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl: server.fetch,
    });

    await expect(client.request('/accounts/GABC')).resolves.toMatchObject({
      account_id: 'GABC',
    });
  });

  // Regression guard for vero-core-engine#182.
  it('does NOT penalise an endpoint for an application-level 4xx', async () => {
    server.failNext('a.example', { type: 'http', status: 404 });

    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl: server.fetch,
      failureThreshold: 1,
    });

    await expect(client.request('/accounts/missing')).rejects.toMatchObject({
      code: VeroErrorCode.AccountNotFound,
    });

    // Only the first endpoint was tried, and it stays healthy.
    expect(server.requests).toHaveLength(1);
    expect(client.health().every((h) => h.healthy)).toBe(true);
  });

  it('quarantines an endpoint after the failure threshold', async () => {
    server.handle('a.example', () => {
      throw new Error('ECONNREFUSED');
    });

    const client = new RpcClient({
      endpoints: ['https://a.example'],
      fetchImpl: server.fetch,
      failureThreshold: 2,
    });

    await expect(client.request('/accounts/GABC')).rejects.toThrow(VeroError);
    expect(client.health()[0]?.healthy).toBe(true); // 1 failure, below threshold

    await expect(client.request('/accounts/GABC')).rejects.toThrow(VeroError);
    expect(client.health()[0]?.healthy).toBe(false);
  });

  it('throws ALL_ENDPOINTS_FAILED when nothing succeeds', async () => {
    server.handle(() => true, () => {
      throw new Error('ECONNREFUSED');
    });

    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl: server.fetch,
    });

    await expect(client.request('/accounts/GABC')).rejects.toMatchObject({
      code: VeroErrorCode.AllEndpointsFailed,
    });
  });

  it('resets a consecutive-failure count after a success', async () => {
    server.failNext('a.example', { type: 'network', error: new Error('ECONNREFUSED') });

    const client = new RpcClient({ endpoints: ['https://a.example'], fetchImpl: server.fetch });
    await expect(client.request('/accounts/GABC')).rejects.toThrow();
    await expect(client.request('/accounts/GABC')).resolves.toMatchObject({
      account_id: 'GABC',
    });
    expect(client.health()[0]?.consecutiveFailures).toBe(0);
  });

  // Regression guard for the SSRF pattern in vero-audit-guard#302.
  it('refuses a path that would escape the endpoint origin', async () => {
    const client = new RpcClient({ endpoints: ['https://a.example'], fetchImpl: server.fetch });

    await expect(client.request('https://evil.example/steal')).rejects.toMatchObject({
      code: VeroErrorCode.InvalidUrl,
    });
    expect(server.requests).toHaveLength(0);
  });

  it('honours endpoint priority', async () => {
    const client = new RpcClient({
      endpoints: [
        { url: 'https://low.example', priority: 10 },
        { url: 'https://high.example', priority: 1 },
      ],
      fetchImpl: server.fetch,
    });

    await client.request('/accounts/GABC');
    expect(server.requests[0]?.url).toContain('high.example');
  });

  it('resetHealth clears quarantines', async () => {
    server.handle('a.example', () => {
      throw new Error('ECONNREFUSED');
    });

    const client = new RpcClient({
      endpoints: ['https://a.example'],
      fetchImpl: server.fetch,
      failureThreshold: 1,
    });

    await expect(client.request('/accounts/GABC')).rejects.toThrow();
    expect(client.health()[0]?.healthy).toBe(false);

    client.resetHealth();
    expect(client.health()[0]?.healthy).toBe(true);
  });
});
