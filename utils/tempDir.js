const fs = require('fs');
const path = require('path');

const uploadDir = path.resolve(process.cwd(), process.env.TEMP_UPLOAD_DIR || './tmp/uploads');

function ensureUploadDir() {
  fs.mkdirSync(uploadDir, { recursive: true });
  return uploadDir;
}

module.exports = { uploadDir, ensureUploadDir };
