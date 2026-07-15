const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { uploadDir } = require('../utils/tempDir');

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
  'video/mpeg',
  'video/ogg',
  'video/3gpp',
  'video/x-flv',
]);

class UnsupportedFileTypeError extends Error {
  constructor(mimetype) {
    super(`Unsupported file type: "${mimetype}". Must be one of: ${[...ALLOWED_MIME_TYPES].join(', ')}`);
    this.name = 'UnsupportedFileTypeError';
    this.statusCode = 400;
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(new UnsupportedFileTypeError(file.mimetype));
    return;
  }
  cb(null, true);
}

const maxUploadBytes = (Number(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxUploadBytes },
});

module.exports = { upload, UnsupportedFileTypeError, ALLOWED_MIME_TYPES };
