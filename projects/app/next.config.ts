import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // workspace 包以 TS 源码导出，由 Next 统一编译。
  transpilePackages: [
    '@kb/contracts',
    '@kb/dal',
    '@kb/service',
    '@kb/storage',
    '@kb/otel',
    '@kb/web',
  ],
  // 探针对外路径固定为设计文档 12.9 的 /healthz/live、/readyz、/startupz。
  async rewrites() {
    return [
      { source: '/healthz/live', destination: '/api/healthz/live' },
      { source: '/readyz', destination: '/api/readyz' },
      { source: '/startupz', destination: '/api/startupz' },
      // ISSUE-004：扩展 API 在设计文档与 ROUTE_REGISTRY 中写作 /proApi/**，
      // 但 Next.js 只挂载 pages/api/**。补一层 rewrite 让文档路径可达。
      { source: '/proApi/:path*', destination: '/api/proApi/:path*' },
    ];
  },
};

export default nextConfig;
