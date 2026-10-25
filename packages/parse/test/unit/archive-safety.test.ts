import { deflateRawSync, crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ArchiveSafetyInspector,
  ArchiveSafetySourceError,
  DEFAULT_ARCHIVE_LIMITS,
  inspectArchiveBuffer,
} from '../../src/index';

interface TestZipEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  externalFileAttributes?: number;
  versionMadeBy?: number;
}

function buildZip(entries: TestZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const compressedSize = entry.compressedSize ?? compressed.length;
    const uncompressedSize = entry.uncompressedSize ?? entry.data.length;
    const data = Buffer.alloc(compressedSize);
    compressed.copy(data);
    const checksum = entry.crc ?? crc32(entry.data);
    const flags = entry.flags ?? 0x0800;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum >>> 0, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum >>> 0, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(entry.externalFileAttributes ?? 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function docxZip(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from('<document/>') },
  ]);
}

function pptxZip(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'ppt/presentation.xml', data: Buffer.from('<presentation/>') },
  ]);
}

function xlsxZip(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
  ]);
}

function epubZip(): Buffer {
  return buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), method: 0 },
    { name: 'META-INF/container.xml', data: Buffer.from('<container/>') },
  ]);
}

function centralSignatureOffset(zip: Buffer): number {
  const offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (offset < 0) throw new Error('central directory not found');
  return offset;
}

function patchSecondLocalOffset(zip: Buffer): void {
  const first = centralSignatureOffset(zip);
  const second = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), first + 4);
  if (second < 0) throw new Error('second central entry not found');
  zip.writeUInt32LE(zip.readUInt32LE(first + 42), second + 42);
}

