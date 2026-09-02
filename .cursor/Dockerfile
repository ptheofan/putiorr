# syntax=docker/dockerfile:1

# Cloud Agent base image for putiorr development.
#
# putiorr requires Node.js >= 24 (see package.json "engines") because it relies
# on the stable node:sqlite API (DatabaseSync). Cursor's default image ships
# Node 22, so the toolchain is pinned to Node 24 here. Debian bookworm on
# x86_64 is used for broad compatibility.
FROM node:24-bookworm-slim

# Keep corepack fully non-interactive so the install step never blocks on a
# download prompt.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# git and curl support repository operations and general tooling;
# ca-certificates provides TLS roots for outbound requests. corepack exposes the
# pnpm version pinned in package.json ("packageManager").
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Pre-fetch the pinned pnpm for the runtime user so the install step is fast and
# does not need to download the package manager on first use.
USER node
RUN corepack prepare pnpm@10.33.0 --activate
