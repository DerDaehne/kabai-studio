# syntax=docker/dockerfile:1

# Build: installs devDependencies (vite, svelte-kit, …) and produces the bundled server.
FROM node:24-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS build
# node 24.21.0 (>=24.18.1 fixes CVE-2026-58041 in node:sqlite, see package.json "engines")
WORKDIR /app
# Baked into build/ by vite.config.ts's `define` (src/lib/version.ts); set by container-image.yml to the pushed
# tag without its "v" prefix, or sha-<short> for an untagged build. Without it, the build would fall back to
# `git describe`, but .git is not in this build context.
ARG STUDIO_VERSION
ENV STUDIO_VERSION=$STUDIO_VERSION
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: build/ plus the entry point. adapter-node bundles every dependency into build/ (no
# "dependencies" entry in package.json), so no npm install or node_modules are needed here.
# server.ts runs under Node's type stripping and statically imports the three source files below,
# which use Node builtins only; every file it imports must be copied here (CI starts the image).
FROM node:24-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS runtime
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src/lib/server/cli.ts /app/src/lib/server/data-dir.ts ./src/lib/server/
COPY --from=build /app/src/lib/version.ts ./src/lib/version.ts
# The minified CSS drops the vendored files' licence headers, so the licence texts ship next to it
COPY --from=build /app/LICENSE /app/NOTICE ./

# Runs as the image's built-in non-root "node" user (uid/gid 1000) instead of creating one.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node

# STUDIO_DATA_DIR matches the volume below. HOST defaults to 0.0.0.0 here (unlike bare metal):
# the container's network namespace is already the isolation boundary, so binding wide open
# inside it needs no extra config — what actually controls reachability from the host is the
# -p publish address (see README "Container"). PORT stays optional; ORIGIN is required for this
# non-loopback HOST — server.ts exits with the exact fix instead of starting half-broken. Set it
# to the address the browser will actually use (the reverse proxy's public origin, or
# http://<host>:<port> for a direct publish).
ENV STUDIO_DATA_DIR=/data
ENV HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 3000

# /api/health is public and answers once the database has opened — no session needed (see hooks.server.ts).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.ts"]
