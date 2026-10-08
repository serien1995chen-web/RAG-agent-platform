/**
 * full-text 子目录出口（P2-05）。
 * 装配 barrel（persistence/index.ts、shared/index.ts）由后续任务负责，本任务不修改。
 */
export { FULL_TEXT_BATCH_SIZE, FullTextRepository } from './repository';
export type { FullTextProjectionInput } from './repository';
export { normalizeText, tokenizeForSearch } from './tokenizer';
