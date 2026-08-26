/* Inspect a Bambu/MakerWorld 3MF: plates, machine, filaments, process, gcode. */
import fs from "node:fs";
import { inflateRawSync } from "node:zlib";

function listEntries(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const out = [];
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const csize = buf.readUInt32LE(ptr + 20);
    const usize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const lho = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    let content = null;
    if (usize < 8 * 1024 * 1024) {
      try {
        const lnLen = buf.readUInt16LE(lho + 26);
        const leLen = buf.readUInt16LE(lho + 28);
        const start = lho + 30 + lnLen + leLen;
        const raw = buf.subarray(start, start + csize);
        content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      } catch {}
    }
    out.push({ name, size: usize, content });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const file = process.argv[2];
const entries = listEntries(fs.readFileSync(file));
console.log(`== ${file} (${entries.length} entries) ==`);

const plates = entries.filter((e) => /^Metadata\/plate_\d+\.png$/i.test(e.name));
console.log("plate thumbnails:", plates.map((p) => p.name).join(", ") || "none");
const gcodes = entries.filter((e) => /\.gcode$/i.test(e.name));
console.log("embedded gcode:", gcodes.map((g) => `${g.name}(${g.size})`).join(", ") || "none");

for (const e of entries) {
  if (!/project_settings\.config$/i.test(e.name) || !e.content) continue;
  const cfg = JSON.parse(e.content.toString("utf8"));
  const keys = [
    "printer_model", "printer_variant", "nozzle_diameter", "layer_height",
    "sparse_infill_density", "enable_support", "filament_type", "brim_type",
    "wall_loops", "top_shell_layers", "inherits",
  ];
  console.log(`-- ${e.name} --`);
  for (const k of keys) {
    if (cfg[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(cfg[k])}`);
  }
}

// filament + per-plate metadata from root model XML
const model = entries.find((e) => /3dmodel\.model$/i.test(e.name));
if (model?.content) {
  const xml = model.content.toString("utf8");
  const ftypes = [...xml.matchAll(/key="filament_type"\s+value="([^"]+)"/g)].map((m) => m[1]);
  if (ftypes.length) console.log("model filament_type values:", ftypes.join(" | "));
  const printerModels = [...xml.matchAll(/key="printer_model"\s+value="([^"]+)"/g)].map((m) => m[1]);
  if (printerModels.length) console.log("model printer_model values:", printerModels.join(" | "));
  const plateItems = [...xml.matchAll(/<plate[^>]*>/gi)].length;
  if (plateItems) console.log("<plate> elements:", plateItems);
}
