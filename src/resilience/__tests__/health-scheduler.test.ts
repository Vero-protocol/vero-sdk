import { HealthScheduler } from '../health-scheduler';

const INTERVAL = 15_000;

describe('HealthScheduler', () => {
  let candidates: jest.Mock;
  let probe: jest.Mock;
  let onRecovery: jest.Mock;
  let onError: jest.Mock;

  const makeScheduler = (overrides: Partial<ConstructorParameters<typeof HealthScheduler>[0]> = {}) =>
    new HealthScheduler({
      intervalMs: INTERVAL,
      candidates,
      probe,
      onRecovery,
      onError,
      ...overrides,
    });

  beforeEach(() => {
    jest.useFakeTimers();
    candidates = jest.fn().mockReturnValue([]);
    probe = jest.fn().mockResolvedValue(undefined);
    onRecovery = jest.fn();
    onError = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('probes current candidates each interval and reports recovery', async () => {
    candidates.mockReturnValue(['https://a.example', 'https://b.example']);
    const s = makeScheduler();
    s.start();

    await jest.advanceTimersByTimeAsync(INTERVAL);

    expect(probe).toHaveBeenCalledWith('https://a.example');
    expect(probe).toHaveBeenCalledWith('https://b.example');
    expect(onRecovery).toHaveBeenCalledTimes(2);
  });

  it('picks up candidates added after start and keeps retrying failures', async () => {
    const s = makeScheduler();
    s.start();

    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(probe).not.toHaveBeenCalled(); // nothing was sick yet

    candidates.mockReturnValue(['https://sick.example']);
    probe.mockRejectedValueOnce(new Error('still down'));

    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('https://sick.example', expect.any(Error));
    expect(onRecovery).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(probe).toHaveBeenCalledTimes(2); // retried next round
    expect(onRecovery).toHaveBeenCalledWith('https://sick.example');
  });

  it('stop() leaves no active timers behind', async () => {
    candidates.mockReturnValue(['https://a.example']);
    const s = makeScheduler();

    s.start();
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    s.stop();
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(probe).not.toHaveBeenCalled();
  });

  it('start() is idempotent — one timer no matter how many times it is called', () => {
    const s = makeScheduler();
    s.start();
    s.start();
    s.start();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('does not schedule follow-up rounds for an in-flight round after stop()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    candidates.mockReturnValue(['https://a.example']);
    probe = jest.fn().mockReturnValue(gate);

    const s = makeScheduler({ probe });
    s.start();
    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(probe).toHaveBeenCalledTimes(1);

    s.stop();
    release();
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('probeOnce() runs a round immediately, even while stopped', async () => {
    candidates.mockReturnValue(['https://a.example']);
    const s = makeScheduler();

    await s.probeOnce();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0); // and schedules nothing further
  });

  it('abandons probes that hang longer than probeTimeoutMs', async () => {
    candidates.mockReturnValue(['https://a.example']);
    probe = jest.fn().mockReturnValue(new Promise<void>(() => undefined));

    const s = makeScheduler({ probe, probeTimeoutMs: 2_000 });
    const round = s.probeOnce();

    await jest.advanceTimersByTimeAsync(2_000);
    await round;

    expect(onError).toHaveBeenCalledWith(
      'https://a.example',
      expect.objectContaining({ message: expect.stringContaining('timed out') }),
    );
    expect(onRecovery).not.toHaveBeenCalled();
  });
});
