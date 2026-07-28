#!/usr/bin/env node

const { runOkxA2aJob } = require('../services/okxA2aJobHandler');

async function main() {
  try {
    await runOkxA2aJob();
  } catch (error) {
    console.error(`[ClipAgent] Job failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
