# ClipAgent

ClipAgent is a video-clipping service for the OKX Marketplace.

## Clip requests

Marketplace clients send structured JSON:

```bash
curl -i -X POST https://clipagent-n1wx.onrender.com/clip \
  -H "Content-Type: application/json" \
  -d '{
    "callerId": "example-caller",
    "videoUrl": "https://example.com/video.mp4"
  }'
```

A structurally valid unpaid request returns the standard x402 HTTP 402
challenge. After payment authorization is replayed, ClipAgent downloads and
validates the video and returns a trackable job:

```json
{
  "success": true,
  "status": "processing",
  "jobId": "2ac8d4f0-...",
  "callerId": "example-caller",
  "statusUrl": "https://clipagent-n1wx.onrender.com/job/2ac8d4f0-..."
}
```

Direct API clients may continue using multipart uploads:

```bash
curl -i -X POST https://clipagent-n1wx.onrender.com/clip \
  -F 'callerId=example-caller' \
  -F 'video=@./video.mp4'
```

Poll `statusUrl` until it returns `completed`:

```json
{
  "success": true,
  "status": "completed",
  "jobId": "2ac8d4f0-...",
  "clips": [
    {
      "index": 0,
      "url": "https://public-project.supabase.co/storage/v1/object/public/clips/...",
      "reason": "The selected moment",
      "startSeconds": 12.5,
      "endSeconds": 43.2,
      "requestedDurationSeconds": 30.7,
      "actualDurationSeconds": 30.6
    }
  ]
}
```

Input failures use a stable JSON boundary:

```json
{
  "success": false,
  "error": {
    "code": "VIDEO_INPUT_REQUIRED",
    "message": "Provide videoUrl in the JSON body or video in multipart field \"video\"."
  }
}
```

Remote inputs must use HTTPS, cannot contain embedded credentials, and cannot
resolve to local, private, link-local, metadata, multicast, or reserved
addresses. Redirect destinations are checked again. Downloads are streamed to
disk and enforce both the declared and observed byte size.

Optional remote-input limits:

- `PUBLIC_BASE_URL` — canonical service origin used for returned status links.
- `REMOTE_VIDEO_DOWNLOAD_TIMEOUT_MS` — complete request and body timeout; defaults to `120000`.
- `REMOTE_VIDEO_MAX_BYTES` — maximum downloaded bytes; defaults to `524288000`.
- `REMOTE_VIDEO_MAX_REDIRECTS` — redirect limit; defaults to `3`.

Business input parsing, URL/DNS validation, remote download, and ffprobe
validation all complete before the route returns success. The installed x402
middleware verifies payment authorization before the business handler and
settles only after a response below HTTP 400; invalid or failed pre-processing
responses therefore are not settled. A successful HTTP 202 is settled before
the asynchronous AI/ffmpeg/upload pipeline completes, so a later provider or
processing failure can still happen after settlement.

## Service checks

- `GET /health` is a liveness check. It returns HTTP 200 with `{"status":"ok"}` whenever the Node process is running, regardless of facilitator readiness.
- `GET /ready` is a readiness check. It returns HTTP 200 only after the OKX x402 facilitator initializes successfully; while initializing or waiting to retry, it returns HTTP 503 with concise retry state.

`/ready` must return HTTP 200 before marketplace validation or paid endpoint testing.

Optional facilitator retry configuration:

- `X402_INIT_RETRY_BASE_MS` — initial transient-failure retry delay; defaults to `1000`.
- `X402_INIT_RETRY_MAX_MS` — maximum retry delay and slower retry interval for apparent permanent authentication or configuration failures; defaults to `30000`.
