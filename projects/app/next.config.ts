import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
  // 公开路径与 Next.js pages/api 挂载点之间只保留这一层 rewrite。
  async rewrites() {
    return [
      { source: '/healthz', destination: '/api/healthz' },
      { source: '/readyz', destination: '/api/readyz' },
      { source: '/v1/knowledge/:path*', destination: '/api/v1/knowledge/:path*' },
    ];
  },
};

export default nextConfig;
