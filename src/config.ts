/**
 * Worker configuration.
 *
 * All configuration comes from environment variables.
 * No secrets are hardcoded.
 */

export const config = {
  /** Path to PrusaSlicer CLI binary. */
  slicerPath: process.env.SLICER_PATH ?? "prusa-slicer",

  /** Maximum time (ms) a single PrusaSlicer execution can run. */
  sliceTimeoutMs: parseInt(process.env.SLICE_TIMEOUT_MS ?? "300000", 10),

  /** Base directory for temporary job processing. */
  tempBaseDir: process.env.TEMP_DIR ?? "/tmp/krb-slicer",

  /** Worker identifier for logging and job tracking. */
  workerId: process.env.WORKER_ID ?? process.env.GITHUB_RUN_ID ?? `local-${process.pid}`,

  /** Firebase project ID (from service account or env). */
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "",

  /** Path to Firebase service account credentials JSON. */
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "",
} as const;

/**
 * Validate that all required configuration is present.
 * Returns an array of missing variable names.
 */
export function validateConfig(): string[] {
  const missing: string[] = [];

  if (!config.slicerPath) missing.push("SLICER_PATH");
  if (!config.firebaseProjectId && !config.firebaseServiceAccountPath) {
    missing.push("FIREBASE_PROJECT_ID or FIREBASE_SERVICE_ACCOUNT_PATH");
  }

  return missing;
}
