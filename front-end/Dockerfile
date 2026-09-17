# Stage 1: build the static bundle. The API base URLs are baked in at
# build time (Vite inlines import.meta.env), pointed at the reverse-proxy
# paths nginx serves below, so the browser only ever talks to one origin.
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV VITE_API_BASE=/api \
    VITE_WEBHOOK_BASE=/webhooks
RUN npm run build

# Stage 2: serve it, and proxy /api and /webhooks to the backends.
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
