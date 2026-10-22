# Local Development Runbook

## Prerequisites

- WSL2 Ubuntu 22.04 with Node 22.23.2, pnpm 10.33.4 and Docker access.
- Dependency install/update commands are user-owned. Do not run
  `pnpm install/add/update/remove` unless the user explicitly requests it.

## Dependencies

```bash
cd ~/RAG-agent-platform
docker compose -f deploy/docker-compose.yml up -d mongo mongo-init redis pgvector minio
docker compose -f deploy/docker-compose.yml ps
```

The dependency services expose Mongo replica set `rs0`, Redis AOF, PostgreSQL
15 with pgvector, and MinIO. The app itself uses port `3010`.

## Configuration

- App template: `projects/app/.env.example`
- Compose template: `deploy/.env.example`
- Local `.env.local` is gitignored.
- Mock auth/external modes are development-only. Production rejects mock auth.

## Development

```bash
pnpm dev
curl -fsS http://localhost:3010/healthz
curl -fsS http://localhost:3010/readyz
```

Successful probes use the frozen envelope and return the `HealthStatus` object
under `data`. A failed readiness dependency returns 503 with a
`KNOWLEDGE_DEPENDENCY_UNAVAILABLE` Problem, never a fake 200.

## Base Pages

```text
/spaces
/spaces/new
/spaces/[spaceId]/overview
/spaces/[spaceId]/sources
/spaces/[spaceId]/segments
/spaces/[spaceId]/tags
/spaces/[spaceId]/access
/spaces/[spaceId]/jobs
/system/status
```

Deferred import, search, image, synonym, connector and API-key capabilities are
not exposed as available console actions.

## Gates

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm architecture:check
pnpm forbidden-files:check
pnpm license:check
pnpm openapi:check
pnpm knowledge:inventory
pnpm knowledge:check-runtime
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:tenant
pnpm test:concurrency
pnpm test:fault
pnpm test:e2e
pnpm build
pnpm build:workers
```

Integration, tenant, concurrency, fault and E2E suites require the four real
dependencies and the `KB_TEST_*` environment variables documented by CI.

## Stop

```bash
docker compose -f deploy/docker-compose.yml down
```

Removing named volumes is destructive and requires explicit confirmation.
