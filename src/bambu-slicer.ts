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
import { extractFileFromZip, getUncompressedSize } from "./bambu-zip.js";

const GCODE_3MF_NAME = "Metadata/plate_1.gcode";
const SLICE_INFO_NAME = "Metadata/slice_info.config";

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
 */
export async function runBambuSlicer(
  inputFile: string,
  outputDir: string,
  request: BambuSliceRequest,
): Promise<SliceExecution> {
  const out3mf = join(outputDir, "output.gcode.3mf");
  const cfgDir = join(outputDir, "bambu-cfg");
  const machineCfgPath = join(cfgDir, "machine.json");
  const processCfgPath = join(cfgDir, "process.json");
  const filamentCfgPath = join(cfgDir, "filament.json");

  let machineCfg: Record<string, unknown>;
  try {
    const resolved = await resolveBambuConfig(request);
    // Materialize typed config files for the CLI loader.
    await mkdir(cfgDir, { recursive: true });
    machineCfg = resolved.machine;
    await Promise.all([
      writeFile(machineCfgPath, JSON.stringify(resolved.machine)),
      writeFile(processCfgPath, JSON.stringify(resolved.process)),
      writeFile(filamentCfgPath, JSON.stringify(resolved.filament)),
    ]);
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

  const args = [
    "--slice",
    "0",
    "--load-settings",
    `${machineCfgPath};${processCfgPath}`,
    "--load-filaments",
    filamentCfgPath,
    "--export-3mf",
    out3mf,
    inputFile,
  ];
  void machineCfg;

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
