/** Reads the current on-network sequence for an account. */
export type SequenceReader = (account: string) => Promise<bigint>;

interface AccountState {
  nextSequence?: bigint;
  lock: Promise<void>;
}

/** Coordinates sequence reservations for accounts. */
export class NonceManager {
  private readonly accounts = new Map<string, AccountState>();

  constructor(private readonly readSequence: SequenceReader) {}

  /** Reserve the next sequence number for an account. */
  async reserve(account: string): Promise<bigint> {
    return this.withLock(account, async () => {
      let state = this.accounts.get(account);
      if (!state || state.nextSequence === undefined) {
        const nextSequence = await this.readSequence(account);
        if (!state) {
          state = { lock: Promise.resolve() };
          this.accounts.set(account, state);
        }
        state.nextSequence = nextSequence;
      }

      const sequence = state.nextSequence;
      state.nextSequence += 1n;
      return sequence;
    });
  }

  /**
   * Resynchronize an account with the authoritative network sequence.
   * Reservations made before this refresh are discarded because they may no
   * longer be valid after a failed submission or fee bump.
   */
  async refresh(account: string): Promise<void> {
    await this.withLock(account, async () => {
      const networkSequence = await this.readSequence(account);
      const state = this.accounts.get(account);
      if (state) {
        state.nextSequence = networkSequence + 1n;
      } else {
        this.accounts.set(account, {
          nextSequence: networkSequence + 1n,
          lock: Promise.resolve(),
        });
      }
    });
  }

  private async withLock<T>(account: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.accounts.get(account)?.lock ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const state = this.accounts.get(account);
    if (state) {
      state.lock = current;
    } else {
      this.accounts.set(account, { lock: current });
    }

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}