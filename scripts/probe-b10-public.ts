import { KnowledgeUrlImportAdapter } from '../packages/service/src/modules/knowledge/adapter/url-import';
import { extractHtmlDocument } from '../packages/parse/src/parsers/html';

const url = process.argv[2];
if (!url) throw new Error('usage: tsx scripts/probe-b10-public.ts <public-url>');

const snapshot = await new KnowledgeUrlImportAdapter({
  extractHtml: extractHtmlDocument,
}).fetch({
  url,
  selector: 'body',
  context: {
    workspaceId: 'ws_b10_real',
    memberId: 'mem_b10_real',
    requestId: 'req_b10_real',
    traceId: 'trace_b10_real',
    scopes: ['knowledge:write'],
  },
});

console.log(
  JSON.stringify(
    {
      safeUrl: snapshot.safeUrl,
      title: snapshot.title,
      selector: snapshot.selector,
      contentHash: snapshot.contentHash,
      contentType: snapshot.contentType,
      markdownPrefix: snapshot.markdown?.slice(0, 120),
    },
    null,
    2,
  ),
);
