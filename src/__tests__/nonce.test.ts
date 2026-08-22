import { NonceManager } from '../nonce';

describe('NonceManager', () => {
  it('reserves sequences in order', async () => {
    const manager = new NonceManager(async () => 12n);

    await expect(manager.reserve('GABC')).resolves.toBe(12n);
    await expect(manager.reserve('GABC')).resolves.toBe(13n);
  });

  it('serializes refresh with an in-flight reservation', async () => {
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const readSequence = jest.fn(async () => {
      reads += 1;
      if (reads === 1) {
        await readStarted;
        return 20n;
      }
      return 20n;
    });
    const manager = new NonceManager(readSequence);

    const reservation = manager.reserve('GABC');
    await Promise.resolve();
    const refresh = manager.refresh('GABC');
    await Promise.resolve();

    expect(readSequence).toHaveBeenCalledTimes(1);
    releaseRead();

    await expect(reservation).resolves.toBe(20n);
    await expect(refresh).resolves.toBeUndefined();
    await expect(manager.reserve('GABC')).resolves.toBe(21n);
    expect(readSequence).toHaveBeenCalledTimes(2);
  });

  it('discards cached reservations during refresh', async () => {
    const readSequence = jest.fn().mockResolvedValueOnce(10n).mockResolvedValueOnce(15n);
    const manager = new NonceManager(readSequence);

    await expect(manager.reserve('GABC')).resolves.toBe(10n);
    await expect(manager.reserve('GABC')).resolves.toBe(11n);
    await expect(manager.refresh('GABC')).resolves.toBeUndefined();
    await expect(manager.reserve('GABC')).resolves.toBe(16n);
  });
});