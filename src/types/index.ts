/**
 * Shared protocol types.
 *
 * These mirror the on-chain definitions in `vero-core-contracts`. Keeping them
 * in one place is the point of this package: previously the relayer, engine and
 * dashboard each carried their own copy, and they drifted.
 */

/** Stellar network the client is pointed at. */
export type NetworkName = 'testnet' | 'mainnet' | 'custom';

/** Roles recognised by the contract's RBAC module. */
export enum Role {
  Admin = 'Admin',
  GuardianManager = 'GuardianManager',
  Guardian = 'Guardian',
  TaskManager = 'TaskManager',
  ConfigManager = 'ConfigManager',
  EmergencyManager = 'EmergencyManager',
  TreasuryManager = 'TreasuryManager',
}

/**
 * Storage keys used by the contract.
 *
 * Mirrors `DataKey` in `vero-core-contracts/src/contracts/storage_layout.rs`.
 * Values are the `manageData` entry names as they appear on-chain.
 */
export const DataKey = {
  task: (taskId: number | bigint) => `task_${taskId}`,
  vote: (taskId: number | bigint) => `vote_${taskId}`,
  reputation: 'vero_reputation',
} as const;

/** A pull request registered on-chain as a reviewable task. */
export interface Task {
  /** Contract-side task identifier. */
  taskId: bigint;
  /** Votes required before the task resolves. */
  minVotesRequired: number;
  /** Whether consensus has been reached. */
  resolved: boolean;
}

/** A Guardian's vote on a task. */
export interface Vote {
  taskId: bigint;
  /** Stellar account of the voting Guardian. */
  guardian: string;
  approve: boolean;
  /** Weight contributed, derived from the Guardian's reputation. */
  weight: bigint;
}

/** Result of submitting a transaction to the network. */
export interface SubmitResult {
  hash: string;
  ledger: number;
  successful: boolean;
}

/** Minimal logger contract. Any console-like object satisfies it. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
