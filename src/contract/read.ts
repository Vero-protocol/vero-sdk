import type { Task, Vote } from '../types/index.js';
import type {
  Address,
  ConsensusState,
  ContractArgument,
  ContractReaderOptions,
  ContractRpcClient,
  Decoder,
  GuardianEntry,
  OperationName,
  RewardStream,
  Snapshot,
  SnapshotMeta,
  VeroReadMethod,
} from './types.js';
import {
  asBigint,
  asBoolean,
  asNumber,
  asString,
  contractInteger,
  identity,
  isRecord,
  optional,
  optionalString,
  recordValue,
  simulatePath,
  toJsonCompatible,
  unwrapResult,
} from './wire.js';

export class VeroContractReader {
  private readonly rpc: ContractRpcClient;
  private readonly contractId: string;

  constructor(options: ContractReaderOptions) {
    this.rpc = options.rpc;
    this.contractId = options.contractId;
  }

  async simulate<T>(
    method: VeroReadMethod,
    args: readonly ContractArgument[] = [],
    decode: Decoder<T> = identity<T>,
  ): Promise<T> {
    const response = await this.rpc.request(simulatePath(this.contractId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractId: this.contractId,
        method,
        args: toJsonCompatible(args),
      }),
    });
    return unwrapResult(response, decode);
  }

  getAdmin(): Promise<Address | undefined> {
    return this.simulate('get_admin', [], optional((value) => asString(value, 'admin')));
  }

  getEstimatedCost(operation: OperationName): Promise<bigint> {
    return this.simulate('get_estimated_cost', [operation], (value) => asBigint(value, 'cost'));
  }

  getStorageVersion(): Promise<number> {
    return this.simulate('get_storage_version', [], (value) => asNumber(value, 'storageVersion'));
  }

  getUpgradeSigners(): Promise<readonly Address[]> {
    return this.simulate('get_upgrade_signers', [], decodeStringArray);
  }

  getUpgradeThreshold(): Promise<number> {
    return this.simulate('get_upgrade_threshold', [], (value) =>
      asNumber(value, 'upgradeThreshold'),
    );
  }

  getWithdrawalTimelock(guardian: Address): Promise<bigint | undefined> {
    return this.simulate(
      'get_withdrawal_timelock',
      [guardian],
      optional((value) => asBigint(value, 'withdrawalTimelock')),
    );
  }

  getTask(taskId: number | bigint): Promise<Task | undefined> {
    return this.simulate('get_task', [contractInteger(taskId)], optional(decodeTask));
  }

  getArchivedTask(taskId: number | bigint): Promise<Task | undefined> {
    return this.simulate('get_archived_task', [contractInteger(taskId)], optional(decodeTask));
  }

  async getVote(taskId: number | bigint, guardian: Address): Promise<Vote | undefined> {
    const snapshot = await this.getSnapshot();
    const normalizedTaskId = asBigint(taskId, 'taskId');
    return snapshot.votes.find(
      (vote) => vote.taskId === normalizedTaskId && vote.guardian === guardian,
    );
  }

  async getConsensusState(taskId: number | bigint): Promise<ConsensusState | undefined> {
    const task = await this.getTask(taskId);
    if (!task) return undefined;
    return {
      taskId: task.taskId,
      votes: getTaskVotes(task),
      minVotesRequired: task.minVotesRequired,
      totalWeightAccrued: getTaskWeight(task),
      resolved: task.resolved,
      cancelled: getTaskCancelled(task),
    };
  }

  getSnapshot(): Promise<Snapshot> {
    return this.simulate('get_snapshot', [], decodeSnapshot);
  }

  getSnapshotMeta(): Promise<SnapshotMeta> {
    return this.simulate('get_snapshot_meta', [], decodeSnapshotMeta);
  }

  getGuardiansPage(offset: number, limit: number): Promise<readonly GuardianEntry[]> {
    return this.simulate('get_guardians_page', [offset, limit], decodeGuardianEntries);
  }

  getTasksPage(offset: number, limit: number): Promise<readonly Task[]> {
    return this.simulate('get_tasks_page', [offset, limit], decodeTasks);
  }

  getRewardStreamsPage(offset: number, limit: number): Promise<readonly RewardStream[]> {
    return this.simulate('get_reward_streams_page', [offset, limit], decodeRewardStreams);
  }

  getSnapshotHistory(): Promise<readonly bigint[]> {
    return this.simulate('get_snapshot_history', [], decodeBigintArray);
  }

  getSnapshotAt(timestamp: number | bigint): Promise<Snapshot> {
    return this.simulate('get_snapshot_at', [contractInteger(timestamp)], decodeSnapshot);
  }

  getRewardStream(taskId: number | bigint): Promise<RewardStream | undefined> {
    return this.simulate(
      'get_reward_stream',
      [contractInteger(taskId)],
      optional(decodeRewardStream),
    );
  }

  hasRole(address: Address, role: string): Promise<boolean> {
    return this.simulate('has_role', [address, role], (value) => asBoolean(value, 'hasRole'));
  }

  isGuardian(guardian: Address): Promise<boolean> {
    return this.simulate('is_guardian', [guardian], (value) => asBoolean(value, 'isGuardian'));
  }

  getReputation(guardian: Address): Promise<bigint | undefined> {
    return this.simulate(
      'get_reputation',
      [guardian],
      optional((value) => asBigint(value, 'reputation')),
    );
  }

  calculateVotingPower(guardian: Address): Promise<bigint | undefined> {
    return this.simulate(
      'calculate_voting_power',
      [guardian],
      optional((value) => asBigint(value, 'votingPower')),
    );
  }

  getWeightThreshold(): Promise<bigint> {
    return this.simulate('get_weight_threshold', [], (value) =>
      asBigint(value, 'weightThreshold'),
    );
  }

  isPaused(): Promise<boolean> {
    return this.simulate('is_paused', [], (value) => asBoolean(value, 'isPaused'));
  }

  getFailureCount(): Promise<number> {
    return this.simulate('get_failure_count', [], (value) => asNumber(value, 'failureCount'));
  }

  getReporterFailureCount(reporter: Address): Promise<number> {
    return this.simulate('get_reporter_failure_count', [reporter], (value) =>
      asNumber(value, 'reporterFailureCount'),
    );
  }

  getFailureReporters(): Promise<readonly Address[]> {
    return this.simulate('get_failure_reporters', [], decodeStringArray);
  }

  isTrustedReportersOnly(): Promise<boolean> {
    return this.simulate('is_trusted_reporters_only', [], (value) =>
      asBoolean(value, 'trustedReportersOnly'),
    );
  }
}

