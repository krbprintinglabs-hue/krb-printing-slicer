/**
 * PrusaSlicer execution service.
 *
 * Runs PrusaSlicer CLI headlessly with controlled arguments.
 * Never executes arbitrary user-provided shell commands.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

/* ── Types ──────────────────────────────────────────────────────────── */

export interface SliceResult {
  printTimeSeconds: number;
  filamentWeightGrams: number;
  filamentLengthMm: number;
  dimensions: {
    widthMm: number;
    depthMm: number;
    heightMm: number;
  };
  layerCount: number;
  supportUsed: boolean;
  gcodeSizeBytes: number;
}

export interface SliceExecution {
  success: boolean;
  result: SliceResult | null;
  error: string | null;
  stdout: string;
  stderr: string;
}

/* ── PrusaSlicer Argument Builder ───────────────────────────────────── */

interface QualityProfile {
  layerHeight: number;
  fillDensity: number;
  supportMaterial: boolean;
  supportMaterialAuto: boolean;
  solidLayers: number;
  perimeters: number;
}

interface MaterialProfile {
  filamentType: string;
  nozzleTemp: number;
  bedTemp: number;
  firstLayerTemp: number;
  firstLayerBedTemp: number;
  printSpeed: number;
  firstLayerSpeed: number;
  retractLength: number;
  retractSpeed: number;
  fanSpeed: number;
}

const QUALITY_PROFILES: Record<string, QualityProfile> = {
  fast: {
    layerHeight: 0.28,
    fillDensity: 10,
    supportMaterial: false,
    supportMaterialAuto: false,
    solidLayers: 3,
    perimeters: 2,
  },
  standard: {
    layerHeight: 0.20,
    fillDensity: 15,
    supportMaterial: true,
    supportMaterialAuto: true,
    solidLayers: 4,
    perimeters: 2,
  },
  "high-detail": {
    layerHeight: 0.16,
    fillDensity: 30,
    supportMaterial: true,
    supportMaterialAuto: true,
    solidLayers: 5,
    perimeters: 3,
  },
};

const MATERIAL_PROFILES: Record<string, MaterialProfile> = {
  pla: {
    filamentType: "PLA",
    nozzleTemp: 215,
    bedTemp: 60,
    firstLayerTemp: 215,
    firstLayerBedTemp: 60,
    printSpeed: 60,
    firstLayerSpeed: 25,
    retractLength: 0.8,
    retractSpeed: 45,
    fanSpeed: 100,
  },
  petg: {
    filamentType: "PETG",
    nozzleTemp: 240,
    bedTemp: 80,
    firstLayerTemp: 240,
    firstLayerBedTemp: 80,
    printSpeed: 50,
    firstLayerSpeed: 20,
    retractLength: 1.0,
    retractSpeed: 40,
    fanSpeed: 50,
  },
  abs: {
    filamentType: "ABS",
    nozzleTemp: 250,
    bedTemp: 100,
    firstLayerTemp: 250,
    firstLayerBedTemp: 100,
    printSpeed: 50,
    firstLayerSpeed: 20,
    retractLength: 1.0,
    retractSpeed: 40,
    fanSpeed: 0,
  },
};

/**
 * Build PrusaSlicer CLI arguments from quality and material presets.
 * All values come from whitelisted configuration — no user input is interpolated.
 */
function buildArgs(quality: string, material: string): string[] {
  const q = QUALITY_PROFILES[quality];
  const m = MATERIAL_PROFILES[quality === material ? quality : material];

  if (!q) throw new Error(`Invalid quality preset: ${quality}`);
  if (!m) throw new Error(`Invalid material: ${material}`);

  return [
    "--layer-height", String(q.layerHeight),
    "--fill-density", `${q.fillDensity}%`,
    "--top-solid-layers", String(q.solidLayers),
    "--bottom-solid-layers", String(q.solidLayers),
    "--perimeters", String(q.perimeters),

    q.supportMaterial ? "--support-material" : "--no-support-material",
    q.supportMaterialAuto ? "--support-material-auto" : "",

    "--filament-type", m.filamentType,
    "--temperature", String(m.nozzleTemp),
    "--bed-temperature", String(m.bedTemp),
    "--first-layer-temperature", String(m.firstLayerTemp),
    "--first-layer-bed-temperature", String(m.firstLayerBedTemp),

    "--perimeter-speed", String(m.printSpeed),
    "--infill-speed", String(m.printSpeed),
    "--first-layer-speed", String(m.firstLayerSpeed),

    "--retract-length", String(m.retractLength),
    "--retract-speed", String(m.retractSpeed),

    m.fanSpeed > 0 ? "--fan-always-on" : "--no-fan-always-on",
    "--min-fan-speed", String(m.fanSpeed),
    "--max-fan-speed", String(m.fanSpeed),

    "--export-gcode",
    "--skirts", "1",
    "--brim-width", "0",
  ].filter(Boolean);
}

/* ── PrusaSlicer Execution ──────────────────────────────────────────── */

/**
 * Check if PrusaSlicer is available at the configured path.
 */
