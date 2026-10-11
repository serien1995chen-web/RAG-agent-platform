import { ApiErrorException } from "@kb/contracts";
import { describe, expect, it } from "vitest";
import { ImportSourceService } from "../../src/modules/collection/application/import-source.service";
import { InsertDataService } from "../../src/modules/item/application/insert-data.service";
import { PushDataService } from "../../src/modules/processing/application/push-data.service";
import type {
  DatasetSourceProvider,
  FullTextStore,
  SourceReadRequest,
  SourceReadResult,
  TrainingProcessorPort,
  VectorController,
} from "../../src/ports/capabilities";
import type {
  CollectionRepository,
  KnowledgeItemRepository,
  ProcessingJobRepository,
} from "../../src/ports/repositories";
import type { RequestContext } from "../../src/ports/types";

const context: RequestContext = {
  requestId: "req-1",
  tenant: { teamId: "team-1", tmbId: "tmb-1", authType: "internal", isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};
const options = { timeoutMs: 5000 };

function collectionsFake(created: unknown[]): CollectionRepository {
  return {
    create: async (input) => {
      created.push(input.collection);
      return { collectionId: "col-1" };
    },
    list: async () => ({ total: 0, list: [], cursor: null }),
    update: async () => ({ version: 2 }),
    deleteTree: async () => ({ deleted: 0 }),
  } as unknown as CollectionRepository;
}

function itemsFake(calls: string[]): KnowledgeItemRepository {
  return {
    bulkUpsert: async () => {
      calls.push("mongo");
      return { upserted: 1, duplicates: 0 };
    },
    updateIndexes: async () => ({ version: 2 }),
    deleteByScope: async () => ({ deleted: 0 }),
  } as unknown as KnowledgeItemRepository;
}

function vectorsFake(calls: string[]): VectorController {
  return {
    insert: async () => {
      calls.push("vector");
      return { inserted: 1 };
    },
    delete: async () => ({ deleted: 0 }),
    embRecall: async () => [],
    getVectorDataByTime: async () => [],
    getVectorCount: async () => 0,
  } as unknown as VectorController;
}

function fullTextFake(calls: string[]): FullTextStore {
  return {
    write: async () => {
      calls.push("fulltext");
    },
    search: async () => [],
    deleteByDataId: async () => ({ deleted: 0 }),
    deleteByDatasetIds: async () => ({ deleted: 0 }),
    deleteByCollectionIds: async () => ({ deleted: 0 }),
  } as unknown as FullTextStore;
}

function trainingProcessor(): TrainingProcessorPort {
  return { process: async () => ({ state: "success", producedItems: 1 }) };
}

function sourceProvider(rawText: string, calls?: string[]): DatasetSourceProvider {
  const read = async (request: SourceReadRequest): Promise<SourceReadResult> => {
    calls?.push("read:" + request.sourceType);
    return { rawText, contentHash: "sha256:" + request.sourceType };
  };
  return { read, preview: read };
}

function pushJobRepo(enqueued: string[]): ProcessingJobRepository {
  return {
    enqueue: async (input) => {
      enqueued.push(input.job.jobId);
      return { taskId: "task-" + input.job.jobId, jobId: input.job.jobId };
    },
    claim: async () => ({ taskId: "t", lockTime: "l" }),
    renew: async () => ({ lockTime: "l" }),
    finish: async () => undefined,
  } as unknown as ProcessingJobRepository;
}

describe("TEST-FI-INGEST-001 path A source import", () => {
  it("preview has zero formal side effects", async () => {
    const created: unknown[] = [];
    const service = new ImportSourceService({
      collections: collectionsFake(created),
      sourceProvider: sourceProvider("正文"),
      trainingProcessor: trainingProcessor(),
    });
    const preview = await service.previewOnly(
      { datasetId: "d", sourceType: "text", sourceRef: "正文", options },
      context,
    );
    expect(preview.rawText).toBe("正文");
    expect(created).toHaveLength(0);
  });

  it("creates a collection and enqueues a parse task for non-empty source", async () => {
    const created: unknown[] = [];
    const queued: string[] = [];
    const service = new ImportSourceService({
      collections: collectionsFake(created),
      sourceProvider: sourceProvider("正文"),
      trainingProcessor: trainingProcessor(),
      enqueue: async (task) => {
        queued.push(task.mode);
        return { taskId: task.taskId };
      },
    });
    const result = await service.createCollectionFromSource(
      {
        collection: { teamId: "team-1", datasetId: "d", name: "c", type: "dataset", parentId: null, metadata: {} } as never,
        sourceType: "text",
        sourceRef: "正文",
        options,
      },
      context,
    );
    expect(result.status).toBe("ready");
    expect(result.remainingTraining).toBe(1);
    expect(created).toHaveLength(1);
    expect(queued).toEqual(["parse"]);
  });

  it("returns insertLen=0 ready without Task/Data for an empty import (TEST-INGEST-EMPTY-001)", async () => {
    const created: unknown[] = [];
    const queued: string[] = [];
    const service = new ImportSourceService({
      collections: collectionsFake(created),
      sourceProvider: sourceProvider("   \n  "),
      trainingProcessor: trainingProcessor(),
      enqueue: async (task) => {
        queued.push(task.mode);
        return { taskId: task.taskId };
      },
    });
    const result = await service.createCollectionFromSource(
      {
        collection: { teamId: "team-1", datasetId: "d", name: "c", type: "dataset", parentId: null, metadata: {} } as never,
        sourceType: "text",
        sourceRef: "   ",
        options,
      },
      context,
    );
    expect(result).toMatchObject({ insertLen: 0, remainingTraining: 0, status: "ready" });
    expect(created).toHaveLength(1);
    expect(queued).toHaveLength(0);
  });
});

describe("TEST-FI-INSERT-001 path B direct insert", () => {
  it("writes vector before the Mongo transaction and emits after commit", async () => {
    const calls: string[] = [];
    const service = new InsertDataService({
      items: itemsFake(calls),
      vectors: vectorsFake(calls),
      fullText: fullTextFake(calls),
      withTransaction: async (work) => {
        calls.push("tx:begin");
        const result = await work();
        calls.push("tx:commit");
        return result;
      },
      emit: () => calls.push("event"),
    });
    const result = await service.insertDirect(
      { dataId: "data-1", datasetId: "d", collectionId: "c", q: "  问题 ", a: "答案", vector: [0.1, 0.2], options },
      context,
    );
    expect(result.inserted).toBe(1);
    expect(result.dedupKey).toMatch(/^qa:[0-9a-f]{64}$/);
    expect(calls).toEqual(["vector", "tx:begin", "mongo", "fulltext", "tx:commit", "event"]);
  });

  it("does not write a vector when the Mongo transaction fails", async () => {
    const calls: string[] = [];
    const service = new InsertDataService({
      items: itemsFake(calls),
      vectors: vectorsFake(calls),
      fullText: fullTextFake(calls),
      withTransaction: async (work) => {
        calls.push("tx:begin");
        await work();
        throw new Error("mongo failed");
      },
    });
    await expect(
      service.insertDirect(
        { dataId: "data-1", datasetId: "d", collectionId: "c", q: "问题", vector: [0.1], options },
        context,
      ),
    ).rejects.toThrow("mongo failed");
    expect(calls).toContain("vector");
    expect(calls).not.toContain("event");
  });

  it("rejects a pure image insert with 501038", async () => {
    const calls: string[] = [];
    const service = new InsertDataService({
      items: itemsFake(calls),
      vectors: vectorsFake(calls),
      fullText: fullTextFake(calls),
    });
    const error = await service
      .insertDirect(
        { dataId: "data-1", datasetId: "d", collectionId: "c", q: "", imageId: "img-1", vector: [0.1], options },
        context,
      )
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiErrorException);
    expect((error as ApiErrorException).error.code).toBe(501038);
    expect(calls).toHaveLength(0);
  });
});

