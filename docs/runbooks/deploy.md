# Knowledge Baseline Deployment Runbook

## Image Boundary

- One image runs two processes: HTTP app and BullMQ/Outbox worker.
- App command: `pnpm --filter @kb/app start`
- Worker command: `node projects/app/dist/workers/worker.mjs`
- App exposes `3010`; worker exposes no HTTP port.
- Docker image construction and pull are user/CI-owned release operations.

## Compose Dependencies

- MongoDB single-node replica set `rs0`
- Redis 7.2 with AOF
- PostgreSQL 15 + pgvector
- MinIO with a persistent volume
- No `latest` tag

## Build And Validate

```bash
pnpm install --frozen-lockfile
pnpm sbom:generate
docker compose -f deploy/docker-compose.yml config
docker compose -f deploy/docker-compose.yml build app
docker compose -f deploy/docker-compose.yml up -d
```

The final two commands are executed by the user or CI when they own image
construction.

## Health

```bash
curl -fsS http://127.0.0.1:3010/healthz
curl -fsS http://127.0.0.1:3010/readyz
docker compose -f deploy/docker-compose.yml ps
```

- `/healthz`: process liveness, 200 with `HealthStatus`.
- `/readyz`: Mongo, Redis, PostgreSQL/pgvector, MinIO and mock IAM probes.
- Worker health: `/tmp/knowledge-worker-ready` exists only after infrastructure
  initialization and listener startup.
- A dependency failure returns 503 Problem and removes the app from readiness.

## Startup Order

1. Mongo, Redis, pgvector and MinIO become healthy.
2. `mongo-init` reaches PRIMARY.
3. App and worker start from the same image.
4. `/healthz`, `/readyz` and worker health become green.

## Shutdown And Rollback

- Stop app/worker before infrastructure.
- Preserve named volumes for rollback.
- Restore durable store snapshots using `docs/runbooks/backup-restore.md`.
- `docker compose down -v` is destructive and requires explicit confirmation.

## External Providers

AIProxy, OCR, Feishu, Yuque and DingTalk stay in mock mode by default and remain
`EXTERNAL_UNVERIFIED` until real credentials, timeout/failure evidence and
provider-specific integration tests exist.

## S1 Evidence

- Compose services, image digests and AIProxy `UNKNOWN/BLOCKED`:
  `docs/acceptance/s1-deployment-evidence.md`.
- S1 command, test and Task evidence:
  `docs/acceptance/s1-stage-evidence.md`.
- `OTEL_EXPORTER_OTLP_ENDPOINT` is optional. An empty value selects explicit
  no-op telemetry and must not affect readiness.
