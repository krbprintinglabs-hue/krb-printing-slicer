/**
 * Supabase Storage access (server-side only).
 *
 * Talks to the Supabase Storage REST API directly with built-in fetch —
 * no additional npm dependency. Objects in the private bucket are
 * downloaded using the service role key, which is transmitted ONLY in
 * request headers from trusted environments (this worker / GitHub Actions).
 * The key is never logged, never placed in URLs, and never exposed to
 * any browser client.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { config } from "./config.js";

/** Hard cap for a single model download (STL/3MF files are modest sized). */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Build the Storage REST URL for an object.
 *
 * Pure helper (no config access) so it can be unit-tested offline.
 * Each object-path segment is URI-encoded individually.
 */
export function buildSupabaseObjectUrl(
  baseUrl: string,
  bucket: string,
  objectPath: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const encodedPath = objectPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
}

/**
 * Download an object from the private Supabase Storage bucket to disk.
 *
 * @param storagePath - Object path from TRUSTED Firestore job metadata
 *   (sliceJobs/{jobId}.storagePath), never from arbitrary browser input.
 *   A leading segment equal to the configured bucket name (legacy Firebase-
 *   style paths such as "custom-prints/{ownerId}/{uploadId}/model.stl") is
 *   tolerated and stripped.
 * @param destDir - Local directory the file is written to.
 * @returns Full path of the downloaded file.
 */
export async function downloadFromSupabase(
  storagePath: string,
  destDir: string,
): Promise<string> {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    throw new Error(
      "Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)",
    );
  }

  // Normalize the path. It originates from trusted Firestore metadata, but
  // traversal segments are rejected unconditionally.
  const segments = storagePath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid storage path`);
  }

  // Tolerate paths that embed the bucket as their first segment.
  if (config.supabaseBucket && segments[0] === config.supabaseBucket) {
    segments.shift();
  }

  if (segments.length === 0) {
    throw new Error(`Invalid storage path`);
  }

  const objectPath = segments.join("/");
  const url = buildSupabaseObjectUrl(
    config.supabaseUrl,
    config.supabaseBucket,
    objectPath,
  );

  await mkdir(destDir, { recursive: true });

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        // Service key is sent only here — never in query strings or logs.
        Authorization: `Bearer ${config.supabaseServiceKey}`,
        apikey: config.supabaseServiceKey,
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `timed out after ${DOWNLOAD_TIMEOUT_MS}ms`
        : "network request failed";
    throw new Error(`Supabase Storage download ${reason}`);
  }

  if (!response.ok) {
    // Drain the body to release the connection. Never surface headers,
    // the Authorization value, or response internals in errors.
    try {
      await response.text();
    } catch {
      // ignore drain errors
    }
    if (response.status === 400 || response.status === 404) {
      // Message substring stays compatible with index.ts classification
      // ("File not found" -> FILE_NOT_FOUND).
      throw new Error(`File not found in Storage: ${storagePath}`);
    }
    throw new Error(
      `Supabase Storage download failed with status ${response.status}`,
    );
  }

  if (!response.body) {
    throw new Error("Supabase Storage returned an empty response body");
  }

  // Local filename = decoded last segment (path separators cannot occur
  // inside a single segment).
  const lastSegment = segments[segments.length - 1];
  let filename = lastSegment;
  try {
    filename = decodeURIComponent(lastSegment);
  } catch {
    // Malformed encoding — keep the raw segment as the filename.
  }

  const destPath = join(destDir, filename);

  // Stream to disk so large models never sit fully in memory.
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
    createWriteStream(destPath),
  );

  return destPath;
}
