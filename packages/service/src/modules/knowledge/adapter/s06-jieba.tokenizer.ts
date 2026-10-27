import { createHash } from 'node:crypto';
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

const TOKENIZER_VERSION = '@node-rs/jieba@2.0.1/default-dict';
const jieba = Jieba.withDict(dict);

export interface FullTextProjectionInput {
  segmentId: string;
  sourceVersion: number;
  indexVersion: number;
  question: string;
  answer: string;
  content: string;
  title?: string;
  searchEnabled: boolean;
}

export interface FullTextProjectionOutput {
  fullTextTokens: string;
  fullTextVersion: number;
  tokenizerVersion: string;
  tokensHash: string;
}

function normalize(value: string): string {
  return Array.from(value.normalize('NFKC'))
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .trim();
}

export function projectFullText(input: FullTextProjectionInput): FullTextProjectionOutput {
  const source = [input.question, input.answer, input.content, input.title ?? '']
    .map(normalize)
    .filter((value) => value.length > 0)
    .join('\n');
  const fullTextTokens = jieba
    .cutForSearch(source, true)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .join(' ');
  return {
    fullTextTokens,
    fullTextVersion: input.indexVersion,
    tokenizerVersion: TOKENIZER_VERSION,
    tokensHash: createHash('sha256').update(fullTextTokens).digest('hex'),
  };
}
