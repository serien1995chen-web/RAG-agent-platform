/**
 * @kb/parse 最小 zip 读取器（基于 yauzl），供 PPTX 预检与读取使用。
 * 仅读取内存缓冲，不落盘；超出单文件上限抛 501053 由调用方映射。
 */
import * as yauzl from "yauzl";

export interface ZipEntry {
  name: string;
  size: number;
  readUtf8(): string;
}

export interface ZipReadOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

export async function openZipEntries(bytes: Uint8Array, options: ZipReadOptions = {}): Promise<ZipEntry[]> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const buffer = Buffer.from(bytes);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, file) => {
      if (error || !file) reject(error ?? new Error("zip_open_failed"));
      else resolve(file);
    });
  });

  const entries: ZipEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entries.length >= maxEntries) {
        reject(new ZipLimitError(`zip entries exceed ${maxEntries}`));
        zip.close();
        return;
      }
      if (entry.uncompressedSize > maxEntryBytes) {
        reject(new ZipLimitError(`zip entry ${entry.fileName} exceeds ${maxEntryBytes} bytes`));
        zip.close();
        return;
      }
      const name = entry.fileName;
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error("zip_entry_open_failed"));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          const data = Buffer.concat(chunks);
          entries.push({ name, size: entry.uncompressedSize, readUtf8: () => data.toString("utf8") });
          zip.readEntry();
        });
      });
    });
    zip.on("end", resolve);
    zip.readEntry();
  });
  zip.close();
  return entries;
}
