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

## Video URL Requirements

`videoUrl` must be a publicly reachable HTTPS URL that returns the video bytes
directly, or redirects (within the configured limit) to another safe HTTPS URL
that does. It must not require cookies, custom authorization headers,
interactive login, or a confirmation page.

Supported by the generic downloader:

- Direct public HTTPS video-file URLs.
- Public cloud-storage object URLs.
- Temporary signed HTTPS object URLs, provided they remain valid through DNS
  validation and the complete download.
- Redirecting URLs whose final safe response contains actual video media.
- URLs without a filename extension when the response contains valid video
  data.
- Responses with a `video/*` Content-Type.
- Responses with `application/octet-stream`, `application/mp4`,
  `application/x-matroska`, or no Content-Type, which are downloaded and then
  checked by ffprobe before a job is accepted.
- Chunked responses without Content-Length; the observed byte count is still
  limited while streaming.

Not supported:

- Webpages containing embedded video players.
- YouTube watch URLs, TikTok video-page URLs, X post URLs, and Vimeo page URLs.
- Normal file-sharing pages that return HTML instead of video bytes.
- Links requiring login, cookies, custom `Authorization` headers, or
  interactive download confirmation.
- Private Google Drive share pages.

The filename and `Content-Disposition` header do not determine compatibility.
The URL does not need to end in `.mp4`, `.mov`, or another video extension.
Explicit HTML types such as `text/html` and `application/xhtml+xml` are
rejected. Accepted downloads must also pass the installed ffprobe duration
check and the subsequent FFmpeg pipeline. Common containers such as MP4, MOV,
WebM, Matroska, MPEG, Ogg, 3GP, FLV, and AVI generally work when the installed
FFmpeg build includes decoders for the file's actual codecs; container support
is therefore not an unconditional codec guarantee.

Recommended JSON:

```json
{
  "callerId": "example-caller",
  "videoUrl": "https://cdn.example.com/videos/interview.mp4"
}
```

Recommended cloud-storage input:

```json
{
  "callerId": "example-caller",
  "videoUrl": "https://storage-provider.example/public/video.mp4?signature=..."
}
```

Supabase public/signed object URLs, Amazon S3 public/presigned object URLs,
Cloudinary delivery URLs, and CDN URLs follow the same generic rules: they work
only when the URL returns the media bytes with an accepted or absent
Content-Type and needs no extra authentication. Provider branding alone does
not establish compatibility.

Dropbox links may work only when configured as direct-download links whose
final response is the file. Normal Dropbox share pages are not supported.
Normal Google Drive share links commonly return HTML or confirmation pages and
are not guaranteed to work. A Google Drive `uc?export=download` URL may work
only when it returns the file directly without login, cookies, or confirmation.

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
