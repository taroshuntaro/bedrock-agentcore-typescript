FROM node:20-slim
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @app/agent...
ENV PORT=8080
EXPOSE 8080
# tsx でソースを直接実行する。コンパイル方式だと ESM の拡張子付き相対 import や
# ワークスペース依存（@app/contract）の dist 解決など追加調整が必要になるため、
# PoC ではソースをそのまま tsx 実行する方式を採用している。
CMD ["pnpm", "--filter", "@app/agent", "exec", "tsx", "src/main.ts"]
