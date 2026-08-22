/**
 * Job processing orchestration.
 *
 * Coordinates the full lifecycle of processing a single slice job:
 * download -> validate -> slice -> parse results -> store result.
 *
 * This module is used by the one-shot executor (index.ts).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { type SliceJob, completeJob, failJob } from "./firestore.js";
import { downloadFromStorage } from "./storage.js";
import { runPrusaSlicer, checkPrusaSlicer } from "./slicer.js";

/**
 * Process a single slice job end-to-end.
 *
 * Steps:
 * 1. Create temp directory
 * 2. Download STL/3MF from Firebase Storage
 * 3. Run PrusaSlicer with configured quality/material
 * 4. Parse results (print time, filament, dimensions, etc.)
 * 5. Update Firestore job record with result
 * 6. Clean up temp directory
 */
export async function processJob(job: SliceJob): Promise<void> {
  const jobDir = join(config.tempBaseDir, job.id);

  try {
    // Create temp directory for this job
    const processingDir = await mkdtemp(jobDir + "-");

    // Download the model file from Firebase Storage
    const inputFilePath = await downloadFromStorage(
      job.storagePath,
      processingDir,
    );

    // Validate file type matches what we expect
    const fileExtension = inputFilePath.split(".").pop()?.toLowerCase();
    if (fileExtension !== "stl" && fileExtension !== "3mf") {
      throw new Error(
        `Unsupported file type: ${fileExtension}. Expected .stl or .3mf`,
      );
    }

    // Run PrusaSlicer
    const execution = await runPrusaSlicer(
      inputFilePath,
      processingDir,
      job.quality,
      job.material,
    );

    if (!execution.success || !execution.result) {
      throw new Error(execution.error ?? "Slicing failed with no error message");
    }

    // Complete the job with results
    await completeJob(job.id, {
      printTimeSeconds: execution.result.printTimeSeconds,
      filamentWeightGrams: execution.result.filamentWeightGrams,
      filamentLengthMm: execution.result.filamentLengthMm,
      dimensions: execution.result.dimensions,
      layerCount: execution.result.layerCount,
      supportUsed: execution.result.supportUsed,
      gcodeSizeBytes: execution.result.gcodeSizeBytes,
    });

    // Clean up temp directory
    await rm(processingDir, { recursive: true, force: true });
  } catch (error) {
    // Clean up on failure too
    try {
      await rm(jobDir + "-", { recursive: true, force: true });
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

    await failJob(job.id, errorCode, errorMessage);
  }
}

/**
 * Check if the worker environment is healthy.
 * Verifies PrusaSlicer is installed and accessible.
 */
export async function checkHealth(): Promise<boolean> {
  return checkPrusaSlicer();
}
