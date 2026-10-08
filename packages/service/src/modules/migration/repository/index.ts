import { createUnimplementedPort } from '../../../ports/defaults';
import type { MigrationRegistryPort } from '../../../ports/capabilities';
import type { Connection } from 'mongoose';
import { MongoMigrationRepository } from './mongo-migration.repository';

export function createMigrationRunRepository(connection?: Connection): MigrationRegistryPort {
  if (connection) return new MongoMigrationRepository(connection);
  return createUnimplementedPort<MigrationRegistryPort>('MigrationRegistryPort');
}
