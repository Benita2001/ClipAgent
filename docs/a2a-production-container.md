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
| `/data/a2a-state` | persistent, secret | ClipAgent job leases, idempotency, stage checkpoints, durable media artifacts, upload identity and delivery-retry JSON |
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

`A2A_PROCESSING_STALE_MS` defaults to 30 minutes and
`A2A_HEARTBEAT_INTERVAL_MS` defaults to 30 seconds. Long operations refresh the
durable heartbeat. Fresh leases are not recoverable by another worker. A lease
whose heartbeat expires is claimed with an atomic cross-process lock and
records `recoveryReason`, `recoveryAttempt`, and `recoveredAt`.

- Attachment, probe, extracted-audio, transcript, ranking, render, upload and
  delivery-payload checkpoints are validated before reuse. A missing, corrupt,
  version-incompatible or identity-incompatible artifact is regenerated from
  the earliest invalid stage.
- A record containing both `result` and `deliveryPayload` resumes delivery only.
- `ready_for_delivery` and `delivery_failed` always resume delivery only.
- `delivered` and `completed` are terminal and are never claimed again.
- Every record persists its A2A service-contract version. A version mismatch
  clears non-terminal durable results atomically and restarts processing.
- Delivery-only recovery revalidates quantity, URLs, timestamps, overlap,
  duration, and selection reasons before submitting the result.
- The installed OKX CLI exposes no delivery idempotency-key option. Recovery
  persists the exact payload checksum and checks official task status before
  resubmission; this is the strongest available local guard, not an
  exactly-once guarantee across an ambiguous remote acknowledgement.

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
- `OKX_A2A_PROVIDER_AGENT_ID=PROVIDER_ID`
- `OKX_A2A_SERVICE_ID=SERVICE_ID`
- `OKX_A2A_CONTRACT_NAME=CONTRACT_NAME`
- `OKX_MARKETPLACE_ENVIRONMENT=MARKETPLACE_ENVIRONMENT`
- `OKX_A2A_MARKETPLACE_METADATA={"serviceType":"A2A","endpointMode":"daemon"}`
- `OKX_A2A_SERVICE_CONTRACTS`
- `OKX_A2A_SERVICE_CLIP_MAP`
- `OKX_A2A_AI_PROVIDER=codex`
- transcription/ranking credentials
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and storage bucket configuration
- `/data/a2a-state/stages` and `/data/a2a-state/artifacts` for durable stage state
- bounded-ranking, heartbeat and Supabase retry controls from `.env.example`

The container supplies explicit `/data` paths for all persistent state. The
remaining timeout and capacity controls are documented in `.env.example`.

## Active marketplace contract

Service `SERVICE_ID` purchases exactly one finished clip for a fixed `0.5 USDT`
service fee. A2A pricing is defined by `OKX_A2A_SERVICE_CONTRACTS` and is
independent of the legacy REST per-clip pricing module. The compatibility
`OKX_A2A_SERVICE_CLIP_MAP` must mirror every active contract exactly or
readiness fails closed.

The source-video duration ceiling is exactly 3,600 seconds. FFprobe enforces
the ceiling before audio extraction, transcription, ranking, rendering, or
upload. Attachment transport capacity is controlled by the installed OKX
client's `OKX_A2A_MAX_FILE_SIZE_BYTES`; the worker reads the same value.

The worker extracts audio once, divides it into sequential overlapping chunks,
and durably checkpoints each successful provider response. Groq is primary;
OpenAI `whisper-1` is invoked only for a required chunk that Groq cannot
complete. Merged timestamps remain relative to the original source video.
Spoken content stays in its original language because both integrations use
their transcription endpoints rather than translation endpoints. Operational
gates remain documented in `docs/chunked-transcription-production-plan.md`.

Ranking is context bounded. Short transcripts use one request; long transcripts
are split into absolute-time windows, each request is checked against
`RANKING_MAX_REQUEST_BYTES`, and the strongest valid candidate is selected
across windows. Malformed provider output falls back to a deterministic,
source-bounded 20–45 second candidate.

Readiness queries the authenticated provider's live service list and compares
service `SERVICE_ID` with the fields the official marketplace response can prove. It
fails closed for a missing service, incorrect A2A type, unacceptable status,
price/currency/fixed-transaction drift, unexpected legacy endpoint, or an
explicitly contradictory description.

The official service response does not expose structured contract version,
output quantity, input/output schemas, attachment policy, source-duration
limit, or file-size limit. Readiness reports these capabilities as
informational limitations and validates their equivalents against the local
runtime contract instead. It never reports a marketplace quantity mismatch
unless OKX provides an authoritative structured quantity field in the future.

## Render

Use a paid Docker Background Worker with one persistent disk mounted at
`/data`. Background workers do not support Render HTTP health checks. Monitor
process restarts, logs, CPU, memory, and disk metrics; `/health` and `/ready`
remain available inside the container/network for diagnostics. Start with at
least 1 CPU, 2 GB RAM, and a 20 GB disk, then size from observed FFmpeg peak
memory and concurrent temporary-media usage. Persistent-disk services run as a
single instance and have restart/deploy downtime.
