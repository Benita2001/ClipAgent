# ClipAgent A2A runtime notes

When this repository is opened inside an OKX A2A job-dispatch session and `OKX_AGENT_TASK_CURRENT_JOB_FILE` is set:

1. Read the job file from `OKX_AGENT_TASK_CURRENT_JOB_FILE`.
2. Run `node scripts/run-okx-a2a-job.js`.
3. Use the existing ClipAgent pipeline to process the accepted job.
4. Deliver the result through the official OKX task delivery command.
5. Clean up temporary source files after delivery or terminal failure.

Do not answer the prompt directly in that mode. Execute the job runner instead.
