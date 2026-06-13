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

COPY src ./src

RUN mkdir -p /data/putiorr-config /putiorr /movies /series /music \
  && chown -R node:node /data /putiorr /movies /series /music

USER node

EXPOSE 9091

CMD ["pnpm", "run", "dev"]

FROM base AS production
ENV NODE_ENV=production

COPY --from=prod-deps /app ./
COPY src ./src

RUN mkdir -p /data/putiorr-config /putiorr /movies /series /music \
  && chown -R node:node /data /putiorr /movies /series /music

USER node

EXPOSE 9091

CMD ["pnpm", "start"]
