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

# ffmpeg builds the stickers: it is the only tool that reads JPEG, GIF *and* mp4 (which is what
# WhatsApp actually sends when you pick a "GIF") and writes animated WebP. Alpine's build links
# libwebp, which is what provides the animated encoder.
# The grep fails the build here rather than at the first sticker: without libwebp there is no
# WebP encoder, and the feature would break only once someone actually sent an image.
RUN apk add --no-cache ffmpeg && ffmpeg -hide_banner -encoders | grep -q libwebp

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
