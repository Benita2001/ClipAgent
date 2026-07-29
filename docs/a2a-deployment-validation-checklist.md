# ClipAgent A2A deployment and production-validation checklist

This checklist is for service `37723` under contract
`clipagent-a2a-37723-v1`. It does not authorize a marketplace mutation or paid
task.

## Deployment checklist

- [ ] Current branch is `clipagent-a2a-staging`.
- [ ] Intended commit is reviewed and pushed only to that branch.
- [ ] Render builds that exact commit, not `main`.
- [ ] Service remains one Docker Background Worker with one `/data` disk.
- [ ] `ENABLE_A2MCP=false`.
- [ ] Provider ID is `6041`; service ID is `37723`.
- [ ] Service contract is one clip, fixed total `0.5 USDT`, contract v1.
- [ ] Service clip map is `{"37723":1}`.
- [ ] Attachment ceiling is `1073741824`.
- [ ] Source-duration ceiling is `3600`.
- [ ] Persistent stage, artifact, transcript, auth, daemon and job-state paths
      resolve beneath `/data`.
- [ ] Build installs Node, FFmpeg, FFprobe, OnchainOS, OKX A2A runtime, Codex,
      and `tini`.
- [ ] Container runs as the non-root ClipAgent user.
- [ ] Startup selects `start.js -> a2a-worker.js`; legacy server modules do not
      load.
- [ ] Wallet session remains authenticated after restart.
- [ ] Authenticated account owns ASP `6041`.
- [ ] Provider is online and the daemon reports running.
- [ ] Live service `37723` is found under ASP `6041`.
- [ ] `/health` returns HTTP 200.
- [ ] `/ready` reports every independent mismatch.
- [ ] After the listing is corrected, `/ready` returns HTTP 200,
      `ready: true`, and `status: operational`.

## Production validation checklist

### Worker

- [ ] Startup and signal handling are clean.
- [ ] No restart loop or daemon duplication appears in logs.
- [ ] Health remains lightweight.
- [ ] Readiness shows separate identity, runtime, marketplace and local-contract
      groups without secrets.
- [ ] Marketplace fee and description are compatible with v1.

### Pipeline

- [ ] Exactly one encrypted attachment reaches the worker.
- [ ] Attachment metadata is complete.
- [ ] Configured-size preflight passes.
- [ ] Downloaded size and checksum match.
- [ ] FFprobe identifies supported video and duration no greater than 3,600
      seconds.
- [ ] Audio extraction succeeds once.
- [ ] Groq processes each required chunk or only failed chunks use OpenAI.
- [ ] Merged transcript timestamps remain absolute and monotonic.
- [ ] Bounded ranking returns exactly one valid 20–45 second moment.
- [ ] FFmpeg renders one playable vertical MP4.
- [ ] Output validation confirms URL, timestamps, duration and reason.
- [ ] Supabase creates one public object.
- [ ] Delivery contains one clip and fixed-service-total pricing metadata.
- [ ] Marketplace task reaches completed state once.

### Recovery

- [ ] Restart after attachment reuses the validated source.
- [ ] Restart after extraction reuses valid audio.
- [ ] Restart after transcription reuses completed chunks.
- [ ] Restart after ranking reuses the valid moment.
- [ ] Restart after rendering reuses the verified MP4.
- [ ] Restart after upload reuses the valid public object.
- [ ] Delivery failure retries delivery without rerunning the pipeline.
- [ ] No partial success or duplicate delivery is observed.

## Marketplace resubmission checklist

- [ ] Do not proceed until the deployed commit is healthy.
- [ ] Change service fee from `1` to `0.5`.
- [ ] Replace stale three-clip/target-count/deadline wording with the exact
      three-part service description in `okx-listing-description.md`.
- [ ] Keep service type as A2A, subscription empty, and endpoint absent.
- [ ] Re-run `/ready`; require HTTP 200 operational.
- [ ] Capture the detailed parameter, example, response, error and unsupported
      behavior sections for the reviewer.
- [ ] Verify live ASP ownership and status immediately before resubmission.
- [ ] Resubmit once through an authorized operator workflow.

## Live test evidence template

| Field | Evidence |
| --- | --- |
| Commit | |
| Render deploy ID | |
| Worker start time | |
| Health result | |
| Readiness result | |
| ASP ownership | |
| Service metadata | |
| Test task ID | |
| Source MIME type | |
| Source bytes | |
| Source duration | |
| Download/checksum | |
| Transcription chunks/providers | |
| Ranking timestamps | |
| Render duration/dimensions | |
| Public upload status | |
| Delivery status | |
| Escrow/completion status | |
| Total runtime | |
| Peak memory/disk | |
| Retries/failures | |

Do not include credentials, wallet addresses, account IDs, attachment secrets,
or private provider responses in this record.
