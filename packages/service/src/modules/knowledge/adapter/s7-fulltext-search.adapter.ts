import type { SearchEngineDeps } from '@kb/search';
import type { S7FullTextSearchPort } from '../application/s7-search.ports';

export class S7FullTextSearchAdapter {
  constructor(private readonly repository: S7FullTextSearchPort) {}

  search: NonNullable<SearchEngineDeps['fullText']>['search'] = async (input, context) =>
    this.repository.search(input, context);
}
