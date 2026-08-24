import { VeroError, VeroErrorCode, normalizeError } from '../errors/index.js';
import type { SubmitResult } from '../types/index.js';
import type {
  Address,
  AddressPairInput,
  BatchCall,
  Bytes32,
  CancelTaskInput,
  ContractArgument,
  ContractInvocation,
  ContractRpcClient,
  ContractWriterOptions,
  EmergencyRecoverInput,
  InitializeInput,
  ProposeUpgradeInput,
  RegisterTaskInput,
  SetFeeBpsInput,
  SetReputationInput,
  SetRoleInput,
  SetTrustedReportersOnlyInput,
  SetUpgradeSignersInput,
  Signer,
  StartRewardStreamInput,
  SubmitOptions,
  TokenAmountInput,
  VeroWriteMethod,
  VoteBatchInput,
  VoteInput,
} from './types.js';
import { asBoolean, asNumber, asString, contractInteger, isRecord, submitPath, toJsonCompatible } from './wire.js';
import type { NonceManager } from '../nonce/index.js';

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPT_CAP = 5;

export class VeroContractWriter {
  private readonly rpc: ContractRpcClient;
  private readonly contractId: string;
  private readonly signer: Signer;
  private readonly nonceManager?: NonceManager;
  private readonly defaultMaxAttempts: number;

  constructor(options: ContractWriterOptions) {
    this.rpc = options.rpc;
    this.contractId = options.contractId;
    this.signer = options.signer;
    this.nonceManager = options.nonceManager;
    this.defaultMaxAttempts = clampAttempts(options.maxAttempts);
  }

  initialize(input: InitializeInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit(
      'initialize',
      [input.admin, input.token, contractInteger(input.lockThreshold)],
      options,
    );
  }

  migrateStorage(admin: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('migrate_storage', [admin], options);
  }

  batchExecute(calls: readonly BatchCall[], options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit(
      'batch_execute',
      [calls.map((call) => ({ method: call.method, args: call.args }))],
      options,
    );
  }

  upgradeContract(admin: Address, newWasmHash: Bytes32, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('upgrade_contract', [admin, newWasmHash], options);
  }

  setUpgradeSigners(input: SetUpgradeSignersInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('set_upgrade_signers', [input.admin, input.signers, input.threshold], options);
  }

  proposeUpgrade(input: ProposeUpgradeInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('propose_upgrade', [input.admin, input.newWasmHash], options);
  }

  approveUpgrade(signer: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('approve_upgrade', [signer], options);
  }

  executeUpgrade(signer: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('execute_upgrade', [signer], options);
  }

  cancelUpgrade(admin: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('cancel_upgrade', [admin], options);
  }

  lockTokens(input: TokenAmountInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('lock_tokens', [input.guardian, contractInteger(input.amount)], options);
  }

  requestUnlock(guardian: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('request_unlock', [guardian], options);
  }

  unlockTokens(guardian: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('unlock_tokens', [guardian], options);
  }

  emergencyRecover(input: EmergencyRecoverInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit(
      'emergency_recover',
      [input.admin, input.recipient, contractInteger(input.amount)],
      options,
    );
  }

  registerTask(input: RegisterTaskInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit(
      'register_task',
      [input.admin, contractInteger(input.taskId), input.minVotesRequired],
      options,
    );
  }

  cancelTask(input: CancelTaskInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('cancel_task', [input.admin, contractInteger(input.taskId)], options);
  }

  purgeTask(input: CancelTaskInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('purge_task', [input.admin, contractInteger(input.taskId)], options);
  }

  vote(input: VoteInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('vote', [input.guardian, contractInteger(input.taskId)], options);
  }

  voteBatch(input: VoteBatchInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit(
      'vote_batch',
      [input.guardian, input.taskIds.map((taskId) => contractInteger(taskId))],
      options,
    );
  }

  archiveTask(input: CancelTaskInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('archive_task', [input.admin, contractInteger(input.taskId)], options);
  }

  recordSnapshot(options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('record_snapshot', [], options);
  }

  startRewardStream(input: StartRewardStreamInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit(
      'start_reward_stream',
      [input.admin, input.dripsContract, input.contributor, contractInteger(input.taskId)],
      options,
    );
  }

