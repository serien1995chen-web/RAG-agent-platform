# syntax=docker/dockerfile:1
# 单镜像多角色：APP_WORKER_MODE=all/http/worker；首期不提供独立 Worker 容器入口。
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY projects ./projects
COPY sdk ./sdk
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@kb/app", "start"]