export function createContractReader(options: ContractReaderOptions): VeroContractReader {
  return new VeroContractReader(options);
}

type TaskWithConsensus = Task & {
  votes?: number;
  totalWeightAccrued?: bigint;
  isCancelled?: boolean;
};

function decodeTask(value: unknown): TaskWithConsensus {
  if (!isRecord(value)) throw new Error('Expected task object');
  const id = recordValue(value, 'taskId', 'task_id', 'id');
  const minVotes = recordValue(value, 'minVotesRequired', 'min_votes_required');
  const resolved = recordValue(value, 'resolved', 'is_done');
  const votes = recordValue(value, 'votes');
  const weight = recordValue(value, 'totalWeightAccrued', 'total_weight_accrued');
  const cancelled = recordValue(value, 'cancelled', 'is_cancelled');
  return {
    taskId: asBigint(id, 'task.id'),
    minVotesRequired: asNumber(minVotes, 'task.minVotesRequired'),
    resolved: asBoolean(resolved, 'task.resolved'),
    ...(votes === undefined ? {} : { votes: asNumber(votes, 'task.votes') }),
    ...(weight === undefined
      ? {}
      : { totalWeightAccrued: asBigint(weight, 'task.totalWeightAccrued') }),
    ...(cancelled === undefined
      ? {}
      : { isCancelled: asBoolean(cancelled, 'task.isCancelled') }),
  };
}

function decodeVote(value: unknown): Vote {
  if (!isRecord(value)) throw new Error('Expected vote object');
  const id = recordValue(value, 'taskId', 'task_id', 'id');
  return {
    taskId: asBigint(id, 'vote.taskId'),
    guardian: asString(recordValue(value, 'guardian', 'address'), 'vote.guardian'),
    approve: asBoolean(recordValue(value, 'approve', 'approved', 'value'), 'vote.approve'),
    weight: asBigint(recordValue(value, 'weight', 'voting_power'), 'vote.weight'),
  };
}

function decodeSnapshotMeta(value: unknown): SnapshotMeta {
  if (!isRecord(value)) throw new Error('Expected snapshot meta object');
  return {
    timestamp: asBigint(recordValue(value, 'timestamp'), 'snapshot.timestamp'),
    paused: asBoolean(recordValue(value, 'paused'), 'snapshot.paused'),
    failureCount: asNumber(recordValue(value, 'failureCount', 'failure_count'), 'failureCount'),
    weightThreshold: asBigint(
      recordValue(value, 'weightThreshold', 'weight_threshold'),
      'weightThreshold',
    ),
    admin: optionalString(recordValue(value, 'admin')),
    vaultAddress: optionalString(recordValue(value, 'vaultAddress', 'vault_address')),
    dripsAddress: optionalString(recordValue(value, 'dripsAddress', 'drips_address')),
    guardianCount: asNumber(recordValue(value, 'guardianCount', 'guardian_count'), 'guardianCount'),
    taskCount: asNumber(recordValue(value, 'taskCount', 'task_count'), 'taskCount'),
    rewardStreamCount: asNumber(
      recordValue(value, 'rewardStreamCount', 'reward_stream_count'),
      'rewardStreamCount',
    ),
  };
}