  grantRole(input: SetRoleInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('grant_role', [input.admin, input.address, input.role], options);
  }

  revokeRole(input: SetRoleInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('revoke_role', [input.admin, input.address, input.role], options);
  }

  addGuardian(input: AddressPairInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('add_guardian', [input.admin, input.address], options);
  }

  removeGuardian(input: AddressPairInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('remove_guardian', [input.admin, input.address], options);
  }

  setReputation(input: SetReputationInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit(
      'set_reputation',
      [input.admin, input.guardian, contractInteger(input.score)],
      options,
    );
  }

  resignGuardian(guardian: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('resign_guardian', [guardian], options);
  }

  setWeightThreshold(admin: Address, threshold: number | bigint, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('set_weight_threshold', [admin, contractInteger(threshold)], options);
  }

  setVaultAddress(input: AddressPairInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('set_vault_address', [input.admin, input.address], options);
  }

  setFeeBps(input: SetFeeBpsInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('set_fee_bps', [input.admin, input.bps], options);
  }

  setTreasuryAddress(input: AddressPairInput, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('set_treasury_address', [input.admin, input.address], options);
  }

  togglePause(admin: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('toggle_pause', [admin], options);
  }

  pause(admin: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('pause', [admin], options);
  }

  unpause(admin: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('unpause', [admin], options);
  }

  recordFailure(reporter: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('record_failure', [reporter], options);
  }

  setTrustedReportersOnly(
    input: SetTrustedReportersOnlyInput,
    options?: SubmitOptions,
  ): Promise<SubmitResult> {
    return this.submit('set_trusted_reporters_only', [input.admin, input.enabled], options);
  }

  resetCircuitBreaker(admin: Address, options?: SubmitOptions): Promise<SubmitResult> {
    return this.submit('reset_circuit_breaker', [admin], options);
  }

  async submit(
    method: VeroWriteMethod,
    args: readonly ContractArgument[],
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const maxAttempts = clampAttempts(options.maxAttempts ?? this.defaultMaxAttempts);
    const signerAccount = await this.signer.publicKey();
    let lastError: VeroError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const sequence = this.nonceManager
        ? await this.nonceManager.reserve(signerAccount)
        : undefined;
      const invocation: ContractInvocation = {
        contractId: this.contractId,
        method,
        args,
        ...(sequence === undefined ? {} : { sequence }),
      };
      const signed = await this.signer.sign(invocation);

      try {
        const response = await this.rpc.request(submitPath(this.contractId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contractId: this.contractId,
            signed: toJsonCompatible(signed),
          }),
        });
        return decodeSubmitResult(response);
      } catch (err) {
        const normalized = normalizeError(err, VeroErrorCode.TransactionFailed);
        lastError = normalized;
        if (normalized.code === VeroErrorCode.BadSequence) {
          if (!this.nonceManager || attempt >= maxAttempts) throw normalized;
          await this.nonceManager.refresh(signerAccount);
          continue;
        }
        if (!isTransportRetry(normalized.code) || attempt >= maxAttempts) {
          throw normalized;
        }
      }
    }

    throw lastError ?? new VeroError(VeroErrorCode.Unknown, 'Contract submission did not run');
  }
}

export function createContractWriter(options: ContractWriterOptions): VeroContractWriter {
  return new VeroContractWriter(options);
}

function clampAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(attempts, MAX_ATTEMPT_CAP);
}

function isTransportRetry(code: VeroErrorCode): boolean {
  return code === VeroErrorCode.AllEndpointsFailed || code === VeroErrorCode.RpcTimeout;
}

function decodeSubmitResult(value: unknown): SubmitResult {
  if (!isRecord(value)) throw new VeroError(VeroErrorCode.Unknown, 'Expected submit result object');
  if ('result' in value) return decodeSubmitResult(value.result);
  const successful = asBoolean(value.successful ?? true, 'submit.successful');
  if (!successful) {
    throw new VeroError(VeroErrorCode.TransactionFailed, 'Transaction was rejected by the network');
  }
  return {
    hash: asString(value.hash, 'submit.hash'),
    ledger: asNumber(value.ledger, 'submit.ledger'),
    successful,
  };
}
