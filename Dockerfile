# syntax=docker/dockerfile:1

# Build: installs devDependencies (vite, svelte-kit, …) and produces the bundled server.
FROM node:24-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS build
# node 24.21.0 (>=24.18.1 fixes CVE-2026-58041 in node:sqlite, see package.json "engines")
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: only build/. adapter-node bundles every dependency into it (no "dependencies"
# entry in package.json), so no npm install or node_modules are needed here.
FROM node:24-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS runtime
WORKDIR /app
COPY --from=build /app/build ./build

# Runs as the image's built-in non-root "node" user (uid/gid 1000) instead of creating one.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node

# STUDIO_DATA_DIR matches the volume below. HOST defaults to 0.0.0.0 here (unlike bare metal):
# the container's network namespace is already the isolation boundary, so binding wide open
# inside it needs no extra config — what actually controls reachability from the host is the
# -p publish address (see README "Container"). PORT/ORIGIN stay optional; ORIGIN is only
# required for login/setup (hooks.server.ts logs the exact fix when it's missing).
ENV STUDIO_DATA_DIR=/data
ENV HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 3000

# /login is public and answers even before an owner exists (redirects to /setup) — no token needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/login`).then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "build"]
