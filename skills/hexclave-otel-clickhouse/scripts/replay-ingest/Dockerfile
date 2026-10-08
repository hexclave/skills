FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
