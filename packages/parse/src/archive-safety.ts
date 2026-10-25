import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import type { Entry, RandomAccessReader } from 'yauzl';

/**
 * Streaming ZIP bomb and zip-slip protection over object-store range reads.
 * The checks cover central directory bounds, duplicate entry paths, compressed
 * size versus uncompressed size, CRC32 and container-specific structure.
 */
const MiB = 1024 * 1024;
const ZIP_SIGNATURES = new Set([0x04034b50, 0x06054b50, 0x08074b50]);

export type ArchiveSafetyReason =
  | 'archive_deadline'
  | 'archive_structure_invalid'
  | 'central_directory_too_large'
  | 'compression_ratio_exceeded'
  | 'directory_has_data'
  | 'encrypted_entry'
  | 'entry_count_exceeded'
  | 'entry_name_invalid'
  | 'entry_path_invalid'
  | 'entry_prefix_conflict'
  | 'entry_too_large'
  | 'entry_duplicate'
  | 'epub_mimetype_invalid'
  | 'manifest_invalid'
  | 'manifest_missing'
  | 'special_entry'
  | 'total_uncompressed_too_large'
  | 'unsupported_compression_method'
  | 'zip64_unsupported';

export type ArchiveContainer = 'archive' | 'docx' | 'epub' | 'pptx' | 'xlsx' | 'zip';

export interface ArchiveRangeSource {
  size: number;
  readRange(start: number, end: number): Promise<Uint8Array>;
}

export interface ArchiveInspectionLimits {
  maxEntries: number;
  maxCentralDirectoryBytes: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxRangeReadBytes: number;
  decompressionChunkBytes: number;
  maxCompressionRatio: number;
  entryRatioMinimumBytes: number;
  totalRatioMinimumBytes: number;
  maxEntryNameBytes: number;
  maxPathSegmentBytes: number;
  maxSafeBasenameCharacters: number;
  deadlineMs: number;
}

export interface ArchiveInspectionInput {
  source: ArchiveRangeSource;
  container: ArchiveContainer;
  originalName: string;
  limits?: Partial<ArchiveInspectionLimits>;
}

export interface ArchiveInspectionResult {
  archive: boolean;
  safe: boolean;
  status:
    | 'not_archive'
    | 'safe'
    | 'too_large'
    | 'unsupported'
    | 'dependency_unavailable'
    | 'dependency_timeout';
  reason?: ArchiveSafetyReason | string;
  entryCount?: number;
  actualUncompressedBytes?: number;
  actualCompressedBytes?: number;
  declaredUncompressedBytes?: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveInspectionLimits = {
  maxEntries: 2000,
  maxCentralDirectoryBytes: 16 * MiB,
  maxEntryBytes: 512 * MiB,
  maxTotalUncompressedBytes: 2048 * MiB,
  maxRangeReadBytes: MiB,
  decompressionChunkBytes: 64 * 1024,
  maxCompressionRatio: 100,
  entryRatioMinimumBytes: 16 * MiB,
  totalRatioMinimumBytes: 64 * MiB,
  maxEntryNameBytes: 1024,
  maxPathSegmentBytes: 255,
  maxSafeBasenameCharacters: 180,
  deadlineMs: 30_000,
};

export class ArchiveSafetyError extends Error {
  constructor(
    readonly reason: ArchiveSafetyReason,
    readonly category: 'too_large' | 'unsupported' = 'unsupported',
    readonly metrics: Pick<
      ArchiveInspectionResult,
      | 'entryCount'
      | 'actualUncompressedBytes'
      | 'actualCompressedBytes'
      | 'declaredUncompressedBytes'
    > = {},
  ) {
    super(reason);
    this.name = 'ArchiveSafetyError';
  }
}

export class ArchiveSafetySourceError extends Error {
  constructor(readonly category: 'dependency_unavailable' | 'dependency_timeout') {
    super(category);
    this.name = 'ArchiveSafetySourceError';
  }
}

interface Eocd {
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
  position: number;
}

interface EntryPlan {
  entry: Entry;
  rawName: Buffer;
  name: string;
  normalizedName: string;
  directory: boolean;
  dataStart: number;
  dataEnd: number;
  entryEnd: number;
}

interface YauzlModule {
  fromRandomAccessReader(
    reader: RandomAccessReader,
    totalSize: number,
    options: {
      autoClose?: boolean;
      decodeStrings?: boolean;
      lazyEntries?: boolean;
      validateEntrySizes?: boolean;
    },
    callback: (error: Error | null, zip?: ZipFile) => void,
  ): void;
}

interface ZipFile extends EventEmitter {
  entryCount: number;
  readEntry(): void;
  readEntryCursor: number;
  openReadStream(entry: Entry, callback: (error: Error | null, stream?: Readable) => void): void;
  close(): void;
}

function readAt(buffer: Buffer, offset: number, length: number): Buffer {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new ArchiveSafetyError('archive_structure_invalid');
  }
  return buffer.subarray(offset, offset + length);
}

