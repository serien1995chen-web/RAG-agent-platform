import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadS11FixtureManifest,
  missingRealProviderFields,
  startS11Stack,
} from './s11-full-business-chain.fixture';

const root = resolve(import.meta.dirname, '../..');

describe('TEST-X-S11-FULL-CHAIN', () => {
  it('keeps deterministic fixture identity stable', () => {
    const manifest = loadS11FixtureManifest();
    const manifestBytes = readFileSync(
      join(root, 'test', 'fixtures', 's11', 'fixture-manifest.json'),
    );
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toHaveLength(64);
    expect(manifest.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries.map((entry) => entry.name)).toEqual([
      's11-two-page.pdf',
      's11-malformed.pdf',
      's11-import-20-pages.pdf',
      's11-zip-bomb.zip',
      's11-zip-slip.zip',
      's11-image-1x1.png',
    ]);
  });

  it('reports BLOCKED without real provider and S10 API-key inputs', async () => {
    const { stack } = await startS11Stack({
      ...process.env,
      S11_E2E_MODE: undefined,
      S11_PROVIDER_MODE: undefined,
    });
    expect(stack.status).toBe('BLOCKED');
    if (stack.status !== 'BLOCKED') throw new Error('unreachable');
    expect(stack.blockers[0]).toMatchObject({
      code: 'REAL_PROVIDER_BLOCKED',
      provider: null,
    });
    expect(stack.blockers[0]?.missingFields).toContain('S11_E2E_MODE=real');
  });

  it('names every missing real-provider variable without exposing values', () => {
    const missing = missingRealProviderFields({});
    expect(missing).toContain('S11_PROVIDER_MODE=real');
    expect(missing).toContain('AIPROXY_API_TOKEN');
    expect(missing).toContain('S11_FEISHU_APP_SECRET');
    expect(missing).toContain('S11_YUQUE_TOKEN');
    expect(missing).toContain('S11_DINGTALK_APP_SECRET');
    expect(missing.join(',')).not.toMatch(/kn_live_|Bearer|secret-value/i);
  });
});
