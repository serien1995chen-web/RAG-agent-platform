import { z } from 'zod';
import type { S5OcrProviderName, S5OcrProviderResult } from '../application/s5-ocr-ports';
import type { S5ParseAsset, S5ParsePage } from '../application/s5-processing-ports';

const ImageSchema = z
  .object({
    url: z.string().url().optional(),
    mimeType: z.string().optional(),
    sha256: z.string().optional(),
    sizeBytes: z.number().int().min(0).optional(),
  })
  .passthrough();

const PageSchema = z
  .object({
    pageNumber: z.number().int().min(1).optional(),
    pageNum: z.number().int().min(1).optional(),
    page: z.number().int().min(1).optional(),
    text: z.string().optional(),
    markdown: z.string().optional(),
    md: z.string().optional(),
    images: z.array(ImageSchema).optional(),
  })
  .passthrough();

const BaseEnvelope = z
  .object({
    markdown: z.string(),
    pages: z.array(PageSchema).default([]),
  })
  .passthrough();

const SangforEnvelopeSchema = BaseEnvelope;
const SomarkEnvelopeSchema = BaseEnvelope.extend({ code: z.literal(0) });
const TextinEnvelopeSchema = BaseEnvelope.extend({ code: z.literal(200) });
const Doc2xStatusSchema = z
  .object({
    status: z.enum(['processing', 'pending', 'success', 'failed']),
    markdown: z.string().optional(),
    pages: z.array(PageSchema).optional(),
    error: z.string().optional(),
  })
  .passthrough();

function pageNumber(page: z.infer<typeof PageSchema>, index: number): number {
  return page.pageNumber ?? page.pageNum ?? page.page ?? index + 1;
}

function normalizePages(
  pages: readonly z.infer<typeof PageSchema>[],
  markdown: string,
): {
  pages: S5ParsePage[];
  assets: S5ParseAsset[];
  diagnostics: S5OcrProviderResult['diagnostics'];
} {
  const normalizedPages: S5ParsePage[] = [];
  const assets: S5ParseAsset[] = [];
  const diagnostics: S5OcrProviderResult['diagnostics'] = [];
  pages.forEach((page, index) => {
    const number = pageNumber(page, index);
    const text = page.markdown ?? page.text ?? page.md ?? '';
    const pageAssets: S5ParseAsset[] = (page.images ?? [])
      .filter((image) => image.url !== undefined)
      .map((image, imageIndex) => {
        const asset: S5ParseAsset = {
          assetId: `provider-page-${number}-image-${imageIndex}`,
          mimeType: image.mimeType ?? 'application/octet-stream',
          sha256: image.sha256 ?? '',
          sizeBytes: image.sizeBytes ?? 0,
          ...(image.url ? { sourceUrl: image.url } : {}),
        } as S5ParseAsset;
        return asset;
      });
    normalizedPages.push({ pageNumber: number, text, assets: pageAssets });
    assets.push(...pageAssets);
  });
  if (normalizedPages.length === 0 && markdown.length > 0) {
    normalizedPages.push({ pageNumber: 1, text: markdown, assets: [] });
    diagnostics.push({ severity: 'info', code: 'ocr_pages_normalized_from_markdown' });
  } else if (pages.length > 0) {
    const text = pages.map((page) => page.markdown ?? page.text ?? page.md ?? '').join('\n\n');
    if (text !== markdown) {
      diagnostics.push({ severity: 'info', code: 'ocr_page_markdown_reconciled' });
    }
  }
  return {
    pages: normalizedPages.sort((left, right) => left.pageNumber - right.pageNumber),
    assets,
    diagnostics,
  };
}

export function parseOcrResponse(
  provider: S5OcrProviderName,
  data: unknown,
  input: {
    pageCountHint?: number;
    status?: number;
  } = {},
): S5OcrProviderResult {
  const schema =
    provider === 'somark'
      ? SomarkEnvelopeSchema
      : provider === 'textin'
        ? TextinEnvelopeSchema
        : provider === 'doc2x'
          ? Doc2xStatusSchema
          : SangforEnvelopeSchema;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new S5OcrResponseContractError('ocr_response_schema_invalid');
  if (!('markdown' in parsed.data) || parsed.data.markdown === undefined) {
    throw new S5OcrResponseContractError('ocr_markdown_missing');
  }
  const markdown = parsed.data.markdown;
  if (markdown.trim().length === 0) {
    throw new S5OcrResponseContractError('ocr_markdown_empty');
  }
  const normalized = normalizePages(parsed.data.pages ?? [], markdown);
  return {
    markdown,
    pages: normalized.pages,
    assets: normalized.assets,
    diagnostics: normalized.diagnostics,
    usage: [
      {
        provider,
        unit: 'page',
        quantity: input.pageCountHint ?? Math.max(1, normalized.pages.length),
        status: input.status ?? 200,
      },
    ],
    requestEvidence: {
      provider,
      status: input.status ?? 200,
      pageCount: normalized.pages.length,
    },
  };
}

export const S5OcrResponseSchemas = {
  sangfor: SangforEnvelopeSchema,
  somark: SomarkEnvelopeSchema,
  textin: TextinEnvelopeSchema,
  doc2x: Doc2xStatusSchema,
} as const;

export class S5OcrResponseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S5OcrResponseContractError';
  }
}
