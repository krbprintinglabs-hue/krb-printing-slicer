/**
 * KRB PrusaSlicer Worker — One-Shot Executor
 *
 * Processes a single slicing job and exits.
 * Called by GitHub Actions workflow with a jobId argument.
 *
 * Usage:
 *   node dist/index.js <jobId>
 *
 * Flow:
 *   1. Parse jobId from CLI args
 *   2. Initialize Firebase Admin SDK
 *   3. Read job from Firestore
 *   4. Atomically claim the job (transaction)
 *   5. Download model from Firebase Storage
 *   6. Run PrusaSlicer
 *   7. Write result to Firestore
 *   8. Clean up temp files
 *   9. Exit
 */

import { config, validateConfig } from "./config.js";
import { initializeFirestore, claimJob, completeJob, failJob, type SliceJob } from "./firestore.js";
import { downloadFromStorage } from "./storage.js";
import { runPrusaSlicer, checkPrusaSlicer } from "./slicer.js";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/* ── Logging ────────────────────────────────────────────────────────── */

function log(level: "info" | "warn" | "error", message: string, meta?: object) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    workerId: config.workerId,
    message,
    ...meta,
  };

  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

/* ── Job Processing ─────────────────────────────────────────────────── */

async function processJob(jobId: string): Promise<void> {
  const processingDir = join(config.tempBaseDir, jobId);
  let inputFilePath: string | undefined;

  try {
    // Create temp directory for this job
    await mkdtemp(processingDir + "-");
    const dir = processingDir + "-";

    // Download the model file from Firebase Storage
    // Job storagePath comes from trusted Firestore metadata
    const inputFilePath = await downloadFromStorage(
      (currentJob as SliceJob).storagePath,
      dir,
    );

    // Validate file type
    const fileExtension = inputFilePath.split(".").pop()?.toLowerCase();
    if (fileExtension !== "stl" && fileExtension !== "3mf") {
      throw new Error(
        `Unsupported file type: ${fileExtension}. Expected .stl or .3mf`,
      );
    }

    log("info", "Running PrusaSlicer", {
      jobId,
      quality: (currentJob as SliceJob).quality,
      material: (currentJob as SliceJob).material,
    });

    // TEMPORARY DIAGNOSTICS — remove once "No such file" root cause is fixed.
    try {
      const st = statSync(inputFilePath);
      log("info", "Pre-slice filesystem diagnostics", {
        jobId,
        cwd: process.cwd(),
        slicerPath: config.slicerPath,
        tempBaseDir: config.tempBaseDir,
        processingDir: dir,
        inputFilePath,
        inputFileExists: existsSync(inputFilePath),
        fileSizeBytes: st.size,
        processingDirListing: readdirSync(dir),
        env_LANG: process.env.LANG ?? null,
        env_LC_ALL: process.env.LC_ALL ?? null,
        env_HOME: process.env.HOME ?? null,
        env_TMPDIR: process.env.TMPDIR ?? null,
        env_LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? null,
      });
    } catch (diagErr) {
      log("warn", "Pre-slice diagnostics failed", {
        jobId,
        error: diagErr instanceof Error ? diagErr.message : String(diagErr),
      });
    }

    // Run PrusaSlicer
    const execution = await runPrusaSlicer(
      inputFilePath,
      dir,
      (currentJob as SliceJob).quality,
      (currentJob as SliceJob).material,
    );

    if (!execution.success || !execution.result) {
      throw new Error(execution.error ?? "Slicing failed with no error message");
    }

    log("info", "Slicing complete", {
      jobId,
      printTimeSeconds: execution.result.printTimeSeconds,
      filamentGrams: execution.result.filamentWeightGrams,
    });

    // Complete the job with results
    await completeJob(jobId, {
      printTimeSeconds: execution.result.printTimeSeconds,
      filamentWeightGrams: execution.result.filamentWeightGrams,
      filamentLengthMm: execution.result.filamentLengthMm,
      dimensions: execution.result.dimensions,
      layerCount: execution.result.layerCount,
      supportUsed: execution.result.supportUsed,
      gcodeSizeBytes: execution.result.gcodeSizeBytes,
    });

    // Clean up temp directory
    await rm(dir, { recursive: true, force: true });

    log("info", "Job completed successfully", { jobId });
  } catch (error) {
    // Clean up on failure too
    try {
      await rm(processingDir + "-", { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Report the failure
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Classify the error for better diagnostics
    let errorCode = "SLICING_FAILED";
    if (errorMessage.includes("File not found")) errorCode = "FILE_NOT_FOUND";
    else if (errorMessage.includes("timed out")) errorCode = "SLICING_TIMEOUT";
    else if (errorMessage.includes("Unsupported file type"))
      errorCode = "UNSUPPORTED_FILE_TYPE";
    else if (errorMessage.includes("Invalid quality preset"))
      errorCode = "INVALID_QUALITY";
    else if (errorMessage.includes("Invalid material"))
      errorCode = "INVALID_MATERIAL";
    else if (errorMessage.includes("Failed to start PrusaSlicer"))
      errorCode = "PRUSASLICER_NOT_FOUND";

    // TEMPORARY DIAGNOSTICS — did the input file survive until failure?
    if (inputFilePath) {
      log("info", "Post-failure filesystem check", {
        jobId,
        inputFilePath,
        stillExists: existsSync(inputFilePath),
        processingDirListing: (() => {
          try {
            return readdirSync(processingDir + "-");
          } catch {
            return "<dir gone>";
          }
        })(),
      });
    }

    await failJob(jobId, errorCode, errorMessage);

    log("error", "Job failed", { jobId, errorCode, errorMessage });
  }
}

let currentJob: SliceJob | null = null;

/* ── Main ───────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  // Parse jobId from CLI args
  const jobId = process.argv[2];

  if (!jobId || typeof jobId !== "string") {
    log("error", "Usage: node dist/index.js <jobId>");
    process.exit(1);
  }

  log("info", "Starting worker", { jobId });

  // Validate configuration
  const missingConfig = validateConfig();
  if (missingConfig.length > 0) {
    log("error", "Missing required configuration", {
      missing: missingConfig,
    });
    process.exit(1);
  }

  // Check PrusaSlicer availability
  const slicerAvailable = await checkPrusaSlicer();
  if (!slicerAvailable) {
    log("error", "PrusaSlicer not found at configured path", {
      slicerPath: config.slicerPath,
    });
    process.exit(1);
  }

  // Initialize Firebase Admin SDK
  try {
    await initializeFirestore();
    log("info", "Firestore initialized");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "Failed to initialize Firestore", { error: message });
    process.exit(1);
  }

  // Atomically claim the job
  try {
    currentJob = await claimJob(jobId, config.workerId);
    if (!currentJob) {
      log("error", "Job not found or already claimed", { jobId });
      process.exit(1);
    }
    log("info", "Job claimed", { jobId, status: currentJob.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "Failed to claim job", { jobId, error: message });
    process.exit(1);
  }

  // Process the job
  const startTime = Date.now();
  await processJob(jobId);
  const elapsed = Date.now() - startTime;

  log("info", "Worker finished", { jobId, elapsedMs: elapsed });
  process.exit(0);
}

// Start the worker
main().catch((error) => {
  log("error", "Fatal error", { error: error.message });
  process.exit(1);
});
