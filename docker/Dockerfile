# The MultiZen server. No browser engine is in this image: CloakBrowser's license forbids
# redistributing it, so the server downloads it into the /data volume on first start.
#
#   docker compose up -d     (see docker-compose.yml, which also applies the seccomp profile)

FROM node:22-bookworm-slim AS runtime-base
# xvfb and the libraries are Chromium's, the second group Firefox's. Then: pgrep for the
# process tree, unshare for the sandbox preflight, tar for the engine archive, and fonts
# so a persona's text doesn't fall back to nothing.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libxshmfence1 \
    libdbus-1-3 libglib2.0-0 libx11-xcb1 libxcb1 libxext6 libxi6 libxrender1 libxtst6 libgtk-3-0 \
    libdbus-glib-1-2 libxt6 libpci3 libegl1 libgl1 libgles2 libgl1-mesa-dri \
    procps util-linux tar tini ca-certificates \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim AS build
# Only for better-sqlite3, when no prebuilt binary fits.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY .yarn/patches .yarn/patches
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/browser-runtime/package.json packages/browser-runtime/package.json
COPY packages/cdp-driver/package.json packages/cdp-driver/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/profile-manager/package.json packages/profile-manager/package.json
COPY packages/settings-store/package.json packages/settings-store/package.json
COPY packages/types/package.json packages/types/package.json
COPY scripts/detection-baseline/package.json scripts/detection-baseline/package.json
RUN corepack yarn workspaces focus @multizen/server
COPY packages packages
COPY apps/server apps/server
RUN corepack yarn workspace @multizen/server build

FROM build AS production-deps
# esbuild inlined every @multizen package, which are all dev dependencies, so this leaves
# no packages/ trees or dangling links to them.
RUN corepack yarn workspaces focus @multizen/server --production

FROM build AS baseline-deps
# Before anything is taken away: the baseline runs as TypeScript, and on the runtime's sources.
RUN corepack yarn workspaces focus @multizen/server @multizen/detection-baseline
COPY scripts/detection-baseline scripts/detection-baseline

# The detection baseline, on the same system packages as the server (see its compose service):
#   docker build -f docker/Dockerfile --target baseline -t multizen-baseline:local .
FROM runtime-base AS baseline
ENV LANG=C.UTF-8
COPY --from=baseline-deps /repo /repo
RUN mkdir -p /data /tmp/.X11-unix /repo/docs/detection-baselines /repo/scripts/detection-baseline/.cache \
  && chown -R node:node /data /repo/docs /repo/scripts/detection-baseline/.cache \
  && chmod 1777 /tmp/.X11-unix
USER node
VOLUME /data
WORKDIR /repo/scripts/detection-baseline
ENTRYPOINT ["tini", "--", "node", "--import", "tsx", "run.ts"]

FROM runtime-base
# With no UTF-8 locale a browser can't open a file whose name isn't ASCII: upload_file and a
# person's upload both give their file its real name, and the page then can't read it.
ENV LANG=C.UTF-8
# A name lookup holds a libuv thread for as long as the resolver takes, and pages choose the names.
ENV UV_THREADPOOL_SIZE=64
WORKDIR /app
# For "type": "module".
COPY apps/server/package.json ./package.json
COPY --from=production-deps /repo/apps/server/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
# A new named volume takes this directory's owner. Xvfb wants its socket directory made by root.
RUN mkdir -p /data /tmp/.X11-unix \
  && chown node:node /data \
  && chmod 700 /data \
  && chmod 1777 /tmp/.X11-unix
USER node
VOLUME /data
EXPOSE 7777
ENTRYPOINT ["tini", "--", "node", "/app/dist/cli.js"]
CMD ["serve"]
