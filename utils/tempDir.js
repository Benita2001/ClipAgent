const fs = require('fs');
const path = require('path');
const { resolveRuntimePaths } = require('../config/runtimePaths');

const uploadDir = resolveRuntimePaths().uploadsDir;

function ensureUploadDir() {
  fs.mkdirSync(uploadDir, { recursive: true });
  return uploadDir;
}

module.exports = { uploadDir, ensureUploadDir };
