/**
 * Model storage layer.
 *
 * Downloads STL/3MF models from the private Supabase Storage bucket via the
 * Storage REST API (see supabase.ts). Object paths come exclusively from
 * trusted Firestore job metadata (sliceJobs/{jobId}.storagePath) — never
 * from arbitrary browser input.
 */

import { stat } from "node:fs/promises";
import { downloadFromSupabase } from "./supabase.js";

/**
 * Download a model file from Supabase Storage to a local directory.
 *
 * Signature unchanged from the previous Firebase Storage implementation so
 * callers (index.ts, jobs.ts) require no changes.
 *
 * @param storagePath - Trusted object path, e.g. "{ownerId}/{uploadId}/model.stl".
 *   A leading segment equal to the configured bucket name ("custom-prints/...")
 *   is tolerated and stripped by the Supabase layer.
 * @param destDir - The local directory to save the file to
 * @returns The full path to the downloaded file
 */
export async function downloadFromStorage(
  storagePath: string,
  destDir: string,
): Promise<string> {
  const destPath = await downloadFromSupabase(storagePath, destDir);

  // Verify the downloaded file
  const fileInfo = await stat(destPath);
  if (fileInfo.size === 0) {
    throw new Error(`Downloaded file is empty: ${destPath}`);
  }

  return destPath;
}
