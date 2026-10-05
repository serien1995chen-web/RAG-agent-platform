import { describe, expect, it } from 'vitest';
import {
  PERMISSION_ALL,
  PERMISSION_READ,
  canRemoveOwner,
  evaluatePermission,
  mergePermissions,
} from '../../packages/acl/src/index';
import { countCodePoints, DEFAULT_CHUNK_POLICY } from '../../packages/chunk/src/index';
import { resolveParseFormat } from '../../packages/parse/src/index';
import { buildQaDedupKey } from '../../packages/qa/src/index';
import { RRF_K, rrfFuse } from '../../packages/search/src/index';

describe('算法包骨架（CR-FEATURE-04 至 08）', () => {
  it('RRF 融合按 1/(k+rank) 累加，k 默认 60', () => {
    const fused = rrfFuse([
      [
        { id: 'a', rank: 1 },
        { id: 'b', rank: 2 },
      ],
      [{ id: 'b', rank: 1 }],
    ]);
    expect(fused.a).toBeCloseTo(1 / (RRF_K + 1));
    expect(fused.b).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  });

  it('ACL：显式 deny 优先于继承，Owner/Root 覆盖为全权限，最后 Owner 受保护', () => {
    expect(
      evaluatePermission({
        inheritedMask: PERMISSION_READ,
        explicitMask: 0,
        isOwner: false,
        isRoot: false,
      }),
    ).toBe(0);
    expect(
      evaluatePermission({
        inheritedMask: 0,
        explicitMask: null,
        isOwner: true,
        isRoot: false,
      }),
    ).toBe(PERMISSION_ALL);
    expect(
      evaluatePermission({
        inheritedMask: 0,
        explicitMask: null,
        isOwner: false,
        isRoot: true,
      }),
    ).toBe(PERMISSION_ALL);
    expect(canRemoveOwner(1)).toBe(false);
    expect(canRemoveOwner(2)).toBe(true);
    expect(mergePermissions(PERMISSION_READ, 2)).toBe(3);
  });

  it('解析格式矩阵覆盖 9 类，未登记扩展返回 null', () => {
    expect(resolveParseFormat('md')?.format).toBe('markdown');
    expect(resolveParseFormat('.CSV')?.format).toBe('csv');
    expect(resolveParseFormat('exe')).toBeNull();
  });

  it('QA 去重键对 NFKC 与首尾空白稳定', () => {
    expect(buildQaDedupKey(' Ａ ', 'b')).toBe(buildQaDedupKey('A', ' b '));
    expect(buildQaDedupKey('a', 'b')).not.toBe(buildQaDedupKey('a', 'c'));
  });

  it('Chunk 默认策略与 Unicode code point 计数', () => {
    expect(DEFAULT_CHUNK_POLICY.chunkSize).toBe(1000);
    expect(DEFAULT_CHUNK_POLICY.maxChunks).toBe(50000);
    expect(countCodePoints('a😀')).toBe(2);
  });
});
