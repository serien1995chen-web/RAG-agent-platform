import { createUnimplementedPort } from '../../../ports/defaults';
import type { CollectionRepository } from '../../../ports/repositories';

/** Adapter 骨架：只封装外部系统访问，不得改变业务状态。 */
export function createSourceCollectionAdapter(): CollectionRepository {
  return createUnimplementedPort<CollectionRepository>('CollectionRepository-adapter');
}

export {
  SourceProviderRegistry,
  SOURCE_PROVIDER_TYPES,
  createSourceProviderRegistry,
  createTextSourceProvider,
  createFileSourceProvider,
  createLinkSourceProvider,
  createApiDatasetSourceProvider,
  createExternalSourceProvider,
} from './source-provider/index';
export type {
  FileParserLike,
  SourceProviderType,
  SourceProviderRegistryDeps,
} from './source-provider/index';
