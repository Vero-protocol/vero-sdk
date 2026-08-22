import type { ContractRpcClient, Signer } from '../contract';
import { createContractReader, createContractWriter } from '../contract';

const rpc: ContractRpcClient = {
  request: async <T>() => ({ hash: 'noop', ledger: 1, successful: true }) as T,
};

const signer: Signer = {
  publicKey: () => 'GSIGNER',
  sign: async (invocation) => ({ invocation, signer: 'GSIGNER', signature: 'sig' }),
};

const reader = createContractReader({ rpc, contractId: 'CVERO' });
const writer = createContractWriter({ rpc, contractId: 'CVERO', signer });

function assertContractTypes(): void {
  void writer.registerTask({ admin: 'GADMIN', taskId: 7n, minVotesRequired: 2 });
  void writer.vote({ guardian: 'GGUARDIAN', taskId: 7n });

  // @ts-expect-error taskId must be an integer, not an arbitrary string.
  void writer.registerTask({ admin: 'GADMIN', taskId: '7', minVotesRequired: 2 });

  // @ts-expect-error read helpers do not accept signers.
  void reader.getTask(7n, signer);

  // @ts-expect-error read clients do not expose transaction submission.
  void reader.submit('vote', ['GGUARDIAN', 7n]);
}

void assertContractTypes;

describe('contract type surface', () => {
  it('is checked by TypeScript via ts-expect-error assertions', () => {
    expect(typeof assertContractTypes).toBe('function');
  });
});
