/**
 * Model storage layer.
 *
 * Downloads STL/3MF models from private object storage. Two backends are
 * supported, selected per job by the storage reference prefix:
 *   - "b2:<path>"        -> Backblaze B2 via its S3-compatible API (see b2.ts)
 *   - anything else      -> Supabase Storage REST API (see supabase.ts)
 * Object paths come exclusively from trusted Firestore job metadata
 * (sliceJobs/{jobId}.storagePath) — never from arbitrary browser input.
 */

import { stat } from "node:fs/promises";
import { downloadFromB2, isB2Reference } from "./b2.js";
import { downloadFromSupabase } from "./supabase.js";

/**
 * Download a model file from object storage to a local directory.
 *
 * Signature unchanged from the previous Firebase Storage implementation so
 * callers (index.ts, jobs.ts) require no changes.
 *
 * @param storagePath - Trusted object path, e.g. "{ownerId}/{uploadId}/model.stl"
 *   (Supabase) or "b2:custom-prints/{ownerId}/{uploadId}/model.stl" (B2).
 *   For B2 references the `b2:` prefix is only a backend marker and is
 *   stripped before any storage operation.
 *   A leading segment equal to the configured bucket name ("custom-prints/...")
 *   is tolerated and stripped by the backend layer.
 * @param destDir - The local directory to save the file to
 * @returns The full path to the downloaded file
 */
export async function downloadFromStorage(
  storagePath: string,
  destDir: string,
): Promise<string> {
  const destPath = isB2Reference(storagePath)
    ? await downloadFromB2(storagePath, destDir)
    : await downloadFromSupabase(storagePath, destDir);

  // Verify the downloaded file
  const fileInfo = await stat(destPath);
  if (fileInfo.size === 0) {
    throw new Error(`Downloaded file is empty: ${destPath}`);
  }

  return destPath;
}
