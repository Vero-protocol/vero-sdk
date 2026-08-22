import { VeroError, VeroErrorCode } from '../errors';
import type { NonceManager } from '../nonce';
import {
  createContractReader,
  createContractWriter,
  type ContractInvocation,
  type ContractRpcClient,
  type SignedContractInvocation,
  type Signer,
} from '../contract';

function makeRpc() {
  const request = jest.fn<Promise<unknown>, [string, RequestInit?]>();
  const rpc: ContractRpcClient = {
    request: request as ContractRpcClient['request'],
  };
  return { rpc, request };
}

function makeSigner() {
  const publicKey = jest.fn<Promise<string>, []>().mockResolvedValue('GSIGNER');
  const sign = jest
    .fn<Promise<SignedContractInvocation>, [ContractInvocation]>()
    .mockImplementation(async (invocation) => ({
      invocation,
      signer: 'GSIGNER',
      signature: `sig-${String(invocation.sequence ?? 'none')}`,
    }));
  const signer: Signer = { publicKey, sign };
  return { signer, publicKey, sign };
}

function makeNonceManager(sequences: readonly bigint[]): NonceManager {
  const reserve = jest.fn<Promise<bigint>, [string]>();
  for (const sequence of sequences) {
    reserve.mockResolvedValueOnce(sequence);
  }
  reserve.mockResolvedValue(sequences[sequences.length - 1] ?? 1n);

  return {
    reserve,
    refresh: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  } as unknown as NonceManager;
}

describe('contract reader', () => {
  it('uses simulation only and never needs a signer for reads', async () => {
    const { rpc, request } = makeRpc();
    request.mockResolvedValue({
      result: {
        id: '42',
        min_votes_required: 2,
        is_done: false,
      },
    });

    const reader = createContractReader({ rpc, contractId: 'CVERO' });
    await expect(reader.getTask(42n)).resolves.toEqual({
      taskId: 42n,
      minVotesRequired: 2,
      resolved: false,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/contracts/CVERO/simulate');
    const init = request.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      contractId: 'CVERO',
      method: 'get_task',
      args: ['42'],
    });
  });

  it('derives consensus state from the task read helper', async () => {
    const { rpc, request } = makeRpc();
    request.mockResolvedValue({
      result: {
        id: 7,
        votes: 3,
        min_votes_required: 2,
        is_done: true,
        total_weight_accrued: '12',
        is_cancelled: false,
      },
    });

    const reader = createContractReader({ rpc, contractId: 'CVERO' });
    await expect(reader.getConsensusState(7)).resolves.toEqual({
      taskId: 7n,
      votes: 3,
      minVotesRequired: 2,
      totalWeightAccrued: 12n,
      resolved: true,
      cancelled: false,
    });
  });
});

describe('contract writer', () => {
  it('submits typed write entrypoints through the provided signer', async () => {
    const { rpc, request } = makeRpc();
    const { signer, sign } = makeSigner();
    const nonceManager = makeNonceManager([101n]);
    request.mockResolvedValue({ hash: 'txhash', ledger: 123, successful: true });

    const writer = createContractWriter({
      rpc,
      contractId: 'CVERO',
      signer,
      nonceManager,
    });

    await expect(
      writer.registerTask({ admin: 'GADMIN', taskId: 42n, minVotesRequired: 2 }),
    ).resolves.toEqual({ hash: 'txhash', ledger: 123, successful: true });

    expect(sign).toHaveBeenCalledWith({
      contractId: 'CVERO',
      method: 'register_task',
      args: ['GADMIN', 42n, 2],
      sequence: 101n,
    });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.signed.invocation.sequence).toBe('101');
  });

  it('does not retry application-level rejections', async () => {
    const { rpc, request } = makeRpc();
    const { signer, sign } = makeSigner();
    request.mockRejectedValue(new VeroError(VeroErrorCode.TransactionFailed, 'DuplicateVote'));

    const writer = createContractWriter({
      rpc,
      contractId: 'CVERO',
      signer,
      nonceManager: makeNonceManager([101n, 102n]),
      maxAttempts: 5,
    });

    await expect(writer.vote({ guardian: 'GGUARDIAN', taskId: 42n })).rejects.toMatchObject({
      code: VeroErrorCode.TransactionFailed,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('retries transport failures without submitting the same sequence twice', async () => {
    const { rpc, request } = makeRpc();
    const { signer, sign } = makeSigner();
    request
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.AllEndpointsFailed, 'temporary outage'))
      .mockResolvedValueOnce({ hash: 'txhash', ledger: 124, successful: true });

    const writer = createContractWriter({
      rpc,
      contractId: 'CVERO',
      signer,
      nonceManager: makeNonceManager([101n, 102n]),
      maxAttempts: 3,
    });

    await writer.vote({ guardian: 'GGUARDIAN', taskId: 42n });

    expect(request).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls.map(([invocation]) => invocation.sequence)).toEqual([101n, 102n]);
  });

  it('refreshes nonce before retrying a bad-sequence rejection', async () => {
    const { rpc, request } = makeRpc();
    const { signer, sign } = makeSigner();
    const nonceManager = makeNonceManager([101n, 201n]);
    request
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.BadSequence, 'tx_bad_seq'))
      .mockResolvedValueOnce({ hash: 'txhash', ledger: 125, successful: true });

    const writer = createContractWriter({
      rpc,
      contractId: 'CVERO',
      signer,
      nonceManager,
      maxAttempts: 3,
    });

    await writer.vote({ guardian: 'GGUARDIAN', taskId: 42n });

    expect(nonceManager.refresh).toHaveBeenCalledWith('GSIGNER');
    expect(sign.mock.calls.map(([invocation]) => invocation.sequence)).toEqual([101n, 201n]);
  });
});
