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

# ffmpeg does two jobs here: it is the only tool that reads JPEG, GIF *and* mp4 (which is what
# WhatsApp actually sends when you pick a "GIF") and writes animated WebP, and it encodes voice
# notes as Ogg/Opus.
#
# The greps fail the build rather than the feature. Without libwebp there is no WebP encoder;
# without libopus, voice notes come out in a format WhatsApp Web plays and the mobile app does
# not — a difference invisible until someone tries it on a phone.
#
# Chromium renders the bot's own HTML to a picture. Fonts are not optional alongside it: without
# font-noto the page draws boxes, and without font-noto-emoji every emoji in a WhatsApp message
# comes out a blank rectangle — which reads as a broken feature rather than a missing package.
#
# The checks fail the build rather than the feature, same as the codecs.
RUN apk add --no-cache ffmpeg chromium font-noto font-noto-emoji font-noto-cjk ttf-dejavu \
 && ffmpeg -hide_banner -encoders | grep -q libwebp \
 && ffmpeg -hide_banner -encoders | grep -q libopus \
 && ffmpeg -hide_banner -encoders | grep -q libx264 \
 && ffmpeg -hide_banner -encoders | grep -qw aac \
 && test -x /usr/bin/chromium \
 && /usr/bin/chromium --version

ENV NODE_ENV=production
# Next binds to localhost without this, and Traefik would get a connection refused.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# `output: "standalone"` traces the runtime deps, so the image carries the server and the
# modules it actually imports rather than all of node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Standalone traces imports, and nothing imports a favicon — `public/` is not part of the
# trace and has to be copied explicitly. Miss it and every file in it 404s in production
# while working perfectly in `next start` locally.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
