import { createUnimplementedPort } from '../../../ports/defaults';
import type { CollectionRepository } from '../../../ports/repositories';
import type { Connection } from 'mongoose';
import type { CollectionTreeRepository } from '../domain/tree';
import type { CollectionTagRepository } from '../domain/tag';
import { MongoCollectionRepository } from './mongo-collection.repository';
import { MongoCollectionTagRepository } from './mongo-collection-tag.repository';

export interface SourceCollectionRepository extends CollectionRepository, CollectionTreeRepository {
  readonly tags: CollectionTagRepository;
}

class MongoSourceCollectionRepository
  extends MongoCollectionRepository
  implements SourceCollectionRepository
{
  readonly tags: MongoCollectionTagRepository;

  constructor(connection: Connection) {
    super(connection);
    this.tags = new MongoCollectionTagRepository(connection);
  }
}

export function createSourceCollectionRepository(
  connection?: Connection,
): SourceCollectionRepository {
  if (connection) return new MongoSourceCollectionRepository(connection);
  return createUnimplementedPort<SourceCollectionRepository>('CollectionRepository');
}
