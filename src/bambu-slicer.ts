/**
 * Bambu Studio slicing backend — MIGRATION BRANCH IMPLEMENTATION.
 *
 * Alternative backend selectable via SLICER_BACKEND=bambu. Production default
 * remains PrusaSlicer (src/slicer.ts, checkpoint prusa-a1-known-good).
 *
 * Uses pinned Bambu Studio v02.08.02.61 CLI with the FULL resolved A1/PLA/
 * Standard configuration extracted from the known-good reference project
 * (profiles/bambu/*.json). Raw resource-profile fragments are NOT used.
 *
 * Output: Bambu writes a *.gcode.3mf archive; slice_info.config carries
 * prediction (s) and weight (g); the per-filament entry carries the proven
 * used_for_support flag. filamentLengthMm / dimensions / layerCount are not
 * exposed by Bambu's slice_info and are reported as zeros.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import type { SliceExecution } from "./slicer.js";
import { isCompleteBambuResult, parseBambuSliceInfo } from "./bambu-poc-result.js";
import { extractFileFromZip, getUncompressedSize } from "./bambu-zip.js";

const GCODE_3MF_NAME = "Metadata/plate_1.gcode";
const SLICE_INFO_NAME = "Metadata/slice_info.config";

function bambuConfigDir(): string {
  return process.env.BAMBU_CONFIG_DIR ?? join("profiles", "bambu");
}

/** Check Bambu CLI availability at the configured path. Same --help convention as PrusaSlicer (2.9.6 has no --version; Bambu does but --help also validates resources). */
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
 * Slice a raw STL with the full resolved KRB A1 configuration.
 * Only standard/pla presets are covered by the current validated configuration.
 */
export async function runBambuSlicer(
  inputFile: string,
  outputDir: string,
  quality: string,
  material: string,
): Promise<SliceExecution> {
  if (quality !== "standard" || material !== "pla") {
    return {
      success: false,
      result: null,
      error: `Bambu backend currently supports only quality=standard material=pla (got ${quality}/${material})`,
      stdout: "",
      stderr: "",
    };
  }

  const cfgDir = bambuConfigDir();
  const machineCfg = join(cfgDir, "krb-a1-machine.json");
  const processCfg = join(cfgDir, "krb-a1-process.json");
  const filamentCfg = join(cfgDir, "krb-a1-filament.json");
  const out3mf = join(outputDir, "output.gcode.3mf");

  const args = [
    "--slice",
    "0",
    "--load-settings",
    `${machineCfg};${processCfg}`,
    "--load-filaments",
    filamentCfg,
    "--export-3mf",
    out3mf,
    inputFile,
  ];

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

      // Extract results from the .gcode.3mf archive.
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
        const gcodeSize =
          getUncompressedSize(archive, GCODE_3MF_NAME) ?? 0;

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
