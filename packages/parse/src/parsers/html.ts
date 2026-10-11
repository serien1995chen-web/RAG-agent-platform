/**
 * @kb/parse HTML 解析器：cheerio 正文提取 + turndown + GFM 表格转 Markdown（设计 9.8.1）。
 * 移除 script/style/nav/注释；提取失败回退全文文本；图片保留 alt 与绝对 URL，不下载远程图片。
 */
import * as cheerio from "cheerio";
import { gfm } from "joplin-turndown-plugin-gfm";
import TurndownService from "turndown";
import type { ParseHandler } from "../format-registry";
import { decodeText, makeResult, normalizeRawText } from "./core";

const NOISE_SELECTORS = ["script", "style", "noscript", "nav", "template", "svg"];

function createTurndown(): TurndownService {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  service.use(gfm);
  return service;
}

/** 将 HTML 片段转 Markdown；失败返回空串由调用方回退。 */
export function convertHtmlToMarkdown(html: string): string {
  try {
    return createTurndown().turndown(html).trim();
  } catch {
    return "";
  }
}

/** 提取 img src（用于图片引用记录，不下载远程图片）。 */
export function extractImageSources(html: string): string[] {
  const $ = cheerio.load(html);
  return $("img")
    .map((_index, element) => $(element).attr("src"))
    .get()
    .filter((src): src is string => typeof src === "string" && src.length > 0);
}

export const parseHtml: ParseHandler = async (context) => {
  const html = decodeText(context.bytes);
  const $ = cheerio.load(html);
  for (const selector of NOISE_SELECTORS) $(selector).remove();
  $("*")
    .contents()
    .filter((_index, node) => node.type === "comment")
    .remove();

  const title = $("title").first().text().trim();
  const bodyElement = $("body").first();
  const htmlFragment =
    bodyElement.length > 0 ? (bodyElement.html() ?? "") : ($.root().html() ?? "");
  const bodyText = bodyElement.length > 0 ? bodyElement.text() : $.root().text();

  let markdown = convertHtmlToMarkdown(htmlFragment);
  if (markdown.length === 0) markdown = normalizeRawText(bodyText).trim();
  if (title.length > 0 && !markdown.startsWith("#")) {
    markdown = `# ${title}\n\n${markdown}`.trim();
  }
  return makeResult("html", markdown, {
    imageRefs: $("img")
      .map((_index, element) => $(element).attr("src"))
      .get()
      .filter((src): src is string => typeof src === "string" && src.length > 0),
  });
};
