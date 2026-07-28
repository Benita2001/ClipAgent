FROM node:24-bookworm-slim

ARG OKX_A2A_VERSION=0.1.10

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg tini \
    && npm install --global "@okxweb3/a2a-node@${OKX_A2A_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm

ARG CODEX_VERSION=0.144.6
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && rm -rf /root/.npm

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/clipagent-entrypoint

RUN chmod 0755 /usr/local/bin/clipagent-entrypoint \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin clipagent \
    && install -d -o clipagent -g clipagent -m 0700 \
       /data /data/auth /data/auth/codex /data/a2a /data/a2a-state /data/logs \
       /data/tmp /data/tmp/uploads /data/tmp/clips \
    && chown -R clipagent:clipagent /app

USER clipagent
ENV NODE_ENV=production \
    ENABLE_A2MCP=false \
    CLIPAGENT_DATA_ROOT=/data \
    CLIPAGENT_AUTH_HOME=/data/auth \
    OKX_AGENT_TASK_HOME=/data/a2a \
    A2A_STATE_DIR=/data/a2a-state \
    A2A_JOB_STATE_FILE=/data/a2a-state/clipagent-a2a-state.json \
    CLIPAGENT_TEMP_ROOT=/data/tmp \
    TEMP_UPLOAD_DIR=/data/tmp/uploads \
    CLIPS_OUTPUT_DIR=/data/tmp/clips \
    CLIPAGENT_LOG_DIR=/data/logs \
    ONCHAINOS_HOME=/data/auth/onchainos \
    CODEX_HOME=/data/auth/codex \
    OKX_A2A_AI_PROVIDER=codex \
    A2A_HEALTH_HOST=0.0.0.0 \
    A2A_HEALTH_PORT=3000 \
    PATH=/home/clipagent/.local/bin:/usr/local/bin:/usr/bin:/bin

# Official installer supports Linux, verifies the downloaded release checksum,
# and installs the native binary beneath the unprivileged user's home.
RUN curl -fsSLo /tmp/onchainos-install.sh \
      https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh \
    && sh /tmp/onchainos-install.sh \
    && rm -f /tmp/onchainos-install.sh \
    && onchainos --version \
    && okx-a2a --version \
    && find /data -mindepth 1 -delete \
    && install -d -m 0700 \
       /data/auth /data/auth/codex /data/a2a /data/a2a-state /data/logs \
       /data/tmp /data/tmp/uploads /data/tmp/clips

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/clipagent-entrypoint"]
CMD ["node", "start.js"]
