---
name: clipagent-a2a
description: Prepare and fulfill OKX A2A ClipAgent video-clipping tasks using the official task attachment or temporary-source transport.
---

# ClipAgent A2A

Turn one attached long-form video into short, social-ready clips. Keep OKX A2A
task negotiation, escrow, attachment transfer, and delivery under the official
Onchain OS task lifecycle. Never use x402 inside an A2A order.

## Customer flow

Trigger examples include “Create clips from this video”, “Turn this podcast
into 3 short clips”, and “Find the best moments in this recording”.

Before task creation:

1. Collect or default clip count, 20–45 second duration, vertical platform,
   strongest self-contained moments, deadline, and optional topic/style notes.
2. Inspect the selected local file without loading it fully into memory.
3. At or below `OKX_ATTACHMENT_MAX_BYTES`, attach it through the official OKX
   task attachment flow.
4. Above that boundary, call the local ClipAgent customer transport helper. It
   streams the file with TUS into the configured private temporary-source
   bucket and returns task metadata containing a short-lived signed reference.
5. Never show transfer IDs, object keys, signed URLs, upload IDs, or storage
   credentials to the human.
6. Show the official task confirmation card and wait for confirmation before
   creating the task.

If large uploads are disabled or `CLIPAGENT_MAX_SOURCE_BYTES` is unset, explain
that large-video transfer is not configured. Do not block ordinary OKX
attachments.

## Provider flow

Do not process media before the official `job_accepted` event.

For an official attachment, follow the ASP `next-action` attachment flow and
pass the resulting local file into the normalized `okx_attachment` input.

For temporary storage, read only the signed reference and verification
metadata from the task. Pass it into the normalized `temporary_source` input.
The provider helper checks disk capacity, streams to temporary disk, validates
size and checksum, runs FFprobe, and invokes the existing ClipAgent pipeline.

After successful processing, verify each final HTTPS clip URL and deliver:

- filename or title;
- playable URL;
- start and end timestamps;
- duration;
- brief selection reason.

On any failure, do not submit a successful delivery. Preserve the accurate task
state and run idempotent local and temporary-source cleanup.
