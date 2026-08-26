/**
 * Bambu 3MF project inspection and slice planning — direct-3MF path.
 *
 * Empirically established CLI behavior (Bambu Studio 02.08.02.61, verified
 * against real MakerWorld/Bambu exports, see scripts/merge-experiments.mjs):
 *
 *   • `bambu-studio --slice 0 --export-3mf out input.3mf` slices the project
 *     with its EMBEDDED machine/filament/process settings (full preservation,
 *     including per-plate arrangement and object-level settings).
 *   • Passing ANY `--load-settings` file RESETS the embedded process and
 *     filament to defaults + loaded files (no partial merge). Therefore
 *     preserving embedded settings and injecting KRB overrides cannot be
 *     combined via CLI flags.
 *   • The plate frame is Z-up; placed models rest at z = 0.
 *   • Output gcode entry may be Metadata/plate_<N>.gcode for any N —
 *     never assume plate_1.
 *
 * Architecture implemented here:
 *   .stl                     → legacy full-KRB config trio (unchanged)
 *   .3mf incompatible machine→ legacy full-KRB config trio (safety fallback)
 *   .3mf compatible, no
 *        explicit KRB deltas → PURE: original bytes, zero settings flags
 *   .3mf compatible + deltas → PATCHED: surgical rewrite of the embedded
 *                             project_settings.config (only overridden keys),
 *                             stale embedded G-code always stripped so every
 *                             job is a fresh slice for KRB's A1.
 */

import { readFile } from "node:fs/promises";
import {
  extractFileFromZip,
  listZipEntries,
  rewriteZip,
} from "./bambu-zip.js";

const PROJECT_SETTINGS_NAME_RE = /project_settings\.config$/i;
/**
 * Stale-result guard: embedded G-code / slice_info from a previous slicing
 * job (possibly another user's) must never reach a fresh slice or our
 * extractor. Always stripped before handing a project to Bambu.
 */
const STALE_RESULT_RE = /(^|\/)Metadata\/(plate_\d+\.gcode|slice_info\.config)$/i;

/** Machine we run in production. Anything else must NOT be trusted. */
const COMPATIBLE_PRINTER_MODEL_RE = /Bambu Lab A1(?! mini)/i;

export interface BambuProjectInfo {
  /** Number of plates that carry thumbnails/definitions. */
  plateCount: number;
  /** True when the project already contains sliced G-code. */
  hasEmbeddedGcode: boolean;
  /** Flattened project settings (569-key style), when present. */
  settings: Record<string, unknown> | null;
  printerModel: string | null;
  printerVariant: string | null;
  filamentTypes: string[];
}

export type Bambu3mfPlan =
  | { mode: "pure"; reason: string }
  | { mode: "patched"; reason: string; patch: Map<string, Buffer> }
  | { mode: "legacy-fallback"; reason: string };

/* ── Inspection ─────────────────────────────────────────────────────── */

