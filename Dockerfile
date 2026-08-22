# KRB PrusaSlicer Worker — Local Development
#
# This Dockerfile is for local development/testing only.
# Production slicing runs on GitHub Actions ubuntu-latest runners.
#
# Build:  docker build -t krb-slicer -f worker/Dockerfile worker/
# Run:    docker run --rm -e FIREBASE_PROJECT_ID=... -v /path/to/sa.json:/sa.json krb-slicer <jobId>

# ── Stage 1: Build ──────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: PrusaSlicer (community AppImage for x86_64) ───────────
FROM ubuntu:22.04 AS slicer

RUN apt-get update && apt-get install -y \
    curl fuse libfuse2 \
    && rm -rf /var/lib/apt/lists/*

ARG PRUSASLICER_APPIMAGE_URL="https://github.com/gneiss15/PrusaSlicer.AppImage/releases/download/2.9.6/PrusaSlicer-2.9.6-x86_64_GN.AppImage"

RUN curl -L -o /tmp/prusaslicer.AppImage "${PRUSASLICER_APPIMAGE_URL}" \
    && chmod +x /tmp/prusaslicer.AppImage \
    && /tmp/prusaslicer.AppImage --appimage-extract --dest /opt \
    && rm /tmp/prusaslicer.AppImage

# ── Stage 3: Runtime ────────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx libglib2.0-0 libfontconfig1 \
    libxrender1 libdbus-1-3 libxkbcommon0 \
    libxcb-xinerama0 libxcb-cursor0 libxcb-keysyms1 libxcb-shape0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=slicer /opt/squashfs-root /opt/prusaslicer
RUN ln -s /opt/prusaslicer/usr/bin/prusa-slicer /usr/local/bin/prusaslicer

RUN mkdir -p /tmp/krb-slicer

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV SLICER_PATH=prusaslicer
ENV TEMP_DIR=/tmp/krb-slicer

ENTRYPOINT ["node", "dist/index.js"]
