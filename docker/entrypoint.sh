#!/bin/sh
set -eu

if [ "${ENABLE_A2MCP:-false}" != "false" ]; then
  echo '{"event":"a2a.startup_rejected","reason":"ENABLE_A2MCP must be false in the production container."}' >&2
  exit 64
fi

umask 077
for directory in \
  "${CLIPAGENT_DATA_ROOT:-/data}" \
  "${CLIPAGENT_AUTH_HOME:-/data/auth}" \
  "${CODEX_HOME:-/data/auth/codex}" \
  "${OKX_AGENT_TASK_HOME:-/data/a2a}" \
  "${A2A_STATE_DIR:-/data/a2a-state}" \
  "${CLIPAGENT_LOG_DIR:-/data/logs}" \
  "${CLIPAGENT_TEMP_ROOT:-/data/tmp}" \
  "${TEMP_UPLOAD_DIR:-/data/tmp/uploads}" \
  "${CLIPS_OUTPUT_DIR:-/data/tmp/clips}"
do
  mkdir -p "$directory"
done

exec "$@"