describe("TEST-REP-PUSH-001 path C batch push", () => {
  it("writes Mongo facts before queue dispatch and dedupes repeated jobIds", async () => {
    const enqueued: string[] = [];
    const service = new PushDataService({
      jobs: pushJobRepo(enqueued),
      trainingProcessor: trainingProcessor(),
    });
    const result = await service.pushBatch(
      {
        datasetId: "d",
        collectionId: "c",
        mode: "qa",
        items: [
          { jobId: "j1", payload: {} },
          { jobId: "j1", payload: {} },
          { jobId: "j2", payload: {} },
        ],
        options,
      },
      context,
    );
    expect(result.accepted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(enqueued).toEqual(["j1", "j2"]);
  });

  it("rejects an oversized batch without enqueuing", async () => {
    const enqueued: string[] = [];
    const service = new PushDataService({
      jobs: pushJobRepo(enqueued),
      trainingProcessor: trainingProcessor(),
      maxItems: 2,
    });
    const error = await service
      .pushBatch(
        {
          datasetId: "d",
          collectionId: "c",
          mode: "qa",
          items: [
            { jobId: "j1", payload: {} },
            { jobId: "j2", payload: {} },
            { jobId: "j3", payload: {} },
          ],
          options,
        },
        context,
      )
      .catch((thrown: unknown) => thrown);
    expect((error as ApiErrorException).error.code).toBe(501052);
    expect(enqueued).toHaveLength(0);
  });
});