function uint16(buffer: Buffer, offset: number): number {
  return readAt(buffer, offset, 2).readUInt16LE(0);
}

function uint32(buffer: Buffer, offset: number): number {
  return readAt(buffer, offset, 4).readUInt32LE(0);
}

function isZipSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return ZIP_SIGNATURES.has(Buffer.from(bytes.subarray(0, 4)).readUInt32LE(0));
}

function normalizedContainer(name: string, fallback: ArchiveContainer): ArchiveContainer {
  if (fallback === 'archive') return 'archive';
  const extension = extname(name).toLowerCase();
  if (extension === '.docx') return 'docx';
  if (extension === '.pptx') return 'pptx';
  if (extension === '.xlsx') return 'xlsx';
  if (extension === '.epub') return 'epub';
  if (extension === '.zip') return 'zip';
  return fallback;
}

function safeBasename(value: string): string {
  const basename = value.split('/').at(-1) ?? '';
  return [...basename.normalize('NFC')]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '');
}

function decodeEntryName(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (error) {
    if (error instanceof ArchiveSafetyError) throw error;
    throw new ArchiveSafetyError('entry_name_invalid');
  }
}

function isDirectoryEntry(entry: Entry, name: string): boolean {
  if (name.endsWith('/')) return true;
  const madeByOs = (entry.versionMadeBy >>> 8) & 0xff;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return madeByOs === 3 && (unixMode & 0o170000) === 0o040000;
}

function assertSpecialEntryAllowed(entry: Entry): void {
  const madeByOs = (entry.versionMadeBy >>> 8) & 0xff;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (madeByOs === 3 && fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new ArchiveSafetyError('special_entry');
  }
}

export function validateArchiveEntryPath(value: string): ArchiveSafetyReason | null {
  if (value.length === 0 || value.includes('\\')) return 'entry_path_invalid';
  if (
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    return 'entry_path_invalid';
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) {
    return 'entry_path_invalid';
  }
  const withoutDirectorySuffix = value.endsWith('/') ? value.slice(0, -1) : value;
  if (withoutDirectorySuffix.length === 0) return 'entry_path_invalid';
  if (Buffer.byteLength(withoutDirectorySuffix, 'utf8') > 1024) return 'entry_path_invalid';
  const segments = withoutDirectorySuffix.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf8') > 255,
    )
  ) {
    return 'entry_path_invalid';
  }
  const basename = safeBasename(withoutDirectorySuffix);
  if (basename.length === 0 || [...basename].length > 180) return 'entry_path_invalid';
  return null;
}

function normalizedEntryName(value: string): string {
  const withoutDirectorySuffix = value.endsWith('/') ? value.slice(0, -1) : value;
  return withoutDirectorySuffix.normalize('NFC').toLocaleLowerCase('en-US');
}

class RemoteRandomAccessReader extends EventEmitter {
  private referenceCount = 0;

  constructor(
    private readonly source: ArchiveRangeSource,
    private readonly maxRangeReadBytes: number,
    private readonly ensureAlive: () => void,
  ) {
    super();
  }

  ref(): void {
    this.referenceCount += 1;
  }

