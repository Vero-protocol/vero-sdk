import { TransactionBuilder, Account, Operation, Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { NetworkConfig } from '../network';
import { DataKey } from '../types';

export interface BuildTransactionOpts {
  fee: string;
  timebounds?: { minTime?: number | string; maxTime?: number | string };
  timeoutSeconds?: number;
}

/**
 * Builds a new TransactionBuilder with correct network configuration.
 */
export function buildTransaction(
  source: Account,
  config: NetworkConfig,
  opts: BuildTransactionOpts
): TransactionBuilder {
  const builder = new TransactionBuilder(source, {
    fee: opts.fee,
    networkPassphrase: config.networkPassphrase,
    timebounds: opts.timebounds,
  });

  if (!opts.timebounds) {
    builder.setTimeout(opts.timeoutSeconds ?? 60);
  }

  return builder;
}

import { xdr } from '@stellar/stellar-sdk';

/**
 * Manage data helper using the DataKey names from src/types
 */
export function buildManageData(key: 'reputation', value: string | Buffer | null): xdr.Operation;
export function buildManageData(key: 'task' | 'vote', arg: number | bigint, value: string | Buffer | null): xdr.Operation;
export function buildManageData(key: string, arg2: unknown, arg3?: unknown): xdr.Operation {
  let name: string;
  let value: string | Buffer | null;

  if (key === 'reputation') {
    name = DataKey.reputation;
    value = arg2 as string | Buffer | null;
  } else if (key === 'task') {
    name = DataKey.task(arg2 as number | bigint);
    value = arg3 as string | Buffer | null;
  } else if (key === 'vote') {
    name = DataKey.vote(arg2 as number | bigint);
    value = arg3 as string | Buffer | null;
  } else {
    throw new Error(`Unknown DataKey type: ${key}`);
  }

  return Operation.manageData({
    name,
    value: value === null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value),
  });
}

/**
 * Build a fee bump transaction reusing the inner transaction's sequence.
 */
export function buildFeeBump(
  innerTx: Transaction,
  feeSource: string,
  fee: string,
  config: NetworkConfig
): FeeBumpTransaction {
  return TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    fee,
    innerTx,
    config.networkPassphrase
  );
}
