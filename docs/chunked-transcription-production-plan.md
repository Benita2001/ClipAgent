# Chunked transcription production plan

This plan hardens ClipAgent for genuine videos up to the existing 3,600-second
marketplace contract. It does not change clip quantity, price, input wording,
or output fields.

## Decision

Use sequential, timestamp-aware audio chunking with bounded overlap, durable
per-chunk checkpoints, and a merged canonical transcript. Do not upload a
full-hour audio file to a provider and do not load every chunk into memory at
once.

The current mono 16 kHz, 64 kbps AAC extraction averages about 8,710 bytes per
second. A full hour is therefore roughly 31.36 MB, above Groq's documented
25 MB free-tier upload cap. Ten-minute chunks are roughly 5.23 MB and leave
ample provider headroom.

## Proposed stages

1. FFprobe the source and enforce the unchanged 3,600-second ceiling.
2. Build a deterministic chunk manifest from source checksum, duration,
   encoding version, chunk length, and overlap.
3. Extract the source audio once using the existing mono 16 kHz AAC settings,
   then derive sequential 600-second chunks with a two-second overlap. Use
   absolute source offsets and remove each temporary chunk after it is durably
   checkpointed.
4. Transcribe one chunk at a time using `verbose_json` segment and word
   timestamps. Retry only the failed chunk with bounded exponential backoff and
   jitter.
5. Add each chunk's absolute source offset to every returned segment and word.
6. Deduplicate overlap-boundary words and segments using time overlap plus
   normalized text agreement. Preserve the earlier chunk on an exact match.
7. Atomically checkpoint the normalized result for each completed chunk.
8. Merge completed chunks into one monotonically ordered canonical transcript,
   validate timestamps against source duration, and atomically persist it.
9. Rank from the canonical transcript. If the transcript approaches a model
   context limit, rank bounded windows first and perform one final selection
   over compact candidate summaries.
10. Render and upload exactly the quantity purchased by the service contract,
    then apply the existing A2A output validator and delivery retry path.

## Durable state

Persist a manifest and chunk records beneath the configured A2A state root,
for example:

```text
/data/a2a-state/transcripts/<job-id>/manifest.json
/data/a2a-state/transcripts/<job-id>/chunks/000.json
/data/a2a-state/transcripts/<job-id>/chunks/001.json
/data/a2a-state/transcripts/<job-id>/merged.json
```

Every record must include:

- schema and transcription-pipeline version;
- job ID, service contract version, and source checksum;
- source start/end offsets and overlap;
- provider and model;
- attempt count and last updated timestamp;
- normalized segments and words;
- completion status and sanitized failure category.

Write each file through the existing temporary-file-plus-rename atomic pattern.
Use the existing job-state lock so only the worker that owns the job may
advance its transcript manifest.

On restart, reuse a completed chunk only when its source checksum, contract
version, chunking parameters, encoding version, provider model, and transcript
schema all match. Otherwise discard that checkpoint and recompute it. A
completed delivery remains terminal and delivery retry must never retrigger
transcription.

Transcripts may contain private spoken content. Store them only on the
persistent encrypted disk, never in logs or the Docker image, and delete them
after successful delivery plus the configured recovery window. Preserve them
longer only for an explicitly disputed task.

## Configuration

Introduce these worker settings during implementation:

```text
TRANSCRIPTION_CHUNKING_ENABLED=true
TRANSCRIPTION_CHUNK_SECONDS=600
TRANSCRIPTION_CHUNK_OVERLAP_SECONDS=2
TRANSCRIPTION_CHUNK_MAX_ATTEMPTS=3
TRANSCRIPTION_RETRY_BASE_MS=1000
TRANSCRIPTION_STATE_DIR=/data/a2a-state/transcripts
TRANSCRIPTION_CHECKPOINT_RETENTION_SECONDS=86400
```

Validate that chunk duration is comfortably below the active provider's upload
limit and that overlap is positive but materially smaller than the chunk.
Read provider capacity from explicit deployment configuration rather than
assuming the current Groq plan.

## Code changes for the implementation stage

- Add an audio-chunk extraction service that uses FFmpeg with absolute offsets.
- Split the existing transcription client into a single-chunk provider client
  and a chunk orchestration service.
- Add transcript timestamp normalization, overlap deduplication, and merged
  transcript validation.
- Add a durable transcript checkpoint store using the A2A lock and atomic
  writes.
- Change the shared clipping pipeline to consume the merged transcript while
  preserving its existing ranking, rendering, upload, cleanup, and delivery
  contracts.
- Extend readiness with chunk configuration and writable checkpoint-directory
  checks. Do not make external transcription API calls from readiness.
- Extend stale recovery so transcription resumes at the first incomplete chunk.
- Redact transcript text and provider response bodies from operational logs.

## Required tests

- exact chunk boundaries for short, exact-multiple, and 3,600-second sources;
- FFmpeg extraction arguments and absolute offset preservation;
- two-second overlap merging without duplicate words or segments;
- monotonically increasing merged timestamps;
- retry of one failed chunk without repeating successful chunks;
- process termination after each chunk and restart from the manifest;
- corrupt, stale, wrong-source, wrong-model, and wrong-contract checkpoints;
- provider size rejection confined to the failed chunk;
- transcript state atomicity and concurrent recovery locking;
- ranking over a full-hour synthetic transcript without context overflow;
- cleanup after success, terminal failure, retention expiry, and dispute hold;
- no transcript text or credentials in readiness, logs, or public errors;
- unchanged one-clip service SERVICE_ID fulfillment and delivery-retry behavior.

## Rollout gates

1. Keep the implementation behind `TRANSCRIPTION_CHUNKING_ENABLED` so it can
   be disabled during rollback; production configuration defaults it to true.
2. Pass focused failure/recovery tests and the full repository suite.
3. Benchmark a genuine 60-minute source locally using the production image.
4. Validate peak disk, memory, FFmpeg time, per-chunk transcription latency,
   ranking context size, and complete wall-clock time on the Render staging
   plan.
5. Enable chunking only in staging and complete an unpaid deterministic
   harness run.
6. Complete one separately authorized escrow staging task using a small source.
7. Run a separately approved 60-minute operational test before describing
   hour-long processing as production-proven.
