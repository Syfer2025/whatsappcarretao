FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    chromium-sandbox \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV FFMPEG_PATH=/usr/bin/ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY . .

RUN mkdir -p data media backups .wwebjs_auth .wwebjs_cache \
  && chown -R node:node data media backups .wwebjs_auth .wwebjs_cache /home/node

USER node:node

EXPOSE 3100
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3100) + '/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
