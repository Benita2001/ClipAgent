# ClipAgent

ClipAgent is an always-running OKX agent-to-agent video worker. A buyer
purchases service `SERVICE_ID`, attaches one official encrypted video, and receives
one AI-selected, social-ready vertical clip. The production contract is
versioned as `CONTRACT_NAME` and costs a fixed total of `0.5 USDT`.

The legacy HTTP/x402 implementation remains isolated for compatibility. It is
not loaded by the production worker and is not the OKX marketplace workflow.

## Production contract

| Field | Value |
| --- | --- |
| Provider | ASP `PROVIDER_ID` |
| Service | `SERVICE_ID` |
| Contract version | `CONTRACT_NAME` |
| Price | Fixed total `0.5 USDT` per task |
| Input | Exactly one official OKX encrypted video attachment |
| Source size | At most `1073741824` bytes (1 GiB configured worker ceiling) |
| Source duration | At most 3,600 seconds |
| Output quantity | Exactly one clip |
| Output | Public playable vertical MP4 |
| Output duration | 20–45 seconds |
| Metadata | Source start/end timestamps, measured duration, selection reason |
| Completion | All-or-nothing |

The 1 GiB value is enforced by ClipAgent and its configured local OKX
attachment transport. It is not evidence that the upstream OKX marketplace has
accepted a 1 GiB attachment; that requires a separately authorized live test.

Buyer text never changes the purchased quantity. The worker can pass optional
free-text instructions to ranking, so a buyer may express a preferred moment,
tone, target platform, or duration. These are advisory: duration remains
bounded to 20–45 seconds, output remains vertical MP4, and delivery remains
exactly one clip. There are no separate structured buyer parameters.

## A2A architecture

```text
Buyer
  -> purchases OKX service SERVICE_ID
  -> attaches one encrypted video
OKX A2A provider daemon
  -> dispatches the accepted job to ClipAgent
ClipAgent worker
  -> validates provider, service, attachment metadata, size and checksum
  -> downloads and decrypts the official attachment
  -> probes source media and duration with FFprobe
  -> extracts audio once with FFmpeg
  -> transcribes bounded chunks with Groq and per-chunk OpenAI fallback
  -> merges absolute source timestamps
  -> ranks one bounded candidate moment
  -> renders and validates one vertical MP4
  -> uploads one result to the public Supabase clips bucket
  -> constructs and submits one deterministic delivery payload
Buyer
  -> receives one completed result
```

No source URL, multipart source, second attachment, buyer-selected quantity, or
partial success path exists in the A2A contract.

## Buyer workflow

1. Select ClipAgent service `SERVICE_ID`.
2. Create an OKX A2A task and complete the marketplace payment/escrow flow.
3. Attach exactly one supported video file through the official OKX attachment
   interface.
4. Optionally include free-text editorial guidance.
5. Wait for all processing stages to complete.
6. Receive one public MP4 URL plus source timestamps, measured duration, and a
   short selection reason.

ClipAgent does not guarantee virality, a completion deadline, or an SLA. It
does not deliver a partial result.

## Provider workflow

The production container starts:

```text
tini
  -> docker/entrypoint.sh
  -> node start.js
  -> a2a-worker.js
  -> one supervised okx-a2a daemon
  -> accepted-job dispatch
  -> scripts/run-okx-a2a-job.js
  -> services/okxA2aJobHandler.js
```

`ENABLE_A2MCP=false` is mandatory in the production image. The worker owns one
daemon, refreshes durable heartbeats during long stages, and fails readiness if
the daemon disconnects.

## Input contract

Required:

- Exactly one official OKX attachment.
- Complete attachment metadata, including file key, digest, encryption
  metadata, and filename.
- A supported video MIME type.
- Downloaded content whose size and checksum agree with the accepted metadata.
- A readable video stream no longer than 3,600 seconds.

Supported MIME types:

- `video/mp4`
- `video/quicktime`
- `video/x-msvideo`
- `video/webm`
- `video/x-matroska`
- `video/mpeg`
- `video/ogg`
- `video/3gpp`
- `video/x-flv`

Optional:

- One free-text editorial instruction in the task message. The worker passes
  it to ranking. Preferences for moment, tone, platform, or duration are
  advisory and cannot alter quantity, output format, or hard limits.

Unsupported:

- Source URLs or filesystem paths.
- Zero or multiple attachments.
- Multipart source-video assembly.
- Audio-only input.
- Buyer-selected clip quantity.
- Guaranteed deadline, SLA, or virality.

