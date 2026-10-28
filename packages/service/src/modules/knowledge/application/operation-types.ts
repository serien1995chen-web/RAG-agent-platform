import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { FileBinaryResult } from './ports';

export interface KnowledgeOperationInput {
  operationId: string;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string | string[] | undefined>>;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
  context: TenantContext;
}

export interface KnowledgeOperationResult {
  status: number;
  data: unknown;
  headers?: Readonly<Record<string, string>>;
  binary?: FileBinaryResult;
}
