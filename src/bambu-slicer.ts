/**
 * Bambu Studio slicing backend — MIGRATION BRANCH IMPLEMENTATION.
 *
 * Alternative backend selectable via SLICER_BACKEND=bambu (now the default on
 * this branch). Production rollback: SLICER_BACKEND=prusa or checkpoint
 * prusa-a1-known-good.
 *
 * Uses pinned Bambu Studio v02.08.02.61 CLI with configurations composed by
 * src/bambu-config.ts from official pinned profiles
 * (profiles/bambu/*). Raw resource-profile fragments are NOT used.
 *
 * Output: Bambu writes a *.gcode.3mf archive; slice_info.config carries
 * prediction (s) and weight (g); the per-filament entry carries the proven
 * used_for_support flag. filamentLengthMm / dimensions / layerCount are not
 * exposed by Bambu's slice_info and are reported as zeros.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import type { SliceExecution } from "./slicer.js";
import { isCompleteBambuResult, parseBambuSliceInfo } from "./bambu-poc-result.js";
import { resolveBambuConfig, type BambuSliceRequest } from "./bambu-config.js";
import {
  inspectBambuProject,
  materializePlannedArchive,
  planBambu3mfSlice,
} from "./bambu-project.js";
import { extractFileFromZip, listZipEntries } from "./bambu-zip.js";

const SLICE_INFO_NAME = "Metadata/slice_info.config";
const OUTPUT_GCODE_RE = /(^|\/)Metadata\/plate_\d+\.gcode$/i;

/** Check Bambu CLI availability at the configured path. */
export async function checkBambu(): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec(config.slicerPath, ["--help"], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Slice with the resolved KRB A1 configuration for this request
 * (material + quality + optional advanced overrides).
 *
 * File-type aware:
 *   .stl → legacy full-KRB configuration (unchanged production path)
 *   .3mf → direct Bambu project slicing:
 *            pure    : original 3MF, embedded settings preserved (A1-compat)
 *            patched : embedded settings + explicit KRB override keys only
 *            fallback: non-A1 / unknown projects get the full KRB trio
 */
export async function runBambuSlicer(
  inputFile: string,
  outputDir: string,
  request: BambuSliceRequest,
): Promise<SliceExecution> {
  const out3mf = join(outputDir, "output.gcode.3mf");

  const ext = inputFile.split(".").pop()?.toLowerCase() ?? "";
  let sliceInput = inputFile;
  let args: string[];

  if (ext === "3mf") {
    // ── Direct-3MF path ────────────────────────────────────────────
    const info = await inspectBambuProject(inputFile);
    if (!info) {
      return {
        success: false,
        result: null,
        error: "Uploaded 3MF could not be read as a Bambu project archive",
        stdout: "",
        stderr: "",
      };
    }

    const plan = await planBambu3mfSlice(request, info, async (name) => {
      const raw = await readFile(join(config.profilesDir, name), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    });

    console.log(
      `[bambu-3mf] plates=${info.plateCount} printer=${info.printerModel ?? "?"}/${info.printerVariant ?? "?"} ` +
        `filament=[${info.filamentTypes.join(",") || "?"}] mode=${plan.mode} — ${plan.reason}`,
    );

    if (plan.mode === "legacy-fallback") {
      // Machine safety: never trust a foreign machine config. Slice with the
      // full authoritative KRB trio instead.
      const legacy = await buildLegacyArgs(inputFile, outputDir, request);
      if ("error" in legacy) return legacy;
      args = legacy.args;
    } else {
      // Both pure and patched get a working copy with stale embedded
      // results stripped (patched adds surgical override keys).
      const original = await readFile(inputFile);
      const rewritten = materializePlannedArchive(original, plan);
      if (!rewritten) {
        return {
          success: false,
          result: null,
          error: "Failed to prepare the 3MF project for slicing",
          stdout: "",
          stderr: "",
        };
      }
      sliceInput = join(outputDir, "krb-project.3mf");
      await writeFile(sliceInput, rewritten);
      // Zero settings flags — Bambu uses the embedded project.
      args = ["--slice", "0", "--export-3mf", out3mf, sliceInput];
    }
  } else {
    // ── STL: unchanged production path ──────────────────────────────
    const legacy = await buildLegacyArgs(inputFile, outputDir, request);
    if ("error" in legacy) return legacy;
    args = legacy.args;
  }

  return spawnBambu(args, out3mf);
}

/** Full authoritative KRB configuration (machine+process+filaments). */
async function buildLegacyArgs(
  inputFile: string,
  outputDir: string,
  request: BambuSliceRequest,
): Promise<{ args: string[] } | { error: string; success: false; result: null; stdout: string; stderr: string }> {
  const cfgDir = join(outputDir, "bambu-cfg");
  const machineCfgPath = join(cfgDir, "machine.json");
  const processCfgPath = join(cfgDir, "process.json");
  const filamentCfgPath = join(cfgDir, "filament.json");

  try {
    const resolved = await resolveBambuConfig(request);
    await mkdir(cfgDir, { recursive: true });
    await Promise.all([
      writeFile(machineCfgPath, JSON.stringify(resolved.machine)),
      writeFile(processCfgPath, JSON.stringify(resolved.process)),
      writeFile(filamentCfgPath, JSON.stringify(resolved.filament)),
    ]);
    return {
      args: [
        "--slice",
        "0",
        "--load-settings",
        `${machineCfgPath};${processCfgPath}`,
        "--load-filaments",
        filamentCfgPath,
        "--export-3mf",
        join(outputDir, "output.gcode.3mf"),
        inputFile,
      ],
    };
  } catch (err) {
    return {
      success: false,
      result: null,
      error: `Invalid slicing configuration: ${
        err instanceof Error ? err.message : String(err)
      }`,
      stdout: "",
      stderr: "",
    };
  }
}

function spawnBambu(args: string[], out3mf: string): Promise<SliceExecution> {
  return new Promise((resolve) => {
    let stderr = "";
    let killed = false;

    const child: ChildProcess = spawn(config.slicerPath, args, {
      timeout: config.sliceTimeoutMs,
      stdio: ["ignore", "ignore", "pipe"],
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 5000);
    }, config.sliceTimeoutMs);

    child.on("close", async (code) => {
      clearTimeout(timeout);

      if (killed) {
        resolve({
          success: false,
          result: null,
          error: `Bambu timed out after ${config.sliceTimeoutMs}ms`,
          stdout: "",
          stderr: stderr.slice(0, 2000),
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          result: null,
          error: `Bambu exited with code ${code}: ${stderr.slice(0, 500)}`,
          stdout: "",
          stderr: stderr.slice(0, 2000),
        });
        return;
      }

      // Extract results from the .gcode.3mf archive. The sliced plate may
      // be any index — locate the gcode entry instead of assuming plate_1.
      try {
        const archive = await readFile(out3mf);
        const sliceInfoRaw = extractFileFromZip(archive, SLICE_INFO_NAME);
        if (!sliceInfoRaw) {
          throw new Error("slice_info.config missing from Bambu output");
        }
        const parsed = parseBambuSliceInfo(sliceInfoRaw.toString("utf-8"));
        if (!isCompleteBambuResult(parsed)) {
          throw new Error(
            `incomplete Bambu slice_info (prediction=${parsed.printTimeSeconds}, weight=${parsed.filamentWeightGrams})`,
          );
        }
        const entries = listZipEntries(archive) ?? [];
        const gcodeEntry = entries.find((e) => OUTPUT_GCODE_RE.test(e.name));
        const gcodeSize = gcodeEntry?.uncompressedSize ?? 0;

        resolve({
          success: true,
          result: {
            printTimeSeconds: parsed.printTimeSeconds as number,
            filamentWeightGrams: parsed.filamentWeightGrams as number,
            // Not exposed by Bambu slice_info:
            filamentLengthMm: 0,
            dimensions: { widthMm: 0, depthMm: 0, heightMm: 0 },
            layerCount: 0,
            supportUsed: parsed.supportUsed,
            gcodeSizeBytes: gcodeSize,
          },
          error: null,
          stdout: "",
          stderr: stderr.slice(0, 2000),
        });
      } catch (err) {
        resolve({
          success: false,
          result: null,
          error: `Failed to extract Bambu output: ${
            err instanceof Error ? err.message : String(err)
          }`,
          stdout: "",
          stderr: stderr.slice(0, 2000),
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        result: null,
        error: `Failed to start Bambu: ${err.message}`,
        stdout: "",
        stderr: "",
      });
    });
  });
}
