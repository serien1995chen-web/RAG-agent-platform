/**
 * 自动生成，请勿手改。
 * 生成命令：node scripts/generate-demo-routes.mjs
 * 数据源：packages/contracts/src/openapi/route-registry.data.json
 * 路由数：87
 */
import type { RouteEntry } from '../types';

export const DEMO_ROUTES: readonly RouteEntry[] = [
  {
    "routeId": "API-DS-001",
    "method": "GET",
    "path": "/api/core/dataset/list",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-DS-002",
    "method": "POST",
    "path": "/api/core/dataset/create",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Team Dataset Create"
  },
  {
    "routeId": "API-DS-003",
    "method": "GET",
    "path": "/api/core/dataset/detail",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-DS-004",
    "method": "POST",
    "path": "/api/core/dataset/update",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write 或 Manage"
  },
  {
    "routeId": "API-DS-005",
    "method": "POST",
    "path": "/api/core/dataset/delete",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Owner"
  },
  {
    "routeId": "API-DS-006",
    "method": "POST",
    "path": "/api/core/dataset/rebuildEmbedding",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Owner"
  },
  {
    "routeId": "API-COL-001",
    "method": "GET",
    "path": "/api/core/dataset/collection/list",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-COL-002",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/folder",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-003",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/file",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-004",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/link",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-005",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/text",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-006",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/externalFile",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-007",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/apiFile",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-008",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/images",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-009",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/backup",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-010",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/template",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-011",
    "method": "GET",
    "path": "/api/core/dataset/collection/detail",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-COL-012",
    "method": "POST",
    "path": "/api/core/dataset/collection/update",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-013",
    "method": "POST",
    "path": "/api/core/dataset/collection/delete",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write/Owner"
  },
  {
    "routeId": "API-COL-014",
    "method": "POST",
    "path": "/api/core/dataset/collection/retrain",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-015",
    "method": "POST",
    "path": "/api/core/dataset/collection/sync",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-COL-016",
    "method": "GET",
    "path": "/api/core/dataset/collection/trainingStatus",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-DATA-001",
    "method": "GET",
    "path": "/api/core/dataset/data/list",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-DATA-002",
    "method": "GET",
    "path": "/api/core/dataset/data/detail",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-DATA-003",
    "method": "POST",
    "path": "/api/core/dataset/data/update",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-DATA-004",
    "method": "POST",
    "path": "/api/core/dataset/data/delete",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-DATA-005",
    "method": "POST",
    "path": "/api/core/dataset/data/insertData",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-DATA-006",
    "method": "POST",
    "path": "/api/core/dataset/data/insertImages",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-DATA-007",
    "method": "POST",
    "path": "/api/core/dataset/data/pushData",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-IDX-001",
    "method": "POST",
    "path": "/api/core/dataset/index/create",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-IDX-002",
    "method": "POST",
    "path": "/api/core/dataset/index/update",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-IDX-003",
    "method": "POST",
    "path": "/api/core/dataset/index/delete",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-TASK-001",
    "method": "GET",
    "path": "/api/core/dataset/training/detail",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-TASK-002",
    "method": "GET",
    "path": "/api/core/dataset/training/errors",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-TASK-003",
    "method": "POST",
    "path": "/api/core/dataset/training/resume",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-DEL-001",
    "method": "GET",
    "path": "/api/core/dataset/delete-jobs/{jobId}",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Dataset Owner 或 Root"
  },
  {
    "routeId": "API-DEL-002",
    "method": "GET",
    "path": "/api/core/dataset/delete-jobs/{jobId}/failures",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Owner 或 Root"
  },
  {
    "routeId": "API-DEL-003",
    "method": "POST",
    "path": "/api/core/dataset/delete-jobs/{jobId}/retry",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Owner 或 Root"
  },
  {
    "routeId": "API-SEARCH-001",
    "method": "POST",
    "path": "/api/core/dataset/searchTest",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-FILE-001",
    "method": "POST",
    "path": "/api/core/dataset/file/presignUpload",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-FILE-002",
    "method": "POST",
    "path": "/api/core/dataset/file/completeMultipart",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-FILE-003",
    "method": "POST",
    "path": "/api/core/dataset/file/abortMultipart",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-FILE-004",
    "method": "POST",
    "path": "/api/core/dataset/file/previewChunks",
    "group": "core",
    "implemented": true,
    "source": "dev/Token/Write"
  },
  {
    "routeId": "API-ROOT-001",
    "method": "POST",
    "path": "/api/admin/dataset/migrations/dry-run",
    "group": "admin",
    "implemented": true,
    "source": "root/Root/Admin"
  },
  {
    "routeId": "API-ROOT-002",
    "method": "POST",
    "path": "/api/admin/dataset/migrations/apply",
    "group": "admin",
    "implemented": true,
    "source": "root/Root/Admin"
  },
  {
    "routeId": "API-ROOT-003",
    "method": "POST",
    "path": "/api/admin/dataset/migrations/resume",
    "group": "admin",
    "implemented": true,
    "source": "root/Root/Admin"
  },
  {
    "routeId": "API-ROOT-004",
    "method": "GET",
    "path": "/api/admin/dataset/reconcile/reports",
    "group": "admin",
    "implemented": true,
    "source": "root / 授权租户管理员"
  },
  {
    "routeId": "API-FILE-005",
    "method": "POST",
    "path": "/api/core/dataset/file/presignSearchTestImage",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-FILE-006",
    "method": "POST",
    "path": "/api/core/dataset/file/getSearchTestImagePreviewUrls",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-HEALTH-001",
    "method": "GET",
    "path": "/healthz/live",
    "group": "health",
    "implemented": true,
    "source": "internal/无认证或内网"
  },
  {
    "routeId": "API-HEALTH-002",
    "method": "GET",
    "path": "/readyz",
    "group": "health",
    "implemented": true,
    "source": "internal/无认证或内网"
  },
  {
    "routeId": "API-HEALTH-003",
    "method": "GET",
    "path": "/startupz",
    "group": "health",
    "implemented": true,
    "source": "internal/无认证或内网"
  },
  {
    "routeId": "API-EXT-001",
    "method": "GET/POST",
    "path": "/proApi/core/dataset/**",
    "group": "extension",
    "implemented": true,
    "source": "extension/调用者上下文"
  },
  {
    "routeId": "API-TAG-001",
    "method": "GET",
    "path": "/api/core/dataset/tag/list",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-TAG-002",
    "method": "POST",
    "path": "/api/core/dataset/tag/create",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-TAG-003",
    "method": "POST",
    "path": "/api/core/dataset/tag/update",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Manage"
  },
  {
    "routeId": "API-TAG-004",
    "method": "POST",
    "path": "/api/core/dataset/tag/delete",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Manage"
  },
  {
    "routeId": "API-TAG-005",
    "method": "POST",
    "path": "/api/core/dataset/tag/addToCollections",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-TAG-006",
    "method": "POST",
    "path": "/api/core/dataset/tag/removeFromCollections",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-PATH-001",
    "method": "GET",
    "path": "/api/core/dataset/paths",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-PATH-002",
    "method": "GET",
    "path": "/api/core/dataset/collection/paths",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-PATH-003",
    "method": "POST",
    "path": "/api/core/dataset/move",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-PATH-004",
    "method": "POST",
    "path": "/api/core/dataset/collection/move",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-ACL-001",
    "method": "GET",
    "path": "/api/core/dataset/getPermission",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-ACL-002",
    "method": "POST",
    "path": "/api/core/dataset/resumeInheritPermission",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Manage"
  },
  {
    "routeId": "API-ACL-003",
    "method": "GET",
    "path": "/proApi/core/dataset/collaborator/list",
    "group": "extension",
    "implemented": true,
    "source": "extension/调用者上下文/Manage"
  },
  {
    "routeId": "API-ACL-004",
    "method": "POST",
    "path": "/proApi/core/dataset/collaborator/update",
    "group": "extension",
    "implemented": true,
    "source": "extension/调用者上下文/Manage"
  },
  {
    "routeId": "API-ACL-005",
    "method": "POST",
    "path": "/proApi/core/dataset/changeOwner",
    "group": "extension",
    "implemented": true,
    "source": "extension/调用者上下文/Owner"
  },
  {
    "routeId": "API-EXP-001",
    "method": "GET",
    "path": "/api/core/dataset/exportAll",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-EXP-002",
    "method": "GET",
    "path": "/api/core/dataset/collection/export",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-IMP-001",
    "method": "POST",
    "path": "/api/core/dataset/collection/import",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-APIDS-001",
    "method": "POST",
    "path": "/api/core/dataset/apiDataset/getCatalog",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-APIDS-002",
    "method": "POST",
    "path": "/api/core/dataset/apiDataset/getPathNames",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-APIDS-003",
    "method": "POST",
    "path": "/api/core/dataset/apiDataset/list",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-APIDS-004",
    "method": "GET",
    "path": "/api/core/dataset/apiDataset/listExistId",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-TASK-004",
    "method": "PUT",
    "path": "/api/core/dataset/training/updateTrainingData",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-TASK-005",
    "method": "POST",
    "path": "/api/core/dataset/training/deleteTrainingData",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Manage"
  },
  {
    "routeId": "API-TASK-006",
    "method": "GET",
    "path": "/api/core/dataset/training/queue",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-TASK-007",
    "method": "POST",
    "path": "/api/core/dataset/training/errors",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-TASK-008",
    "method": "POST",
    "path": "/api/core/dataset/training/collectionErrors",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-TASK-009",
    "method": "GET",
    "path": "/api/core/dataset/training/hasError",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-AGG-001",
    "method": "POST",
    "path": "/api/core/dataset/createWithFiles",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Team Dataset Create"
  },
  {
    "routeId": "API-VIRT-001",
    "method": "GET",
    "path": "/api/core/dataset/collection/virtual",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Read"
  },
  {
    "routeId": "API-SEARCH-002",
    "method": "POST",
    "path": "/api/internal/dataset/search",
    "group": "internal",
    "implemented": true,
    "source": "internal/服务身份（teamId 由主体解析）"
  },
  {
    "routeId": "API-COL-017",
    "method": "POST",
    "path": "/api/core/dataset/collection/create/empty",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-FILE-007",
    "method": "POST",
    "path": "/api/core/dataset/file/uploadPart",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  },
  {
    "routeId": "API-IMP-002",
    "method": "POST",
    "path": "/api/core/dataset/import",
    "group": "core",
    "implemented": true,
    "source": "public/Token/Write"
  }
] as const;
