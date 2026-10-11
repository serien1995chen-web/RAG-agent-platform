/**
 * @kb/parse PDF 文本层解析（设计 9.8.1）：无文本层时 scanRequired=true 走 Provider；
 * 解析异常按 501057 分类；图片以标记记录。
 */
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  makeResult,
  normalizeRawText,
  parseFailedError,
  type ParseHandler,
} from '../format-registry';

// pdfjs 在 Node 下解析文本层无需外部字体；禁用 worker 以避免浏览器环境依赖。
const require = createRequire(import.meta.url);
void require;

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

export const parsePdf: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(context.bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    });
    const document = await task.promise;
    const pages: string[] = [];
    const imageRefs: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items = textContent.items as PdfTextItem[];
      const text = items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+\n/g, '\n')
        .trim();
      const ops = await page.getOperatorList();
      const imageOps = ops.fnArray.filter(
        (fn) => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintImageMaskXObject,
      ).length;
      for (let index = 0; index < imageOps; index += 1)
        imageRefs.push(`pdf:${pageNumber}:image:${index}`);
      pages.push(text);
    }
    await document.destroy();
    const rawText = normalizeRawText(pages.join('\n\n'));
    const hasTextLayer = rawText.replace(/\s/g, '').length > 0;
    if (!hasTextLayer && context.enhanceScannedPdf) {
      return context.enhanceScannedPdf(context.bytes, context.request);
    }
    return makeResult('pdf', rawText, { scanRequired: !hasTextLayer, imageRefs });
  } catch {
    throw parseFailedError('pdf', 'pdf_text_layer_failed', requestId);
  }
};
