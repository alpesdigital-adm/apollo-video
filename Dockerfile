ARG APOLLO_BUILD_REVISION=local

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY remotion/package.json remotion/package-lock.json ./remotion/
COPY scripts/generate-prisma-clients.mjs ./scripts/generate-prisma-clients.mjs
RUN npm ci && npm ci --prefix remotion

FROM node:22-bookworm-slim AS build

ARG APOLLO_BUILD_REVISION

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    APOLLO_BUILD_REVISION=$APOLLO_BUILD_REVISION

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/generated ./generated
COPY --from=dependencies /app/remotion/node_modules ./remotion/node_modules
COPY . .
RUN mkdir -p public \
    && npm run remotion:build \
    && cd remotion \
    && node -e "require('@remotion/renderer').ensureBrowser({logLevel:'error'}).catch((error)=>{console.error(error);process.exit(1)})" \
    && cd .. \
    && npm run build

FROM node:22-bookworm-slim AS runtime

ARG APOLLO_BUILD_REVISION

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    APOLLO_BUILD_REVISION=$APOLLO_BUILD_REVISION \
    HOSTNAME=0.0.0.0 \
    PORT=3333

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libnss3 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/generated ./generated
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/remotion ./remotion

RUN mkdir -p /app/tmp /app/artifacts /app/render-outputs \
    && chown -R node:node /app/tmp /app/artifacts /app/render-outputs

USER node
EXPOSE 3333

CMD ["npm", "run", "start"]
