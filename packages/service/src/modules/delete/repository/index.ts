import { createUnimplementedPort } from '../../../ports/defaults';
import type { DeleteJobRepository } from '../../../ports/repositories';
import type { Connection } from 'mongoose';
import { MongoDeleteJobRepository } from './mongo-delete-job.repository';

export function createDeleteJobRepository(connection?: Connection): DeleteJobRepository {
  if (connection) return new MongoDeleteJobRepository(connection);
  return createUnimplementedPort<DeleteJobRepository>('DeleteJobRepository');
}

export { MongoDeleteFactsRepository } from './mongo-delete-facts.repository';
export { MongoCrossStoreOperationRepository } from './mongo-cross-store-operation.repository';
export { MongoReconcileReportRepository } from './mongo-reconcile-report.repository';
export { MongoS3TtlRepository } from './mongo-s3-ttl.repository';
