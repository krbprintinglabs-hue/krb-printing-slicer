/**
 * Cleanup service.
 *
 * In GitHub Actions mode, each runner is ephemeral — temp files are
 * automatically removed when the job completes. This module exists
 * only for local development where temp files may accumulate.
 */

import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Clean up temp directories older than maxAgeMs.
 * Only useful during local development.
 */
export async function cleanupStaleTempDirs(maxAgeMs: number = 3600000): Promise<number> {
  let cleaned = 0;

  try {
    const entries = await readdir(config.tempBaseDir);
    const now = Date.now();

    for (const entry of entries) {
      const entryPath = join(config.tempBaseDir, entry);

      try {
        const entryStat = await stat(entryPath);

        if (!entryStat.isDirectory()) continue;

        const age = now - entryStat.mtimeMs;
        if (age > maxAgeMs) {
          await rm(entryPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // TEMP_DIR might not exist yet — that's fine
  }

  return cleaned;
}