  unref(): void {
    this.referenceCount -= 1;
    if (this.referenceCount > 0) return;
    if (this.referenceCount < 0) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    this.close((error) => {
      if (error) this.emit('error', error);
      else this.emit('close');
    });
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null, bytesRead?: number) => void,
  ): void {
    this.ensureAlive();
    if (length > this.maxRangeReadBytes) {
      callback(new ArchiveSafetySourceError('dependency_unavailable'));
      return;
    }
    void this.source
      .readRange(position, position + length)
      .then((bytes) => {
        this.ensureAlive();
        if (bytes.byteLength !== length) {
          throw new ArchiveSafetyError('archive_structure_invalid');
        }
        Buffer.from(bytes).copy(buffer, offset);
        callback(null, length);
      })
      .catch((error: unknown) => {
        callback(
          error instanceof Error ? error : new ArchiveSafetyError('archive_structure_invalid'),
        );
      });
  }

  createReadStream(options: { start: number; end: number }): Readable {
    return Readable.from(this.streamRange(options.start, options.end));
  }

  close(callback: (error: Error | null) => void): void {
    callback(null);
  }

  private async *streamRange(start: number, end: number): AsyncGenerator<Buffer> {
    let position = start;
    while (position < end) {
      this.ensureAlive();
      const next = Math.min(end, position + this.maxRangeReadBytes);
      const bytes = await this.source.readRange(position, next);
      if (bytes.byteLength !== next - position) {
        throw new ArchiveSafetyError('archive_structure_invalid');
      }
      yield Buffer.from(bytes);
      position = next;
    }
  }
}

async function readEocd(
  source: ArchiveRangeSource,
  limits: ArchiveInspectionLimits,
  ensureAlive: () => void,
): Promise<Eocd> {
  ensureAlive();
  const tailSize = Math.min(source.size, 65_557);
  const tailStart = source.size - tailSize;
  const tail = Buffer.from(await source.readRange(tailStart, source.size));
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== 0x06054b50) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength !== tail.length) continue;
    if (index >= 20 && tail.readUInt32LE(index - 20) === 0x07064b50) {
      throw new ArchiveSafetyError('zip64_unsupported');
    }
    const diskNumber = tail.readUInt16LE(index + 4);
    const centralDisk = tail.readUInt16LE(index + 6);
    const diskEntries = tail.readUInt16LE(index + 8);
    const entryCount = tail.readUInt16LE(index + 10);
    const centralDirectorySize = tail.readUInt32LE(index + 12);
    const centralDirectoryOffset = tail.readUInt32LE(index + 16);
    const position = tailStart + index;
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    if (
      centralDirectorySize > limits.maxCentralDirectoryBytes ||
      centralDirectoryOffset + centralDirectorySize > position
    ) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    return { centralDirectoryOffset, centralDirectorySize, entryCount, position };
  }
  throw new ArchiveSafetyError('archive_structure_invalid');
}

const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as YauzlModule;

async function readEntries(
  source: ArchiveRangeSource,
  limits: ArchiveInspectionLimits,
  expectedEntryCount: number,
  ensureAlive: () => void,
): Promise<{ zip: ZipFile; entries: Entry[] }> {
  const reader = new RemoteRandomAccessReader(source, limits.maxRangeReadBytes, ensureAlive);
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      reader as unknown as RandomAccessReader,
      source.size,
      {
        autoClose: false,
        decodeStrings: false,
        lazyEntries: true,
        validateEntrySizes: true,
      },
      (error, opened) => {
        if (error || !opened) reject(error ?? new Error('archive_open_failed'));
        else resolve(opened);
      },
    );
  });
  if (zip.entryCount !== expectedEntryCount) {
    zip.close();
    throw new ArchiveSafetyError('archive_structure_invalid');
  }
  const entries: Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    zip.on('error', (error) => finish(error));
    zip.on('entry', (entry) => {
      try {
        ensureAlive();
        if (entries.length >= limits.maxEntries) {
          throw new ArchiveSafetyError('entry_count_exceeded', 'too_large');
        }
        entries.push(entry);
        zip.readEntry();
      } catch (error) {
        finish(error instanceof Error ? error : new Error('archive_entry_failed'));
      }
    });
    zip.on('end', () => finish());
    zip.readEntry();
  }).catch((error: unknown) => {
    zip.close();
    throw error;
  });
  return { zip, entries };
}

