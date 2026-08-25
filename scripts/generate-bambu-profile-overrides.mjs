#!/usr/bin/env node
/**
 * Generate Bambu quality/material override artifacts from OFFICIAL Bambu Studio
 * profile files (pinned tag v02.08.02.61).
 *
 * Usage: node scripts/generate-bambu-profile-overrides.mjs <inputDir>
 *   <inputDir> must contain the raw official JSON files downloaded from
 *   https://github.com/bambulab/BambuStudio/tree/v02.08.02.61/resources/profiles/BBL :
 *     process/fdm_process_single_0.28.json      -> ch-p028.json
 *     process/fdm_process_single_0.16.json      -> ch-p016.json
 *     process/0.28mm Extra Draft @BBL A1.json   -> q-fast.json
 *     process/0.16mm High Quality @BBL A1.json  -> q-high.json
 *     filament/fdm_filament_pet.json            -> ch-fpet.json
 *     filament/Bambu PETG Basic @base.json      -> ch-petgbase.json
 *     filament/Bambu PETG Basic @BBL A1.json    -> f-petg.json
 *     filament/fdm_filament_abs.json            -> ch-fabs.json
 *     filament/Bambu ABS @base.json             -> ch-absbase.json
 *     filament/Bambu ABS @BBL A1.json           -> f-abs.json
 *
 * Outputs (committed): profiles/bambu/quality-{fast,high}.json,
 *                      profiles/bambu/material-{petg,abs}.json
 */

import fs from "node:fs";
import path from "node:path";

const inputDir = process.argv[2];
if (!inputDir) {
  console.error("usage: generate-bambu-profile-overrides.mjs <inputDir>");
  process.exit(1);
}
const read = (f) =>
  JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(inputDir, f), "utf8"));
const outDir = path.resolve("profiles/bambu");

const META = new Set([
  "type", "name", "inherits", "from", "setting_id", "instantiation",
  "description", "compatible_printers",
]);

function settingsOf(obj) {
  const s = {};
  for (const [k, v] of Object.entries(obj)) if (!META.has(k)) s[k] = v;
  return s;
}

// ---------- QUALITY: effective delta vs the resolved Standard process base ----------
const standardBase = settingsOf(read(path.resolve("profiles/bambu/krb-a1-process.json")));

function qualityArtifact(chainFile, deltaFile, systemName) {
  const eff = { ...standardBase };
  Object.assign(eff, settingsOf(read(chainFile))); // fdm_process_single_0.xx chain values
  Object.assign(eff, settingsOf(read(deltaFile))); // @A1 child overrides
  const artifact = {};
  for (const [k, v] of Object.entries(eff)) {
    if (JSON.stringify(v) !== JSON.stringify(standardBase[k])) artifact[k] = v;
  }
  artifact.inherits = systemName; // lineage back to the official system profile
  return artifact;
}

fs.writeFileSync(
  path.join(outDir, "quality-fast.json"),
  JSON.stringify(qualityArtifact("ch-p028.json", "q-fast.json", "0.28mm Extra Draft @BBL A1"), null, 2),
);
fs.writeFileSync(
  path.join(outDir, "quality-high.json"),
  JSON.stringify(qualityArtifact("ch-p016.json", "q-high.json", "0.16mm High Quality @BBL A1"), null, 2),
);

// ---------- MATERIAL: full effective override (root -> @base -> @A1) ----------
function materialArtifact(chainFiles, systemName) {
  const eff = {};
  for (const f of chainFiles) Object.assign(eff, settingsOf(read(f)));
  for (const k of Object.keys(eff)) {
    if (Array.isArray(eff[k]) && eff[k].length === 0) delete eff[k]; // set_at() crash guard
  }
  eff.inherits = systemName;
  return eff;
}

fs.writeFileSync(
  path.join(outDir, "material-petg.json"),
  JSON.stringify(materialArtifact(["ch-fpet.json", "ch-petgbase.json", "f-petg.json"], "Bambu PETG Basic @BBL A1"), null, 2),
);
fs.writeFileSync(
  path.join(outDir, "material-abs.json"),
  JSON.stringify(materialArtifact(["ch-fabs.json", "ch-absbase.json", "f-abs.json"], "Bambu ABS @BBL A1"), null, 2),
);

console.log("generated: quality-fast.json, quality-high.json, material-petg.json, material-abs.json");
