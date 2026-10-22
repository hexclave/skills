FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .
ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "src/server.ts"]
