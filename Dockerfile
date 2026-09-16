FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HEADLESS=true \
    PORT=3000

CMD ["node", "scripts/health-server.js"]
