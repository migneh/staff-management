FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY config.example.json ./config.example.json

RUN mkdir -p /app/data /app/backups && chown -R node:node /app
USER node

VOLUME ["/app/data", "/app/backups"]
CMD ["node", "src/index.js"]
