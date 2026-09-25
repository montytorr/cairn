# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# --- dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# --- build -----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules

# Declared before `COPY . .` so that changing the SHA busts only the layers
# below it, leaving the dependency layers cached.
ARG GIT_SHA=unknown
COPY . .
RUN echo "$GIT_SHA" > public/build-version.txt || (mkdir -p public && echo "$GIT_SHA" > public/build-version.txt)
# When, so a CLI whose fingerprint disagrees can tell which side is newer:
# its own mtime against this (CAIRN-290). Below `COPY . .`, so it is rebuilt
# with every source change rather than cached from the first build.
RUN date -u +%Y-%m-%dT%H:%M:%SZ > public/build-time.txt
# The fingerprint of the CLI this image was built beside, so a copied
# ~/.local/bin/cairn can tell whether it is the current file rather than
# whether it belongs to the current release — 133 commits fitted inside
# v0.5.1, so the version answers almost nothing (CAIRN-261). Written here
# because the standalone build does not trace `cli/`, and into public/ because
# that directory is already carried into the runtime image.
RUN node -e "const{createHash}=require('node:crypto'),{readFileSync,writeFileSync}=require('node:fs');writeFileSync('public/cli-hash.txt',createHash('sha256').update(readFileSync('cli/cairn.mjs')).digest('hex').slice(0,16))"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- migrations ------------------------------------------------------------
FROM base AS migrator
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY migrations ./migrations
CMD ["npm", "run", "db:migrate"]

# --- runtime ---------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# -G nodejs matters: busybox adduser defaults the primary group to `nogroup`,
# so without it the group created on the line before has no members, the
# --chown=nextjs:nodejs below sets a group the process is not in, and every
# group permission bit in the image is inert. Owner permissions carried it, so
# nothing failed — it just made "make it group-writable" a plausible fix that
# could never work.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Next 16 standalone still reads this metadata from the root .next at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/.next/required-server-files.json ./.next/

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
