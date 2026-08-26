"use strict";
// Local resolver unit tests (no Bambu binary required). Run: node test-resolver.cjs
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");

execSync("npx tsc --noEmit", { stdio: "inherit" });

import("./dist/bambu-config.js").then(async (m) => {
  const { resolveBambuConfig } = m;

  // 1) REGRESSION: standard/pla without overrides == committed known-good trio
  const base = await resolveBambuConfig({ material: "pla", quality: "standard" });
  const load = (p) => { const j = JSON.parse(fs.readFileSync(p, "utf8")); delete j.name; return j; };
  const stripName = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.name; return c; };
  assert.deepStrictEqual(stripName(base.machine), load("profiles/bambu/krb-a1-machine.json"), "machine drift");
  assert.deepStrictEqual(stripName(base.process), load("profiles/bambu/krb-a1-process.json"), "process drift");
  assert.deepStrictEqual(stripName(base.filament), load("profiles/bambu/krb-a1-filament.json"), "filament drift");
  console.log("PASS regression: standard/pla == known-good trio (name cosmetic)");

  // 2) quality deltas
  const fast = await resolveBambuConfig({ material: "pla", quality: "fast" });
  assert.strictEqual(fast.process.layer_height, "0.28");
  assert.strictEqual(fast.process.inherits, "0.28mm Extra Draft @BBL A1");
  assert.strictEqual(fast.process.sparse_infill_speed[0], "200");

  const high = await resolveBambuConfig({ material: "pla", quality: "high" });
  assert.strictEqual(high.process.layer_height, "0.16");
  assert.strictEqual(high.process.sparse_infill_pattern, "gyroid");
  assert.strictEqual(high.process.outer_wall_speed[0], "60");
  assert.strictEqual(high.process.top_shell_layers, "6"); // from 0.16 chain, not standard's 5
  console.log("PASS quality: fast(0.28) high(0.16/gyroid/ow60/top6)");

  // 3) material overrides
  const petg = await resolveBambuConfig({ material: "petg", quality: "standard" });
  assert.strictEqual(petg.filament.nozzle_temperature[0], "245");
  assert.strictEqual(petg.filament.hot_plate_temp[0], "70");
  assert.strictEqual(petg.filament.filament_density[0], "1.25");
  assert.strictEqual(petg.filament.filament_max_volumetric_speed[0], "13");
  assert.strictEqual(petg.filament.filament_type[0], "PETG");

  const abs = await resolveBambuConfig({ material: "abs", quality: "standard" });
  assert.strictEqual(abs.filament.nozzle_temperature[0], "270");
  assert.strictEqual(abs.filament.nozzle_temperature_initial_layer[0], "260");
  assert.strictEqual(abs.filament.hot_plate_temp[0], "100");
  assert.strictEqual(abs.filament.textured_plate_temp[0], "100");
  assert.strictEqual(abs.filament.filament_type[0], "ABS");
  assert.strictEqual(abs.filament.slow_down_layer_time[0], "12");
  console.log("PASS materials: petg/abs official values applied");

  // 4) advanced overrides beat presets
  const adv1 = await resolveBambuConfig({ material: "pla", quality: "high", layerHeight: 0.12 });
  assert.strictEqual(adv1.process.layer_height, "0.12");
  const adv2 = await resolveBambuConfig({ material: "pla", quality: "standard", infill: 60 });
  assert.strictEqual(adv2.process.sparse_infill_density, "60%");
  const adv3 = await resolveBambuConfig({ material: "pla", quality: "standard", supports: false });
  assert.strictEqual(adv3.process.enable_support, "0");
  const adv4 = await resolveBambuConfig({ material: "petg", quality: "fast", layerHeight: "0.24", infill: "100%", supports: true });
  assert.strictEqual(adv4.process.layer_height, "0.24");
  assert.strictEqual(adv4.process.sparse_infill_density, "100%");
  assert.strictEqual(adv4.process.enable_support, "1");

  // 4b) supports string vocabulary (production UI payloads)
  const sAuto = await resolveBambuConfig({ material: "pla", quality: "standard", supports: "auto" });
  assert.strictEqual(sAuto.process.enable_support, "1", "supports='auto' must enable");
  const sNone = await resolveBambuConfig({ material: "pla", quality: "standard", supports: "none" });
  assert.strictEqual(sNone.process.enable_support, "0", "supports='none' must disable (regression T8)");
  const sNone2 = await resolveBambuConfig({ material: "pla", quality: "standard", supports: false });
  assert.strictEqual(sNone2.process.enable_support, "0");
  console.log("PASS advanced: overrides take priority over presets; supports auto/none handled");

  // 5) unsupported combos fail loudly, never fall back to PLA
  await assert.rejects(() => resolveBambuConfig({ material: "tpu", quality: "standard" }), /Unsupported material 'tpu'/);
  await assert.rejects(() => resolveBambuConfig({ material: "pla", quality: "ultra" }), /Unsupported quality 'ultra'/);
  await assert.rejects(() => resolveBambuConfig({ material: "pla", quality: "standard", supports: "maybe" }), /Unsupported supports value 'maybe'/);
  console.log("PASS unsupported: loud errors, no silent fallback");

  console.log("ALL RESOLVER TESTS PASSED");
}).catch((e) => { console.error("TEST FAILURE:", e.message); process.exit(1); });
