import { VeroError, VeroErrorCode } from '../errors/index.js';
import type { ContractArgument, Decoder } from './types.js';

export const simulatePath = (contractId: string): string => `/contracts/${contractId}/simulate`;
export const submitPath = (contractId: string): string => `/contracts/${contractId}/submit`;

export function toJsonCompatible(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map((item) => toJsonCompatible(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = toJsonCompatible(item);
    }
    return out;
  }
  return value;
}

export function contractInteger(value: number | bigint): ContractArgument {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new VeroError(VeroErrorCode.Unknown, 'Contract integer arguments must be safe integers');
  }
  return value;
}

export function unwrapResult<T>(response: unknown, decode: Decoder<T>): T {
  if (isRecord(response)) {
    const error = response.error;
    if (typeof error === 'string' && error.length > 0) {
      throw new VeroError(VeroErrorCode.TransactionFailed, error);
    }
    if ('result' in response) return decode(response.result);
    if ('value' in response) return decode(response.value);
  }
  return decode(response);
}

export function identity<T>(value: unknown): T {
  return value as T;
}

export function optional<T>(decode: Decoder<T>): Decoder<T | undefined> {
  return (value) => {
    if (value === null || value === undefined) return undefined;
    return decode(value);
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new VeroError(VeroErrorCode.Unknown, `Expected ${field} to be a string`);
  }
  return value;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new VeroError(VeroErrorCode.Unknown, `Expected ${field} to be a boolean`);
  }
  return value;
}

export function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VeroError(VeroErrorCode.Unknown, `Expected ${field} to be a number`);
  }
  return value;
}

export function asBigint(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new VeroError(VeroErrorCode.Unknown, `Expected ${field} to be an integer`);
}

export function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : asString(value, 'optional string');
}

export function recordValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}
