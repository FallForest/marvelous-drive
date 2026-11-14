# Marvelous Drive - single image, no build step.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400 \
    DRIVE_DATA_DIR=/data

# Manifests first, on their own: the dependency layer must not be invalidated
# by a source edit, which is the whole reason it is a separate RUN.
COPY package.json package-lock.json pnpm-workspace.yaml ./

# The HEIC decoder is an optionalDependency: without this line the image runs
# fine but every .heic answers 503, because heif-loader.js resolves libheif-js
# at runtime. `npm ci` rather than `npm install`: the lockfile pins the decoder
# to the version the notice in apps/server/THIRD-PARTY.md is written against,
# and it installs from a manifest that lists no other runtime dependency.
RUN npm ci --omit=dev --no-audit --no-fund

COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY packages/cli ./packages/cli
COPY docs ./docs

RUN mkdir -p /data/blobs /data/tmp
VOLUME ["/data"]
EXPOSE 4400

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.js"]
