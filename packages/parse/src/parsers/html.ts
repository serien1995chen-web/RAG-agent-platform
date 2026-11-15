/**
 * @kb/parse HTML 解析器：cheerio 正文提取 + turndown + GFM 表格转 Markdown（设计 9.8.1）。
 * 移除 script/style/nav/注释；提取失败回退全文文本；图片保留 alt 与绝对 URL，不下载远程图片。
 * turndown 与 joplin-turndown-plugin-gfm 无自带类型，采用带类型断言的动态 import。
 */
import { createRequire } from 'node:module';
import { createKnowledgeError } from '@kb/contracts';
import * as cheerio from 'cheerio';
import { decodeText, makeResult, normalizeRawText, type ParseHandler } from '../format-registry';

const load = createRequire(import.meta.url);

const NOISE_SELECTORS = ['script', 'style', 'noscript', 'nav', 'template', 'svg'];
const URL_NOISE_SELECTORS = ['i', 'script', 'style'];

interface TurndownServiceLike {
  use(plugin: (service: TurndownServiceLike) => void): TurndownServiceLike;
  turndown(input: string): string;
}

interface TurndownCtor {
  new (options?: { headingStyle?: string; codeBlockStyle?: string }): TurndownServiceLike;
}

interface TurndownModule {
  default?: TurndownCtor;
}

interface GfmModule {
  gfm?: (service: TurndownServiceLike) => void;
}

/** 将 HTML 片段转 Markdown；失败返回空串由调用方回退。 */
export async function convertHtmlToMarkdown(html: string): Promise<string> {
  try {
    const turndownMod = load('turndown') as unknown as TurndownModule & TurndownCtor;
    const gfmMod = load('joplin-turndown-plugin-gfm') as unknown as GfmModule;
    const TurndownService = turndownMod.default ?? turndownMod;
    const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    if (gfmMod.gfm) service.use(gfmMod.gfm);
    return service.turndown(html).trim();
  } catch {
    return '';
  }
}

export interface HtmlDocumentExtraction {
  title: string;
  markdown: string;
  imageRefs: string[];
  usedSelector: string;
}

function unsupported(context: { requestId: string; traceId: string }, reason: string): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { reason, field: 'selector', source: 'url_html' },
  });
}

/**
 * URL-import extraction shared by preview and Worker parsing.
 * The URL path follows the FastGPT-visible cleanup rules: use the selected
 * node or body, remove i/script/style and empty anchors, then resolve relative
 * href/media against the final validated page URL.
 */
export async function extractHtmlDocument(input: {
  html: string;
  selector?: string;
  baseUrl?: string;
  requestId: string;
  traceId: string;
}): Promise<HtmlDocumentExtraction> {
  for (const tag of ['html', 'body', 'main']) {
    const open = input.html.match(new RegExp(`<${tag}(?:\\s|>)`, 'gi'))?.length ?? 0;
    const close = input.html.match(new RegExp(`</${tag}\\s*>`, 'gi'))?.length ?? 0;
    if (open > close) return unsupported(input, 'html_invalid');
  }
  const $ = cheerio.load(input.html);
  const usedSelector = input.selector?.trim() || 'body';
  let selected: ReturnType<typeof $>;
  try {
    selected = $(usedSelector);
  } catch {
    return unsupported(input, 'selector_invalid');
  }
  if (selected.length === 0) return unsupported(input, 'selector_no_match');

  for (const selector of URL_NOISE_SELECTORS) selected.find(selector).remove();
  $('*')
    .contents()
    .filter((_index, node) => node.type === 'comment')
    .remove();
  selected
    .find('a')
    .filter((_index, element) => {
      return $(element).text().trim() === '' && $(element).children().length === 0;
    })
    .remove();

  const baseUrl = input.baseUrl ? new URL(input.baseUrl) : null;
  const toAbsoluteUrl = (value: string) => {
    if (!baseUrl) return value;
    if (value.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(value)) return value;
    if (value.startsWith('//')) return `${baseUrl.protocol}${value}`;
    if (value.startsWith('/')) return `${baseUrl.origin}${value}`;
    try {
      return new URL(value, baseUrl).href;
    } catch {
      return value;
    }
  };
  selected.find('a').each((_index, element) => {
    const href = $(element).attr('href');
    if (href) $(element).attr('href', toAbsoluteUrl(href));
  });
  selected.find('img, video, source, audio, iframe').each((_index, element) => {
    const src = $(element).attr('src');
    if (src) $(element).attr('src', toAbsoluteUrl(src));
  });

  const html = selected
    .map((_index, element) => $(element).html())
    .get()
    .join('\n');
  const selectedText = normalizeRawText(selected.text()).trim();
  if (!selectedText) return unsupported(input, 'content_empty');
  let markdown = await convertHtmlToMarkdown(html);
  if (!markdown) markdown = selectedText;
  if (!markdown.trim()) return unsupported(input, 'content_empty');

  const title = (
    $('head title').first().text().trim() ||
    $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    input.baseUrl ||
    'Imported page'
  ).slice(0, 240);
  const imageRefs = selected
    .find('img')
    .map((_index, element) => $(element).attr('src'))
    .get()
    .filter((src): src is string => typeof src === 'string' && src.length > 0);
  return { title, markdown: markdown.trim(), imageRefs, usedSelector };
}

/** 提取 img src（用于图片引用记录，不下载远程图片）。 */
export function extractImageSources(html: string): string[] {
  const $ = cheerio.load(html);
  return $('img')
    .map((_index, element) => $(element).attr('src'))
    .get()
    .filter((src): src is string => typeof src === 'string' && src.length > 0);
}

export const parseHtml: ParseHandler = async (context) => {
  const html = decodeText(context.bytes);
  if (context.selector !== undefined || context.baseUrl !== undefined) {
    const extraction = await extractHtmlDocument({
      html,
      selector: context.selector,
      baseUrl: context.baseUrl,
      requestId: context.request.requestId ?? context.request.sourceId,
      traceId: context.request.traceId ?? context.request.sourceId,
    });
    return makeResult('html', extraction.markdown, {
      imageRefs: extraction.imageRefs,
    });
  }
  const $ = cheerio.load(html);
  for (const selector of NOISE_SELECTORS) $(selector).remove();
  $('*')
    .contents()
    .filter((_index, node) => node.type === 'comment')
    .remove();

  const title = $('title').first().text().trim();
  const bodyElement = $('body').first();
  const htmlFragment =
    bodyElement.length > 0 ? (bodyElement.html() ?? '') : ($.root().html() ?? '');
  const bodyText = bodyElement.length > 0 ? bodyElement.text() : $.root().text();

  let markdown = await convertHtmlToMarkdown(htmlFragment);
  if (markdown.length === 0) markdown = normalizeRawText(bodyText).trim();
  if (title.length > 0 && !markdown.startsWith('#')) {
    markdown = `# ${title}\n\n${markdown}`.trim();
  }
  return makeResult('html', markdown, {
    imageRefs: $('img')
      .map((_index, element) => $(element).attr('src'))
      .get()
      .filter((src): src is string => typeof src === 'string' && src.length > 0),
  });
};
