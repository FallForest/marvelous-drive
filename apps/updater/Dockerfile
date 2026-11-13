# Marvelous Drive update agent.
#
# Build from the repository root so the script path resolves:
#   docker build -f apps/updater/Dockerfile -t marvelous-drive-updater:local .
#
# The agent is one file with no dependencies, so there is no install step: the
# image only needs an HTTP runtime plus the docker CLI it shells out to.
FROM node:24-alpine
RUN apk add --no-cache bash docker-cli docker-cli-compose
WORKDIR /app
COPY apps/updater/update-agent.mjs ./update-agent.mjs
CMD ["node", "update-agent.mjs"]
