# Stage 1: Build
FROM node:22-alpine AS build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ .
# Keep the shared chart contract at the same relative path as the checkout.
COPY src/arete/services/chart_contract.json /app/src/arete/services/chart_contract.json
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Custom nginx config with API proxy
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
