# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript and keep only production dependencies ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Native modules (better-sqlite3) fall back to compiling when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- whisper.cpp: local speech-to-text, built on the machine that runs it so it uses that CPU's features ----
FROM node:22-bookworm-slim AS whisper
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.7.5 https://github.com/ggml-org/whisper.cpp /whisper
WORKDIR /whisper
RUN cmake -B build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build build -j2 --config Release --target whisper-cli

# ---- runtime stage ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
# ffmpeg also provides ffprobe. tini reaps the ffmpeg child processes cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=whisper /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node brand-assets ./brand-assets
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
