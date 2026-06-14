FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @app/agent...
RUN pnpm -r --filter @app/agent... build

FROM node:20-slim
WORKDIR /repo
COPY --from=build /repo /repo
ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/agent/dist/main.js"]
