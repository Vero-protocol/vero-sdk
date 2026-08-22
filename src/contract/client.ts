import { createContractReader, VeroContractReader } from './read';
import { createContractWriter, VeroContractWriter } from './write';
import type { ContractReaderOptions, ContractWriterOptions } from './types';

export type VeroContractClientOptions = ContractWriterOptions;

export class VeroContractClient {
  readonly read: VeroContractReader;
  readonly write: VeroContractWriter;

  constructor(options: VeroContractClientOptions) {
    this.read = createContractReader(options);
    this.write = createContractWriter(options);
  }
}

export function createContractClient(options: VeroContractClientOptions): VeroContractClient {
  return new VeroContractClient(options);
}

export function createReadOnlyContractClient(options: ContractReaderOptions): VeroContractReader {
  return createContractReader(options);
}
