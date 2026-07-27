# Suggested OKX listing description

Use this text for manual review and submission. Do not treat this file as an
automatic marketplace update.

> Extracts valuable moments from a prepared video and returns
> completed, ready-to-post clip URLs synchronously.
>
> Prepare one video using the free multipart `POST /uploads` endpoint, then
> call the paid `POST /clip` endpoint with application/json:
> (`{"uploadId":"opaque-id","clipCount":1,"minDurationSeconds":20,"maxDurationSeconds":30}`)
> The first unpaid request returns an x402 HTTP 402 challenge.
> Replay the same request with the required x402 payment header. A successful
> paid request returns the completed clip URLs directly in HTTP 200; it does not
> return a job ID or polling URL. Use a short supported video for marketplace
> testing.
