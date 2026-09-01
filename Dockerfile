# ---- Base Node ----
FROM node:20-slim AS base
WORKDIR /app
RUN npm install -g npm@11.15.0 --ignore-scripts

# ---- Dependencies ----
FROM base AS dependencies
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# # ---- Client Build Stage ----
# FROM base AS client-build
# WORKDIR /app
# # Copy client package files first to leverage Docker cache
# COPY client/package*.json ./client/
# RUN cd client && npm ci
# # Copy client source code and build it
# COPY client/ ./client/
# RUN cd client && npm run build

# ---- Client Build Stage ----
FROM base AS client-build
WORKDIR /app/client

# Copy package configurations first for caching
COPY client/package*.json ./
RUN npm ci

# Copy ALL client source files (including public/ and src/)
COPY client/ ./

# Run the build tool inside the proper directory
RUN npm run build

# ---- Build ----
FROM base AS build
# FIX: Explicitly set working directory so files land in /app
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
# Copy server code
COPY server/ ./server/
COPY migrations/ ./migrations/
# Pull the compiled React app from the client-build stage
COPY --from=client-build /app/client/build/ ./client/build/

# ---- Apprise ----
FROM python:3.11-slim AS apprise
RUN pip install --no-cache-dir --target=/opt/apprise apprise

# ---- Release ----
FROM node:20-slim AS release
WORKDIR /app

# Install runtime dependencies
#
# intel-media-va-driver-non-free, libmfx-gen1.2, libva2, libva-drm2,
# vainfo: userspace VAAPI/QSV driver stack for ytstream's
# mode=ffmpeg&transcode=h264&hardware=qsv (see server/routes/ytstream.js
# buildVideoEncoderArgs()). Without these, ffmpeg's
# `-init_hw_device vaapi=...` / `qsv=...` calls fail even though
# docker-compose.yaml passes /dev/dri through — the render node being
# present is not enough, ffmpeg also needs a driver that can talk to it.
#
# Uses the non-free driver (not the open-source intel-media-va-driver) —
# confirmed via `vainfo` that this host's Intel iGPU needs it. Debian's
# contrib/non-free/non-free-firmware components aren't enabled by
# default, and the base image may list its repos either in the newer
# DEB822 format (/etc/apt/sources.list.d/debian.sources) or the legacy
# single-file /etc/apt/sources.list depending on which Debian release
# the node:20-slim tag currently tracks, so both are handled here.
#
# fonts-dejavu-core: provides /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf,
# used by ensurePlaceholderSegment's drawtext filter (the "Loading..." text
# drawn over a video's own thumbnail for ytstream.instantStart). Referenced
# by exact fontfile= path, not through fontconfig, so no fontconfig cache
# setup is needed - just this file being present.
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i '/^Components:/ s/$/ contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
        sed -i '/^deb /s/ main$/ main contrib non-free non-free-firmware/' /etc/apt/sources.list; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    atomicparsley \
    curl \
    unzip \
    python3 \
    ca-certificates \
    intel-media-va-driver-non-free \
    libmfx-gen1.2 \
    libva2 \
    libva-drm2 \
    vainfo \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Download the latest yt-dlp release
RUN mkdir -p /opt/yt-dlp && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/yt-dlp/yt-dlp && \
    chmod 0777 /opt/yt-dlp /opt/yt-dlp/yt-dlp
ENV PATH="/opt/yt-dlp:${PATH}"

# Install Deno
ENV DENO_INSTALL="/usr/local"
RUN curl -fsSL https://deno.land/install.sh | sh

# Copy Apprise from builder stage
COPY --from=apprise /opt/apprise /opt/apprise
ENV PYTHONPATH="/opt/apprise"

# Create apprise wrapper
RUN printf '#!/bin/sh\nexec python3 -c "from apprise.cli import main; main()" "$@"\n' > /usr/local/bin/apprise && \
    chmod +x /usr/local/bin/apprise

# Copy production node_modules
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application files (These will now resolve cleanly)
COPY --from=build /app/server ./server
COPY --from=build /app/client/build ./client/build
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json

# Copy config.example.json to server directory
COPY config/config.example.json /app/server/config.example.json

# Copy the new simplified entrypoint script
COPY scripts/docker-entrypoint-simple.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3011
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl --fail --silent --show-error --output /dev/null http://localhost:3011/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
