# worldmonitor — Zeabur Deployment Dockerfile
# Ensures Node.js is present in BOTH build AND runtime containers,
# overriding zbpack's static-site detection for this Vite project.
#
# Service 1 (web):   default CMD     → node zeabur-server.js
# Service 2 (relay): override CMD    → node scripts/ais-relay.cjs
#                    (set in Zeabur Settings → Custom Start Command)

FROM node:22-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Build frontend (only needed for Service 1, but harmless for Service 2)
# NODE_OPTIONS ensures enough heap for the large Vite bundle
RUN NODE_OPTIONS='--max-old-space-size=3072' npm run build:zeabur

EXPOSE 3000

# Default: run the unified Node.js web server
# Service 2 overrides this via Zeabur Settings → Custom Start Command
CMD ["node", "zeabur-server.js"]
