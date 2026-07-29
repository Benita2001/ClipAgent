# ClipAgent

ClipAgent is migrating to an A2A-native video-clipping worker. Production
startup now defaults to the A2A worker; the previous HTTP/x402 runtime remains
available only as a temporary compatibility mode.

## Production runtime

```bash
# Default: A2A worker only
npm start

# Explicit equivalent
npm run start:a2a

# Temporary legacy compatibility runtime
npm run start:legacy
```

`ENABLE_A2MCP=false` is the default. In this mode, startup does not import the
legacy Express routes or x402 modules. The worker starts or connects to the
OKX A2A daemon, dispatches accepted job files through
`scripts/run-okx-a2a-job.js` / `services/okxA2aJobHandler.js`, and exposes:

- `GET /health` for process liveness;
- `GET /ready` for daemon, identity, job-state, FFmpeg, FFprobe, storage,
  service-map, and disk-capacity readiness.

Hosted production must provide the `okx-a2a` and `onchainos` executables,
persist their authentication/configuration, and place `A2A_JOB_STATE_FILE` on
a persistent writable volume.

## A2A marketplace contract

The active staging contract is service `37723`, **1 Finished Social Clip**:

- fixed marketplace fee: `0.5 USDT`;
- purchased quantity: exactly one clip, determined by the service ID;
- input: one encrypted OKX video attachment up to 3,600 seconds long;
- output: one public playable vertical MP4 URL with start/end timestamps,
  measured duration, and a short selection reason;
- output duration: 20–45 seconds.

Buyer instructions may influence the preferred duration, target platform, tone,
or preferred moment, but cannot change the purchased quantity. The versioned
`OKX_A2A_SERVICE_CONTRACTS` configuration is the A2A pricing and fulfillment
source of truth. `OKX_A2A_SERVICE_CLIP_MAP` is retained only as a compatibility
mirror and must match it exactly.

Long-form audio is extracted once and transcribed as sequential ten-minute
chunks with a two-second boundary overlap. Groq is attempted first for every
chunk; only a chunk that cannot be completed by Groq falls back to OpenAI
`whisper-1`. Successful chunks are durably checkpointed, merged back onto the
original source timeline, and reused after restart. Transcription remains in
the spoken language; ClipAgent does not call an audio translation endpoint.

The worker persists the contract version with each job. A non-terminal result
created under another contract version is never delivered without being
revalidated and reprocessed. Completed delivery requires the exact purchased
quantity, valid non-overlapping timestamps, unique public URLs, 20–45 second
durations, and non-empty selection reasons.

Future two- and three-clip services are not configured until OKX assigns real
service IDs. Their fixed fees are independent A2A service contracts; they do
not reuse the legacy REST pricing function at runtime.

## Legacy API compatibility

The legacy runtime is isolated behind `ENABLE_A2MCP=true`. Its public contract
remains:

1. `POST /clip` is the only x402-protected endpoint. It accepts a small JSON request containing an HTTPS video URL, downloads the video after payment verification, runs the existing media pipeline, and returns final Supabase clip URLs.
2. Pricing is 0.5 USDT per requested clip. Clip counts default to 1, may request up to 3 clips, and each clip stays in the 20–45 second window.

The source video, extracted audio, and rendered local clips are temporary. Supabase stores final clips only.

## Generate clips

`POST /clip` accepts `application/json` only:

```bash
curl -i -X POST http://localhost:3000/clip \
  -H 'Content-Type: application/json' \
  --data '{"videoUrl":"https://example.com/video.mp4","clipCount":3,"instructions":"Find the most engaging moments"}'
```

```json
{
  "videoUrl": "https://example.com/video.mp4",
  "clipCount": 3,
  "instructions": "Find the most engaging moments",
  "minDuration": 20,
  "maxDuration": 45
}
```

