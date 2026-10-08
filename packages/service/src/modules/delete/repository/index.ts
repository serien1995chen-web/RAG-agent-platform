import { createUnimplementedPort } from '../../../ports/defaults';
import type { DeleteJobRepository } from '../../../ports/repositories';
import type { Connection } from 'mongoose';
import { MongoDeleteJobRepository } from './mongo-delete-job.repository';

export function createDeleteJobRepository(connection?: Connection): DeleteJobRepository {
  if (connection) return new MongoDeleteJobRepository(connection);
  return createUnimplementedPort<DeleteJobRepository>('DeleteJobRepository');
}