## Output and delivery contract

Successful delivery contains exactly one clip record:

```json
{
  "status": "completed",
  "jobId": "job-example",
  "providerId": PROVIDER_ID,
  "serviceId": SERVICE_ID,
  "serviceContractVersion": "CONTRACT_NAME",
  "purchasedClipCount": 1,
  "generatedClipCount": 1,
  "clipCount": 1,
  "pricingModel": "fixed_service_total",
  "serviceFeeAmount": "0.5",
  "serviceFeeCurrency": "USDT",
  "clips": [
    {
      "url": "https://project.supabase.co/storage/v1/object/public/clips/job-example/clip-1.mp4",
      "startTime": 312.4,
      "endTime": 343.2,
      "durationSeconds": 30.8,
      "selectionReason": "A concise, self-contained explanation with a strong opening and clear takeaway."
    }
  ]
}
```

The job is not marked complete unless the URL is public, timestamps are valid,
measured duration is 20–45 seconds, and the selection reason is non-empty.

## Transcription and ranking

ClipAgent extracts audio once as mono 16 kHz AAC. It divides the full source
timeline into sequential ten-minute chunks with a two-second overlap. Every
chunk is attempted with Groq first. Retryable Groq failures use bounded retry;
only the failed chunk falls back to OpenAI `whisper-1`.

Successful chunks are persisted before processing continues. Recovery resumes
from the first incomplete chunk and never retranscribes valid completed
chunks. Overlap speech is deduplicated and timestamps are restored to the
original source timeline. Transcription stays in the spoken language; no
translation endpoint is used.

Ranking is context bounded. Short transcripts use one bounded request. Long
transcripts are divided into absolute-time ranking windows, and the strongest
valid candidate is selected across them. A deterministic source-bounded
fallback handles malformed ranking output.

## Durable recovery

Persistent production state lives under `/data`:

- `/data/a2a-state/clipagent-a2a-state.json` — leases, state and delivery retry;
- `/data/a2a-state/stages` — stage manifests;
- `/data/a2a-state/artifacts` — validated source, audio and render artifacts;
- `/data/a2a-state/transcripts` — chunk and merged transcript checkpoints;
- `/data/a2a` — daemon/session state;
- `/data/auth` — secret authentication state.

Durable checkpoints cover attachment validation, source probe, audio
extraction, transcription, ranking, render validation, upload identity,
delivery payload, and final delivery. Artifact checksum, size, configuration
versions, source identity, service contract version, and relevant timestamps
are checked before reuse.

A fresh processing lease cannot be taken by a second worker. Heartbeats prevent
long transcription, rendering, upload, or delivery work from appearing stale.
Delivery retry reuses valid processing and upload checkpoints.

## Health and readiness

- `GET /health` is lightweight process liveness.
- `GET /ready` is production acceptance readiness.

Readiness reports separate groups:

- `identityChecks` — authenticated wallet-derived ASP ownership and status;
- `runtimeChecks` — daemon, persistent state, media tools, storage,
  configuration, service mapping, and disk;
- `marketplaceChecks` — only authoritative live marketplace fields;
- `localContractChecks` — the full versioned one-clip runtime contract;
- `marketplaceCapabilityLimitations` — structured fields the official listing
  API does not expose;
- `failures` — every independent failed check.

The marketplace API does not expose structured contract version, output
quantity, input/output schemas, attachment policy, source-duration limit, or
file-size limit. Their absence is informational. The worker validates those
invariants locally and uses marketplace description compatibility only to
detect explicit buyer-facing contradictions.

Readiness returns HTTP 200 only with `ready: true` and
`status: "operational"`.

## Configuration

Copy `.env.example` to a local untracked `.env`. Never commit secrets.
Production has no identity defaults. Replace the uppercase placeholders only
after OKX assigns the provider and service:

