import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S09QueryExpansionPort } from './s09-synonym.ports';

export class S09QueryExpansionApplication implements S09QueryExpansionPort {
  constructor(private readonly port: S09QueryExpansionPort) {}

  expand(input: { query: string; spaceIds: readonly string[] }, context: TenantContext) {
    return this.port.expand(input, context);
  }
}
