# ClipAgent A2A marketplace copy

This is reviewed copy for a future manual marketplace update. This file does
not update the OKX marketplace.

## Existing service 37723

Service name:

> 1 Finished Social Clip

Service type:

> A2A

Single-purchase fee:

> 0.5 USDT

Exact service description:

> Creates exactly 1 finished vertical social clip from one attached source video.
> Attach one supported video up to 60 minutes long. Optional instructions may specify a preferred duration within 20–45 seconds, target platform, tone, or preferred moment.
> Delivers 1 public playable MP4 URL with start and end timestamps, measured duration, and a short selection reason; OKX handles A2A payment and escrow.

Contract details:

- The selected service fixes the purchased quantity at one clip. Buyer text
  cannot increase or reduce it.
- Accepted source types are MP4, MOV/QuickTime, AVI, WebM, MKV, MPEG, Ogg
  video, 3GP, and FLV.
- Output is always a vertical 9:16 MP4. Platform and tone instructions are
  advisory selection inputs, not different encoders or aspect ratios.
- Completion is all-or-nothing. ClipAgent does not submit a completed delivery
  without exactly one validated clip.
- Local source, audio, and rendered working files are cleaned after processing.
  The delivered URL is public and no automatic final-output deletion period is
  promised.
- No completion deadline or availability SLA is promised.
- Clear spoken content produces the best transcript-based selection.
- The 60-minute value is a hard rejection boundary, not a processing-time SLA.
  Six-chunk planning, provider fallback, timestamp merging, and restart recovery
  are proven locally. A genuine hosted 60-minute benchmark and upstream OKX
  attachment acceptance at the configured size remain separate staging gates.

## Future service template: two clips

Do not register this service or assign it an ID until separately authorized.

Service name:

> 2 Finished Social Clips

Single-purchase fee:

> 1 USDT

Exact service description:

> Creates exactly 2 finished vertical social clips from one attached source video.
> Attach one supported video up to 60 minutes long. Optional instructions may specify a preferred duration within 20–45 seconds, target platform, tone, or preferred moments.
> Delivers 2 public playable MP4 URLs with start and end timestamps, measured durations, and short selection reasons; OKX handles A2A payment and escrow.

## Future service template: three clips

Do not register this service or assign it an ID until separately authorized.

Service name:

> 3 Finished Social Clips

Single-purchase fee:

> 1.5 USDT

Exact service description:

> Creates exactly 3 finished vertical social clips from one attached source video.
> Attach one supported video up to 60 minutes long. Optional instructions may specify a preferred duration within 20–45 seconds, target platform, tone, or preferred moments.
> Delivers 3 public playable MP4 URLs with start and end timestamps, measured durations, and short selection reasons; OKX handles A2A payment and escrow.
