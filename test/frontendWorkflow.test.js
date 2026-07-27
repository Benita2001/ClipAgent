const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

test('browser workflow uploads video separately and sends only JSON to the paid route', async () => {
  const source = await fs.promises.readFile(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(source, /fetch\('\/uploads', \{ method: 'POST', body: data \}\)/);
  assert.match(source, /fetch\('\/clip'/);
  assert.match(source, /'Content-Type': 'application\/json'/);
  assert.match(source, /uploadId: prepared\.uploadId/);
  assert.doesNotMatch(source, /videoUrl/);
  assert.doesNotMatch(source, /file\.path|localPath/);
  assert.match(source, /clipagent:payment-required/);
});

test('browser workflow does not invent or embed a payment signature', async () => {
  const source = await fs.promises.readFile(path.join(publicDir, 'app.js'), 'utf8');
  assert.doesNotMatch(source, /signed-payment|mock-payment|fake-payment/);
  assert.match(source, /if \(paymentSignature\) headers\['Payment-Signature'\] = paymentSignature/);
});
