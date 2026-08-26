/* Real-world staleness test: take an ALREADY-SLICED Bambu output 3MF
   (contains plate gcode + slice_info from a previous job) and send it
   back through runBambuSlicer like a customer upload.
   Must: detect hasEmbeddedGcode, strip it, fresh-slice, never reuse. */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

execSync("npx tsc", { stdio: "inherit" });
const { inspectBambuProject, planBambu3mfSlice, materializePlannedArchive } = await import("../dist/bambu-project.js");
const { listZipEntries, extractFileFromZip } = await import("../dist/bambu-zip.js");
const { runBambuSlicer } = await import("../dist/bambu-slicer.js");

const SLICED_SRC = "combo-out/matrix/2-chibi-3mf-pure/output.gcode.3mf";
if (!fs.existsSync(SLICED_SRC)) { console.log("missing prerequisite:", SLICED_SRC); process.exit(1); }

const original = fs.readFileSync(SLICED_SRC);
const origG = listZipEntries(original).find((e) => /Metadata\/plate_\d+\.gcode$/i.test(e.name));
const origSliceInfo = extractFileFromZip(original, "Metadata/slice_info.config");
const origText = extractFileFromZip(original, origG.name).toString("latin1");
console.log(`input=sliced project: gcodeEntry=${origG.name} uncompressed=${origG.uncompressedSize}b predTimeInGcode=${/total estimated time/.test(origText)}`);

const info = await inspectBambuProject(SLICED_SRC);
console.log("inspection:", JSON.stringify({ plates: info.plateCount, printer: info.printerModel, variant: info.printerVariant, hasGcode: info.hasEmbeddedGcode }));
if (!info.hasEmbeddedGcode) { console.log("FAIL expected hasEmbeddedGcode=true"); process.exit(1); }

let failures = 0;
for (const req of [
  { label: "sliced-input PURE", request: { material: "pla", quality: "standard" } },
  { label: "sliced-input PATCHED lh0.12", request: { material: "pla", quality: "standard", layerHeight: "0.12" }, wantMode: "patched" },
]) {
  const wd = path.join("combo-out/stale", req.label.replace(/[^a-z0-9-]/gi, "_"));
  fs.rmSync(wd, { recursive: true, force: true });
  fs.mkdirSync(wd, { recursive: true });
  const inputCopy = path.join(wd, "input.3mf");
  fs.writeFileSync(inputCopy, original);

  const plan = await planBambu3mfSlice(req.request, info, async () => ({}));
  console.log(`\n[${req.label}] plan=${plan.mode} — ${plan.reason}`);
  if (req.wantMode && plan.mode !== req.wantMode) { console.log("FAIL wrong mode"); failures++; continue; }

  // Verify stripping BEFORE handing to Bambu
  const mat = materializePlannedArchive(original, plan);
  const names = listZipEntries(mat).map((e) => e.name);
  const leaked = names.filter((n) => /plate_\d+\.gcode$|slice_info\.config$/i.test(n));
  console.log(`stripped-archive: entries=${names.length} residualGcodeOrSliceInfo=${leaked.length}`);
  if (leaked.length) { console.log("FAIL stale entries survived:", leaked); failures++; continue; }
  fs.writeFileSync(path.join(wd, "krb-project.3mf"), mat);

  const exec = await runBambuSlicer(inputCopy, wd, req.request);
  if (!exec.success || !exec.result) { console.log("FAIL slice:", exec.error); failures++; continue; }
  console.log(`fresh slice ok: time=${(exec.result.printTimeSeconds / 60).toFixed(1)}min weight=${exec.result.filamentWeightGrams}g support=${exec.result.supportUsed} gcodeBytes=${exec.result.gcodeSizeBytes}`);

  const outBuf = fs.readFileSync(path.join(wd, "output.gcode.3mf"));
  const outG = listZipEntries(outBuf).find((e) => /Metadata\/plate_\d+\.gcode$/i.test(e.name));
  const outText = extractFileFromZip(outBuf, outG.name).toString("latin1");
  const fresh = outText.length !== origText.length;
  console.log(`freshness: outLen=${outText.length} vs prevJobLen=${origText.length} different=${fresh}`);
  if (!fresh) { console.log("FAIL output identical to previous job's gcode"); failures++; }
}

console.log(failures === 0 ? "\nSTALENESS TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