Only `videoUrl` is required. The URL must use HTTPS and resolve only to public network addresses. An unpaid request receives the official SDK's HTTP 402 challenge. The buyer replays the exact same method, URL, and JSON body with the `Payment-Signature` header required by that challenge. The video is downloaded once, after verification; video bytes are not part of the paid replay.

After successful processing:

```json
{
  "success": true,
  "clips": [
    {
      "url": "https://project.supabase.co/storage/v1/object/public/clips/...",
      "startSeconds": 10,
      "endSeconds": 35,
      "durationSeconds": 25,
      "selectionReason": "..."
    }
  ]
}
```

The route rejects multipart bodies, non-HTTPS URLs, localhost/private/link-local/metadata destinations, filesystem paths, oversized downloads, unsafe redirects, and unknown fields. The mounted payment configuration contains only `POST /clip`.

## Internal upload compatibility

`POST /uploads` remains available for the existing same-origin test UI and compatibility tests. It streams one multipart `video` file into bounded temporary storage and returns a single-use `uploadId`. This is not the marketplace workflow and is not exposed in the public agent schema.

## OKX A2A video transport

The A2A workflow keeps escrow and delivery separate from x402. Videos
at or below `OKX_A2A_MAX_FILE_SIZE_BYTES` use one official encrypted OKX task
attachment. Source URLs and multipart source-video submissions are not accepted.

The installed OKX client controls its attachment transport ceiling through
`OKX_A2A_MAX_FILE_SIZE_BYTES`; ClipAgent reads the same setting and retains
`OKX_ATTACHMENT_MAX_BYTES` only as a deprecated compatibility alias. Source
videos are rejected after FFprobe when their duration exceeds exactly 3,600
seconds, before audio extraction, transcription, ranking, rendering, or upload.
The configured production ceiling is 1 GiB, but upstream OKX acceptance at that
size remains a staging validation item. Final clips use the public
`SUPABASE_STORAGE_BUCKET`.

Durable checkpoints under `/data/a2a-state` cover attachment validation,
source probing, extracted audio, transcription, bounded ranking, validated
render output, uploaded object identity, delivery payload, and final delivery.
Each artifact is verified before reuse. Active-job heartbeats prevent valid
long operations from being reclaimed by stale recovery. Supabase upload retries
are limited to transient network, timeout, HTTP 429 and HTTP 5xx failures.

Production readiness also validates the authenticated live OKX service metadata
against the local service contract. Service `37723` must remain one clip for a
fixed total `0.5 USDT`, with the matching contract version and no buyer-selected
quantity or dynamic/per-clip pricing.

## Processing and settlement

The synchronous pipeline reuses:

- FFprobe validation
- FFmpeg audio extraction
- Groq transcription
- Groq ranking, with the existing Gemini fallback
- FFmpeg clip rendering
- Supabase upload
- local cleanup in `finally`

The official installed OKX middleware buffers the business response. Its current behavior settles only for a successful response and releases the response after synchronous settlement. Responses with status `400` or higher are not settled. Graceful-disconnect checkpoints prevent later expensive stages and successful delivery after the buyer connection is gone.

## Cleanup

The pipeline deletes the downloaded source, extracted audio, and local rendered clips after success or failure. Supabase objects are never part of local cleanup. A cleanup failure prevents a successful paid response.

## Browser workflow

The existing same-origin page remains an internal compatibility client for `POST /uploads`. Marketplace clients use the URL-based public contract above.

## Configuration

Copy `.env.example` to `.env` and provide:

- `GROQ_API_KEY`
- optional `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- OKX facilitator credentials

Useful bounded settings include upload size/TTL, FFprobe/FFmpeg timeouts, provider timeouts, Supabase timeout, marketplace processing timeout, and `X402_MAX_TIMEOUT_SECONDS`.

## Run and test

```bash
npm start
npm test
```

The test suite keeps provider, storage, and facilitator calls mocked. It covers upload preparation, x402 challenge/replay, settlement gating, graceful disconnects, pipeline failures, and cleanup.
