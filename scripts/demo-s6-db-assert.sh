#!/usr/bin/env bash
# S6 证据：读取 s6-ids.json，对 Mongo image_assets/dataset_datas 与 pgvector 做断言并落盘。
set -euo pipefail
EVIDENCE="${S6_EVIDENCE_DIR:-/mnt/c/Users/Administrator/Documents/Codex/2026-10-16/files-mentioned-by-the-user-p0-2/outputs/kb-demo-s6-fix-20261018}"
IDS="$EVIDENCE/02-green/s6-ids.json"
[ -f "$IDS" ] || { echo "missing $IDS" >&2; exit 1; }
DS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).datasetId)' "$IDS")
CID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).collectionId)' "$IDS")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

docker exec kb-demo-mongo-1 mongosh --quiet rag_demo --eval "
const d = ObjectId('$DS');
const c = ObjectId('$CID');
const ds = db.datasets.findOne({ _id: d });
const asset = db.image_assets.findOne({ datasetId: d });
const data = db.dataset_datas.findOne({ datasetId: d });
const coll = db.dataset_collections.findOne({ _id: c });
print(JSON.stringify({
  datasetIndexVersion: ds && ds.indexVersion,
  imageAsset: asset && { state: asset.state, ttlExpireAt: asset.ttlExpireAt, size: asset.size, mimeType: asset.mimeType },
  data: {
    total: db.dataset_datas.countDocuments({ datasetId: d }),
    imageId: data && data.imageId,
    indexTypes: data && data.indexes ? data.indexes.map((index) => index.type) : [],
  },
  collection: coll && { type: coll.type, trainingMode: coll.trainingMode, autoIndexes: coll.autoIndexes, trainingState: coll.trainingState },
}));
" >"$TMP/mongo.json"

docker exec kb-demo-pgvector-1 psql -U kb -d kb -t -A -F'|' -c \
  "SELECT index_version, vector_dims(vector), count(*) FROM modeldata WHERE dataset_id = '$DS' GROUP BY 1, 2;" \
  >"$TMP/vector.txt"

node - "$DS" "$CID" "$TMP/mongo.json" "$TMP/vector.txt" "$EVIDENCE/02-green/db-assertions.json" <<'NODE'
const fs = require('node:fs');
const [datasetId, collectionId, mongoPath, vectorPath, outPath] = process.argv.slice(2);
const mongo = JSON.parse(fs.readFileSync(mongoPath, 'utf8'));
const line = fs.readFileSync(vectorPath, 'utf8').trim().split('\n')[0] ?? '';
const [indexVersion, dimension, rows] = line.split('|');
const assertions = {
  datasetId,
  collectionId,
  datasetIndexVersion: mongo.datasetIndexVersion,
  imageAsset: {
    state: mongo.imageAsset?.state,
    ttlExpireAt: mongo.imageAsset?.ttlExpireAt ?? null,
    size: mongo.imageAsset?.size,
    mimeType: mongo.imageAsset?.mimeType,
  },
  data: mongo.data,
  collection: mongo.collection,
  vector: {
    indexVersion,
    dimension: Number(dimension),
    rows: Number(rows),
  },
};
fs.writeFileSync(outPath, JSON.stringify(assertions, null, 2));
console.log(JSON.stringify(assertions, null, 2));
NODE
