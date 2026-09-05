# KRB PrusaSlicer Worker

Headless 3D model slicing worker. Runs as a short-lived GitHub Actions job — no permanent server required.

## Architecture

```
Customer -> KRB Website -> Firestore (sliceJobs)
                                |
                    GitHub Actions workflow_dispatch
                                |
                    Fresh Ubuntu runner (x64, 4 CPU, 16GB RAM)
                                |
                    Download STL/3MF from private Supabase Storage
                                |
                    PrusaSlicer CLI (headless)
                                |
                    Write results to Firestore
                                |
                    Website reads result
```

**No permanent server. No Oracle Cloud. No polling loop.**

Each slicing request triggers a fresh GitHub Actions job. The runner is destroyed after completion.

## GitHub Actions Setup

### 1. Repository

The worker code lives in a **public** GitHub repository (required for free/unlimited runners).

Recommended: `krb-printing-slicer`

### 2. Repository Secrets

Set these in GitHub -> Settings -> Secrets and variables -> Actions:

| Secret | Description |
|--------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | Contents of your Firebase service account JSON (the entire JSON, not a path) — used for Firestore job access |
| `FIREBASE_PROJECT_ID` | Your Firebase project ID |
| `SUPABASE_URL` | Your Supabase project URL (e.g. `https://<project>.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase service key — server-side only, never exposed to the browser |
| `B2_ENDPOINT` | Backblaze B2 S3-compatible endpoint (e.g. `https://s3.us-west-004.backblazeb2.com`) |
| `B2_KEY_ID` | Backblaze B2 S3 key ID — server-side only, never exposed to the browser |
| `B2_APPLICATION_KEY` | Backblaze B2 S3 application key — server-side only, never exposed to the browser |
| `B2_BUCKET_NAME` | Backblaze B2 bucket holding uploaded models |

The storage bucket is not a secret: the workflow passes `SUPABASE_BUCKET=custom-prints` to the worker.

## Model Storage Backends

The worker downloads the job's model from one of two backends, selected per
job by the `storagePath` prefix in the Firestore `sliceJobs` document:

| storagePath | Backend |
|-------------|---------|
| `b2:custom-prints/<owner>/<upload>/model.stl` | Backblaze B2 (S3-compatible API) |
| `<owner>/<upload>/model.stl` (no prefix) | Supabase Storage (legacy) |

The `b2:` prefix is only a backend marker: it is stripped before any S3
operation, i.e. `b2:custom-prints/foo/bar.3mf` is fetched as object key
`custom-prints/foo/bar.3mf` (with a leading bucket segment tolerated and
stripped, so in practice the key sent is `foo/bar.3mf` against
`B2_BUCKET_NAME`). Legacy Supabase references keep working unchanged.

### 3. Website Server Environment Variables

Set these on your Next.js server (NOT in `NEXT_PUBLIC_`):

| Variable | Description |
|----------|-------------|
| `GITHUB_SLICER_TOKEN` | GitHub PAT with `actions:write` scope on the slicer repo |
| `GITHUB_SLICER_REPO` | Repository in `owner/repo` format (e.g., `krb-printing/krb-printing-slicer`) |

### 4. Workflow File

The workflow is at `.github/workflows/slice.yml` in the slicer repository.

## PrusaSlicer Installation

The workflow uses the **community AppImage build** from `gneiss15/PrusaSlicer.AppImage`:

- Version: 2.9.6
- Platform: Linux x86_64
- Method: Download AppImage, extract with `--appimage-extract`
- Cached between runs via `actions/cache`

This is the most reliable headless method since Prusa stopped shipping official Linux AppImages after 2.8.1.

## Quality Profiles

| Preset | Layer Height | Fill Density | Supports | Perimeters |
|--------|-------------|--------------|----------|------------|
| Fast | 0.28mm | 10% | Off | 2 |
| Standard | 0.20mm | 15% | Auto | 2 |
| High-Detail | 0.16mm | 30% | Auto | 3 |

## Materials

| Material | Nozzle Temp | Bed Temp | Print Speed | Retract |
|----------|------------|----------|-------------|---------|
| PLA | 215°C | 60°C | 60mm/s | 0.8mm |
| PETG | 240°C | 80°C | 50mm/s | 1.0mm |
| ABS | 250°C | 100°C | 50mm/s | 1.0mm |

## Local Development

```bash
cd worker
npm install
npm run build

# Run with a test jobId
SLICER_PATH=prusaslicer \
FIREBASE_PROJECT_ID=your-project \
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/sa.json \
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_KEY=your-service-key \
npm run worker -- <jobId>
```

Or via Docker:

```bash
docker build -t krb-slicer -f worker/Dockerfile worker/
docker run --rm \
  -e FIREBASE_PROJECT_ID=your-project \
  -v /path/to/sa.json:/tmp/sa.json:ro \
  -e FIREBASE_SERVICE_ACCOUNT_PATH=/tmp/sa.json \
  krb-slicer <jobId>
```

## Test Mode

To test the full pipeline end-to-end:

1. Upload a test STL to the private Supabase Storage bucket
2. Create a slice job via `POST /api/slice`
3. The website triggers the GitHub Actions workflow
4. Watch the workflow run in GitHub Actions tab
5. Check Firestore `sliceJobs/{jobId}` for the result

## Security

- Customer STL/3MF files live in the private Supabase Storage bucket (`custom-prints`) and are downloaded ephemerally by the worker
- The Supabase service key is only ever sent server-side (GitHub Actions runner -> Supabase); it never reaches the browser, URLs, or logs
- Firebase credentials are GitHub Actions secrets (never in code or logs)
- GitHub token is server-side only (never exposed to browser)
- Model paths come exclusively from trusted Firestore job metadata — never from browser input
- All PrusaSlicer arguments are whitelisted — no user input passed to shell
- Worker uses `spawn()` (not `exec()`) for process execution
- Temporary files are cleaned up after each run

## Files

```
src/
├── config.ts      — Environment configuration
├── firestore.ts   — Admin SDK, atomic job claiming
├── supabase.ts    — Supabase Storage REST download (service key)
├── b2.ts          — Backblaze B2 S3-compatible download (`b2:` references)
├── storage.ts     — Model download layer (B2/Supabase dispatcher)
├── slicer.ts      — PrusaSlicer CLI execution
├── jobs.ts        — Job lifecycle orchestration
├── cleanup.ts     — Temp file cleanup (local dev only)
└── index.ts       — One-shot executor entry point
package.json / tsconfig.json
Dockerfile        — Local dev container

.github/workflows/
└── slice.yml      — GitHub Actions workflow
```
