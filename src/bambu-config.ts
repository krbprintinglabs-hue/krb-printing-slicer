/**
 * Bambu configuration resolver — MIGRATION BRANCH.
 *
 * Composes the final full-resolved A1 configuration for a slice request:
 *   fixed machine (A1 0.4) -> quality process override -> material filament
 *   override -> advanced user overrides.
 *
 * All values originate from official pinned profiles (v02.08.02.61):
 *   - Base trio           : profiles/bambu/krb-a1-*.json        (Standard + PLA)
 *   - Quality deltas      : profiles/bambu/quality-fast.json     (0.28mm Extra Draft chain)
 *                           profiles/bambu/quality-high.json     (0.16mm High Quality chain)
 *   - Material overrides  : profiles/bambu/material-petg.json    (PETG Basic chain)
 *                           profiles/bambu/material-abs.json     (ABS chain)
 * Regenerate deltas via scripts/generate-bambu-profile-overrides.mjs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_DIR = process.env.BAMBU_CONFIG_DIR ?? join("profiles", "bambu");

export const SUPPORTED_MATERIALS = ["pla", "petg", "abs"] as const;
export const SUPPORTED_QUALITIES = ["fast", "standard", "high"] as const;
type QualityId = (typeof SUPPORTED_QUALITIES)[number];

/** UI label aliases accepted alongside canonical identifiers. */
const QUALITY_ALIASES: Record<string, QualityId> = {
  fast: "fast",
  standard: "standard",
  high: "high",
  "high-detail": "high",
  "high quality": "high",
};

export interface BambuSliceRequest {
  material: string;
  quality: string;
  /** mm — advanced override */
  layerHeight?: number | string;
  /** percent number (60) or string ("60%") — advanced override */
  infill?: number | string;
  /** advanced override; undefined keeps preset/profile default */
  supports?: boolean;
}

export interface ResolvedBambuConfig {
  machine: Record<string, unknown>;
  process: Record<string, unknown>;
  filament: Record<string, unknown>;
}

function normalizeQuality(quality: string): string {
  const q = quality.toLowerCase();
  const mapped = QUALITY_ALIASES[q];
  if (!mapped) {
    throw new Error(
      `Unsupported quality '${quality}' (supported: fast, standard, high/high-detail)`,
    );
  }
  return mapped;
}

function normalizeMaterial(material: string): string {
  const m = material.toLowerCase();
  if (!(SUPPORTED_MATERIALS as readonly string[]).includes(m)) {
    throw new Error(
      `Unsupported material '${material}' (supported: ${SUPPORTED_MATERIALS.join(", ")})`,
    );
  }
  return m;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(CONFIG_DIR, file), "utf-8"));
}

function normalizeInfill(infill: number | string): string {
  if (typeof infill === "number") return `${infill}%`;
  const s = infill.trim();
  return s.endsWith("%") ? s : `${s}%`;
}

/**
 * Compose the final typed configuration trio. Throws (never falls back to PLA
 * or another preset silently) when material/quality is unsupported.
 */
export async function resolveBambuConfig(
  request: BambuSliceRequest,
): Promise<ResolvedBambuConfig> {
  const quality = normalizeQuality(request.quality);
  const material = normalizeMaterial(request.material);

  const machine = await readJson("krb-a1-machine.json");
  const process = await readJson("krb-a1-process.json");
  const filament = await readJson("krb-a1-filament.json");

  if (quality !== "standard") {
    Object.assign(process, await readJson(`quality-${quality}.json`));
  }
  if (material !== "pla") {
    Object.assign(filament, await readJson(`material-${material}.json`));
  }

  // Advanced overrides — highest priority.
  if (request.layerHeight !== undefined && request.layerHeight !== null) {
    process["layer_height"] = String(request.layerHeight);
  }
  if (request.infill !== undefined && request.infill !== null) {
    process["sparse_infill_density"] = normalizeInfill(request.infill);
  }
  if (request.supports !== undefined && request.supports !== null) {
    process["enable_support"] = request.supports ? "1" : "0";
  }

  // Stamp CLI loader metadata (from/user + type are mandatory, see
  // BambuStudio.cpp load_config_file). Lineage points at the official system
  // profile each composition derives from.
  const systemProcess =
    quality === "standard"
      ? "0.20mm Standard @BBL A1"
      : ((process["inherits"] as string) ?? "0.20mm Standard @BBL A1");
  process["inherits"] = systemProcess;
  process["from"] = "user";
  process["type"] = "process";
  process["name"] = `KRB A1 ${quality} ${material}`;

  filament["from"] = "user";
  filament["type"] = "filament";
  filament["name"] =
    material === "pla" ? "Generic PLA @BBL A1" : (filament["name"] ?? `KRB ${material}`);

  machine["from"] = "user";
  machine["type"] = "machine";
  machine["name"] = "Bambu Lab A1 0.4 nozzle";

  return { machine, process, filament };
}
