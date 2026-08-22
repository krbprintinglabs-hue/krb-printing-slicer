/**
 * Firebase Storage operations using Admin SDK.
 *
 * Downloads model files from Firebase Storage to local temporary directories.
 */

import { getStorage } from "firebase-admin/storage";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { config } from "./config.js";

/**
 * Download a file from Firebase Storage to a local directory.
 *
 * @param storagePath - The Storage path (e.g., "custom-prints/{ownerId}/{uploadId}/model.stl")
 * @param destDir - The local directory to save the file to
 * @returns The full path to the downloaded file
 */
export async function downloadFromStorage(
  storagePath: string,
  destDir: string,
): Promise<string> {
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);

  // Verify the file exists
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`File not found in Storage: ${storagePath}`);
  }

  // Create destination directory
  await mkdir(destDir, { recursive: true });

  // Extract filename from storage path
  const filename = storagePath.split("/").pop() ?? "model.stl";
  const destPath = join(destDir, filename);

  // Download the file
  await file.download({ destination: destPath });

  // Verify the downloaded file
  const fileInfo = await stat(destPath);
  if (fileInfo.size === 0) {
    throw new Error(`Downloaded file is empty: ${destPath}`);
  }

  return destPath;
}

/**
 * Get file metadata from Firebase Storage.
 */
export async function getStorageFileMetadata(storagePath: string) {
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);

  const [metadata] = await file.getMetadata();
  return {
    name: metadata.name,
    size: parseInt(String(metadata.size ?? "0"), 10),
    contentType: metadata.contentType,
    timeCreated: metadata.timeCreated,
  };
}

/**
 * Upload a file to Firebase Storage.
 */
export async function uploadToStorage(
  storagePath: string,
  localPath: string,
  contentType?: string,
): Promise<void> {
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);

  await bucket.upload(localPath, {
    destination: file,
    contentType,
  });
}
