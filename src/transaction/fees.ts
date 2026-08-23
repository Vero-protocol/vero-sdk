import { RpcClient } from '../rpc';
import { VeroError, VeroErrorCode } from '../errors';

export interface EstimateFeeOpts {
  minFee: string | number | bigint;
  maxFee: string | number | bigint;
}

/**
 * Estimate network fee and clamp it within bounds.
 */
export async function estimateFee(rpc: RpcClient, opts: EstimateFeeOpts): Promise<string> {
  const minFee = BigInt(opts.minFee);
  const maxFee = BigInt(opts.maxFee);

  if (minFee > maxFee) {
    throw new VeroError(VeroErrorCode.Unknown, 'minFee cannot be greater than maxFee');
  }

  let networkFeeStr: string;
  try {
    const feeStats = await rpc.request<{ fee_charged: { p50: string } }>('/fee_stats');
    networkFeeStr = feeStats.fee_charged.p50;
  } catch (err) {
    // If request fails, fallback to minFee as safe default
    // or we can just throw. Let's just throw, but SDK errors might need to be wrapped.
    if (err instanceof VeroError) throw err;
    throw new VeroError(VeroErrorCode.RpcRequestFailed, 'Failed to fetch fee_stats', err);
  }

  const networkFee = BigInt(networkFeeStr);
  let finalFee = networkFee;

  if (finalFee < minFee) {
    finalFee = minFee;
  }
  if (finalFee > maxFee) {
    finalFee = maxFee;
  }

  return finalFee.toString();
}
