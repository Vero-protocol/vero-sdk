import { CircuitBreaker } from '../circuit-breaker';
import type { BreakerTransition } from '../circuit-breaker';

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const b = new CircuitBreaker();
    expect(b.state).toBe('closed');
    expect(b.canAttempt(1000)).toBe(true);
  });

  it('opens after the failure threshold and refuses attempts during cooldown', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5_000 });

    b.recordFailure(1_000);
    expect(b.state).toBe('closed');

    b.recordFailure(2_000);
    expect(b.state).toBe('open');
    expect(b.canAttempt(3_000)).toBe(false);
    expect(b.canAttempt(6_999)).toBe(false);
  });

  it('emits every state transition with a reason', () => {
    const transitions: BreakerTransition[] = [];
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      onTransition: (t) => transitions.push(t),
    });

    b.recordFailure(1_000, 'ECONNREFUSED');
    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'closed->open:failure-threshold',
    ]);
    expect(transitions[0]?.at).toBe(1_000);

    b.canAttempt(2_500); // cooldown elapsed -> half-open, slot consumed
    b.recordSuccess();
    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'closed->open:failure-threshold',
      'open->half-open:cooldown-elapsed',
      'half-open->closed:probe-succeeded',
    ]);
  });

  it('eligible() is side-effect free; canAttempt() performs the open->half-open move', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    b.recordFailure(1_000);

    expect(b.eligible(3_000)).toBe(true);
    expect(b.state).toBe('open'); // unchanged by the eligibility peek

    expect(b.canAttempt(3_000)).toBe(true);
    expect(b.state).toBe('half-open');
  });

  it('allows exactly one probe in half-open until its outcome is recorded', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    b.recordFailure(1_000);

    expect(b.canAttempt(3_000)).toBe(true);
    expect(b.canAttempt(3_001)).toBe(false); // second concurrent caller denied

    b.recordFailure(3_002); // probe failed -> back to open, fresh cooldown
    expect(b.state).toBe('open');
    expect(b.canAttempt(4_000)).toBe(false); // within the NEW cooldown window
    expect(b.canAttempt(6_000)).toBe(true);
  });

  // Acceptance: a failing half-open probe reopens the breaker without
  // restoring full traffic.
  it('reopens on a failed probe and does not restore traffic before the new cooldown', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });

    b.recordFailure(0);
    expect(b.canAttempt(20_000)).toBe(true); // the probe
    b.recordFailure(20_000);

    expect(b.state).toBe('open');
    expect(b.eligible(25_000)).toBe(false); // old cooldown boundary has passed, still dark
    expect(b.canAttempt(30_000)).toBe(true); // only after a full fresh cooldown
  });

  it('closes and resets the failure count after a successful probe', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 });

    b.recordFailure(1);
    b.recordFailure(2);
    expect(b.canAttempt(3_000)).toBe(true);
    b.recordSuccess();

    expect(b.state).toBe('closed');
    b.recordFailure(3_001); // count restarts from zero: one failure must not reopen
    expect(b.state).toBe('closed');
  });

  it('ignores failures recorded while fully open', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    b.recordFailure(1_000);
    b.recordFailure(1_100);
    b.recordFailure(1_200);
    // Cooldown measured from the original opening, not from late failures.
    expect(b.canAttempt(2_000)).toBe(true);
  });

  it('reset() force-closes from any state', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    b.recordFailure(1_000);
    expect(b.state).toBe('open');

    b.reset();
    expect(b.state).toBe('closed');
    expect(b.canAttempt(1_001)).toBe(true);
  });
});
