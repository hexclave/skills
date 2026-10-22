FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --filter @acme/dashboard
WORKDIR /app/apps/dashboard
ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "src/server.ts"]
