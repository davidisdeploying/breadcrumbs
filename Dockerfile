# Matches the playwright version in package.json so the bundled Chromium and your saved
# profile stay compatible. The Playwright image already includes Node and the browsers.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Runs one fetch and exits. The scheduler (host cron / Ofelia) invokes it on a cadence.
CMD ["node", "fetch.mjs"]
