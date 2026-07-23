# ClipAgent

ClipAgent is a video-clipping service for the OKX Marketplace.

## Service checks

- `GET /health` is a liveness check. It returns HTTP 200 with `{"status":"ok"}` whenever the Node process is running, regardless of facilitator readiness.
- `GET /ready` is a readiness check. It returns HTTP 200 only after the OKX x402 facilitator initializes successfully; while initializing or waiting to retry, it returns HTTP 503 with concise retry state.

`/ready` must return HTTP 200 before marketplace validation or paid endpoint testing.

Optional facilitator retry configuration:

- `X402_INIT_RETRY_BASE_MS` — initial transient-failure retry delay; defaults to `1000`.
- `X402_INIT_RETRY_MAX_MS` — maximum retry delay and slower retry interval for apparent permanent authentication or configuration failures; defaults to `30000`.
