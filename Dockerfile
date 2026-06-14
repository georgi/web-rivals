# Single-container build + run for Web Rivals.
#
# One Node process serves the built client (static files) AND the authoritative
# game WebSocket on a single port. Nothing else is required: build this image,
# run it, map the port. The client connects its WebSocket back to the same
# origin it was served from, so no URL/env configuration is needed.
#
#   docker build -t web-rivals .
#   docker run -d --restart unless-stopped -p 80:8080 --name web-rivals web-rivals
#
# Then browse to http://<your-hetzner-host>/ . Put it behind a TLS-terminating
# reverse proxy (Caddy/nginx/Traefik) for https:// — the client auto-selects
# wss:// when the page is served over https, so no extra config there either.

FROM node:22-slim

WORKDIR /app

# Install ALL workspace deps first (better layer caching). Dev deps are included
# on purpose: the server runs its TypeScript directly via tsx, and the client
# build needs vite. The shared package is consumed as TS source by both.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
COPY tools/package.json tools/
RUN npm ci

# Copy the sources and build the client (-> client/dist). WS_URL is left unset,
# so the bundle defaults to same-origin and the production build drops the
# dev-only latency gate.
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Port the server listens on inside the container. Map it on the host as needed.
ENV PORT=8080
EXPOSE 8080

# Start the authoritative server; it serves client/dist + the WS on $PORT.
# (start:once = tsx without the dev file-watcher.)
CMD ["npm", "run", "start:once", "-w", "@rivals/server"]
