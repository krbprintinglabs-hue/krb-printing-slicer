/**
 * Minimal read-only + rewrite-capable ZIP handling for Bambu Studio
 * *.gcode.3mf outputs and uploaded 3MF projects.
 *
 * Supports the subset of ZIP needed here: no Zip64, STORE (0) and DEFLATE (8)
 * entries. Bambu 3MF archives satisfy both constraints. Implemented with
 * built-ins only so the worker gains no new runtime dependencies.
 */

import { inflateRawSync, deflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function locateEocd(archive: Buffer): number | null {
  const searchFloor = Math.max(0, archive.length - 22 - 65_536);
  for (let i = archive.length - 22; i >= searchFloor; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return null;
}

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  crc: number;
  localHeaderOffset: number;
}

/** List every central-directory entry (no content extracted). */
export function listZipEntries(archive: Buffer): ZipEntryInfo[] | null {
  const eocd = locateEocd(archive);
  if (eocd === null) return null;
  const out: ZipEntryInfo[] = [];
  const entryCount = archive.readUInt16LE(eocd + 10);
  let ptr = archive.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > archive.length || archive.readUInt32LE(ptr) !== CEN_SIG) return null;
    const method = archive.readUInt16LE(ptr + 10);
    const compressedSize = archive.readUInt32LE(ptr + 20);
    const uncompressedSize = archive.readUInt32LE(ptr + 24);
    const nameLen = archive.readUInt16LE(ptr + 28);
    const extraLen = archive.readUInt16LE(ptr + 30);
    const commentLen = archive.readUInt16LE(ptr + 32);
    const crc = archive.readUInt32LE(ptr + 16);
    const localHeaderOffset = archive.readUInt32LE(ptr + 42);
    out.push({
      name: archive.toString("utf8", ptr + 46, ptr + 46 + nameLen),
      compressedSize,
      uncompressedSize,
      method,
      crc,
      localHeaderOffset,
    });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function dataSpan(
  archive: Buffer,
  e: Pick<ZipEntryInfo, "compressedSize" | "localHeaderOffset">,
): { start: number; end: number } {
  const localNameLen = archive.readUInt16LE(e.localHeaderOffset + 26);
  const localExtraLen = archive.readUInt16LE(e.localHeaderOffset + 28);
  const start = e.localHeaderOffset + 30 + localNameLen + localExtraLen;
  return { start, end: start + e.compressedSize };
}

function inflateEntry(archive: Buffer, e: ZipEntryInfo): Buffer | null {
  try {
    const { start, end } = dataSpan(archive, e);
    const raw = archive.subarray(start, end);
    return e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
  } catch {
    return null;
  }
}

/** Extract one entry's uncompressed content by exact name, or null if absent/corrupt. */
export function extractFileFromZip(archive: Buffer, wantedName: string): Buffer | null {
  const entries = listZipEntries(archive);
  if (!entries) return null;
  const hit = entries.find((e) => e.name === wantedName);
  return hit ? inflateEntry(archive, hit) : null;
}

/** Extract by exact ZipEntryInfo. */
export function extractEntry(archive: Buffer, entry: ZipEntryInfo): Buffer | null {
  return inflateEntry(archive, entry);
}

/** Uncompressed size of an entry (for gcodeSizeBytes without extracting). */
export function getUncompressedSize(archive: Buffer, wantedName: string): number | null {
  const entries = listZipEntries(archive);
  if (!entries) return null;
  return entries.find((e) => e.name === wantedName)?.uncompressedSize ?? null;
}

/* ── CRC32 ──────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ── Rewrite ────────────────────────────────────────────────────────── */

export interface RewriteOptions {
  /** Replace these entries' content (names must match exactly). */
  patch?: Map<string, Buffer>;
  /** Drop entries whose name matches. */
  strip?: RegExp;
}

interface OutEntry {
  name: string;
  crc: number;
  csize: number;
  usize: number;
  method: number;
  /** Full local block: header + payload. */
  block: Buffer;
}

/**
 * Rewrite a ZIP: drop `strip` matches, replace `patch` entries (deflated),
 * copy everything else byte-for-byte. Returns null on unsupported input.
 */
export function rewriteZip(archive: Buffer, opts: RewriteOptions = {}): Buffer | null {
  const entries = listZipEntries(archive);
  if (entries === null || locateEocd(archive) === null) return null;

  const outs: OutEntry[] = [];
  for (const e of entries) {
    if (opts.strip?.test(e.name)) continue;

    const replacement = opts.patch?.get(e.name);
    if (replacement !== undefined) {
      const deflated = deflateRawSync(replacement, { level: 9 });
      const crc = crc32(replacement);
      const nameBuf = Buffer.from(e.name, "utf8");
      const header = Buffer.alloc(30 + nameBuf.length);
      header.writeUInt32LE(LOC_SIG, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0, 10); // time
      header.writeUInt16LE(0x21, 12); // date (deterministic)
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(deflated.length, 18);
      header.writeUInt32LE(replacement.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(header, 30);
      outs.push({ name: e.name, crc, csize: deflated.length, usize: replacement.length, method: 8, block: Buffer.concat([header, deflated]) });
      continue;
    }

    // Copy original local block verbatim (header + payload).
    const { start, end } = dataSpan(archive, e);
    const block = archive.subarray(e.localHeaderOffset, end);
    outs.push({
      name: e.name,
      crc: e.crc,
      csize: e.compressedSize,
      usize: e.uncompressedSize,
      method: e.method,
      block,
    });
  }

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const o of outs) {
    const localOffset = offset;
    chunks.push(o.block);
    offset += o.block.length;

    const nameBuf = Buffer.from(o.name, "utf8");
    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(o.method, 10);
    cen.writeUInt16LE(0, 12); // time
    cen.writeUInt16LE(0x21, 14); // date
    cen.writeUInt32LE(o.crc, 16);
    cen.writeUInt32LE(o.csize, 20);
    cen.writeUInt32LE(o.usize, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(localOffset, 42);
    nameBuf.copy(cen, 46);
    central.push(cen);
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(outs.length, 8);
  eocd.writeUInt16LE(outs.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
