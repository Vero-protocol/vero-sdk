import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { VeroError, VeroErrorCode } from '../errors';
import {
  FreighterSigner,
  KeypairSigner,
  RabetSigner,
  type FreighterApi,
  type RabetApi,
  type Signer,
} from '../signers';

const unsignedXdr = (): string => {
  const source = Keypair.random();
  return new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build()
    .toXDR();
};

const codeOf = async (promise: Promise<unknown>): Promise<VeroErrorCode> => {
  try {
    await promise;
    throw new Error('Expected signer to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(VeroError);
    return (error as VeroError).code;
  }
};

describe('wallet signers', () => {
  it('reports absent wallet globals with the same code', async () => {
    const freighter = new FreighterSigner(undefined);
    const rabet = new RabetSigner(undefined);

    expect(await codeOf(freighter.getPublicKey())).toBe(VeroErrorCode.WalletUnavailable);
    expect(await codeOf(rabet.getPublicKey())).toBe(VeroErrorCode.WalletUnavailable);
  });

  it('normalizes cancellation identically across wallet adapters', async () => {
    const freighterApi: FreighterApi = {
      getAddress: jest.fn(),
      getNetworkDetails: jest.fn().mockResolvedValue({ networkPassphrase: Networks.TESTNET }),
      signTransaction: jest.fn().mockRejectedValue(new Error('User declined the request')),
    };
    const rabetApi: RabetApi = {
      connect: jest.fn(),
      getNetwork: jest.fn().mockResolvedValue(Networks.TESTNET),
      sign: jest.fn().mockRejectedValue(new Error('Request was rejected by the user')),
    };
    const request = { transactionXdr: unsignedXdr(), networkPassphrase: Networks.TESTNET };

    expect(await codeOf(new FreighterSigner(freighterApi).signTransaction(request))).toBe(
      VeroErrorCode.UserRejected,
    );
    expect(await codeOf(new RabetSigner(rabetApi).signTransaction(request))).toBe(
      VeroErrorCode.UserRejected,
    );
  });

  it('refuses a network mismatch before either wallet prompts for a signature', async () => {
    const freighterApi: FreighterApi = {
      getAddress: jest.fn(),
      getNetworkDetails: jest.fn().mockResolvedValue({ networkPassphrase: Networks.PUBLIC }),
      signTransaction: jest.fn(),
    };
    const rabetApi: RabetApi = {
      connect: jest.fn(),
      getNetwork: jest.fn().mockResolvedValue(Networks.PUBLIC),
      sign: jest.fn(),
    };
    const request = { transactionXdr: unsignedXdr(), networkPassphrase: Networks.TESTNET };

    expect(await codeOf(new FreighterSigner(freighterApi).signTransaction(request))).toBe(
      VeroErrorCode.NetworkMismatch,
    );
    expect(await codeOf(new RabetSigner(rabetApi).signTransaction(request))).toBe(
      VeroErrorCode.NetworkMismatch,
    );
    expect(freighterApi.signTransaction).not.toHaveBeenCalled();
    expect(rabetApi.sign).not.toHaveBeenCalled();
  });
});

describe('KeypairSigner', () => {
  it('implements Signer and creates a valid signed transaction', async () => {
    const keypair = Keypair.random();
    const signer: Signer = new KeypairSigner(keypair.secret());
    const signedXdr = await signer.signTransaction({
      transactionXdr: unsignedXdr(),
      networkPassphrase: Networks.TESTNET,
    });

    expect(await signer.getPublicKey()).toBe(keypair.publicKey());
    expect(TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET).signatures).toHaveLength(1);
  });

  it('redacts the secret from strings, JSON, object inspection, errors, and logs', async () => {
    const keypair = Keypair.random();
    const secret = keypair.secret();
    const signer = new KeypairSigner(secret);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const representations = [
      signer.toString(),
      JSON.stringify(signer),
      JSON.stringify(Object.getOwnPropertyDescriptors(signer)),
    ];
    const error = await signer
      .signTransaction({ transactionXdr: 'not-xdr', networkPassphrase: Networks.TESTNET })
      .catch((caught: unknown) => caught);
    representations.push(String(error), JSON.stringify(error));

    expect(representations.join(' ')).not.toContain(secret);
    expect(JSON.stringify(signer)).toContain('[REDACTED]');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('does not include an invalid secret in its constructor error', () => {
    const secret = 'definitely-not-a-secret';
    expect(() => new KeypairSigner(secret)).toThrow(VeroError);
    try {
      new KeypairSigner(secret);
    } catch (error) {
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    }
  });
});
