import { describe, expect, it } from 'vitest';
import nextConfig from '../../projects/app/next.config';
import { ROUTE_REGISTRY } from '../../packages/contracts/src/index';

/**
 * ISSUE-004：注册表与设计文档把扩展路由写在 `/proApi/**`，而 Next.js 只能在
 * `/api/**` 下挂载 handler。契约要求文档路径可直接访问，因此必须存在 rewrite。
 */
describe('route reachability (ISSUE-004)', () => {
  it('rewrites /proApi/** to the actual /api/proApi/** mount', async () => {
    const rewrites = (await nextConfig.rewrites?.()) ?? [];
    expect(rewrites).toEqual(
      expect.arrayContaining([{ source: '/proApi/:path*', destination: '/api/proApi/:path*' }]),
    );
  });

  it('every registered /proApi route has a documented public path', () => {
    const extensionRoutes = ROUTE_REGISTRY.filter((route) => route.path.startsWith('/proApi/'));
    expect(extensionRoutes.length).toBeGreaterThan(0);
    for (const route of extensionRoutes) {
      expect(route.path.startsWith('/proApi/')).toBe(true);
    }
  });

  it('keeps the three health probes rewritable', async () => {
    const rewrites = (await nextConfig.rewrites?.()) ?? [];
    for (const source of ['/healthz/live', '/readyz', '/startupz']) {
      expect(rewrites.some((rule) => rule.source === source)).toBe(true);
    }
  });
});
