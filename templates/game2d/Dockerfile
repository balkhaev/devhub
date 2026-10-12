FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN bun run build

FROM oven/bun:1-slim AS production
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/dist ./dist
COPY server.ts ./
COPY server ./server
USER bun
EXPOSE 3000
CMD ["bun", "server.ts"]
