# Node 22: `ai` and `@ai-sdk/*` declare `engines.node >= 22`, and Next 16 needs >= 20.9.
# Pinning it here rather than letting a builder guess is what makes the build reproducible.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Not set during build: `next build` does not need any secret, and baking one into a
# layer is what the SecretsUsedInArgOrEnv warning was about.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Next binds to localhost without this, and Traefik would get a connection refused.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# `output: "standalone"` traces the runtime deps, so the image carries the server and the
# modules it actually imports rather than all of node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
