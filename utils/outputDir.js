const fs = require('fs');
const path = require('path');
const { resolveRuntimePaths } = require('../config/runtimePaths');

const clipsOutputDir = resolveRuntimePaths().outputDir;

function ensureOutputDir() {
  fs.mkdirSync(clipsOutputDir, { recursive: true });
  return clipsOutputDir;
}

module.exports = { clipsOutputDir, ensureOutputDir };
