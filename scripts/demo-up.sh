#!/usr/bin/env bash
# demo-up.sh - 一键启动知识库验收 demo（独立 compose project + 本地 dev server）
#
# 用法：bash scripts/demo-up.sh [--port 3200] [--no-worker]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=kb-demo
PORT=3200
START_WORKER=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-worker) START_WORKER=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 22.23.2 >/dev/null 2>&1 || true
fi
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

echo "== 1/6 检查端口 =="
# 自己的 kb-demo 容器已经占用这些端口时视为正常（重复执行 demo-up 属于幂等场景）。
OWN_PORTS=$(docker ps --filter "name=${PROJECT}" --format '{{.Ports}}' 2>/dev/null || true)
for p in 27019 6381 5434 9004 9005 "$PORT"; do
  if ss -ltn 2>/dev/null | grep -q ":$p "; then
    if printf '%s\n' "$OWN_PORTS" | grep -q ":$p->"; then
      continue
    fi
    echo "端口 $p 已被占用；demo 需要独立端口，请先释放或换 --port" >&2
    exit 3
  fi
done

echo "== 2/6 启动依赖（project=$PROJECT）=="
docker compose -f "$REPO/deploy/demo/compose.demo.yml" -p "$PROJECT" up -d mongo redis pgvector minio

echo "== 3/6 初始化 Mongo 副本集 =="
docker compose -f "$REPO/deploy/demo/compose.demo.yml" -p "$PROJECT" up -d mongo-init
for _ in $(seq 1 90); do
  # 用 -a：mongo-init 是一次性容器，成功后即退出；ps -q 只看运行中会永远等不到。
  cid=$(docker compose -f "$REPO/deploy/demo/compose.demo.yml" -p "$PROJECT" ps -aq mongo-init || true)
  if [ -n "$cid" ]; then
    state=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$cid" 2>/dev/null || true)
    case "$state" in
      "exited 0") echo "replica set ready"; break ;;
      "exited "*) echo "mongo-init failed: $state" >&2; exit 4 ;;
    esac
  fi
  sleep 2
done

echo "== 4/6 导出 demo 环境 =="
COMMIT=$(git -C "$REPO" rev-parse HEAD)
BRANCH=$(git -C "$REPO" branch --show-current)
export NODE_ENV=development
export APP_WORKER_MODE=all
export KB_INSTANCE_ID=kb-demo-1
export KB_DEPENDENCY_BASELINE_ID=kb-baseline-6.1
export KB_VERSION_CHECK_POLICY=strict
export KB_ALLOW_RUNTIME_OVERRIDE=false
export KB_MONGO_URI='mongodb://127.0.0.1:27019/rag_demo?directConnection=true'
export KB_REDIS_URL='redis://127.0.0.1:6381'
export KB_PG_URL='postgresql://kb:kb_demo_password@127.0.0.1:5434/kb'
export KB_S3_ENDPOINT='http://127.0.0.1:9004'
export KB_S3_REGION=us-east-1
export KB_S3_BUCKET=kb-demo
export KB_S3_ACCESS_KEY_REF='env:MINIO_ROOT_USER'
export KB_S3_SECRET_KEY_REF='env:MINIO_ROOT_PASSWORD'
export MINIO_ROOT_USER=kb_demo_minio
export MINIO_ROOT_PASSWORD=kb_demo_minio_password
export KB_DEV_TEAM_ID=0000000000000000000000d1
export KB_DEV_TMB_ID=0000000000000000000000d2
export KB_CONNECT_TIMEOUT_MS=5000
export KB_REQUEST_TIMEOUT_MS=2000
export KB_MONGO_POOL_SIZE=10
export KB_REDIS_CONNECTIONS=2
export KB_PG_POOL_SIZE=10
export KB_S3_CONCURRENCY=4
export KB_PROVIDER_CONCURRENCY=4
export KB_BATCH_SIZE=100
export KB_QUEUE_CONCURRENCY=4
export KB_PROVIDER_TIMEOUT_MS=30000
export KB_PROVIDER_MAX_RETRIES=3
export KB_LOG_LEVEL=info
export KB_EXTERNAL_MOCK_MODE='{"auth":"mock","model":"mock","capacity":"mock","pdfProvider":"mock","backup":"mock"}'
export NEXT_PUBLIC_DEMO_BASELINE_COMMIT="$COMMIT"
export NEXT_PUBLIC_DEMO_BASELINE_BRANCH="$BRANCH"
export NEXT_PUBLIC_DEMO_WORKER_MODE=all
export NEXT_PUBLIC_DEMO_IDENTITY="0000000000000000000000d1/0000000000000000000000d2"

echo "== 5/6 启动 @kb/app（端口 $PORT）=="
cd "$REPO/projects/app"
pnpm exec next dev -p "$PORT" >"$REPO/.demo-app.log" 2>&1 &
APP_PID=$!
echo "app pid=$APP_PID, log=$REPO/.demo-app.log"

echo "== 6/6 等待探针 =="
for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/api/readyz" >/dev/null 2>&1; then
    echo "readyz OK"
    break
  fi
  sleep 2
done

if ! curl -sf "http://127.0.0.1:$PORT/api/startupz" >/dev/null 2>&1; then
  echo "startupz 未通过，查看 $REPO/.demo-app.log" >&2
fi

if [ "$START_WORKER" = "1" ]; then
  echo "启动 worker（训练任务消费者）"
  ( cd "$REPO" && pnpm exec tsx projects/app/src/runtime/worker.ts >"$REPO/.demo-worker.log" 2>&1 & echo $! >/tmp/kb-demo-worker.pid )
fi

cat <<EOF

知识库验收 demo 已启动：
  http://localhost:$PORT/demo/kb

基线：$BRANCH @ ${COMMIT:0:7}
依赖：mongo 27019（副本集）/ redis 6381 / pgvector 5434 / minio 9004
日志：.demo-app.log，.demo-worker.log
停止：bash scripts/demo-down.sh
EOF
