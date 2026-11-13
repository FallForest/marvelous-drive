# Marvelous Drive - single image, no build step.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400 \
    DRIVE_DATA_DIR=/data

COPY package.json pnpm-workspace.yaml ./
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
