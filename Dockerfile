FROM node:24-bookworm-slim

# ffmpeg/ffprobe are required by audioExtractionService.js, cuttingService.js,
# and durationLimitService.js — not bundled with the base Node image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
