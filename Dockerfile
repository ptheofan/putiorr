# syntax=docker/dockerfile:1

FROM node:24-alpine AS base

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml ./

FROM base AS prod-deps
RUN pnpm install --prod --frozen-lockfile

FROM base AS dev-deps
RUN pnpm install --frozen-lockfile

FROM dev-deps AS dev
ENV NODE_ENV=development
ARG PUTIORR_PUTIO_APP_ID=9354
ARG PUTIORR_PUTIO_OAUTH_RELAY_URL=https://ptheofan.github.io/putiorr/putio-oauth-relay.html
ENV PUTIORR_PUTIO_APP_ID=$PUTIORR_PUTIO_APP_ID
ENV PUTIORR_PUTIO_OAUTH_RELAY_URL=$PUTIORR_PUTIO_OAUTH_RELAY_URL

COPY src ./src

RUN mkdir -p /data/putiorr-config /putiorr /movies /series /music \
  && chown -R node:node /data /putiorr /movies /series /music

USER node

EXPOSE 9091

CMD ["pnpm", "run", "dev"]

FROM base AS production
ENV NODE_ENV=production
ARG PUTIORR_PUTIO_APP_ID=9354
ARG PUTIORR_PUTIO_OAUTH_RELAY_URL=https://ptheofan.github.io/putiorr/putio-oauth-relay.html
ENV PUTIORR_PUTIO_APP_ID=$PUTIORR_PUTIO_APP_ID
ENV PUTIORR_PUTIO_OAUTH_RELAY_URL=$PUTIORR_PUTIO_OAUTH_RELAY_URL

COPY --from=prod-deps /app ./
COPY src ./src

RUN mkdir -p /data/putiorr-config /putiorr /movies /series /music \
  && chown -R node:node /data /putiorr /movies /series /music

USER node

EXPOSE 9091

CMD ["pnpm", "start"]
