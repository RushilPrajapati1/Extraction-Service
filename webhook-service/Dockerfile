# Node 24 runs .ts directly (type stripping) and ships node:sqlite, so
# there is no build step and no native module to compile.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV WEBHOOK_DB_PATH=/data/webhooks.db \
    PORT=8787

EXPOSE 8787
CMD ["node", "src/index.ts"]
