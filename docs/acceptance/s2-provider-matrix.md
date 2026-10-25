# S2 Provider Matrix

| Provider      | Adapter                                        | Configuration                                            | Verification          |
| ------------- | ---------------------------------------------- | -------------------------------------------------------- | --------------------- |
| MinIO         | `MinioKnowledgeObjectStore`                    | endpoint, port, TLS, access key, secret, region, bucket  | `REAL_VERIFIED`       |
| AWS S3        | `AwsS3KnowledgeObjectStore`                    | endpoint, region, bucket, credential refs                | `EXTERNAL_UNVERIFIED` |
| Cloudflare R2 | `AwsS3KnowledgeObjectStore` with `provider=r2` | account endpoint, region `auto`, bucket, credential refs | `EXTERNAL_UNVERIFIED` |
| Tencent COS   | `CosKnowledgeObjectStore`                      | endpoint, region, bucket, secret refs                    | `EXTERNAL_UNVERIFIED` |
| Alibaba OSS   | `OssKnowledgeObjectStore`                      | endpoint, region, bucket, access key refs                | `EXTERNAL_UNVERIFIED` |

## Unified Contract

All adapters implement `ObjectStorePort`:

- `ensureBucket`
- `putObject`
- `headObject`
- `getObject`
- `presignPut`
- `presignGet`
- `createMultipartUpload`
- `uploadPart`
- `listParts`
- `completeMultipartUpload`
- `abortMultipartUpload`
- `deleteObject`

Provider 404 maps to `KNOWLEDGE_NOT_FOUND`; 403/5xx maps to `KNOWLEDGE_DEPENDENCY_UNAVAILABLE`; timeout maps to `KNOWLEDGE_DEPENDENCY_TIMEOUT`; malformed responses map to `KNOWLEDGE_PROVIDER_CONTRACT_INVALID`.

No API response, error detail or log includes a bucket secret, provider access key, signed URL or raw object key except the canonical `ObjectBlobReference` returned by Upload Complete.
