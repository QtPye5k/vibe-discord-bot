ARG LOCAL_WHISPER_MODEL=Xenova/whisper-tiny.en
FROM node:24-bookworm-slim AS build
ARG LOCAL_WHISPER_MODEL
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
COPY web ./web
COPY scripts/build-web.mjs ./scripts/build-web.mjs
COPY scripts/prepare-voice.ts ./scripts/prepare-voice.ts
# Prepare the selected local recognizer without copying host caches or credentials into the image.
RUN pnpm build && LOCAL_WHISPER_MODEL="$LOCAL_WHISPER_MODEL" pnpm voice:prepare && pnpm prune --prod

FROM node:24-bookworm-slim
ARG LOCAL_WHISPER_MODEL
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HEALTH_HOST=0.0.0.0 HEALTH_PORT=3000 DATABASE_PATH=/app/data/bot.sqlite LOCAL_WHISPER_MODEL=${LOCAL_WHISPER_MODEL}
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/.cache/models ./.cache/models
COPY scripts/start.mjs ./scripts/start.mjs
RUN mkdir -p /app/data && chown node:node /app/data /app/.cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start.mjs"]
