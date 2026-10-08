import { ApiErrorException } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '../../src/ports/types';
import { MongoDeleteJobRepository } from '../../src/modules/delete/repository/mongo-delete-job.repository';
import {
  DatasetDeleteFailureSchema,
  DatasetDeleteJobSchema,
  type DatasetDeleteFailureDoc,
  type DatasetDeleteJobDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();
const context: RequestContext = {
  requestId: 'req-delete-repo',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let repository: MongoDeleteJobRepository;
let jobs: mongoose.Model<DatasetDeleteJobDoc>;
let failures: mongoose.Model<DatasetDeleteFailureDoc>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_delete_repository'));
  await connection.asPromise();
  jobs = connection.model<DatasetDeleteJobDoc>('DatasetDeleteJob', DatasetDeleteJobSchema);
  failures = connection.model<DatasetDeleteFailureDoc>(
    'DatasetDeleteFailure',
    DatasetDeleteFailureSchema,
  );
  await Promise.all([jobs.init(), failures.init()]);
  repository = new MongoDeleteJobRepository(connection);
}, 60_000);

beforeEach(async () => {
  await Promise.all([jobs.deleteMany({}), failures.deleteMany({})]);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MongoDeleteJobRepository (P2-12)', () => {
  it('creates a stable job id and follows the frozen state machine', async () => {
    const datasetId = String(new mongoose.Types.ObjectId());
    const created = await repository.create(
      {
        job: {
          teamId: String(teamId),
          datasetId,
          state: 'marked',
          stage: 'mongo',
          progress: 0,
          failureCount: 0,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const duplicate = await repository.create(
      {
        job: {
          teamId: String(teamId),
          datasetId,
          state: 'marked',
          stage: 'mongo',
          progress: 0,
          failureCount: 0,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(duplicate.jobId).toBe(created.jobId);

    const queued = await repository.transition(
      {
        jobId: created.jobId,
        expectedState: 'marked',
        nextState: 'queued',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(queued.state).toBe('queued');
    await expect(
      repository.transition(
        {
          jobId: created.jobId,
          expectedState: 'marked',
          nextState: 'completed',
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiErrorException);
  });

  it('paginates failures and retries only failed jobs', async () => {
    const datasetId = String(new mongoose.Types.ObjectId());
    const created = await repository.create(
      {
        job: {
          teamId: String(teamId),
          datasetId,
          state: 'marked',
          stage: 'mongo',
          progress: 0,
          failureCount: 0,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    await repository.transition(
      {
        jobId: created.jobId,
        expectedState: 'marked',
        nextState: 'queued',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    await repository.transition(
      {
        jobId: created.jobId,
        expectedState: 'queued',
        nextState: 'deleting',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    await repository.transition(
      {
        jobId: created.jobId,
        expectedState: 'deleting',
        nextState: 'failed',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    await failures.insertMany(
      Array.from({ length: 3 }, (_, index) => ({
        teamId,
        jobId: created.jobId,
        resourceType: 'vector',
        resourceId: String(index),
        stage: 'vector',
        attempt: 1,
        errorClass: 'Error',
        retryable: true,
        lastError: `failure-${index}`,
      })),
    );
    const page = await repository.listFailures(
      { jobId: created.jobId, limit: 2, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(page.list).toHaveLength(2);
    expect(page.cursor).toBeTruthy();
    expect(
      await repository.retry({ jobId: created.jobId, options: { timeoutMs: 5_000 } }, context),
    ).toEqual({
      accepted: true,
    });
    const foreign = await repository.create(
      {
        job: {
          teamId: String(otherTeamId),
          datasetId,
          state: 'marked',
          stage: 'mongo',
          progress: 0,
          failureCount: 0,
        },
        options: { timeoutMs: 5_000 },
      },
      { ...context, tenant: { ...context.tenant, teamId: String(otherTeamId) } },
    );
    await expect(
      repository.get({ jobId: foreign.jobId, options: { timeoutMs: 5_000 } }, context),
    ).rejects.toMatchObject({ error: { code: 501070 } });
  });
});
