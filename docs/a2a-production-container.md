# A2A production container

The production image is an always-running, single-instance worker. It starts
`tini -> docker/entrypoint.sh -> node start.js -> a2a-worker.js`. The entrypoint
rejects `ENABLE_A2MCP` unless it is exactly `false`.

## Persistent filesystem

Mount one encrypted persistent disk at `/data`.

| Path | Classification | Purpose |
| --- | --- | --- |
| `/data/auth/onchainos` | persistent, secret | OnchainOS identity, encrypted keyring, wallet and login session |
| `/data/auth/codex` | persistent, secret | AI provider authentication |
| `/data/a2a` | persistent, secret | XMTP database, daemon/session SQLite, jobs, downloads, commands and daemon state |
| `/data/a2a-state` | persistent, secret | ClipAgent idempotency, attachment recovery metadata and delivery-retry JSON |
| `/data/logs` | persistent, non-secret but sensitive | Operational diagnostics; never log attachment secrets or credentials |
| `/data/tmp/uploads` | temporary | Downloaded source attachments; deleted after success or terminal failure |
| `/data/tmp/clips` | temporary | Rendered clips before durable upload; rebuildable |

No `/data` content, `.env` file, wallet file, session file, SQLite database, or
local agent home is included in the image. Provision authentication at runtime
through an encrypted disk or secret-management procedure. Never bake it into an
image layer.

The authenticated provisioning and recovery procedure is in
[`a2a-authenticated-staging.md`](a2a-authenticated-staging.md).

## Recovery policy

`A2A_PROCESSING_STALE_MS` defaults to 30 minutes. Fresh processing records are
not recoverable by another worker. A stale record is claimed with an atomic
cross-process lock and records `recoveryReason`, `recoveryAttempt`, and
`recoveredAt`.

- Attachment acquisition, validation, transcription, ranking, rendering, or an
  incomplete upload restarts from attachment acquisition. Pipeline cleanup makes
  intermediate media rebuildable.
- A record containing both `result` and `deliveryPayload` resumes delivery only.
- `ready_for_delivery` and `delivery_failed` always resume delivery only.
- `delivered` and `completed` are terminal and are never claimed again.

The Render persistent disk permits only one service instance, which matches the
single-daemon design. The file lock still prevents duplicate local dispatches.

## Daemon supervision

The worker owns one `okx-a2a` daemon. It starts the daemon with
`--no-autostart`, waits until status reports `running`, polls it while serving,
immediately makes readiness false after disconnection, and terminates after the
configured consecutive-failure threshold. `SIGTERM` and `SIGINT` close the
health server and stop only a daemon started by this worker.

## Required runtime configuration

- `ENABLE_A2MCP=false`
- `OKX_A2A_PROVIDER_AGENT_ID=6041`
- `OKX_A2A_SERVICE_ID`
- `OKX_A2A_SERVICE_CLIP_MAP`
- `OKX_A2A_AI_PROVIDER=codex`
- transcription/ranking credentials
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and storage bucket configuration

The container supplies explicit `/data` paths for all persistent state. The
remaining timeout and capacity controls are documented in `.env.example`.

## Render

Use a paid Docker Background Worker with one persistent disk mounted at
`/data`. Background workers do not support Render HTTP health checks. Monitor
process restarts, logs, CPU, memory, and disk metrics; `/health` and `/ready`
remain available inside the container/network for diagnostics. Start with at
least 1 CPU, 2 GB RAM, and a 20 GB disk, then size from observed FFmpeg peak
memory and concurrent temporary-media usage. Persistent-disk services run as a
single instance and have restart/deploy downtime.
