import { createUnimplementedPort } from '../../../ports/defaults';
import type { ProcessingJobRepository } from '../../../ports/repositories';
import type { Connection } from 'mongoose';
import { MongoProcessingJobRepository } from './mongo-processing-job.repository';

export function createProcessingJobRepository(connection?: Connection): ProcessingJobRepository {
  if (connection) return new MongoProcessingJobRepository(connection);
  return createUnimplementedPort<ProcessingJobRepository>('ProcessingJobRepository');
}
