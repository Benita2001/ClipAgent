# Suggested OKX listing description

Use this text for manual review and submission. Do not treat this file as an
automatic marketplace update.

> Extracts valuable moments from a short, publicly accessible video and returns
> completed, ready-to-post clip URLs synchronously.
>
> Call `POST /clip` using either JSON with both required fields
> (`{"callerId":"unique-caller-or-request-id","videoUrl":"https://example.com/video.mp4"}`)
> or multipart form data with required string field `callerId` and required file
> field `video`. The first unpaid request returns an x402 HTTP 402 challenge.
> Replay the same request with the required x402 payment header. A successful
> paid request returns the completed clip URLs directly in HTTP 200; it does not
> return a job ID or polling URL. Use a short supported video for marketplace
> testing.
