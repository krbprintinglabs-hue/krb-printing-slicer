/**
 * Minimal read-only ZIP extractor for Bambu Studio *.gcode.3mf outputs.
 *
 * Supports the subset of ZIP needed here: no Zip64, STORE (0) and DEFLATE (8)
 * entries. Bambu 3MF archives satisfy both constraints. Implemented with
 * built-ins only so the worker gains no new runtime dependencies.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** Extract one entry's uncompressed content by exact name, or null if absent/corrupt. */
export function extractFileFromZip(archive: Buffer, wantedName: string): Buffer | null {
  let eocd = -1;
  const searchFloor = Math.max(0, archive.length - 22 - 65_536);
  for (let i = archive.length - 22; i >= searchFloor; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entryCount = archive.readUInt16LE(eocd + 10);
  let ptr = archive.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > archive.length || archive.readUInt32LE(ptr) !== CEN_SIG) return null;
    const method = archive.readUInt16LE(ptr + 10);
    const compressedSize = archive.readUInt32LE(ptr + 20);
    const nameLen = archive.readUInt16LE(ptr + 28);
    const extraLen = archive.readUInt16LE(ptr + 30);
    const commentLen = archive.readUInt16LE(ptr + 32);
    const localHeaderOffset = archive.readUInt32LE(ptr + 42);
    const name = archive.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    if (name === wantedName) {
      const localNameLen = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const raw = archive.subarray(dataStart, dataStart + compressedSize);
      try {
        return method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      } catch {
        return null;
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Uncompressed size of an entry (for gcodeSizeBytes without extracting). */
export function getUncompressedSize(archive: Buffer, wantedName: string): number | null {
  let eocd = -1;
  const searchFloor = Math.max(0, archive.length - 22 - 65_536);
  for (let i = archive.length - 22; i >= searchFloor; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = archive.readUInt16LE(eocd + 10);
  let ptr = archive.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > archive.length || archive.readUInt32LE(ptr) !== CEN_SIG) return null;
    const uncompressedSize = archive.readUInt32LE(ptr + 24);
    const nameLen = archive.readUInt16LE(ptr + 28);
    const extraLen = archive.readUInt16LE(ptr + 30);
    const commentLen = archive.readUInt16LE(ptr + 32);
    const name = archive.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    if (name === wantedName) return uncompressedSize;
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
