# Stage 1: Build the Vite-powered landing page
FROM node:22.14.0 AS frontend-builder
WORKDIR /app

# Provide the base tsconfig so the workspace's config extension resolves correctly.
COPY tsconfig.json ./tsconfig.json

# Copy package manifests first to leverage Docker layer caching for node_modules.
COPY package.json ./package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/ethics-core/package.json packages/ethics-core/package.json

# Install dependencies using workspace support
RUN npm install

# Bring in the remainder of the landing page source and produce the static dist bundle.
COPY packages/web/ /app/packages/web/
COPY packages/ethics-core/ /app/packages/ethics-core/

# Build argument for Turnstile site key (public, safe to expose in frontend)
ARG TURNSTILE_SITE_KEY
ENV VITE_TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY

RUN npm run build --workspace=@arete/web


# Stage 2: Build the Discord bot
FROM node:22.14.0-slim AS bot-builder
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/discord-bot/package*.json packages/discord-bot/
COPY packages/shared/package.json packages/shared/
COPY packages/ethics-core/package.json packages/ethics-core/

# Install dependencies (includes @discordjs/opus build)
RUN npm install --include=dev

# Copy and build bot
COPY . .
RUN npm run build --workspace=@arete/shared
RUN npx tsc -p packages/discord-bot/tsconfig.json

# Prune dev dependencies to reduce image size
RUN cd packages/discord-bot && npm install --production


# Stage 3: Final runtime image
FROM node:22.14.0-slim
WORKDIR /app

# Copy built frontend assets from the Vite build stage
# Note: TURNSTILE_SITE_KEY is baked into the frontend build (public, safe to expose)
COPY --from=frontend-builder /app/packages/web/dist ./packages/web/dist

# Copy built bot
COPY --from=bot-builder /app/packages/discord-bot/dist ./packages/discord-bot/dist
COPY --from=bot-builder /app/packages/discord-bot/package*.json ./packages/discord-bot/
COPY --from=bot-builder /app/packages/shared/package*.json ./packages/shared/
COPY --from=bot-builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=bot-builder /app/packages/shared/prompts ./packages/shared/prompts
COPY --from=bot-builder /app/packages/ethics-core ./packages/ethics-core
COPY --from=bot-builder /app/package.json ./package.json
COPY --from=bot-builder /app/package-lock.json ./package-lock.json
RUN npm install --production --ignore-scripts

# Copy the lightweight Node server used to host the static site
COPY server.js ./server.js

# Copy GitHub App private key (if it exists)
# Create keys directory first
RUN mkdir -p ./keys
# Copy keys directory if it exists using wildcard pattern
COPY keys* ./keys/

# Note: TURNSTILE_SECRET_KEY must be provided at runtime via environment variables
# This secret key is used for server-side verification and must never be committed
# For Fly.io deployment, use: fly secrets set TURNSTILE_SECRET_KEY=...

# Simple startup script to run the bot alongside the static site host
RUN echo '#!/bin/sh\n\
cd /app/packages/discord-bot && node dist/index.js &\n\
cd /app && node server.js\n\
' > /app/start.sh && chmod +x /app/start.sh

EXPOSE 3000
CMD ["/app/start.sh"]
