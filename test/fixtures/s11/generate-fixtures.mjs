#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const fixtureRoot = join(import.meta.dirname, 'generated');
const manifestPath = join(import.meta.dirname, 'fixture-manifest.json');
const SEED = 's11-release-hardening-v1';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64',
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildTwoPagePdf() {
  return buildPdf(2, 'S11 OCR provider fixture');
}

export function buildMalformedPdf() {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog\n', 'latin1');
}

function zipBytes(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const compressedSize = file.compressedSize ?? compressed.length;
    const uncompressedSize = file.uncompressedSize ?? file.data.length;
    const compressedData = Buffer.alloc(compressedSize);
    compressed.copy(compressedData);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressedData);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressedData.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

export function buildZipBomb() {
  return zipBytes([
    {
      name: 'bomb.txt',
      data: Buffer.alloc(4096),
      uncompressedSize: 2 * 1024 * 1024 * 1024 + 1,
    },
  ]);
}

export function buildZipSlip() {
  return zipBytes([{ name: '../escape.txt', data: Buffer.from('blocked') }]);
}

function buildPdf(pageCount, label) {
  const ids = {
    catalog: 1,
    pages: 2,
    font: 3,
    firstPage: 4,
  };
  const pageIds = Array.from({ length: pageCount }, (_, index) => ids.firstPage + index * 2);
  const objects = new Map();
  objects.set(ids.catalog, `<< /Type /Catalog /Pages ${ids.pages} 0 R >>`);
  objects.set(
    ids.pages,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  );
  objects.set(ids.font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pageIds.forEach((pageId, index) => {
    const contentId = pageId + 1;
    const text = `${label} page ${index + 1}`;
    const content = `BT /F1 16 Tf 72 720 Td (${text}) Tj ET`;
    objects.set(
      pageId,
      `<< /Type /Page /Parent ${ids.pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${ids.font} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.set(
      contentId,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  });
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const [id, object] of [...objects.entries()].sort(([left], [right]) => left - right)) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${object}\nendobj\n`;
  }
  const maxId = Math.max(...objects.keys());
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    const value = offsets[id];
    if (value === undefined) {
      body += '0000000000 00000 f \n';
    } else {
      body += `${String(value).padStart(10, '0')} 00000 n \n`;
    }
  }
  body += `trailer\n<< /Size ${maxId + 1} /Root ${ids.catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function fixtureSpecs() {
  return [
    {
      name: 's11-two-page.pdf',
      bytes: buildTwoPagePdf(),
      pageCount: 2,
      mimeType: 'application/pdf',
      purpose: ['ocr:sangfor', 'ocr:somark', 'ocr:textin', 'ocr:doc2x'],
    },
    {
      name: 's11-malformed.pdf',
      bytes: buildMalformedPdf(),
      pageCount: null,
      mimeType: 'application/pdf',
      purpose: ['fault:invalid-output'],
    },
    {
      name: 's11-import-20-pages.pdf',
      bytes: buildPdf(20, 'S11 import performance fixture'),
      pageCount: 20,
      mimeType: 'application/pdf',
      purpose: ['performance:import', 'import:file'],
    },
    {
      name: 's11-zip-bomb.zip',
      bytes: buildZipBomb(),
      pageCount: null,
      mimeType: 'application/zip',
      purpose: ['security:zip-bomb'],
    },
    {
      name: 's11-zip-slip.zip',
      bytes: buildZipSlip(),
      pageCount: null,
      mimeType: 'application/zip',
      purpose: ['security:zip-slip'],
    },
    {
      name: 's11-image-1x1.png',
      bytes: PNG_1X1,
      pageCount: null,
      mimeType: 'image/png',
      purpose: ['aiproxy:vlm', 'aiproxy:vision-embedding'],
    },
  ];
}

function buildManifest() {
  const entries = fixtureSpecs().map((fixture) => ({
    name: fixture.name,
    sha256: sha256(fixture.bytes),
    bytes: fixture.bytes.length,
    pageCount: fixture.pageCount,
    mimeType: fixture.mimeType,
    purpose: fixture.purpose,
  }));
  return {
    schemaVersion: 1,
    seed: SEED,
    fixtureRoot: 'test/fixtures/s11/generated',
    fixtureHash: sha256(canonicalJson(entries)),
    entries,
  };
}

function writeFixtures() {
  mkdirSync(fixtureRoot, { recursive: true });
  for (const fixture of fixtureSpecs()) {
    writeFileSync(join(fixtureRoot, fixture.name), fixture.bytes);
  }
  const manifest = buildManifest();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function checkFixtures() {
  if (!existsSync(manifestPath)) throw new Error('fixture manifest is missing');
  const expected = buildManifest();
  const actual = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('fixture manifest does not match deterministic fixture bytes');
  }
  for (const fixture of fixtureSpecs()) {
    const path = join(fixtureRoot, fixture.name);
    if (!existsSync(path)) throw new Error(`fixture is missing: ${fixture.name}`);
    if (sha256(readFileSync(path)) !== sha256(fixture.bytes)) {
      throw new Error(`fixture hash mismatch: ${fixture.name}`);
    }
  }
  return expected;
}

export function loadFixtureManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    console.log('Usage: node test/fixtures/s11/generate-fixtures.mjs [--write|--check|--json]');
    process.exit(0);
  }
  try {
    const manifest = args.has('--check') ? checkFixtures() : writeFixtures();
    if (args.has('--json')) {
      console.log(
        JSON.stringify(
          {
            status: 'PASS',
            fixtureHash: manifest.fixtureHash,
            files: manifest.entries.map((entry) => entry.name),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `${args.has('--check') ? 'verified' : 'wrote'} ${manifest.entries.length} fixtures; fixtureHash=${manifest.fixtureHash}`,
      );
    }
  } catch (error) {
    console.error(`S11_FIXTURE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
