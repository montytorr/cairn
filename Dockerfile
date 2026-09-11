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
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- migrations ------------------------------------------------------------
FROM base AS migrator
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY supabase/migrations ./supabase/migrations
CMD ["npm", "run", "db:migrate"]

# --- runtime ---------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Next 16 standalone still reads this metadata from the root .next at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/.next/required-server-files.json ./.next/

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
