/**
 * Worker configuration.
 *
 * All configuration comes from environment variables.
 * No secrets are hardcoded.
 */

export const config = {
  /** Slicing backend: "bambu" (default); "prusa" = emergency fallback. */
  slicerBackend: (process.env.SLICER_BACKEND ?? "bambu").toLowerCase(),

  /** Path to PrusaSlicer CLI binary (prusa backend) or Bambu CLI (bambu backend). */
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

  /** Supabase project URL (e.g. https://<project>.supabase.co). */
  supabaseUrl: process.env.SUPABASE_URL ?? "",

  /** Supabase service key — server-side only, never exposed to browsers. */
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY ?? "",

  /** Private Supabase Storage bucket holding uploaded models. */
  supabaseBucket: process.env.SUPABASE_BUCKET ?? "custom-prints",
} as const;

/**
 * Validate that all required configuration is present.
 * Returns an array of missing variable names.
 */
export function validateConfig(): string[] {
  const missing: string[] = [];

  if (!config.slicerPath) missing.push("SLICER_PATH");
  if (config.slicerBackend !== "prusa" && config.slicerBackend !== "bambu") {
    missing.push("SLICER_BACKEND (must be 'prusa' or 'bambu')");
  }
  if (!config.firebaseProjectId && !config.firebaseServiceAccountPath) {
    missing.push("FIREBASE_PROJECT_ID or FIREBASE_SERVICE_ACCOUNT_PATH");
  }
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceKey) missing.push("SUPABASE_SERVICE_KEY");
  if (!config.supabaseBucket) missing.push("SUPABASE_BUCKET");

  return missing;
}
