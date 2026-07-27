# ClipAgent

ClipAgent is a synchronous paid video-clipping API. Its hackathon architecture has two endpoints:

1. `POST /uploads` prepares one temporary video for free.
2. `POST /clip` is the only x402-protected endpoint. It consumes the opaque `uploadId`, runs the existing media pipeline, and returns final Supabase clip URLs.

The source video, extracted audio, and rendered local clips are temporary. Supabase stores final clips only.

## Prepare a video

Send one `multipart/form-data` field named `video`:

```bash
curl -X POST http://localhost:3000/uploads \
  -F 'video=@./video.mp4'
```

The file is streamed to `TEMP_UPLOAD_DIR`, limited by `PREPARED_UPLOAD_MAX_MB`, and validated with FFprobe before registration.

```json
{
  "uploadId": "opaque-single-use-id",
  "durationSeconds": 45,
  "filename": "video.mp4",
  "expiresAt": "2026-07-27T20:00:00.000Z"
}
```

The ID is held in an in-memory registry, expires after `PREPARED_UPLOAD_TTL_MS`, and is consumed atomically by the paid request. Internal server paths are never returned.

## Generate clips

`POST /clip` accepts `application/json` only:

```json
{
  "uploadId": "opaque-single-use-id",
  "clipCount": 1,
  "minDurationSeconds": 20,
  "maxDurationSeconds": 30
}
```

An unpaid request receives the official SDK's HTTP 402 challenge. The buyer replays the exact same method, URL, and JSON body with the `Payment-Signature` header required by that challenge. Video bytes are not part of the paid replay.

After successful processing:

```json
{
  "success": true,
  "clips": [
    {
      "url": "https://project.supabase.co/storage/v1/object/public/clips/...",
      "startSeconds": 10,
      "endSeconds": 35,
      "durationSeconds": 25
    }
  ]
}
```

The route rejects multipart bodies, remote URLs, filesystem paths, unknown fields, expired IDs, and reused IDs. The mounted payment configuration contains only `POST /clip`.

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

The paid route consumes each upload ID once. The pipeline deletes the uploaded source, extracted audio, and local rendered clips after success or failure. Expired unused uploads are deleted by the registry expiry timer. Supabase objects are never part of local cleanup.

The registry and files are local to one process. A restart invalidates prepared IDs, and multiple server replicas do not share them. This is intentional for the hackathon architecture.

## Browser workflow

The same-origin page at `/` automatically uploads the selected video and then creates the small JSON `/clip` request. It emits `clipagent:payment-required` when an x402 challenge arrives so an OKX-capable buyer host can authorize and replay the request. Without a buyer integration, it clearly reports that payment authorization is required; it never fabricates a payment.

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
