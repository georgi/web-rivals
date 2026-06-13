# Web Rivals — authoritative game server (PRD §3 hosting note, §21.3).
#
# The server is a PERSISTENT Node process (in-memory rooms, fixed-tick sim) — it
# must NOT run on serverless/edge. This image runs `server/src/index.ts` with tsx
# (no build step: shared/ and server/ are consumed as TypeScript directly).
#
# Build context is the MONOREPO ROOT, not server/. From the repo root:
#   docker build -f server/Dockerfile -t web-rivals-server .
#   docker run --rm -p 8080:8080 web-rivals-server
#
# Honors $PORT (default 8080). Fly.io sets PORT via [env] in fly.toml.

FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# --- dependency layer -------------------------------------------------------
# Copy only what npm needs to resolve the workspace graph first, so changes to
# server source don't bust the install cache. We need the root manifest + lock
# and every workspace package.json referenced by the root `workspaces` globs
# (npm validates the whole graph even when we only run the server).
COPY package.json package-lock.json ./
COPY shared/package.json   ./shared/package.json
COPY server/package.json   ./server/package.json
COPY client/package.json   ./client/package.json
COPY tools/package.json    ./tools/package.json

# `npm ci` against the committed lockfile = reproducible installs. We keep dev
# deps because tsx (the runtime) and typescript live in the ROOT devDependencies.
# --ignore-scripts is safe here: no workspace has a meaningful install/postinstall.
RUN npm ci --ignore-scripts

# --- source layer -----------------------------------------------------------
# Only the code the server actually executes at runtime: shared (imported as
# @rivals/shared) and the server itself. Client/tools source is never loaded.
COPY shared ./shared
COPY server ./server

# --- runtime ----------------------------------------------------------------
# node:22-slim already ships a non-root `node` user (uid 1000). Drop privileges.
USER node

EXPOSE 8080

# Run tsx directly (NOT `tsx watch` — that's the dev script and restarts on file
# changes). `npx tsx` resolves the binary from the installed devDependency.
CMD ["npx", "tsx", "server/src/index.ts"]