describe('TEST-X-SECURITY-UPLOAD archive safety inspector', () => {
  it('TEST-FILE-001-U13 accepts valid ZIP, DOCX, PPTX, XLSX and EPUB containers', async () => {
    const cases = [
      ['fixture.zip', 'zip', buildZip([{ name: 'hello.txt', data: Buffer.from('hello') }])],
      ['fixture.docx', 'docx', docxZip()],
      ['fixture.pptx', 'pptx', pptxZip()],
      ['fixture.xlsx', 'xlsx', xlsxZip()],
      ['fixture.epub', 'epub', epubZip()],
    ] as const;
    for (const [originalName, container, bytes] of cases) {
      const result = await inspectArchiveBuffer(bytes, { originalName, container });
      expect(result).toMatchObject({ archive: true, safe: true, status: 'safe' });
    }
  });

  it('TEST-FILE-001-U14 rejects per-entry and total compression ratios above 100:1', async () => {
    const perEntry = buildZip([{ name: 'bomb.txt', data: Buffer.alloc(17 * 1024 * 1024) }]);
    expect(
      await inspectArchiveBuffer(perEntry, { originalName: 'bomb.zip', container: 'zip' }),
    ).toMatchObject({ safe: false, status: 'unsupported', reason: 'compression_ratio_exceeded' });

    const totalRatio = buildZip([
      { name: 'a.txt', data: Buffer.alloc(33 * 1024 * 1024) },
      { name: 'b.txt', data: Buffer.alloc(33 * 1024 * 1024) },
    ]);
    expect(
      await inspectArchiveBuffer(totalRatio, {
        originalName: 'total.zip',
        container: 'zip',
        limits: { entryRatioMinimumBytes: 128 * 1024 * 1024 },
      }),
    ).toMatchObject({ safe: false, status: 'unsupported', reason: 'compression_ratio_exceeded' });
  });

  it('TEST-FILE-001-U15 and TEST-FILE-004-A08 reject traversal, absolute, UNC, drive and NUL paths', async () => {
    for (const name of [
      '../evil',
      '/absolute',
      'C:/drive',
      '//server/share',
      'dir\\file',
      'nul\0file',
      `${'a'.repeat(256)}.txt`,
      `${'a/'.repeat(600)}file.txt`,
      `${'a'.repeat(181)}.txt`,
    ]) {
      const zip = buildZip([{ name, data: Buffer.from('x') }]);
      const result = await inspectArchiveBuffer(zip, {
        originalName: 'unsafe.zip',
        container: 'zip',
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toBe('entry_path_invalid');
    }
  });

  it('TEST-FILE-001-U16 rejects duplicate, symlink, encrypted and unknown-method entries', async () => {
    const duplicate = buildZip([
      { name: 'A.txt', data: Buffer.from('a') },
      { name: 'a.txt', data: Buffer.from('b') },
    ]);
    expect(
      await inspectArchiveBuffer(duplicate, { originalName: 'duplicate.zip', container: 'zip' }),
    ).toMatchObject({ safe: false, reason: 'entry_duplicate' });

    const prefixConflict = buildZip([
      { name: 'folder/file.txt', data: Buffer.from('a') },
      { name: 'folder', data: Buffer.from('b') },
    ]);
    expect(
      await inspectArchiveBuffer(prefixConflict, {
        originalName: 'prefix.zip',
        container: 'zip',
      }),
    ).toMatchObject({ safe: false, reason: 'entry_prefix_conflict' });

    const symlink = buildZip([
      {
        name: 'link',
        data: Buffer.from('target'),
        versionMadeBy: (3 << 8) | 20,
        externalFileAttributes: (0o120777 << 16) >>> 0,
      },
    ]);
    expect(
      await inspectArchiveBuffer(symlink, { originalName: 'symlink.zip', container: 'zip' }),
    ).toMatchObject({ safe: false, reason: 'special_entry' });

    const encrypted = buildZip([{ name: 'secret.txt', data: Buffer.from('x'), flags: 0x0801 }]);
    expect(
      await inspectArchiveBuffer(encrypted, { originalName: 'encrypted.zip', container: 'zip' }),
    ).toMatchObject({ safe: false, reason: 'encrypted_entry' });

    const unknownMethod = buildZip([
      { name: 'unknown.txt', data: Buffer.from('x'), method: 99 as 0 | 8 },
    ]);
    expect(
      await inspectArchiveBuffer(unknownMethod, {
        originalName: 'unknown.zip',
        container: 'zip',
      }),
    ).toMatchObject({ safe: false, reason: 'unsupported_compression_method' });
  });

  it('TEST-FILE-001-U17 enforces entry count, total size and single-entry boundaries', async () => {
    const entries = Array.from({ length: 2001 }, (_, index) => ({
      name: `entry-${index}.txt`,
      data: Buffer.alloc(0),
    }));
    expect(
      await inspectArchiveBuffer(buildZip(entries), {
        originalName: 'entries.zip',
        container: 'zip',
      }),
    ).toMatchObject({ safe: false, status: 'too_large', reason: 'entry_count_exceeded' });

    const oversizedEntry = buildZip([
      {
        name: 'large.txt',
        data: Buffer.from('x'),
        uncompressedSize: 1025,
        compressedSize: 32,
      },
    ]);
    expect(
      await inspectArchiveBuffer(oversizedEntry, {
        originalName: 'large.zip',
        container: 'zip',
        limits: { maxEntryBytes: 1024, maxTotalUncompressedBytes: 4096 },
      }),
    ).toMatchObject({ safe: false, status: 'too_large', reason: 'entry_too_large' });

    const oversizedTotal = buildZip([
      { name: 'a.txt', data: Buffer.from('a'), uncompressedSize: 1000, compressedSize: 20 },
      { name: 'b.txt', data: Buffer.from('b'), uncompressedSize: 1000, compressedSize: 20 },
    ]);
    expect(
      await inspectArchiveBuffer(oversizedTotal, {
        originalName: 'total.zip',
        container: 'zip',
        limits: {
          maxEntryBytes: 1024,
          maxTotalUncompressedBytes: 1500,
          entryRatioMinimumBytes: 2048,
          totalRatioMinimumBytes: 2048,
        },
      }),
    ).toMatchObject({ safe: false, status: 'too_large', reason: 'total_uncompressed_too_large' });
  });

  it('TEST-FILE-001-U18 rejects corrupted central directory, CRC mismatch, overlapping entries and marker mismatch', async () => {
    const corrupt = docxZip();
    const central = centralSignatureOffset(corrupt);
    corrupt.writeUInt32LE(0, central);
    expect(
      await inspectArchiveBuffer(corrupt, { originalName: 'corrupt.docx', container: 'docx' }),
    ).toMatchObject({ safe: false, reason: 'archive_structure_invalid' });

    expect(
      await inspectArchiveBuffer(docxZip(), {
        originalName: 'central.docx',
        container: 'docx',
        limits: { maxCentralDirectoryBytes: 16 },
      }),
    ).toMatchObject({ safe: false, reason: 'archive_structure_invalid' });

    const badCrc = buildZip([{ name: 'bad.txt', data: Buffer.from('bad'), method: 0, crc: 0 }]);
    expect(
      await inspectArchiveBuffer(badCrc, { originalName: 'bad.zip', container: 'zip' }),
    ).toMatchObject({ safe: false, reason: 'archive_structure_invalid' });

    const overlap = buildZip([
      { name: 'a.txt', data: Buffer.from('a'), method: 0 },
      { name: 'b.txt', data: Buffer.from('b'), method: 0 },
    ]);
    patchSecondLocalOffset(overlap);
    expect(
      await inspectArchiveBuffer(overlap, { originalName: 'overlap.zip', container: 'zip' }),
    ).toMatchObject({ safe: false, reason: 'archive_structure_invalid' });

    const missingMarker = buildZip([{ name: 'word/document.xml', data: Buffer.from('<x/>') }]);
    expect(
      await inspectArchiveBuffer(missingMarker, {
        originalName: 'missing.docx',
        container: 'docx',
      }),
    ).toMatchObject({ safe: false, reason: 'archive_structure_invalid' });
  });

  it('TEST-FILE-001-U19 and TEST-FILE-004-A16 fail closed on deadline and source failures', async () => {
    const bytes = docxZip();
    const timed = await new ArchiveSafetyInspector().inspect({
      originalName: 'slow.docx',
      container: 'docx',
      limits: { deadlineMs: 5 },
      source: {
        size: bytes.length,
        async readRange(start, end) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return bytes.subarray(start, end);
        },
      },
    });
    expect(timed).toMatchObject({ safe: false, status: 'unsupported', reason: 'archive_deadline' });

    for (const category of ['dependency_unavailable', 'dependency_timeout'] as const) {
      const failed = await new ArchiveSafetyInspector().inspect({
        originalName: 'provider.docx',
        container: 'docx',
        source: {
          size: bytes.length,
          async readRange() {
            throw new ArchiveSafetySourceError(category);
          },
        },
      });
      expect(failed.safe).toBe(false);
      expect(failed.status).toBe(category);
    }
  });

  it('TEST-FILE-004-A13/A14/A15 validates generated archive manifest and limits', async () => {
    const valid = buildZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'sources/source-1/file.txt', data: Buffer.from('file') },
    ]);
    expect(
      await inspectArchiveBuffer(valid, {
        originalName: 'sources.zip',
        container: 'archive',
        limits: { maxEntries: 2001 },
      }),
    ).toMatchObject({ archive: true, safe: true, status: 'safe' });

    const bomb = buildZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'sources/source-1/bomb.txt', data: Buffer.alloc(17 * 1024 * 1024) },
    ]);
    expect(
      await inspectArchiveBuffer(bomb, {
        originalName: 'sources.zip',
        container: 'archive',
        limits: { maxEntries: 2001 },
      }),
    ).toMatchObject({ safe: false, reason: 'compression_ratio_exceeded' });

    const excessEntries = buildZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'sources/source-1/a.txt', data: Buffer.from('a') },
      { name: 'sources/source-2/b.txt', data: Buffer.from('b') },
    ]);
    expect(
      await inspectArchiveBuffer(excessEntries, {
        originalName: 'sources.zip',
        container: 'archive',
        limits: { maxEntries: 2 },
      }),
    ).toMatchObject({ safe: false, status: 'too_large', reason: 'entry_count_exceeded' });

    const directoryEntry = buildZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'sources/source-1/', data: Buffer.alloc(0), method: 0 },
    ]);
    expect(
      await inspectArchiveBuffer(directoryEntry, {
        originalName: 'sources.zip',
        container: 'archive',
        limits: { maxEntries: 2001 },
      }),
    ).toMatchObject({ safe: false, reason: 'manifest_invalid' });

    const invalidManifest = buildZip([
      { name: 'sources/source-1/file.txt', data: Buffer.from('x') },
    ]);
    expect(
      await inspectArchiveBuffer(invalidManifest, {
        originalName: 'sources.zip',
        container: 'archive',
        limits: { maxEntries: 2001 },
      }),
    ).toMatchObject({ safe: false, reason: 'manifest_missing' });

    const corrupt = valid;
    const centralOffset = centralSignatureOffset(corrupt);
    corrupt[centralOffset] = 0;
    expect(
      await inspectArchiveBuffer(corrupt, {
        originalName: 'sources.zip',
        container: 'archive',
        limits: { maxEntries: 2001 },
      }),
    ).toMatchObject({ safe: false, reason: 'archive_structure_invalid' });
  });

  it('TEST-FILE-004-A17 keeps every range read bounded', async () => {
    const bytes = buildZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'sources/source-1/file.txt', data: Buffer.alloc(2 * 1024 * 1024, 'a') },
    ]);
    let largestRange = 0;
    const result = await new ArchiveSafetyInspector().inspect({
      originalName: 'sources.zip',
      container: 'archive',
      limits: { maxEntries: 2001, maxRangeReadBytes: 64 * 1024 },
      source: {
        size: bytes.length,
        async readRange(start, end) {
          largestRange = Math.max(largestRange, end - start);
          return bytes.subarray(start, end);
        },
      },
    });
    expect(result.safe).toBe(true);
    expect(largestRange).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps Plan 3.7 default limits exact', () => {
    expect(DEFAULT_ARCHIVE_LIMITS).toMatchObject({
      maxEntries: 2000,
      maxCentralDirectoryBytes: 16 * 1024 * 1024,
      maxEntryBytes: 512 * 1024 * 1024,
      maxTotalUncompressedBytes: 2048 * 1024 * 1024,
      maxRangeReadBytes: 1024 * 1024,
      decompressionChunkBytes: 64 * 1024,
      maxCompressionRatio: 100,
      entryRatioMinimumBytes: 16 * 1024 * 1024,
      totalRatioMinimumBytes: 64 * 1024 * 1024,
      deadlineMs: 30_000,
    });
  });
});
