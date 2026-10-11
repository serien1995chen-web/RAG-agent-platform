/**
 * @kb/parse HTML 解析器：cheerio 正文提取 + turndown + GFM 表格转 Markdown（设计 9.8.1）。
 * 移除 script/style/nav/注释；提取失败回退全文文本；图片保留 alt 与绝对 URL，不下载远程图片。
 * turndown 与 joplin-turndown-plugin-gfm 无自带类型，采用带类型断言的动态 import。
 */
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import { decodeText, makeResult, normalizeRawText, type ParseHandler } from '../format-registry';

const load = createRequire(import.meta.url);

const NOISE_SELECTORS = ['script', 'style', 'noscript', 'nav', 'template', 'svg'];

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
