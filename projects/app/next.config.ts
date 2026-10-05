import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // workspace 包以 TS 源码导出，由 Next 统一编译。
  transpilePackages: ['@kb/contracts', '@kb/service', '@kb/storage', '@kb/otel', '@kb/web'],
  // 探针对外路径固定为设计文档 12.9 的 /healthz/live、/readyz、/startupz。
  async rewrites() {
    return [
      { source: '/healthz/live', destination: '/api/healthz/live' },
      { source: '/readyz', destination: '/api/readyz' },
      { source: '/startupz', destination: '/api/startupz' },
    ];
  },
};

export default nextConfig;
