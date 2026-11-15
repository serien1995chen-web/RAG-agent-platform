import { KnowledgeUrlImportAdapter } from '../packages/service/src/modules/knowledge/adapter/url-import';
import { extractHtmlDocument } from '../packages/parse/src/parsers/html';
import type { TenantContext } from '../packages/service/src/shared/persistence/knowledge/tenant';

const base = process.argv[2]?.replace(/\/+$/, '');
if (!base) throw new Error('usage: tsx scripts/probe-b10-public-cases.ts <fixture-base-url>');

const context: TenantContext = {
  workspaceId: 'ws_b10_public',
  memberId: 'mem_b10_public',
  requestId: 'req_b10_public',
  traceId: 'trace_b10_public',
  scopes: ['knowledge:write'],
};
const adapter = new KnowledgeUrlImportAdapter({ extractHtml: extractHtmlDocument });
await fetch(`${base}/b10/reset`).then((response) => {
  if (!response.ok) throw new Error(`fixture reset failed: ${response.status}`);
});

async function outcome(path: string, selector = 'body') {
  try {
    const snapshot = await adapter.fetch({ url: `${base}${path}`, selector, context });
    return {
      result: 'PASS',
      title: snapshot.title,
      selector: snapshot.selector,
      contentHash: snapshot.contentHash,
      containsSelected:
        snapshot.markdown?.replace(/\\/g, '').includes('SELECTED_FIXTURE_TEXT') ?? false,
      containsOutside:
        snapshot.markdown?.includes('OUTSIDE_TEXT') ||
        snapshot.markdown?.includes('NAVIGATION_NOISE') ||
        false,
    };
  } catch (error) {
    const code = (error as { problem?: { error?: { code?: string } } }).problem?.error?.code;
    return { result: code ?? 'ERROR' };
  }
}

const cases: Record<string, unknown> = {};
for (const [name, path] of [
  ['normal', '/b10/normal.html'],
  ['selector', '/b10/selector.html'],
  ['noise', '/b10/noise.html'],
  ['chinese', '/b10/zh.html'],
  ['redirectOne', '/b10/redirect/one'],
  ['redirectPrivate', '/b10/redirect/private'],
  ['redirectLoop', '/b10/redirect/loop'],
  ['empty', '/b10/empty.html'],
  ['noSelectorMatch', '/b10/no-selector-match.html'],
  ['brokenHtml', '/b10/broken.html'],
  ['unsupportedMime', '/b10/unsupported.bin'],
  ['recursive', '/b10/recursive.html'],
  ['large', '/b10/large'],
  ['slow', '/b10/slow'],
] as const) {
  cases[name] = await outcome(
    path,
    ['selector', 'noise', 'noSelectorMatch'].includes(name) ? 'main' : 'body',
  );
}
cases.flakyFirst = await outcome('/b10/flaky');
cases.flakyRetry = await outcome('/b10/flaky');

console.log(JSON.stringify(cases, null, 2));