```text
ENABLE_A2MCP=false
OKX_A2A_PROVIDER_AGENT_ID=PROVIDER_ID
OKX_A2A_SERVICE_ID=SERVICE_ID
OKX_A2A_CONTRACT_NAME=CONTRACT_NAME
OKX_MARKETPLACE_ENVIRONMENT=MARKETPLACE_ENVIRONMENT
OKX_A2A_MARKETPLACE_METADATA={"serviceType":"A2A","endpointMode":"daemon"}
OKX_A2A_SERVICE_CONTRACTS={"SERVICE_ID":{"active":true,"contractVersion":"CONTRACT_NAME","clipCount":1,"pricingModel":"fixed_service_total","feeAmount":"0.5","feeCurrency":"USDT"}}
OKX_A2A_SERVICE_CLIP_MAP={"SERVICE_ID":1}
OKX_A2A_MAX_FILE_SIZE_BYTES=1073741824
CLIPAGENT_MAX_DURATION_SECONDS=3600
TRANSCRIPTION_CHUNKING_ENABLED=true
TRANSCRIPTION_PRIMARY_PROVIDER=groq
TRANSCRIPTION_FALLBACK_PROVIDER=openai
TRANSCRIPTION_CHUNK_SECONDS=600
TRANSCRIPTION_CHUNK_OVERLAP_SECONDS=2
RANKING_CONTEXT_PROTECTION_ENABLED=true
SUPABASE_STORAGE_BUCKET=clips
```

Required secrets include `GROQ_API_KEY`, `OPENAI_API_KEY`,
`SUPABASE_URL`, and `SUPABASE_SERVICE_KEY`. OnchainOS and Codex
authentication are provisioned interactively onto the encrypted `/data` disk,
not baked into the image.

## Deployment

The supported staging target is one Render Docker Background Worker with one
encrypted persistent disk mounted at `/data`. The image runs as a non-root user
under `tini`. Do not run multiple instances against the same persistent state.

Deployment procedure:

1. Run the focused and full test suites, syntax checks, Docker build, and
   `git diff --check`.
2. Commit only reviewed A2A runtime and documentation files.
3. Push only `clipagent-a2a-staging`.
4. Confirm Render builds the intended commit and starts the A2A-only entrypoint.
5. Confirm wallet authentication, ownership of ASP `PROVIDER_ID`, daemon connection,
   service `SERVICE_ID`, `/health`, and `/ready`.
6. Update the live listing only after the deployed worker is healthy.
7. Resubmit only after the live listing fee and description match the local
   v1 contract.

Detailed operational procedures are in:

- [`docs/a2a-production-container.md`](docs/a2a-production-container.md)
- [`docs/a2a-authenticated-staging.md`](docs/a2a-authenticated-staging.md)
- [`docs/a2a-deployment-validation-checklist.md`](docs/a2a-deployment-validation-checklist.md)
- [`docs/okx-listing-description.md`](docs/okx-listing-description.md)

## Testing

```bash
npm test
```

Focused tests cover:

- task and attachment normalization;
- size, checksum, MIME and duration validation;
- chunked transcription retry, fallback, merge and recovery;
- bounded ranking and timestamp constraints;
- FFmpeg rendering and output validation;
- Supabase retry and durable upload reuse;
- job locking, heartbeat, stale recovery and delivery retry;
- local contract and live marketplace readiness;
- A2A-only startup and container hardening.

External provider calls, live OKX transport, marketplace escrow, and live
Supabase behavior are mocked in the repository suite unless explicitly stated.
A local pass does not prove those external systems.

## Marketplace resubmission

Before resubmission:

1. Deploy and verify the final staging commit.
2. Change service `SERVICE_ID` to fixed total `0.5 USDT`.
3. Replace its description with the exact three-part text in
   `docs/okx-listing-description.md`.
4. Ensure the listing does not advertise three clips, buyer-selected quantity,
   a source URL, dynamic/per-clip pricing, or a guaranteed deadline.
5. Verify `/ready` becomes HTTP 200 and operational.
6. Capture the complete parameter details, examples, response shape, and error
   behavior from the listing document for the reviewer.
7. Resubmit through the authorized operator workflow.

## Known limitations

- Upstream OKX acceptance of a 1 GiB attachment is not yet proven.
- A genuine hosted 60-minute production benchmark remains pending.
- Only one official input attachment and one output clip are supported.
- Buyer instructions are advisory free text, not structured guarantees.
- No source URL, multipart input, partial completion, deadline, SLA, or virality
  guarantee is supported.
- Official delivery does not expose a separate idempotency-key flag; ClipAgent
  uses deterministic payload persistence and remote task-status checks as its
  strongest available protection.

## Legacy compatibility

`ENABLE_A2MCP=true` starts the isolated legacy HTTP/x402 implementation,
including its own `/clip`, source-URL, upload compatibility, and per-clip
pricing behavior. Those routes and tests are intentionally retained during the
A2A migration. They do not define service `SERVICE_ID` and must not be used by
marketplace buyers or reviewers.
