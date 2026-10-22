# Build context = the upload root (this directory). deploy.sh copies the app into ./app first.
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY app/package.json app/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY app/ ./
RUN pnpm build && pnpm prune --prod --ignore-workspace

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build /app/package.json /app/server.mjs ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
