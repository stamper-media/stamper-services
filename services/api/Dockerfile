# syntax=docker/dockerfile:1.7-labs
# Stamper api/worker image (one image; ROLE=api|worker selects the role at runtime).
# Build from this repository's root:  docker build -f services/api/Dockerfile -t stamper-api .
# @stamper/* packages come from vendor/ (pnpm-workspace.yaml overrides) until they are on npm.
ARG NODE_IMAGE=node:24-bookworm-slim
# Static ffmpeg/ffprobe 7.1, pinned by digest.
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4

FROM ${FFMPEG_IMAGE} AS ffmpeg

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.32.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY vendor ./vendor
COPY --exclude=**/node_modules --exclude=**/dist services/api ./services/api
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@stamper/api..."
RUN pnpm --filter "@stamper/api" run build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --legacy --prod --filter @stamper/api /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /var/lib/stamper/staging /var/lib/stamper/cache /var/lib/stamper/models \
 && chown -R node:node /var/lib/stamper
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
