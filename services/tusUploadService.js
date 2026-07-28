const fs = require('fs');

const TUS_VERSION = '1.0.0';
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

function encodeMetadata(metadata) {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
    .join(',');
}

async function uploadFileWithTus(filePath, authorization, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const chunkBytes = options.chunkBytes || TUS_CHUNK_BYTES;
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) throw new Error('TUS source must be a regular file.');

  const createResponse = await fetchImpl(authorization.uploadEndpoint, {
    method: 'POST',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(stats.size),
      'Upload-Metadata': encodeMetadata(authorization.metadata),
      'x-signature': authorization.token,
    },
  });
  if (!createResponse.ok) {
    throw new Error(`Resumable upload creation failed with HTTP ${createResponse.status}.`);
  }
  const location = createResponse.headers.get('location');
  if (!location) throw new Error('Resumable upload creation returned no upload URL.');
  const uploadUrl = new URL(location, authorization.uploadEndpoint).toString();

  const handle = await fs.promises.open(filePath, 'r');
  let offset = 0;
  try {
    while (offset < stats.size) {
      const length = Math.min(chunkBytes, stats.size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead <= 0) throw new Error('Unexpected end of file during resumable upload.');
      const response = await fetchImpl(uploadUrl, {
        method: 'PATCH',
        headers: {
          'Tus-Resumable': TUS_VERSION,
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
          'Content-Length': String(bytesRead),
          'x-signature': authorization.token,
        },
        body: bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead),
      });
      if (!response.ok) {
        throw new Error(`Resumable upload failed with HTTP ${response.status}.`);
      }
      const nextOffset = Number(response.headers.get('upload-offset'));
      offset = Number.isSafeInteger(nextOffset) && nextOffset > offset
        ? nextOffset
        : offset + bytesRead;
    }
  } catch (error) {
    await fetchImpl(uploadUrl, {
      method: 'DELETE',
      headers: {
        'Tus-Resumable': TUS_VERSION,
        'x-signature': authorization.token,
      },
    }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
  return { uploadUrl, sizeBytes: stats.size };
}

module.exports = { uploadFileWithTus, encodeMetadata, TUS_VERSION, TUS_CHUNK_BYTES };
