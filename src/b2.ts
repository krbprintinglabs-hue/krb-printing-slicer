/**
 * Backblaze B2 storage access (server-side only).
 *
 * Talks to B2 through its S3-compatible API (@aws-sdk/client-s3).
 * Jobs created by the website may reference models as `b2:<path>` where the
 * `b2:` prefix is ONLY a backend marker — it is stripped before any S3/B2
 * operation. The key ID / application key are transmitted ONLY in the
 * SigV4-signed request from trusted environments (this worker /
 * GitHub Actions). Credentials are never logged, never placed in URLs, and
 * never exposed to any browser client.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { config } from "./config.js";

/** Backend marker prefix on website-generated storage references. */
export const B2_REFERENCE_PREFIX = "b2:";

/** Hard cap for a single model download (STL/3MF files are modest sized). */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * True when a storage reference points at B2 rather than Supabase.
 *
 * Pure helper (no config access) so it can be unit-tested offline.
 */
export function isB2Reference(storagePath: string): boolean {
  return storagePath.trimStart().startsWith(B2_REFERENCE_PREFIX);
}

/**
 * Strip the `b2:` backend marker to obtain the raw object reference,
 * e.g. "b2:custom-prints/<owner>/<uuid>/model.stl" ->
 *       "custom-prints/<owner>/<uuid>/model.stl".
 *
 * Only the leading marker is removed; the remainder is returned verbatim.
 * Pure helper (no config access) so it can be unit-tested offline.
 */
export function stripB2Prefix(storagePath: string): string {
  const trimmed = storagePath.trimStart();
  if (!trimmed.startsWith(B2_REFERENCE_PREFIX)) {
    throw new Error(`Not a B2 storage reference: ${storagePath}`);
  }
  return trimmed.slice(B2_REFERENCE_PREFIX.length);
}

/**
 * Resolve the S3 object key for a B2 reference. The configured bucket may
 * appear as the first path segment (as in website-generated references such
 * as "b2:custom-prints/<owner>/<uuid>/model.stl"); it is dropped and the
 * B2_BUCKET_NAME env value is always used as the bucket.
 *
 * Pure helper (no network) so it can be unit-tested offline.
 */
export function resolveB2Key(
  storagePath: string,
  bucket: string,
): { bucket: string; key: string; filename: string } {
  const withoutPrefix = stripB2Prefix(storagePath);

  // Normalize the remainder. Traversal segments are rejected unconditionally
  // even though the path originates from trusted Firestore metadata.
  const segments = withoutPrefix
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid storage path`);
  }

  // Tolerate references that embed the bucket as their first segment.
  if (bucket && segments[0] === bucket) {
    segments.shift();
  }

  if (segments.length === 0) {
    throw new Error(`Invalid storage path`);
  }

  const lastSegment = segments[segments.length - 1];
  let filename = lastSegment;
  try {
    filename = decodeURIComponent(lastSegment);
  } catch {
    // Malformed encoding — keep the raw segment as the filename.
  }

  return { bucket, key: segments.join("/"), filename };
}

/** Minimal structural type so tests can inject a fake client. */
export interface B2GetObjectClient {
  send(command: GetObjectCommand): Promise<{ Body?: unknown; $metadata?: unknown }>;
}

function createB2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.b2Endpoint,
    credentials: {
      accessKeyId: config.b2KeyId,
      secretAccessKey: config.b2ApplicationKey,
    },
    forcePathStyle: false,
  });
}

/**
 * Download an object from Backblaze B2 to disk.
 *
 * @param storagePath - B2 reference from TRUSTED Firestore job metadata
 *   (sliceJobs/{jobId}.storagePath), e.g. "b2:custom-prints/<ownerId>/<uploadId>/model.stl".
 * @param destDir - Local directory the file is written to.
 * @param clientOverride - Injected S3-compatible client (tests only).
 * @returns Full path of the downloaded file.
 */
export async function downloadFromB2(
  storagePath: string,
  destDir: string,
  clientOverride?: B2GetObjectClient,
): Promise<string> {
  if (!config.b2Endpoint || !config.b2KeyId || !config.b2ApplicationKey || !config.b2BucketName) {
    throw new Error(
      "B2 Storage is not configured (B2_ENDPOINT / B2_KEY_ID / B2_APPLICATION_KEY / B2_BUCKET_NAME missing)",
    );
  }

  const { bucket, key, filename } = resolveB2Key(storagePath, config.b2BucketName);

  const client: B2GetObjectClient = clientOverride ?? createB2Client();

  await mkdir(destDir, { recursive: true });

  let response: { Body?: unknown };
  try {
    response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NoSuchKey" || error.name === "NotFound")
    ) {
      // Message substring stays compatible with index.ts classification
      // ("File not found" -> FILE_NOT_FOUND).
      throw new Error(`File not found in Storage: ${storagePath}`);
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`B2 Storage download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
    }
    throw new Error(
      `B2 Storage download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = response.Body as unknown;
  let source: Readable;
  if (body instanceof Readable) {
    source = body;
  } else if (
    body !== null &&
    typeof body === "object" &&
    typeof (body as NodeWebReadableStream).getReader === "function"
  ) {
    source = Readable.fromWeb(body as unknown as NodeWebReadableStream);
  } else {
    throw new Error("B2 Storage returned an empty response body");
  }

  const destPath = join(destDir, filename);

  // Stream to disk so large models never sit fully in memory.
  await pipeline(source, createWriteStream(destPath), {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  }).catch((error: unknown) => {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `timed out after ${DOWNLOAD_TIMEOUT_MS}ms`
        : "stream failed";
    throw new Error(`B2 Storage download ${reason}`);
  });

  return destPath;
}
