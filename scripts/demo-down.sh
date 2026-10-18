#!/usr/bin/env bash
# demo-down.sh - 停止 demo 自己的 app / worker / 依赖栈。
# 只操作 kb-demo project，不触碰用户或审计环境。
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=kb-demo

echo "== 停止 worker =="
if [ -f /tmp/kb-demo-worker.pid ]; then
  kill "$(cat /tmp/kb-demo-worker.pid)" 2>/dev/null || true
  rm -f /tmp/kb-demo-worker.pid
fi
pkill -f 'projects/app/src/runtime/worker.ts' 2>/dev/null || true

echo "== 停止 app =="
pkill -f 'next dev -p 3200' 2>/dev/null || true

echo "== 停止依赖（$PROJECT）=="
docker compose -f "$REPO/deploy/demo/compose.demo.yml" -p "$PROJECT" down "$@"

echo "完成。用户容器未受影响。"
