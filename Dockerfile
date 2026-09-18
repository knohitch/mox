# CapRover image shared by the Mox API and web apps.
# Both CapRover apps can build the same repository/branch; MOX_PROCESS_TYPE
# selects which process starts at runtime:
#   web      -> static SPA server (no database required)
#   api      -> control plane + migrations
#   combined -> control plane + migrations + built SPA fallback
#
# Pull Node from Amazon ECR Public, not Docker Hub. CapRover BuildKit
# sessions commonly die on registry-1.docker.io metadata ("no active
# session" / "context deadline exceeded").
FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY runtime ./runtime
COPY infra ./infra
COPY scripts ./scripts

# Optional build-time fallback. Split-host CapRover deployments normally
# inject VITE_MOX_API_URL at runtime through scripts/serve-web.mjs.
ARG VITE_MOX_API_URL=
ENV VITE_MOX_API_URL=$VITE_MOX_API_URL

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mox/control-plane... --filter @mox/web... run build

FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80
ENV MOX_PROCESS_TYPE=combined
ENV MOX_WEB_DIST_DIR=/app/apps/web/dist

RUN corepack enable
COPY --from=build /app /app
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 80 8080
ENTRYPOINT ["/app/docker-entrypoint.sh"]
