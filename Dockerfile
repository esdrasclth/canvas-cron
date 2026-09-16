# La imagen base trae Node 24 y los navegadores de Playwright, pero no una
# cadena de compilacion. better-sqlite3 dejo de publicar binarios
# precompilados en la v13, asi que node-gyp tiene que construirlo aqui.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Imagen final sin compiladores: solo se copian los modulos ya construidos.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HEADLESS=true \
    PORT=3000

CMD ["node", "scripts/health-server.js"]
