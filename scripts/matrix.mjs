/* Drive dist/bambu-slicer.js runBambuSlicer across the test matrix. */
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const CASES = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const PROBES = ["layer_height", "sparse_infill_density", "sparse_infill_pattern", "enable_support", "filament_type", "printer_model", "nozzle_temperature"];

function gcodeConfig(out3mf) {
  const buf = fs.readFileSync(out3mf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const found = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const csize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    if (/Metadata\/plate_\d+\.gcode$/i.test(name)) {
      found.gcodeEntry = name;
      const lho = buf.readUInt32LE(ptr + 42);
      const lnLen = buf.readUInt16LE(lho + 26);
      const leLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnLen + leLen;
      const raw = buf.subarray(start, start + csize);
      const text = (method === 0 ? Buffer.from(raw) : inflateRawSync(raw)).toString("latin1");
      for (const k of PROBES) {
        const m = text.match(new RegExp(`^;\\s*${k}\\s*=\\s*(.+)$`, "mi"));
        if (m && !found[k]) found[k] = m[1].trim().slice(0, 40);
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return found;
}

const { runBambuSlicer } = await import("../dist/bambu-slicer.js");

let failures = 0;
for (const c of CASES) {
  const wd = path.join("combo-out", "matrix", c.name.replace(/[^a-z0-9_-]/gi, "_"));
  fs.rmSync(wd, { recursive: true, force: true });
  fs.mkdirSync(wd, { recursive: true });
  process.stdout.write(`${c.name}: `);
  const t0 = Date.now();
  try {
    const exec = await runBambuSlicer(c.file, wd, c.request);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!exec.success || !exec.result) {
      console.log(`FAIL (${secs}s) ${exec.error}`);
      failures++;
      continue;
    }
    const r = exec.result;
    console.log(
      `ok (${secs}s) time=${(r.printTimeSeconds / 60).toFixed(1)}min weight=${r.filamentWeightGrams}g support=${r.supportUsed} gcodeBytes=${r.gcodeSizeBytes}`,
    );
    const cfgDump = gcodeConfig(path.join(wd, "output.gcode.3mf"));
    console.log("        cfg:", JSON.stringify(cfgDump));
    if (c.expect) {
      const probs = [];
      for (const [k, v] of Object.entries(c.expect)) {
        if (k === "timeMinRange") {
          const m = r.printTimeSeconds / 60;
          if (m < v[0] || m > v[1]) probs.push(`time ${m.toFixed(1)} not in [${v}]`);
        } else if (k === "weightRange") {
          if (r.filamentWeightGrams < v[0] || r.filamentWeightGrams > v[1]) probs.push(`weight ${r.filamentWeightGrams} not in [${v}]`);
        } else if (String(r[k]) !== String(v)) {
          probs.push(`result.${k}=${r[k]} != ${v}`);
        }
      }
      for (const [k, v] of Object.entries(c.expectCfg ?? {})) {
        if (cfgDump[k] === undefined || !String(cfgDump[k]).startsWith(String(v))) probs.push(`cfg.${k}='${cfgDump[k]}' !~ '${v}'`);
      }
      if (probs.length) { console.log("        EXPECT FAIL:", probs.join("; ")); failures++; }
      else console.log("        expectations PASS");
    }
  } catch (e) {
    console.log("THREW", e.message);
    failures++;
  }
}
console.log(failures === 0 ? "\nMATRIX PASSED" : `\n${failures} MATRIX FAILURES`);
process.exit(failures === 0 ? 0 : 1);
