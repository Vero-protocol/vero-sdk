import type { NonceManager } from '../nonce/index.js';
import type { Role, SubmitResult, Task, Vote } from '../types/index.js';

export type { SubmitResult, Task, Vote };

export type Address = string;
export type ContractInteger = number | bigint;
export type Bytes32 = string | Uint8Array;

export type ContractArgument =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | readonly ContractArgument[]
  | { readonly [key: string]: ContractArgument };

export interface ContractInvocation {
  contractId: string;
  method: VeroWriteMethod;
  args: readonly ContractArgument[];
  sequence?: bigint;
}

export interface SignedContractInvocation {
  invocation: ContractInvocation;
  signer: Address;
  signature: string;
}

export interface Signer {
  publicKey(): Address | Promise<Address>;
  sign(invocation: ContractInvocation): Promise<SignedContractInvocation>;
}

export interface ContractRpcClient {
  request<T = unknown>(path: string, init?: RequestInit): Promise<T>;
}

export interface ContractClientOptions {
  rpc: ContractRpcClient;
  contractId: string;
}

export type ContractReaderOptions = ContractClientOptions;

export interface ContractWriterOptions extends ContractClientOptions {
  signer: Signer;
  nonceManager?: NonceManager;
  /** Maximum submit attempts for transport failures and `BAD_SEQUENCE`. @default 2 */
  maxAttempts?: number;
}

export interface SubmitOptions {
  maxAttempts?: number;
}

export type VeroReadMethod =
  | 'get_admin'
  | 'get_estimated_cost'
  | 'get_storage_version'
  | 'get_upgrade_signers'
  | 'get_upgrade_threshold'
  | 'get_withdrawal_timelock'
  | 'get_task'
  | 'get_archived_task'
  | 'get_snapshot'
  | 'get_snapshot_meta'
  | 'get_guardians_page'
  | 'get_tasks_page'
  | 'get_reward_streams_page'
  | 'get_snapshot_history'
  | 'get_snapshot_at'
  | 'get_reward_stream'
  | 'has_role'
  | 'is_guardian'
  | 'get_reputation'
  | 'calculate_voting_power'
  | 'get_weight_threshold'
  | 'is_paused'
  | 'get_failure_count'
  | 'get_reporter_failure_count'
  | 'get_failure_reporters'
  | 'is_trusted_reporters_only';

export type VeroWriteMethod =
  | 'initialize'
  | 'migrate_storage'
  | 'batch_execute'
  | 'upgrade_contract'
  | 'set_upgrade_signers'
  | 'propose_upgrade'
  | 'approve_upgrade'
  | 'execute_upgrade'
  | 'cancel_upgrade'
  | 'lock_tokens'
  | 'request_unlock'
  | 'unlock_tokens'
  | 'emergency_recover'
  | 'register_task'
  | 'cancel_task'
  | 'purge_task'
  | 'vote'
  | 'vote_batch'
  | 'archive_task'
  | 'record_snapshot'
  | 'start_reward_stream'
  | 'grant_role'
  | 'revoke_role'
  | 'add_guardian'
  | 'remove_guardian'
  | 'set_reputation'
  | 'resign_guardian'
  | 'set_weight_threshold'
  | 'set_vault_address'
  | 'set_fee_bps'
  | 'set_treasury_address'
  | 'toggle_pause'
  | 'pause'
  | 'unpause'
  | 'record_failure'
  | 'set_trusted_reporters_only'
  | 'reset_circuit_breaker';

export type OperationName =
  | 'RegisterTask'
  | 'Vote'
  | 'AddGuardian'
  | 'SetReputation'
  | 'LockTokens'
  | 'UnlockTokens'
  | 'ResignGuardian'
  | 'SetWeightThreshold'
  | 'StartRewardStream'
  | 'TogglePause'
  | 'RecordFailure'
  | 'ResetCircuitBreaker'
  | 'UpgradeContract'
  | 'RecordSnapshot'
  | 'PurgeTask'
  | 'VoteBatch'
  | 'SetUpgradeSigners'
  | 'ProposeUpgrade'
  | 'ApproveUpgrade'
  | 'ExecuteUpgrade'
  | 'CancelUpgrade'
  | 'EmergencyRecover'
  | 'SetFeeBps'
  | 'SetTreasuryAddress'
  | 'CancelTask'
  | 'RemoveGuardian'
  | 'RequestUnlock'
  | 'SetVaultAddress'
  | 'Pause'
  | 'Unpause';

export interface ConsensusState {
  taskId: bigint;
  votes: number;
  minVotesRequired: number;
  totalWeightAccrued: bigint;
  resolved: boolean;
  cancelled: boolean;
}

export interface SnapshotMeta {
  timestamp: bigint;
  paused: boolean;
  failureCount: number;
  weightThreshold: bigint;
  admin?: Address;
  vaultAddress?: Address;
  dripsAddress?: Address;
  guardianCount: number;
  taskCount: number;
  rewardStreamCount: number;
}

export interface RewardStream {
  taskId: bigint;
  contributor: Address;
  dripsContract: Address;
  active: boolean;
}

export interface GuardianEntry {
  address: Address;
  isGuardian: boolean;
  reputation?: bigint;
}

export interface Snapshot {
  timestamp: bigint;
  paused: boolean;
  failureCount: number;
  weightThreshold: bigint;
  admin?: Address;
  vaultAddress?: Address;
  dripsAddress?: Address;
  guardians: readonly GuardianEntry[];
  reputations: Readonly<Record<Address, bigint>>;
  tasks: readonly Task[];
  votes: readonly Vote[];
  rewardStreams: readonly RewardStream[];
}

export interface RegisterTaskInput {
  admin: Address;
  taskId: ContractInteger;
  minVotesRequired: number;
}

export interface CancelTaskInput {
  admin: Address;
  taskId: ContractInteger;
}

export interface VoteInput {
  guardian: Address;
  taskId: ContractInteger;
}

export interface VoteBatchInput {
  guardian: Address;
  taskIds: readonly ContractInteger[];
}

export interface AddressPairInput {
  admin: Address;
  address: Address;
}

export interface SetReputationInput {
  admin: Address;
  guardian: Address;
  score: ContractInteger;
}

export interface TokenAmountInput {
  guardian: Address;
  amount: ContractInteger;
}

export interface EmergencyRecoverInput {
  admin: Address;
  recipient: Address;
  amount: ContractInteger;
}

export interface StartRewardStreamInput {
  admin: Address;
  dripsContract: Address;
  contributor: Address;
  taskId: ContractInteger;
}

export interface SetRoleInput {
  admin: Address;
  address: Address;
  role: Role;
}

export interface SetUpgradeSignersInput {
  admin: Address;
  signers: readonly Address[];
  threshold: number;
}

export interface ProposeUpgradeInput {
  admin: Address;
  newWasmHash: Bytes32;
}

export interface SetFeeBpsInput {
  admin: Address;
  bps: number;
}

export interface SetTrustedReportersOnlyInput {
  admin: Address;
  enabled: boolean;
}

export interface InitializeInput {
  admin: Address;
  token: Address;
  lockThreshold: ContractInteger;
}

export interface BatchCall {
  method: VeroWriteMethod;
  args: readonly ContractArgument[];
}

export type Decoder<T> = (value: unknown) => T;
