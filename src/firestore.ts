/**
 * Firestore operations using Firebase Admin SDK.
 *
 * Handles:
 * - Firebase Admin initialization
 * - Atomic job claiming (prevents duplicate processing)
 * - Job status updates
 * - Job result storage
 */

import { initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { config } from "./config.js";

let app: App | undefined;
let db: Firestore | undefined;

/* ── Initialization ─────────────────────────────────────────────────── */

export async function initializeFirestore(): Promise<Firestore> {
  if (db) return db;

  const serviceAccountPath = config.firebaseServiceAccountPath;

  if (serviceAccountPath) {
    // Load service account from file
    const { readFileSync } = await import("node:fs");
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));
    app = initializeApp({
      credential: cert(serviceAccount),
      projectId: config.firebaseProjectId || serviceAccount.project_id,
    });
  } else {
    // Use Application Default Credentials (ADC)
    // On GitHub Actions, GOOGLE_APPLICATION_CREDENTIALS is set by the workflow
    app = initializeApp({
      projectId: config.firebaseProjectId,
    });
  }

  db = getFirestore(app);

  // Verify connection
  await db.listCollections();

  return db;
}

export function getDb(): Firestore {
  if (!db) throw new Error("Firestore not initialized. Call initializeFirestore() first.");
  return db;
}

/* ── Types ──────────────────────────────────────────────────────────── */

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface SliceJobData {
  userId: string;
  uploadId: string;
  storagePath: string;
  fileType: string;
  material: string;
  quality: string;
  status: JobStatus;
  result: unknown | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  // Worker fields (added during processing)
  startedAt?: number;
  workerId?: string;
}

export interface SliceJob extends SliceJobData {
  id: string;
}

/* ── Job Operations ─────────────────────────────────────────────────── */

const JOBS_COLLECTION = "sliceJobs";

/**
 * Atomically claim a specific job by ID.
 *
 * Uses a Firestore transaction to ensure the job is only claimed once.
 * The job transitions from "queued" to "processing" with worker identification.
 *
 * Returns the claimed job, or null if the job is not claimable
 * (already processing, completed, failed, or not found).
 */
export async function claimJob(
  jobId: string,
  workerId: string,
): Promise<SliceJob | null> {
  const firestore = getDb();
  const docRef = firestore.collection(JOBS_COLLECTION).doc(jobId);

  const result = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);

    if (!snapshot.exists) return null;

    const data = snapshot.data() as SliceJobData;

    // Only claim jobs that are queued
    if (data.status !== "queued") return null;

    // Claim the job
    const now = Date.now();
    transaction.update(docRef, {
      status: "processing",
      startedAt: now,
      workerId,
      updatedAt: now,
    });

    return {
      id: snapshot.id,
      ...data,
      status: "processing" as JobStatus,
      startedAt: now,
      workerId,
    };
  });

  return result;
}

/**
 * Mark a job as completed with results.
 */
export async function completeJob(
  jobId: string,
  result: unknown,
): Promise<void> {
  const firestore = getDb();
  const now = Date.now();

  await firestore.collection(JOBS_COLLECTION).doc(jobId).update({
    status: "completed",
    result,
    completedAt: now,
    updatedAt: now,
  });
}

/**
 * Mark a job as failed with error details.
 */
export async function failJob(
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const firestore = getDb();
  const now = Date.now();

  await firestore.collection(JOBS_COLLECTION).doc(jobId).update({
    status: "failed",
    error: JSON.stringify({
      code: errorCode,
      message: errorMessage,
      failedAt: now,
    }),
    completedAt: now,
    updatedAt: now,
  });
}

/* ── End of Job Operations ────────────────────────────────────────── */
