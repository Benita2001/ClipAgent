const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createUploadsRouter } = require('../routes/uploads');
const {
  createPreparedUpload,
  getPreparedUpload,
  takePreparedUpload,
  clearPreparedUploadsForTests,
} = require('../services/preparedUploadService');

async function request(app, options = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/uploads`,
      options
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.afterEach(() => clearPreparedUploadsForTests());

test('POST /uploads returns opaque metadata and registers a single-use prepared file', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-upload-'));
  const filePath = path.join(directory, 'server-random-name.mp4');
  await fs.promises.writeFile(filePath, 'video');
  const app = express();
  app.use(createUploadsRouter({
    uploadSingle(req, res, next) {
      req.file = {
        path: filePath,
        filename: 'server-random-name.mp4',
        originalname: 'customer-video.mp4',
        mimetype: 'video/mp4',
        size: 5,
      };
      next();
    },
    checkDurationLimit: async () => ({ durationSeconds: 45 }),
  }));

  try {
    const response = await request(app, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.filename, 'customer-video.mp4');
    assert.equal(response.body.durationSeconds, 45);
    assert.equal(typeof response.body.uploadId, 'string');
    assert.equal(Object.hasOwn(response.body, 'path'), false);
    assert.equal(JSON.stringify(response.body).includes(directory), false);

    const prepared = await getPreparedUpload(response.body.uploadId);
    assert.equal(prepared.file.path, filePath);
    assert.equal((await takePreparedUpload(response.body.uploadId)).uploadId, response.body.uploadId);
    assert.equal(await takePreparedUpload(response.body.uploadId), null);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('POST /uploads cleans a file when FFprobe validation fails', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-upload-'));
  const filePath = path.join(directory, 'invalid.mp4');
  await fs.promises.writeFile(filePath, 'invalid');
  const app = express();
  app.use(createUploadsRouter({
    uploadSingle(req, res, next) {
      req.file = {
        path: filePath,
        filename: 'invalid.mp4',
        originalname: 'invalid.mp4',
        mimetype: 'video/mp4',
        size: 7,
      };
      next();
    },
    checkDurationLimit: async () => {
      const error = new Error('ffprobe rejected media');
      error.statusCode = 400;
      throw error;
    },
  }));
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({
      success: false,
      error: { code: 'UPLOAD_VALIDATION_FAILED' },
    });
  });

  try {
    const response = await request(app, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'UPLOAD_VALIDATION_FAILED');
    await assert.rejects(fs.promises.access(filePath), { code: 'ENOENT' });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('prepared upload records expose no path through their public metadata', () => {
  const record = createPreparedUpload(
    {
      path: '/private/server/path.mp4',
      filename: 'random.mp4',
      originalname: 'video.mp4',
      size: 123,
      mimetype: 'video/mp4',
    },
    { durationSeconds: 30 },
    { now: Date.now() }
  );
  const publicShape = {
    uploadId: record.uploadId,
    filename: record.file.originalname,
    durationSeconds: record.durationSeconds,
    expiresAt: record.expiresAt,
  };
  assert.equal(JSON.stringify(publicShape).includes('/private/server'), false);
});

test('prepared upload IDs are consumed atomically', async () => {
  const record = createPreparedUpload(
    { path: '/tmp/atomic.mp4', originalname: 'atomic.mp4' },
    { durationSeconds: 30 }
  );
  const results = await Promise.all([
    takePreparedUpload(record.uploadId),
    takePreparedUpload(record.uploadId),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('expired prepared uploads are removed with their source file', async () => {
  const cleaned = [];
  const record = createPreparedUpload(
    { path: '/tmp/expired.mp4', originalname: 'expired.mp4' },
    { durationSeconds: 30 },
    {
      now: Date.now() - 16 * 60 * 1000,
      cleanup: async (paths) => cleaned.push(...paths),
    }
  );
  assert.equal(await getPreparedUpload(record.uploadId, {
    cleanup: async (paths) => cleaned.push(...paths),
  }), null);
  assert.deepEqual(cleaned, ['/tmp/expired.mp4']);
});
