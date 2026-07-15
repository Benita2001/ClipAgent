const fs = require('fs');
const path = require('path');

const clipsOutputDir = path.resolve(process.cwd(), process.env.CLIPS_OUTPUT_DIR || './output/clips');

function ensureOutputDir() {
  fs.mkdirSync(clipsOutputDir, { recursive: true });
  return clipsOutputDir;
}

module.exports = { clipsOutputDir, ensureOutputDir };
