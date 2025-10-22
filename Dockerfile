# Stage 1: Build the Vite-powered landing page
FROM node:22.21.0 AS frontend-builder
WORKDIR /app

# Provide the base tsconfig so the workspace's config extension resolves correctly.
COPY tsconfig.json ./tsconfig.json

# Copy only the package manifest first to leverage Docker layer caching for node_modules.
COPY packages/web/package.json packages/web/package.json

# Install frontend dependencies in isolation to keep the image lean.
WORKDIR /app/packages/web
RUN npm install

# Bring in the remainder of the landing page source and produce the static dist bundle.
COPY packages/web/ /app/packages/web/
RUN npm run build


# Stage 2: Build the Discord bot
FROM node:22.21.0-slim AS bot-builder
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/discord-bot/package*.json packages/discord-bot/
COPY packages/shared/package.json packages/shared/

# Install dependencies (includes @discordjs/opus build)
RUN npm install --include=dev

# Copy and build bot
COPY . .
RUN npm run build --workspace=@arete/shared
RUN npx tsc -p packages/discord-bot/tsconfig.json

# Prune dev dependencies to reduce image size
RUN cd packages/discord-bot && npm install --production


# Stage 3: Final runtime image
FROM node:22.21.0-slim
WORKDIR /app

# Copy built frontend assets from the Vite build stage
COPY --from=frontend-builder /app/packages/web/dist ./packages/web/dist

# Copy built bot
COPY --from=bot-builder /app/packages/discord-bot/dist ./packages/discord-bot/dist
COPY --from=bot-builder /app/packages/discord-bot/package*.json ./packages/discord-bot/
COPY --from=bot-builder /app/packages/shared/package.json ./packages/shared/
COPY --from=bot-builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=bot-builder /app/packages/shared/prompts ./packages/shared/prompts
RUN cd packages/shared && npm install --production
RUN cd packages/discord-bot && npm install --production

# Copy the lightweight Node server used to host the static site
COPY server.js ./server.js

# Simple startup script to run the bot alongside the static site host
RUN echo '#!/bin/sh\n\
cd /app/packages/discord-bot && node dist/index.js &\n\
cd /app && node server.js\n\
' > /app/start.sh && chmod +x /app/start.sh

EXPOSE 3000
CMD ["/app/start.sh"]
