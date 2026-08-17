FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISPLAY=:99 \
    NO_OPEN=1 \
    HEADLESS=0 \
    REMOTE_MODE=1 \
    BROWSER_CHANNEL=chromium \
    PORT=4317 \
    REMOTE_SCREEN_WIDTH=1440 \
    REMOTE_SCREEN_HEIGHT=900

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright-core install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       apache2-utils \
       curl \
       fonts-noto-core \
       nginx \
       novnc \
       openbox \
       supervisor \
       websockify \
       x11vnc \
       xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY . .
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/nursing-register.conf
RUN chmod 0755 /app/docker/entrypoint.sh /app/docker/start-nginx.sh \
    && mkdir -p /run/nginx /var/log/supervisor

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
