# PDF Suite API: Office (LibreOffice) and HTML (Chromium) conversion, server-side compress and OCR.
# NOTE: written for deployment but not built in CI yet (no Docker daemon was available while authoring).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      chromium fonts-liberation fonts-dejavu-core fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @pdfsuite/api...
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SOFFICE_PATH=/usr/bin/soffice CHROME_PATH=/usr/bin/chromium CHROME_NO_SANDBOX=1
# API_KEYS is required when HOST is not loopback (see src/main.ts)
USER node
EXPOSE 8787
CMD ["pnpm", "--filter", "@pdfsuite/api", "start"]
