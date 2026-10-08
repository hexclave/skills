# replay-ingest for Hexclave Deployments. The remote builder ALWAYS uses the upload root as the
# Docker build context (rootDirectory only locates the Dockerfile), so paths are root-relative.
# For a standalone `docker build scripts/replay-ingest`, use scripts/replay-ingest/Dockerfile.
FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY replay-ingest/package.json replay-ingest/tsconfig.json ./
COPY replay-ingest/src ./src
ENV NODE_ENV=production PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
