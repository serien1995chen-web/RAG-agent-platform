/**
 * @kb/parse 本地类型声明：为无自带类型的已登记解析依赖提供最小契约。
 * 不新增运行时依赖，仅补齐 TypeScript 声明（papaparse/turndown/joplin-gfm/yauzl）。
 */
declare module "papaparse" {
  export interface ParseError {
    code?: string;
    message?: string;
    type?: string;
    row?: number;
  }
  export interface ParseResult<T> {
    data: T[];
    errors: ParseError[];
  }
  export interface ParseConfig {
    skipEmptyLines?: boolean | "greedy";
    header?: boolean;
  }
  export function parse<T>(input: string, config?: ParseConfig): ParseResult<T>;
  const Papa: { parse: typeof parse };
  export default Papa;
}

declare module "turndown" {
  export interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    codeBlockStyle?: "indented" | "fenced";
    bulletListMarker?: string;
  }
  export interface TurndownPlugin {
    (service: TurndownService): void;
  }
  export default class TurndownService {
    constructor(options?: TurndownOptions);
    use(plugin: TurndownPlugin): this;
    turndown(input: string): string;
  }
}

declare module "joplin-turndown-plugin-gfm" {
  import type { TurndownPlugin } from "turndown";
  export const gfm: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
}

declare module "yauzl" {
  export interface Entry {
    fileName: string;
    uncompressedSize: number;
    compressedSize: number;
  }
  export interface ZipFile {
    readEntry(): void;
    openReadStream(
      entry: Entry,
      callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
    ): void;
    close(): void;
    on(event: "entry", listener: (entry: Entry) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export function fromBuffer(
    buffer: Buffer,
    options: { lazyEntries: boolean },
    callback: (error: Error | null, zipfile?: ZipFile) => void,
  ): void;
}