function decodeRewardStream(value: unknown): RewardStream {
  if (!isRecord(value)) throw new Error('Expected reward stream object');
  return {
    taskId: asBigint(recordValue(value, 'taskId', 'task_id'), 'rewardStream.taskId'),
    contributor: asString(recordValue(value, 'contributor'), 'rewardStream.contributor'),
    dripsContract: asString(
      recordValue(value, 'dripsContract', 'drips_contract'),
      'rewardStream.dripsContract',
    ),
    active: asBoolean(recordValue(value, 'active'), 'rewardStream.active'),
  };
}

function decodeGuardianEntry(value: unknown): GuardianEntry {
  if (!isRecord(value)) throw new Error('Expected guardian entry object');
  return {
    address: asString(recordValue(value, 'address'), 'guardian.address'),
    isGuardian: asBoolean(recordValue(value, 'isGuardian', 'is_guardian'), 'guardian.isGuardian'),
    reputation:
      recordValue(value, 'reputation') === undefined || recordValue(value, 'reputation') === null
        ? undefined
        : asBigint(recordValue(value, 'reputation'), 'guardian.reputation'),
  };
}

function decodeSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) throw new Error('Expected snapshot object');
  return {
    timestamp: asBigint(recordValue(value, 'timestamp'), 'snapshot.timestamp'),
    paused: asBoolean(recordValue(value, 'paused'), 'snapshot.paused'),
    failureCount: asNumber(recordValue(value, 'failureCount', 'failure_count'), 'failureCount'),
    weightThreshold: asBigint(
      recordValue(value, 'weightThreshold', 'weight_threshold'),
      'weightThreshold',
    ),
    admin: optionalString(recordValue(value, 'admin')),
    vaultAddress: optionalString(recordValue(value, 'vaultAddress', 'vault_address')),
    dripsAddress: optionalString(recordValue(value, 'dripsAddress', 'drips_address')),
    guardians: decodeGuardianCollection(recordValue(value, 'guardians')),
    reputations: decodeReputationMap(recordValue(value, 'reputations')),
    tasks: decodeTasks(recordValue(value, 'tasks')),
    votes: decodeVoteCollection(recordValue(value, 'votes')),
    rewardStreams: decodeRewardStreams(recordValue(value, 'rewardStreams', 'reward_streams')),
  };
}

function decodeTasks(value: unknown): readonly Task[] {
  return decodeArrayOrRecordValues(value, decodeTask);
}

function decodeRewardStreams(value: unknown): readonly RewardStream[] {
  return decodeArrayOrRecordValues(value, decodeRewardStream);
}

function decodeGuardianEntries(value: unknown): readonly GuardianEntry[] {
  return decodeArrayOrRecordValues(value, decodeGuardianEntry);
}

function decodeStringArray(value: unknown): readonly string[] {
  return decodeArrayOrRecordValues(value, (entry) => asString(entry, 'array entry'));
}

function decodeBigintArray(value: unknown): readonly bigint[] {
  return decodeArrayOrRecordValues(value, (entry) => asBigint(entry, 'array entry'));
}

function decodeArrayOrRecordValues<T>(value: unknown, decode: Decoder<T>): readonly T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(decode);
  if (isRecord(value)) return Object.values(value).map(decode);
  throw new Error('Expected array or record');
}

function decodeGuardianCollection(value: unknown): readonly GuardianEntry[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(decodeGuardianEntry);
  if (!isRecord(value)) throw new Error('Expected guardian collection');
  return Object.entries(value).map(([address, isGuardian]) => ({
    address,
    isGuardian: Boolean(isGuardian),
  }));
}

function decodeReputationMap(value: unknown): Readonly<Record<Address, bigint>> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('Expected reputation map');
  const reputations: Record<Address, bigint> = {};
  for (const [address, score] of Object.entries(value)) {
    reputations[address] = asBigint(score, `reputation.${address}`);
  }
  return reputations;
}

function decodeVoteCollection(value: unknown): readonly Vote[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(decodeVote);
  if (!isRecord(value)) throw new Error('Expected vote collection');
  return Object.entries(value).map(([key, approved]) => {
    const [task, guardian] = key.split(':');
    return {
      taskId: asBigint(task, 'vote.taskId'),
      guardian: guardian ?? '',
      approve: Boolean(approved),
      weight: 0n,
    };
  });
}

function getTaskVotes(task: Task): number {
  return (task as TaskWithConsensus).votes ?? 0;
}

function getTaskWeight(task: Task): bigint {
  return (task as TaskWithConsensus).totalWeightAccrued ?? 0n;
}

function getTaskCancelled(task: Task): boolean {
  return (task as TaskWithConsensus).isCancelled ?? false;
}
