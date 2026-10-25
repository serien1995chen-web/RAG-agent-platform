# S2 Deployment Evidence

## Compose

The S2 infrastructure was started with the Plan-approved command:

```bash
docker compose -f deploy/docker-compose.yml up -d --wait --pull never mongo redis pgvector minio
```

`mongo-init` was started once to establish replica set `rs0`. No image pull was executed.

Healthy services:

- MinIO
- MongoDB
- Redis
- PostgreSQL/pgvector

## Image Digests

| Image    | Tag                            | Digest                                                                    |
| -------- | ------------------------------ | ------------------------------------------------------------------------- |
| AIProxy  | `v0.7.3`                       | `sha256:da8d8394634eacdcf72533953c77c1e0ca3e28920545354dd20bdaa0aaa9ee4b` |
| MongoDB  | `5.0.32`                       | `sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e` |
| Redis    | `7.2-alpine`                   | `sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c` |
| pgvector | `0.8.0-pg15`                   | `sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c` |
| MinIO    | `RELEASE.2025-09-07T16-13-09Z` | `sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d` |

## Configuration

- `KB_S3_VENDOR` defaults to `minio`.
- `KB_FILE_PUBLIC_BASE_URL` defaults to `http://localhost:3010`.
- `KB_FILE_TICKET_SECRET_REF` references an environment secret and never stores a resolved secret in a response or log.
- The private bucket remains `knowledge-private`; the development Compose bucket is `kb-local`.

## External Providers

AWS S3, Cloudflare R2, Tencent COS and Alibaba OSS were not exercised with real credentials. Their status is `EXTERNAL_UNVERIFIED`.
