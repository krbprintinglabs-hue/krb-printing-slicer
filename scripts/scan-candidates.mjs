/* Scan candidate 3MFs for machine/plates to find a multi-plate A1-compatible one. */
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

function readPsc(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = { plates: new Set(), gcode: false, psc: null };
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const csize = buf.readUInt32LE(ptr + 20);
    const usize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    const pm = name.match(/^Metadata\/plate_(\d+)\.png$/i);
    if (pm) out.plates.add(pm[1]);
    if (/\.gcode$/i.test(name)) out.gcode = true;
    if (/project_settings\.config$/i.test(name) && usize < 8 * 1048576) {
      const lho = buf.readUInt32LE(ptr + 42);
      const lnLen = buf.readUInt16LE(lho + 26);
      const leLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnLen + leLen;
      const raw = buf.subarray(start, start + csize);
      try {
        out.psc = JSON.parse((method === 0 ? Buffer.from(raw) : inflateRawSync(raw)).toString("utf8"));
      } catch {}
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const candidates = process.argv.slice(2);
for (const f of candidates) {
  if (!fs.existsSync(f)) continue;
  const r = readPsc(f);
  if (!r) { console.log(`${path.basename(f)}: not a zip`); continue; }
  const s = r.psc ?? {};
  console.log(
    `${path.basename(f)}: plates=${r.plates.size || "?"} gcode=${r.gcode} printer=${JSON.stringify(s.printer_model)} variant=${JSON.stringify(s.printer_variant)} layer=${JSON.stringify(s.layer_height)} filament=${JSON.stringify(s.filament_type)}`,
  );
}