function validateDeclaredMetadata(
  entries: Entry[],
  limits: ArchiveInspectionLimits,
): { totalDeclared: number; totalCompressed: number } {
  let totalDeclared = 0;
  let totalCompressed = 0;
  for (const entry of entries) {
    if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x1) !== 0) {
      throw new ArchiveSafetyError('encrypted_entry');
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new ArchiveSafetyError('unsupported_compression_method');
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw new ArchiveSafetyError('entry_too_large', 'too_large');
    }
    if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    totalDeclared += entry.uncompressedSize;
    totalCompressed += entry.compressedSize;
    if (totalDeclared > limits.maxTotalUncompressedBytes) {
      throw new ArchiveSafetyError('total_uncompressed_too_large', 'too_large');
    }
  }
  return { totalDeclared, totalCompressed };
}

async function validateDataDescriptor(
  source: ArchiveRangeSource,
  dataEnd: number,
  centralDirectoryOffset: number,
  entry: Entry,
): Promise<number> {
  const available = centralDirectoryOffset - dataEnd;
  if (available < 12) throw new ArchiveSafetyError('archive_structure_invalid');
  const length = Math.min(16, available);
  const descriptor = Buffer.from(await source.readRange(dataEnd, dataEnd + length));
  const hasSignature = descriptor.length >= 16 && descriptor.readUInt32LE(0) === 0x08074b50;
  const offset = hasSignature ? 4 : 0;
  if (descriptor.length < offset + 12) {
    throw new ArchiveSafetyError('archive_structure_invalid');
  }
  const descriptorCrc = descriptor.readUInt32LE(offset);
  const descriptorCompressed = descriptor.readUInt32LE(offset + 4);
  const descriptorUncompressed = descriptor.readUInt32LE(offset + 8);
  if (
    descriptorCrc >>> 0 !== entry.crc32 >>> 0 ||
    descriptorCompressed !== entry.compressedSize ||
    descriptorUncompressed !== entry.uncompressedSize
  ) {
    throw new ArchiveSafetyError('archive_structure_invalid');
  }
  return dataEnd + offset + 12;
}

async function buildEntryPlans(
  source: ArchiveRangeSource,
  entries: Entry[],
  limits: ArchiveInspectionLimits,
  centralDirectoryOffset: number,
  container: ArchiveContainer,
): Promise<EntryPlan[]> {
  const plans: EntryPlan[] = [];
  const filePaths = new Set<string>();
  const directoryPaths = new Set<string>();
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    const raw = entry as Entry & { fileNameRaw?: Buffer };
    const rawName = Buffer.isBuffer(raw.fileNameRaw)
      ? raw.fileNameRaw
      : Buffer.from(String(entry.fileName), 'utf8');
    const name = decodeEntryName(rawName);
    if (validateArchiveEntryPath(name)) throw new ArchiveSafetyError('entry_path_invalid');
    const directory = isDirectoryEntry(entry, name);
    assertSpecialEntryAllowed(entry);
    if (directory && (entry.uncompressedSize !== 0 || entry.compressedSize !== 0)) {
      throw new ArchiveSafetyError('directory_has_data');
    }
    if (container === 'archive' && directory) {
      throw new ArchiveSafetyError('manifest_invalid');
    }
    const normalizedName = normalizedEntryName(name);
    if (seenPaths.has(normalizedName)) throw new ArchiveSafetyError('entry_duplicate');
    if (directory && filePaths.has(normalizedName)) {
      throw new ArchiveSafetyError('entry_prefix_conflict');
    }
    if (!directory) {
      const parts = normalizedName.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const parent = parts.slice(0, index).join('/');
        if (filePaths.has(parent)) throw new ArchiveSafetyError('entry_prefix_conflict');
      }
      if ([...filePaths].some((path) => path.startsWith(`${normalizedName}/`))) {
        throw new ArchiveSafetyError('entry_prefix_conflict');
      }
      if (directoryPaths.has(normalizedName)) {
        throw new ArchiveSafetyError('entry_prefix_conflict');
      }
      filePaths.add(normalizedName);
    } else {
      directoryPaths.add(normalizedName);
    }
    seenPaths.add(normalizedName);

    const localHeader = Buffer.from(
      await source.readRange(
        entry.relativeOffsetOfLocalHeader,
        entry.relativeOffsetOfLocalHeader + 30,
      ),
    );
    if (uint32(localHeader, 0) !== 0x04034b50) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    const localFlags = uint16(localHeader, 6);
    const localMethod = uint16(localHeader, 8);
    const localCrc = uint32(localHeader, 14);
    const localCompressedSize = uint32(localHeader, 18);
    const localUncompressedSize = uint32(localHeader, 22);
    if (localFlags !== entry.generalPurposeBitFlag || localMethod !== entry.compressionMethod) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    const localNameLength = uint16(localHeader, 26);
    const localExtraLength = uint16(localHeader, 28);
    const localName = Buffer.from(
      await source.readRange(
        entry.relativeOffsetOfLocalHeader + 30,
        entry.relativeOffsetOfLocalHeader + 30 + localNameLength,
      ),
    );
    if (!localName.equals(rawName)) throw new ArchiveSafetyError('archive_structure_invalid');
    const dataStart = entry.relativeOffsetOfLocalHeader + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const hasDataDescriptor = (localFlags & 0x0008) !== 0;
    let entryEnd = dataEnd;
    if (hasDataDescriptor) {
      const localValues = [localCrc, localCompressedSize, localUncompressedSize];
      const localValuesAreZero = localValues.every((value) => value === 0);
      const localValuesMatch =
        localCrc >>> 0 === entry.crc32 >>> 0 &&
        localCompressedSize === entry.compressedSize &&
        localUncompressedSize === entry.uncompressedSize;
      if (!localValuesAreZero && !localValuesMatch) {
        throw new ArchiveSafetyError('archive_structure_invalid');
      }
      entryEnd = await validateDataDescriptor(source, dataEnd, centralDirectoryOffset, entry);
    } else if (
      localCrc >>> 0 !== entry.crc32 >>> 0 ||
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    ) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    if (
      dataStart < 30 ||
      dataEnd < dataStart ||
      dataEnd > centralDirectoryOffset ||
      entryEnd > centralDirectoryOffset ||
      entryEnd > source.size
    ) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    plans.push({
      entry,
      rawName,
      name,
      normalizedName,
      directory,
      dataStart,
      dataEnd,
      entryEnd,
    });
  }
  const ranges = plans
    .map((plan) => ({
      start: plan.entry.relativeOffsetOfLocalHeader,
      end: plan.entryEnd,
    }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1]!.end > ranges[index]!.start) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
  }
  return plans;
}

