import { Account, Keypair, Transaction, FeeBumpTransaction, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { buildTransaction, buildManageData, buildFeeBump, estimateFee } from '../transaction';
import { TESTNET } from '../network';
import { DataKey } from '../types';
import { RpcClient } from '../rpc';
import { VeroErrorCode, VeroError } from '../errors';

describe('Transaction Builder', () => {
  const sourceKeypair = Keypair.random();
  const source = new Account(sourceKeypair.publicKey(), '100');

  describe('buildTransaction', () => {
    it('builds a transaction with default timeout and network configuration', () => {
      const builder = buildTransaction(source, TESTNET, { fee: '100' });
      builder.addOperation(buildManageData('reputation', 'test'));
      const tx = builder.build();

      expect(tx.fee).toBe('100');
      expect(tx.networkPassphrase).toBe(TESTNET.networkPassphrase);
      
      const decodedTx = TransactionBuilder.fromXdr(tx.toXdr(), TESTNET.networkPassphrase) as Transaction;
      expect(decodedTx.timeBounds?.maxTime).toBeDefined();
      expect(decodedTx.source).toBe(sourceKeypair.publicKey());
    });
  });

  describe('buildManageData', () => {
    it('creates manageData for reputation', () => {
      const op = buildManageData('reputation', 'my_reputation');
      const parsed = Operation.fromXdrObject(op) as Operation.ManageData;
      expect(parsed.name).toBe(DataKey.reputation);
      expect(Buffer.from(parsed.value!).toString('utf-8')).toBe('my_reputation');
    });

    it('creates manageData for task', () => {
      const op = buildManageData('task', 42, Buffer.from('data'));
      const parsed = Operation.fromXdrObject(op) as Operation.ManageData;
      expect(parsed.name).toBe(DataKey.task(42));
      expect(parsed.value).toEqual(Buffer.from('data'));
    });

    it('creates manageData for vote', () => {
      const op = buildManageData('vote', 123n, 'yes');
      const parsed = Operation.fromXdrObject(op) as Operation.ManageData;
      expect(parsed.name).toBe(DataKey.vote(123n));
      expect(Buffer.from(parsed.value!).toString('utf-8')).toBe('yes');
    });
  });

  describe('buildFeeBump', () => {
    it('creates a fee bump transaction reusing the inner sequence', () => {
      const builder = buildTransaction(source, TESTNET, { fee: '100' });
      builder.addOperation(buildManageData('reputation', 'test'));
      const innerTx = builder.build();

      const feeSourceKeypair = Keypair.random();
      const feeBumpTx = buildFeeBump(innerTx, feeSourceKeypair.publicKey(), '200', TESTNET);
      
      const decodedFeeBump = TransactionBuilder.fromXdr(feeBumpTx.toXdr(), TESTNET.networkPassphrase) as FeeBumpTransaction;
      expect(decodedFeeBump instanceof FeeBumpTransaction).toBe(true);
      expect(decodedFeeBump.feeSource).toBe(feeSourceKeypair.publicKey());
      expect(decodedFeeBump.fee).toBe('400');
      expect(decodedFeeBump.innerTransaction.sequence).toBe(innerTx.sequence);
    });
  });

  describe('estimateFee', () => {
    let mockRpc: jest.Mocked<RpcClient>;

    beforeEach(() => {
      mockRpc = {
        request: jest.fn(),
      } as any;
    });

    it('clamps fee to minFee', async () => {
      mockRpc.request.mockResolvedValueOnce({ fee_charged: { p50: '100' } });
      const fee = await estimateFee(mockRpc, { minFee: 200, maxFee: 500 });
      expect(fee).toBe('200');
    });

    it('clamps fee to maxFee', async () => {
      mockRpc.request.mockResolvedValueOnce({ fee_charged: { p50: '1000' } });
      const fee = await estimateFee(mockRpc, { minFee: 100, maxFee: 500 });
      expect(fee).toBe('500');
    });

    it('uses network fee when within bounds', async () => {
      mockRpc.request.mockResolvedValueOnce({ fee_charged: { p50: '300' } });
      const fee = await estimateFee(mockRpc, { minFee: 100, maxFee: 500 });
      expect(fee).toBe('300');
    });

    it('throws VeroError if minFee > maxFee', async () => {
      await expect(estimateFee(mockRpc, { minFee: 500, maxFee: 100 })).rejects.toThrow(VeroError);
      await expect(estimateFee(mockRpc, { minFee: 500, maxFee: 100 })).rejects.toMatchObject({
        code: VeroErrorCode.Unknown
      });
    });

    it('falls back to throw RpcRequestFailed on network error', async () => {
      mockRpc.request.mockRejectedValueOnce(new Error('Network failure'));
      await expect(estimateFee(mockRpc, { minFee: 100, maxFee: 500 })).rejects.toMatchObject({
        code: VeroErrorCode.RpcRequestFailed
      });
    });
  });
});