function readProjectSettings(archive: Buffer): Record<string, unknown> | null {
  const entries = listZipEntries(archive);
  if (!entries) return null;
  const hit = entries.find((e) => PROJECT_SETTINGS_NAME_RE.test(e.name));
  if (!hit || hit.uncompressedSize > 16 * 1024 * 1024) return null;
  const raw = extractFileFromZip(archive, hit.name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf-8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function inspectBambuProject(inputFile: string): Promise<BambuProjectInfo | null> {
  let archive: Buffer;
  try {
    archive = await readFile(inputFile);
  } catch {
    return null;
  }
  const entries = listZipEntries(archive);
  if (!entries) return null;

  const plateThumbs = new Set(
    entries
      .map((e) => e.name.match(/^Metadata\/plate_(\d+)\.png$/i)?.[1])
      .filter((n): n is string => n !== undefined),
  );
  const hasEmbeddedGcode = entries.some((e) => STALE_RESULT_RE.test(e.name));
  const settings = readProjectSettings(archive);

  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;

  const filamentTypes = Array.isArray(settings?.filament_type)
    ? (settings!.filament_type as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  return {
    plateCount: Math.max(1, plateThumbs.size),
    hasEmbeddedGcode,
    settings,
    printerModel: str(settings?.printer_model),
    printerVariant: str(settings?.printer_variant),
    filamentTypes,
  };
}

/* ── Compatibility & planning ───────────────────────────────────────── */

export function isMachineCompatible(info: BambuProjectInfo): boolean {
  if (!info.settings) return false;
  if (!info.printerModel || !COMPATIBLE_PRINTER_MODEL_RE.test(info.printerModel)) return false;
  if (info.printerVariant !== "0.4") return false;
  const nozzles = Array.isArray(info.settings.nozzle_diameter)
    ? (info.settings.nozzle_diameter as unknown[])
    : [];
  if (!nozzles.some((n) => String(n) === "0.4")) return false;
  return true;
}

/**
 * Build the plan for a .3mf job.
 * `deltaLoader` supplies official pinned profile fragments for explicit
 * quality/material choices (profiles/bambu/*.json).
 */
export async function planBambu3mfSlice(
  request: {
    material: string;
    quality: string;
    layerHeight?: number | string | null;
    infill?: number | string | null;
    supports?: boolean | number | string | null;
  },
  info: BambuProjectInfo,
  deltaLoader: (name: string) => Promise<Record<string, unknown>>,
): Promise<Bambu3mfPlan> {
  if (!info.settings) {
    return { mode: "legacy-fallback", reason: "3mf has no embedded project settings" };
  }
  if (!isMachineCompatible(info)) {
    return {
      mode: "legacy-fallback",
      reason: `embedded machine '${info.printerModel ?? "unknown"}' ${
        info.printerVariant ?? ""
      } is not the production A1 0.4 — using full KRB configuration`,
    };
  }

  const patch: Record<string, unknown> = {};

  // Explicit quality choice → apply that KRB process delta on top of the
  // embedded project (only these keys change).
  if (request.quality !== "standard") {
    Object.assign(patch, await deltaLoader(`quality-${request.quality}.json`));
  }
  // Explicit material choice → apply the KRB filament delta.
  if (request.material !== "pla") {
    Object.assign(patch, await deltaLoader(`material-${request.material}.json`));
  }
  // Explicit advanced overrides — highest priority.
  if (request.layerHeight != null) patch.layer_height = String(request.layerHeight);
  if (request.infill != null) {
    const s = String(request.infill).trim();
    patch.sparse_infill_density = s.endsWith("%") ? s : `${s}%`;
  }
  if (request.supports != null) {
    patch.enable_support = normalizeSupportsFlag(request.supports) ? "1" : "0";
  }

  delete patch.inherits;
  delete patch.from;
  delete patch.type;
  delete patch.name;

  const overrideKeys = Object.keys(patch);
  if (overrideKeys.length === 0) {
    return {
      mode: "pure",
      reason: info.hasEmbeddedGcode
        ? "A1-compatible project (previously sliced — G-code will be regenerated)"
        : "A1-compatible project — slicing with embedded settings",
    };
  }

  const merged = { ...info.settings, ...patch };
  const pscName = "Metadata/project_settings.config";
  const patchMap = new Map<string, Buffer>();
  patchMap.set(pscName, Buffer.from(JSON.stringify(merged)));

  return {
    mode: "patched",
    reason: `A1-compatible project with explicit KRB overrides: ${overrideKeys
      .sort()
      .join(", ")}`,
    patch: patchMap,
  };
}

const SUPPORTS_TRUE = new Set(["auto", "true", "yes", "on", "1"]);
const SUPPORTS_FALSE = new Set(["none", "false", "no", "off", "0"]);

function normalizeSupportsFlag(value: boolean | number | string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = value.trim().toLowerCase();
  if (SUPPORTS_TRUE.has(s)) return true;
  if (SUPPORTS_FALSE.has(s)) return false;
  throw new Error(`Unsupported supports value '${String(value)}'`);
}

/**
 * Materialize the archive Bambu will slice:
 *   pure    → original with stale embedded results stripped
 *   patched → same, plus surgical project_settings.config overrides
 * Returns null only for legacy-fallback plans (caller uses its own path).
 */
export function materializePlannedArchive(
  original: Buffer,
  plan: Bambu3mfPlan,
): Buffer | null {
  if (plan.mode === "legacy-fallback") return null;
  if (plan.mode === "pure") {
    return rewriteZip(original, { strip: STALE_RESULT_RE });
  }
  return rewriteZip(original, {
    patch: plan.patch,
    strip: STALE_RESULT_RE,
  });
}