async function validateContainerMarkers(
  plans: EntryPlan[],
  container: ArchiveContainer,
  mimetype: string | null,
): Promise<void> {
  const names = new Set(plans.map((plan) => plan.normalizedName));
  if (container === 'docx') {
    if (!names.has('[content_types].xml') || !names.has('word/document.xml')) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
  } else if (container === 'pptx') {
    if (!names.has('[content_types].xml') || !names.has('ppt/presentation.xml')) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
  } else if (container === 'xlsx') {
    if (!names.has('[content_types].xml') || !names.has('xl/workbook.xml')) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
  } else if (container === 'epub') {
    if (plans[0]?.name !== 'mimetype' || mimetype !== 'application/epub+zip') {
      throw new ArchiveSafetyError('epub_mimetype_invalid');
    }
  } else if (container === 'archive') {
    const manifests = plans.filter((plan) => plan.normalizedName === 'manifest.json');
    if (manifests.length !== 1) throw new ArchiveSafetyError('manifest_missing');
    if (
      plans.some(
        (plan) =>
          plan.normalizedName !== 'manifest.json' &&
          !/^sources\/[^/]+\/[^/]+$/.test(plan.normalizedName),
      )
    ) {
      throw new ArchiveSafetyError('manifest_invalid');
    }
  }
}

interface EntryDataInspection {
  actualUncompressedBytes: number;
  actualCompressedBytes: number;
  trailingCompressedBytes: number;
  crc: number;
  capturedPrefix: Buffer;
}