export async function checkPrusaSlicer(): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);

    // PrusaSlicer 2.9.6 has no --version option (it exits non-zero with
    // "Unknown option --version"), so availability is checked via --help.
    await exec(config.slicerPath, ["--help"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run PrusaSlicer on an input file.
 *
 * @param inputFile - Full path to the STL or 3MF file
 * @param outputDir - Directory where output files will be written
 * @param quality - Quality preset (fast, standard, high-detail)
 * @param material - Material type (pla, petg, abs)
 * @returns Execution result with parsed statistics
 */
export async function runPrusaSlicer(
  inputFile: string,
  outputDir: string,
  quality: string,
  material: string,
): Promise<SliceExecution> {
  // Validate inputs against whitelists
  if (!QUALITY_PROFILES[quality]) {
    return {
      success: false,
      result: null,
      error: `Invalid quality preset: ${quality}`,
      stdout: "",
      stderr: "",
    };
  }
  if (!MATERIAL_PROFILES[material]) {
    return {
      success: false,
      result: null,
      error: `Invalid material: ${material}`,
      stdout: "",
      stderr: "",
    };
  }

  const args = buildArgs(quality, material);
  const outputFile = join(outputDir, "output.gcode");

  // Add input file and output path
  args.push("-o", outputFile, inputFile);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child: ChildProcess = spawn(config.slicerPath, args, {
      timeout: config.sliceTimeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // Force kill after 5 seconds if still alive
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5000);
    }, config.sliceTimeoutMs);

    child.on("close", async (code) => {
      clearTimeout(timeout);

      if (killed) {
        resolve({
          success: false,
          result: null,
          error: `PrusaSlicer timed out after ${config.sliceTimeoutMs}ms`,
          stdout,
          stderr,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          result: null,
          error: `PrusaSlicer exited with code ${code}: ${stderr.slice(0, 500)}`,
          stdout,
          stderr,
        });
        return;
      }

      // Parse the output
      try {
        const result = await parseOutput(outputFile, stdout, stderr);
        resolve({
          success: true,
          result,
          error: null,
          stdout,
          stderr,
        });
      } catch (err) {
        resolve({
          success: false,
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
          stdout,
          stderr,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        result: null,
        error: `Failed to start PrusaSlicer: ${err.message}`,
        stdout,
        stderr,
      });
    });
  });
}

/* ── Output Parsing ─────────────────────────────────────────────────── */

async function parseOutput(
  gcodePath: string,
  stdout: string,
  stderr: string,
): Promise<SliceResult> {
  let gcodeContent = "";
  try {
    gcodeContent = await readFile(gcodePath, "utf-8");
  } catch {
    // gcode file may not exist if slicing failed
  }

  const combined = `${stdout}\n${stderr}\n${gcodeContent}`;

  // Parse print time. PrusaSlicer reports durations either as words
  // ("2 hours 41 minutes 3 seconds"), as h/m/s ("2h 41m 3s", also used in the
  // "; estimated printing time (normal mode) = ..." G-code footer), or as a
  // plain minute count ("Print time: 42 minutes").
  const hmsWords = combined.match(
    /(\d+)\s*hours?\s+(\d+)\s*minutes?(?:\s+(\d+)\s*seconds?)?/i,
  );
  const hmsCompact = combined.match(/(\d+)\s*h\s*(\d+)\s*m(?:\s*(\d+)\s*s)?/i);
  const minutesOnly = combined.match(/Print time:\s*(\d+)\s*minutes?/i);

  let printTimeSeconds = 0;
  const duration = hmsWords ?? hmsCompact;
  if (duration) {
    printTimeSeconds =
      parseInt(duration[1], 10) * 3600 +
      parseInt(duration[2], 10) * 60 +
      (duration[3] ? parseInt(duration[3], 10) : 0);
  } else if (minutesOnly) {
    printTimeSeconds = parseInt(minutesOnly[1], 10) * 60;
  }

  // Parse filament usage in grams. Covers the console form
  // ("Filament used: 41.64 g") and the G-code footer forms
  // ("; filament used = 41.64g" / "; filament used [g] = 41.64").
  const filamentMatch = combined.match(
    /filament\s+used\s*(?:\[g\])?\s*[:=]\s*([\d.]+)\s*g?/i,
  );
  const filamentWeightGrams = filamentMatch
    ? parseFloat(filamentMatch[1])
    : 0;

  // Parse filament length in meters
  const lengthMatch = combined.match(
    /Filament used:\s*[\d.]+\s*g\s*\(([\d.]+)\s*m\)/i,
  );
  const filamentLengthMm = lengthMatch
    ? parseFloat(lengthMatch[1]) * 1000
    : 0;

  // Parse dimensions
  const dimMatch = combined.match(
    /Print size:\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i,
  );
  const dimensions = {
    widthMm: dimMatch ? parseFloat(dimMatch[1]) : 0,
    depthMm: dimMatch ? parseFloat(dimMatch[2]) : 0,
    heightMm: dimMatch ? parseFloat(dimMatch[3]) : 0,
  };

  // Parse layer count
  const layerMatch = combined.match(/layer_count\s*=\s*(\d+)/i);
  const layerCount = layerMatch ? parseInt(layerMatch[1], 10) : 0;

  // Detect support usage from actual generated extrusion type markers in the
  // G-code (";TYPE:Support material"), not from configuration settings text.
  const supportUsed = combined.includes("TYPE:Support material");

  // Gcode file size
  let gcodeSizeBytes = 0;
  try {
    const fileInfo = await stat(gcodePath);
    gcodeSizeBytes = fileInfo.size;
  } catch {
    // ignore
  }

  return {
    printTimeSeconds,
    filamentWeightGrams,
    filamentLengthMm,
    dimensions,
    layerCount,
    supportUsed,
    gcodeSizeBytes,
  };
}
