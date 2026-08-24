import { VeroError, VeroErrorCode } from '../errors';
import type { NonceManager } from '../nonce';
import { Role } from '../types';
import {
  createContractClient,
  createContractReader,
  createContractWriter,
  createReadOnlyContractClient,
  VeroContractReader,
  VeroContractWriter,
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
  const snapshotResult = {
    timestamp: '10',
    paused: false,
    failure_count: 1,
    weight_threshold: '5',
    admin: 'GADMIN',
    vault_address: 'GVAULT',
    drips_address: 'GDRIPS',
    guardian_count: 1,
    task_count: 1,
    reward_stream_count: 1,
    guardians: { GGUARDIAN: true },
    reputations: { GGUARDIAN: '9' },
    tasks: [{ id: 4, min_votes_required: 2, is_done: false }],
    votes: { '4:GGUARDIAN': true },
    reward_streams: [
      {
        task_id: 4,
        contributor: 'GCONTRIB',
        drips_contract: 'GDRIPS',
        active: true,
      },
    ],
  };

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

  it('creates read-only and full clients with split read/write surfaces', () => {
    const { rpc } = makeRpc();
    const { signer } = makeSigner();

    const readOnly = createReadOnlyContractClient({ rpc, contractId: 'CVERO' });
    const full = createContractClient({ rpc, contractId: 'CVERO', signer });

    expect(readOnly).toBeInstanceOf(VeroContractReader);
    expect(full.read).toBeInstanceOf(VeroContractReader);
    expect(full.write).toBeInstanceOf(VeroContractWriter);
  });

  it('routes all public read helpers through simulation with decoders', async () => {
    const cases = [
      {
        name: 'getAdmin',
        result: 'GADMIN',
        call: (reader: VeroContractReader) => reader.getAdmin(),
        method: 'get_admin',
        args: [],
        expected: 'GADMIN',
      },
      {
        name: 'getEstimatedCost',
        result: '44',
        call: (reader: VeroContractReader) => reader.getEstimatedCost('Vote'),
        method: 'get_estimated_cost',
        args: ['Vote'],
        expected: 44n,
      },
      {
        name: 'getStorageVersion',
        result: 3,
        call: (reader: VeroContractReader) => reader.getStorageVersion(),
        method: 'get_storage_version',
        args: [],
        expected: 3,
      },
      {
        name: 'getUpgradeSigners',
        result: { first: 'G1', second: 'G2' },
        call: (reader: VeroContractReader) => reader.getUpgradeSigners(),
        method: 'get_upgrade_signers',
        args: [],
        expected: ['G1', 'G2'],
      },
      {
        name: 'getUpgradeThreshold',
        result: 2,
        call: (reader: VeroContractReader) => reader.getUpgradeThreshold(),
        method: 'get_upgrade_threshold',
        args: [],
        expected: 2,
      },
      {
        name: 'getWithdrawalTimelock',
        result: '99',
        call: (reader: VeroContractReader) => reader.getWithdrawalTimelock('GGUARDIAN'),
        method: 'get_withdrawal_timelock',
        args: ['GGUARDIAN'],
        expected: 99n,
      },
      {
        name: 'getArchivedTask',
        result: { taskId: '4', minVotesRequired: 2, resolved: true },
        call: (reader: VeroContractReader) => reader.getArchivedTask(4),
        method: 'get_archived_task',
        args: [4],
        expected: { taskId: 4n, minVotesRequired: 2, resolved: true },
      },
      {
        name: 'getSnapshot',
        result: snapshotResult,
        call: (reader: VeroContractReader) => reader.getSnapshot(),
        method: 'get_snapshot',
        args: [],
        expected: expect.objectContaining({
          timestamp: 10n,
          guardians: [{ address: 'GGUARDIAN', isGuardian: true }],
          reputations: { GGUARDIAN: 9n },
        }),
      },
      {
        name: 'getSnapshotMeta',
        result: snapshotResult,
        call: (reader: VeroContractReader) => reader.getSnapshotMeta(),
        method: 'get_snapshot_meta',
        args: [],
        expected: expect.objectContaining({ timestamp: 10n, guardianCount: 1 }),
      },
      {
        name: 'getGuardiansPage',
        result: [{ address: 'GGUARDIAN', is_guardian: true, reputation: '7' }],
        call: (reader: VeroContractReader) => reader.getGuardiansPage(0, 10),
        method: 'get_guardians_page',
        args: [0, 10],
        expected: [{ address: 'GGUARDIAN', isGuardian: true, reputation: 7n }],
      },
      {
        name: 'getTasksPage',
        result: [{ task_id: '8', min_votes_required: 3, is_done: false }],
        call: (reader: VeroContractReader) => reader.getTasksPage(0, 5),
        method: 'get_tasks_page',
        args: [0, 5],
        expected: [{ taskId: 8n, minVotesRequired: 3, resolved: false }],
      },
      {
        name: 'getRewardStreamsPage',
        result: [{ task_id: '8', contributor: 'GC', drips_contract: 'GD', active: true }],
        call: (reader: VeroContractReader) => reader.getRewardStreamsPage(0, 5),
        method: 'get_reward_streams_page',
        args: [0, 5],
        expected: [{ taskId: 8n, contributor: 'GC', dripsContract: 'GD', active: true }],
      },
      {
        name: 'getSnapshotHistory',
        result: ['1', '2'],
        call: (reader: VeroContractReader) => reader.getSnapshotHistory(),
        method: 'get_snapshot_history',
        args: [],
        expected: [1n, 2n],
      },
      {
        name: 'getSnapshotAt',
        result: snapshotResult,
        call: (reader: VeroContractReader) => reader.getSnapshotAt(10),
        method: 'get_snapshot_at',
        args: [10],
        expected: expect.objectContaining({ timestamp: 10n }),
      },
      {
        name: 'getRewardStream',
        result: { task_id: '9', contributor: 'GC', drips_contract: 'GD', active: false },
        call: (reader: VeroContractReader) => reader.getRewardStream(9),
        method: 'get_reward_stream',
        args: [9],
        expected: { taskId: 9n, contributor: 'GC', dripsContract: 'GD', active: false },
      },
      {
        name: 'hasRole',
        result: true,
        call: (reader: VeroContractReader) => reader.hasRole('GADMIN', Role.Admin),
        method: 'has_role',
        args: ['GADMIN', Role.Admin],
        expected: true,
      },
      {
        name: 'isGuardian',
        result: true,
        call: (reader: VeroContractReader) => reader.isGuardian('GGUARDIAN'),
        method: 'is_guardian',
        args: ['GGUARDIAN'],
        expected: true,
      },
      {
        name: 'getReputation',
        result: '7',
        call: (reader: VeroContractReader) => reader.getReputation('GGUARDIAN'),
        method: 'get_reputation',
        args: ['GGUARDIAN'],
        expected: 7n,
      },
      {
        name: 'calculateVotingPower',
        result: '7',
        call: (reader: VeroContractReader) => reader.calculateVotingPower('GGUARDIAN'),
        method: 'calculate_voting_power',
        args: ['GGUARDIAN'],
        expected: 7n,
      },
      {
        name: 'getWeightThreshold',
        result: '10',
        call: (reader: VeroContractReader) => reader.getWeightThreshold(),
        method: 'get_weight_threshold',
        args: [],
        expected: 10n,
      },
      {
        name: 'isPaused',
        result: false,
        call: (reader: VeroContractReader) => reader.isPaused(),
        method: 'is_paused',
        args: [],
        expected: false,
      },
      {
        name: 'getFailureCount',
        result: 1,
        call: (reader: VeroContractReader) => reader.getFailureCount(),
        method: 'get_failure_count',
        args: [],
        expected: 1,
      },
      {
        name: 'getReporterFailureCount',
        result: 2,
        call: (reader: VeroContractReader) => reader.getReporterFailureCount('GREPORTER'),
        method: 'get_reporter_failure_count',
        args: ['GREPORTER'],
        expected: 2,
      },
      {
        name: 'getFailureReporters',
        result: ['G1', 'G2'],
        call: (reader: VeroContractReader) => reader.getFailureReporters(),
        method: 'get_failure_reporters',
        args: [],
        expected: ['G1', 'G2'],
      },
      {
        name: 'isTrustedReportersOnly',
        result: true,
        call: (reader: VeroContractReader) => reader.isTrustedReportersOnly(),
        method: 'is_trusted_reporters_only',
        args: [],
        expected: true,
      },
    ];

    for (const testCase of cases) {
      const { rpc, request } = makeRpc();
      request.mockResolvedValue({ result: testCase.result });
      const reader = createContractReader({ rpc, contractId: 'CVERO' });

      await expect(testCase.call(reader)).resolves.toEqual(testCase.expected);

      expect(request).toHaveBeenCalledWith('/contracts/CVERO/simulate', expect.any(Object));
      const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
      expect(body.method).toBe(testCase.method);
      expect(body.args).toEqual(testCase.args.map((arg) => String(arg).match(/^\d+$/) ? Number(arg) : arg));
    }
  });

  it('returns undefined for optional empty reads', async () => {
    const { rpc, request } = makeRpc();
    request.mockResolvedValue({ result: null });

    const reader = createContractReader({ rpc, contractId: 'CVERO' });

    await expect(reader.getAdmin()).resolves.toBeUndefined();
    await expect(reader.getTask(1)).resolves.toBeUndefined();
  });

  it('normalizes contract simulation errors', async () => {
    const { rpc, request } = makeRpc();
    request.mockResolvedValue({ error: 'DuplicateVote' });

    const reader = createContractReader({ rpc, contractId: 'CVERO' });

    await expect(reader.getAdmin()).rejects.toMatchObject({
      code: VeroErrorCode.TransactionFailed,
      message: 'DuplicateVote',
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
  it('routes all public write helpers through the provided signer', async () => {
    const writeCases = [
      {
        name: 'initialize',
        method: 'initialize',
        call: (writer: VeroContractWriter) =>
          writer.initialize({ admin: 'GADMIN', token: 'GTOKEN', lockThreshold: 10n }),
      },
      {
        name: 'migrateStorage',
        method: 'migrate_storage',
        call: (writer: VeroContractWriter) => writer.migrateStorage('GADMIN'),
      },
      {
        name: 'batchExecute',
        method: 'batch_execute',
        call: (writer: VeroContractWriter) =>
          writer.batchExecute([{ method: 'record_snapshot', args: [] }]),
      },
      {
        name: 'upgradeContract',
        method: 'upgrade_contract',
        call: (writer: VeroContractWriter) => writer.upgradeContract('GADMIN', 'WASM_HASH'),
      },
      {
        name: 'setUpgradeSigners',
        method: 'set_upgrade_signers',
        call: (writer: VeroContractWriter) =>
          writer.setUpgradeSigners({ admin: 'GADMIN', signers: ['G1'], threshold: 1 }),
      },
      {
        name: 'proposeUpgrade',
        method: 'propose_upgrade',
        call: (writer: VeroContractWriter) =>
          writer.proposeUpgrade({ admin: 'GADMIN', newWasmHash: 'WASM_HASH' }),
      },
      {
        name: 'approveUpgrade',
        method: 'approve_upgrade',
        call: (writer: VeroContractWriter) => writer.approveUpgrade('GSIGNER'),
      },
      {
        name: 'executeUpgrade',
        method: 'execute_upgrade',
        call: (writer: VeroContractWriter) => writer.executeUpgrade('GSIGNER'),
      },
      {
        name: 'cancelUpgrade',
        method: 'cancel_upgrade',
        call: (writer: VeroContractWriter) => writer.cancelUpgrade('GADMIN'),
      },
      {
        name: 'lockTokens',
        method: 'lock_tokens',
        call: (writer: VeroContractWriter) =>
          writer.lockTokens({ guardian: 'GGUARDIAN', amount: 10n }),
      },
      {
        name: 'requestUnlock',
        method: 'request_unlock',
        call: (writer: VeroContractWriter) => writer.requestUnlock('GGUARDIAN'),
      },
      {
        name: 'unlockTokens',
        method: 'unlock_tokens',
        call: (writer: VeroContractWriter) => writer.unlockTokens('GGUARDIAN'),
      },
      {
        name: 'emergencyRecover',
        method: 'emergency_recover',
        call: (writer: VeroContractWriter) =>
          writer.emergencyRecover({ admin: 'GADMIN', recipient: 'GDEST', amount: 5n }),
      },
      {
        name: 'cancelTask',
        method: 'cancel_task',
        call: (writer: VeroContractWriter) => writer.cancelTask({ admin: 'GADMIN', taskId: 4n }),
      },
      {
        name: 'purgeTask',
        method: 'purge_task',
        call: (writer: VeroContractWriter) => writer.purgeTask({ admin: 'GADMIN', taskId: 4n }),
      },
      {
        name: 'voteBatch',
        method: 'vote_batch',
        call: (writer: VeroContractWriter) =>
          writer.voteBatch({ guardian: 'GGUARDIAN', taskIds: [4n, 5n] }),
      },
      {
        name: 'archiveTask',
        method: 'archive_task',
        call: (writer: VeroContractWriter) =>
          writer.archiveTask({ admin: 'GADMIN', taskId: 4n }),
      },
      {
        name: 'recordSnapshot',
        method: 'record_snapshot',
        call: (writer: VeroContractWriter) => writer.recordSnapshot(),
      },
      {
        name: 'startRewardStream',
        method: 'start_reward_stream',
        call: (writer: VeroContractWriter) =>
          writer.startRewardStream({
            admin: 'GADMIN',
            dripsContract: 'GDRIPS',
            contributor: 'GCONTRIB',
            taskId: 4n,
          }),
      },
      {
        name: 'grantRole',
        method: 'grant_role',
        call: (writer: VeroContractWriter) =>
          writer.grantRole({ admin: 'GADMIN', address: 'GUSER', role: Role.TaskManager }),
      },
      {
        name: 'revokeRole',
        method: 'revoke_role',
        call: (writer: VeroContractWriter) =>
          writer.revokeRole({ admin: 'GADMIN', address: 'GUSER', role: Role.TaskManager }),
      },
      {
        name: 'addGuardian',
        method: 'add_guardian',
        call: (writer: VeroContractWriter) =>
          writer.addGuardian({ admin: 'GADMIN', address: 'GGUARDIAN' }),
      },
      {
        name: 'removeGuardian',
        method: 'remove_guardian',
        call: (writer: VeroContractWriter) =>
          writer.removeGuardian({ admin: 'GADMIN', address: 'GGUARDIAN' }),
      },
      {
        name: 'setReputation',
        method: 'set_reputation',
        call: (writer: VeroContractWriter) =>
          writer.setReputation({ admin: 'GADMIN', guardian: 'GGUARDIAN', score: 9n }),
      },
      {
        name: 'resignGuardian',
        method: 'resign_guardian',
        call: (writer: VeroContractWriter) => writer.resignGuardian('GGUARDIAN'),
      },
      {
        name: 'setWeightThreshold',
        method: 'set_weight_threshold',
        call: (writer: VeroContractWriter) => writer.setWeightThreshold('GADMIN', 10n),
      },
      {
        name: 'setVaultAddress',
        method: 'set_vault_address',
        call: (writer: VeroContractWriter) =>
          writer.setVaultAddress({ admin: 'GADMIN', address: 'GVAULT' }),
      },
      {
        name: 'setFeeBps',
        method: 'set_fee_bps',
        call: (writer: VeroContractWriter) => writer.setFeeBps({ admin: 'GADMIN', bps: 25 }),
      },
      {
        name: 'setTreasuryAddress',
        method: 'set_treasury_address',
        call: (writer: VeroContractWriter) =>
          writer.setTreasuryAddress({ admin: 'GADMIN', address: 'GTREASURY' }),
      },
      {
        name: 'togglePause',
        method: 'toggle_pause',
        call: (writer: VeroContractWriter) => writer.togglePause('GADMIN'),
      },
      {
        name: 'pause',
        method: 'pause',
        call: (writer: VeroContractWriter) => writer.pause('GADMIN'),
      },
      {
        name: 'unpause',
        method: 'unpause',
        call: (writer: VeroContractWriter) => writer.unpause('GADMIN'),
      },
      {
        name: 'recordFailure',
        method: 'record_failure',
        call: (writer: VeroContractWriter) => writer.recordFailure('GREPORTER'),
      },
      {
        name: 'setTrustedReportersOnly',
        method: 'set_trusted_reporters_only',
        call: (writer: VeroContractWriter) =>
          writer.setTrustedReportersOnly({ admin: 'GADMIN', enabled: true }),
      },
      {
        name: 'resetCircuitBreaker',
        method: 'reset_circuit_breaker',
        call: (writer: VeroContractWriter) => writer.resetCircuitBreaker('GADMIN'),
      },
    ];

    for (const testCase of writeCases) {
      const { rpc, request } = makeRpc();
      const { signer } = makeSigner();
      request.mockResolvedValue({ result: { hash: 'txhash', ledger: 1, successful: true } });
      const writer = createContractWriter({ rpc, contractId: 'CVERO', signer });

      await expect(testCase.call(writer)).resolves.toEqual({
        hash: 'txhash',
        ledger: 1,
        successful: true,
      });

      const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
      expect(request.mock.calls[0]?.[0]).toBe('/contracts/CVERO/submit');
      expect(body.signed.invocation.method).toBe(testCase.method);
    }
  });

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

  it('honors per-submit attempt caps and returns nested submit results', async () => {
    const { rpc, request } = makeRpc();
    const { signer, sign } = makeSigner();
    request
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.RpcTimeout, 'timeout'))
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.RpcTimeout, 'timeout'))
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.RpcTimeout, 'timeout'))
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.RpcTimeout, 'timeout'))
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.RpcTimeout, 'timeout'))
      .mockResolvedValue({ result: { hash: 'too-late', ledger: 1, successful: true } });

    const writer = createContractWriter({
      rpc,
      contractId: 'CVERO',
      signer,
      maxAttempts: 99,
    });

    await expect(writer.recordSnapshot({ maxAttempts: 99 })).rejects.toMatchObject({
      code: VeroErrorCode.RpcTimeout,
    });
    expect(sign).toHaveBeenCalledTimes(5);
  });

  it('uses the default attempt count for invalid submit attempt options', async () => {
    const { rpc, request } = makeRpc();
    const { signer, sign } = makeSigner();
    request
      .mockRejectedValueOnce(new VeroError(VeroErrorCode.RpcTimeout, 'timeout'))
      .mockResolvedValueOnce({ result: { hash: 'txhash', ledger: 2, successful: true } });

    const writer = createContractWriter({
      rpc,
      contractId: 'CVERO',
      signer,
      maxAttempts: 0,
    });

    await expect(writer.recordSnapshot({ maxAttempts: 0 })).resolves.toEqual({
      hash: 'txhash',
      ledger: 2,
      successful: true,
    });
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('does not retry bad sequences without a nonce manager', async () => {
    const { rpc, request } = makeRpc();
    const { signer } = makeSigner();
    request.mockRejectedValueOnce(new VeroError(VeroErrorCode.BadSequence, 'tx_bad_seq'));

    const writer = createContractWriter({ rpc, contractId: 'CVERO', signer, maxAttempts: 3 });

    await expect(writer.recordSnapshot()).rejects.toMatchObject({
      code: VeroErrorCode.BadSequence,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed and unsuccessful submit responses', async () => {
    const { rpc, request } = makeRpc();
    const { signer } = makeSigner();
    const writer = createContractWriter({ rpc, contractId: 'CVERO', signer });

    request.mockResolvedValueOnce({ successful: false });
    await expect(writer.recordSnapshot()).rejects.toMatchObject({
      code: VeroErrorCode.TransactionFailed,
    });

    request.mockResolvedValueOnce('not an object');
    await expect(writer.recordSnapshot()).rejects.toMatchObject({
      code: VeroErrorCode.Unknown,
    });
  });
});