async function inspectEntryData(
  source: ArchiveRangeSource,
  plan: EntryPlan,
  limits: ArchiveInspectionLimits,
  ensureAlive: () => void,
  capturePrefix: boolean,
  onOutput: (bytes: number) => void,
): Promise<EntryDataInspection> {
  const compressedChunks = async function* compressedChunks() {
    let position = plan.dataStart;
    while (position < plan.dataEnd) {
      ensureAlive();
      const end = Math.min(
        plan.dataEnd,
        position + Math.min(limits.maxRangeReadBytes, limits.decompressionChunkBytes),
      );
      const chunk = await source.readRange(position, end);
      if (chunk.byteLength !== end - position) {
        throw new ArchiveSafetyError('archive_structure_invalid');
      }
      yield Buffer.from(chunk);
      position = end;
    }
  };

  let actualUncompressedBytes = 0;
  let crc = 0;
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        ensureAlive();
        const buffer = Buffer.from(chunk);
        actualUncompressedBytes += buffer.byteLength;
        if (actualUncompressedBytes > limits.maxEntryBytes) {
          throw new ArchiveSafetyError('entry_too_large', 'too_large');
        }
        crc = crc32(buffer, crc);
        onOutput(buffer.byteLength);
        if (capturePrefix) {
          const remaining = Math.max(0, 64 - capturedBytes);
          if (remaining > 0) {
            const part = buffer.subarray(0, Math.min(remaining, buffer.byteLength));
            captured.push(part);
            capturedBytes += part.byteLength;
          }
          if (actualUncompressedBytes > 64) {
            throw new ArchiveSafetyError('epub_mimetype_invalid');
          }
        }
        callback();
      } catch (error) {
        callback(
          error instanceof Error ? error : new ArchiveSafetyError('archive_structure_invalid'),
        );
      }
    },
  });

  try {
    if (plan.entry.compressionMethod === 0) {
      if (plan.entry.compressedSize !== plan.entry.uncompressedSize) {
        throw new ArchiveSafetyError('archive_structure_invalid');
      }
      await pipeline(Readable.from(compressedChunks()), sink);
      return {
        actualUncompressedBytes,
        actualCompressedBytes: plan.entry.compressedSize,
        trailingCompressedBytes: 0,
        crc,
        capturedPrefix: Buffer.concat(captured),
      };
    }
    if (plan.entry.compressionMethod !== 8) {
      throw new ArchiveSafetyError('unsupported_compression_method');
    }
    const inflate = createInflateRaw({ chunkSize: limits.decompressionChunkBytes });
    await pipeline(Readable.from(compressedChunks()), inflate, sink);
    const consumed = Number((inflate as unknown as { bytesWritten?: number }).bytesWritten);
    if (!Number.isSafeInteger(consumed) || consumed < 0) {
      throw new ArchiveSafetyError('archive_structure_invalid');
    }
    return {
      actualUncompressedBytes,
      actualCompressedBytes: consumed,
      trailingCompressedBytes: plan.entry.compressedSize - consumed,
      crc,
      capturedPrefix: Buffer.concat(captured),
    };
  } catch (error) {
    if (error instanceof ArchiveSafetyError) throw error;
    throw new ArchiveSafetyError('archive_structure_invalid');
  }
}

