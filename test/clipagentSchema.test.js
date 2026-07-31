const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const clipagentSchemaRouter = require('../routes/clipagentSchema');
const { REMOTE_VIDEO_MAX_BYTES } = require('../services/remoteVideoService');

async function requestSchema() {
  const app = express();
  app.use(clipagentSchemaRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/.well-known/clipagent`
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('public schema documents the required JSON contract without payment metadata extensions', async () => {
  const response = await requestSchema();

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.json.schema.required, ['videoUrl']);
  assert.equal(response.body.json.schema.properties.videoUrl.pattern, '^https://');
  assert.equal(response.body.json.schema.properties.clipCount.maximum, 3);
  assert.deepEqual(
    response.body.optionalFields,
    ['clipCount', 'instructions', 'minDuration', 'maxDuration']
  );
  assert.deepEqual(
    response.body.defaults,
    { clipCount: 1, instructions: '', minDuration: 20, maxDuration: 45 }
  );
  assert.equal(
    response.body.limits.maximumRemoteVideoBytes,
    REMOTE_VIDEO_MAX_BYTES
  );
  assert.equal(Object.hasOwn(response.body.json.schema.properties, 'uploadId'), false);
  assert.equal(Object.hasOwn(response.body, 'x402'), false);
  assert.equal(Object.hasOwn(response.body, 'outputSchema'), false);
});
