/**
 * @kb/parse DOCX 解析（设计 9.8.1）：mammoth 转 HTML → Markdown；表格转 Markdown；
 * 内嵌图片经注入 ObjectStorePort 入对象存储；失败 501057。
 */
import { randomUUID } from "node:crypto";
import mammoth from "mammoth";
import type { ParseHandler } from "../format-registry";
import { parseFailedError } from "../format-registry";
import { makeResult, normalizeRawText } from "./core";
import { convertHtmlToMarkdown, extractImageSources } from "./html";

export const parseDocx: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(context.bytes) });
    const html = result.value;
    const imageRefs = extractImageSources(html);
    const storedRefs: string[] = [];
    if (context.objectStore?.putObject) {
      for (const source of imageRefs) {
        if (!source.startsWith("data:")) continue;
        const comma = source.indexOf(",");
        if (comma < 0) continue;
        const meta = source.slice(5, comma);
        const payload = source.slice(comma + 1);
        const isBase64 = /;base64/i.test(meta);
        const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
        const contentType = meta.split(";")[0] ?? "application/octet-stream";
        const key = `docx/${context.request.teamId}/${context.request.datasetId}/${randomUUID()}`;
        const stored = await context.objectStore.putObject({ key, body: new Uint8Array(bytes), contentType });
        storedRefs.push(stored);
      }
    }
    const markdown = normalizeRawText(convertHtmlToMarkdown(html));
    return makeResult("docx", markdown, { imageRefs: storedRefs });
  } catch {
    throw parseFailedError("docx", "docx_convert_failed", requestId);
  }
};