async function inspectArchive(
  input: ArchiveInspectionInput,
  limits: ArchiveInspectionLimits,
  deadline: number,
  metrics: Pick<
    ArchiveInspectionResult,
    'entryCount' | 'actualUncompressedBytes' | 'actualCompressedBytes' | 'declaredUncompressedBytes'
  >,
): Promise<ArchiveInspectionResult> {
  const ensureAlive = () => {
    if (Date.now() > deadline) throw new ArchiveSafetyError('archive_deadline');
  };
  const source: ArchiveRangeSource = {
    size: input.source.size,
    readRange: async (start, end) => {
      ensureAlive();
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > input.source.size ||
        end - start > limits.maxRangeReadBytes
      ) {
        throw new ArchiveSafetyError('archive_structure_invalid');
      }
      const bytes = await input.source.readRange(start, end);
      ensureAlive();
      if (bytes.byteLength !== end - start)
        throw new ArchiveSafetyError('archive_structure_invalid');
      return bytes;
    },
  };
  const first = Buffer.from(await source.readRange(0, Math.min(source.size, 4)));
  if (!isZipSignature(first)) {
    return { archive: false, safe: true, status: 'not_archive' };
  }
  const container = normalizedContainer(input.originalName, input.container);
  const eocd = await readEocd(source, limits, ensureAlive);
  metrics.entryCount = eocd.entryCount;
  if (eocd.entryCount > limits.maxEntries) {
    throw new ArchiveSafetyError('entry_count_exceeded', 'too_large', metrics);
  }
  const { zip, entries } = await readEntries(source, limits, eocd.entryCount, ensureAlive);
  try {
    const declared = validateDeclaredMetadata(entries, limits);
    metrics.declaredUncompressedBytes = declared.totalDeclared;
    const plans = await buildEntryPlans(
      source,
      entries,
      limits,
      eocd.centralDirectoryOffset,
      container,
    );
    let actualTotal = 0;
    let actualCompressedTotal = 0;
    let mimetype: string | null = null;
    for (const [entryIndex, plan] of plans.entries()) {
      if (plan.directory) continue;
      const inspected = await inspectEntryData(
        source,
        plan,
        limits,
        ensureAlive,
        container === 'epub' && entryIndex === 0,
        (bytes) => {
          actualTotal += bytes;
          metrics.actualUncompressedBytes = actualTotal;
          if (actualTotal > limits.maxTotalUncompressedBytes) {
            throw new ArchiveSafetyError('total_uncompressed_too_large', 'too_large', metrics);
          }
        },
      );
      const actualEntry = inspected.actualUncompressedBytes;
      actualCompressedTotal += inspected.actualCompressedBytes;
      metrics.actualCompressedBytes = actualCompressedTotal;
      if (actualEntry !== plan.entry.uncompressedSize) {
        throw new ArchiveSafetyError('archive_structure_invalid', 'unsupported', metrics);
      }
      if (
        actualEntry >= limits.entryRatioMinimumBytes &&
        actualEntry / Math.max(inspected.actualCompressedBytes, 1) > limits.maxCompressionRatio
      ) {
        throw new ArchiveSafetyError('compression_ratio_exceeded', 'unsupported', metrics);
      }
      if (
        actualTotal >= limits.totalRatioMinimumBytes &&
        actualTotal / Math.max(actualCompressedTotal, 1) > limits.maxCompressionRatio
      ) {
        throw new ArchiveSafetyError('compression_ratio_exceeded', 'unsupported', metrics);
      }
      if (inspected.trailingCompressedBytes !== 0) {
        throw new ArchiveSafetyError('archive_structure_invalid', 'unsupported', metrics);
      }
      if (inspected.crc >>> 0 !== plan.entry.crc32 >>> 0) {
        throw new ArchiveSafetyError('archive_structure_invalid', 'unsupported', metrics);
      }
      if (container === 'epub' && entryIndex === 0) {
        mimetype = inspected.capturedPrefix.toString('utf8');
      }
    }
    await validateContainerMarkers(plans, container, mimetype);
    return {
      archive: true,
      safe: true,
      status: 'safe',
      entryCount: eocd.entryCount,
      declaredUncompressedBytes: declared.totalDeclared,
      actualUncompressedBytes: actualTotal,
      actualCompressedBytes: actualCompressedTotal,
    };
  } finally {
    zip.close();
  }
}

export class ArchiveSafetyInspector {
  async inspect(input: ArchiveInspectionInput): Promise<ArchiveInspectionResult> {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...input.limits };
    const metrics: Pick<
      ArchiveInspectionResult,
      | 'entryCount'
      | 'actualUncompressedBytes'
      | 'actualCompressedBytes'
      | 'declaredUncompressedBytes'
    > = {};
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = Date.now() + limits.deadlineMs;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ArchiveSafetyError('archive_deadline', 'unsupported', metrics)),
          limits.deadlineMs,
        );
      });
      return await Promise.race([inspectArchive(input, limits, deadline, metrics), timeout]);
    } catch (error) {
      if (error instanceof ArchiveSafetySourceError) {
        return {
          archive: true,
          safe: false,
          status: error.category,
          reason: error.category,
          ...metrics,
        };
      }
      if (error instanceof ArchiveSafetyError) {
        return {
          archive: true,
          safe: false,
          status: error.category === 'too_large' ? 'too_large' : 'unsupported',
          reason: error.reason,
          ...metrics,
          ...error.metrics,
        };
      }
      return {
        archive: true,
        safe: false,
        status: 'unsupported',
        reason: 'archive_structure_invalid',
        ...metrics,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function inspectArchiveBuffer(
  bytes: Uint8Array,
  input: Omit<ArchiveInspectionInput, 'source'> & { limits?: Partial<ArchiveInspectionLimits> },
): Promise<ArchiveInspectionResult> {
  const buffer = Buffer.from(bytes);
  return new ArchiveSafetyInspector().inspect({
    ...input,
    source: {
      size: buffer.length,
      async readRange(start, end) {
        return buffer.subarray(start, end);
      },
    },
  });
}
