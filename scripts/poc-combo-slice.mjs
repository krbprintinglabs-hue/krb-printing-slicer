#!/usr/bin/env node
/**
 * POC combo slicer: resolve a KRB A1 configuration via src/bambu-config.ts,
 * slice a fixture with the pinned Bambu CLI, and ASSERT that the requested
 * values actually appear in the generated G-code config dump.
 *
 * Usage (runner):
 *   node scripts/poc-combo-slice.mjs \
 *     '{"material":"petg","quality":"standard"}' fixture.stl /usr/local/bin/bambu-studio
 *
 * Exit 0 = all assertions held. Any mismatch exits 1.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const request = JSON.parse(process.argv[2]);
const stl = process.argv[3];
const slicer = process.argv[4] || "/usr/local/bin/bambu-studio";
const workDir = process.argv[5] || path.join("combo-out", `${request.material}-${request.quality}`);

const { resolveBambuConfig } = await import("../dist/bambu-config.js");

fs.mkdirSync(workDir, { recursive: true });
const resolved = await resolveBambuConfig(request);
const cfgDir = path.join(workDir, "cfg");
fs.mkdirSync(cfgDir, { recursive: true });
for (const [n, obj] of [
  ["machine", resolved.machine],
  ["process", resolved.process],
  ["filament", resolved.filament],
]) {
  fs.writeFileSync(path.join(cfgDir, `${n}.json`), JSON.stringify(obj));
}

const out3mf = path.join(workDir, "out.gcode.3mf");
execFileSync(slicer, [
  "--slice", "0",
  "--load-settings", `${path.join(cfgDir, "machine.json")};${path.join(cfgDir, "process.json")}`,
  "--load-filaments", path.join(cfgDir, "filament.json"),
  "--export-3mf", out3mf,
  stl,
], { stdio: ["ignore", "ignore", "inherit"] });

// Extract plate gcode
execFileSync("unzip", ["-o", out3mf, "-d", path.join(workDir, "unpacked")], { stdio: "ignore" });
const gcode = path.join(workDir, "unpacked", "Metadata", "plate_1.gcode");
if (!fs.existsSync(gcode)) {
  console.error(`FAIL ${JSON.stringify(request)}: no plate gcode produced`);
  process.exit(1);
}
const text = fs.readFileSync(gcode, "utf8");
const siPath = path.join(workDir, "unpacked", "Metadata", "slice_info.config");
const si = fs.readFileSync(siPath, "utf8");
const pred = si.match(/key="prediction"\s+value="(\d+)"/)?.[1];
const wgt = si.match(/key="weight"\s+value="([0-9.]+)"/)?.[1];
const sup = /used_for_support="true"/.test(si);

/** Assert a config comment line exists with an exact value. */
function assertCfg(key, expected) {
  const re = new RegExp(`^;\\s*${key}\\s*=\\s*${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "mi");
  const ok = re.test(text);
  console.log(`  ${ok ? "PASS" : "FAIL"} ${key} = ${expected}`);
  return ok;
}

let failures = 0;
function check(label, ok) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
}

console.log(`== ${request.material}/${request.quality}${request.layerHeight ? ` lh=${request.layerHeight}` : ""}${request.infill != null ? ` infill=${request.infill}` : ""}${request.supports !== undefined ? ` supports=${request.supports}` : ""} ==`);
console.log(`  prediction=${pred}s (${(Number(pred) / 60).toFixed(1)}min) weight=${wgt}g supportUsed=${sup} gcodeBytes=${fs.statSync(gcode).size}`);

failures += assertCfg("layer_height", String(request.layerHeight ?? resolved.process.layer_height)) ? 0 : 1;
failures += assertCfg("sparse_infill_density", String(resolved.process.sparse_infill_density)) ? 0 : 1;
failures += assertCfg("enable_support", request.supports === false ? "0" : "1") ? 0 : 1;
if (resolved.filament.nozzle_temperature) {
  failures += assertCfg("nozzle_temperature", resolved.filament.nozzle_temperature[0]) ? 0 : 1;
}
if (resolved.filament.hot_plate_temp) {
  failures += assertCfg("hot_plate_temp", resolved.filament.hot_plate_temp[0]) ? 0 : 1;
}

if (failures > 0) {
  console.error(`== COMBO FAILED (${failures} assertion misses) ==`);
  process.exit(1);
}
console.log("== COMBO PASSED ==");
