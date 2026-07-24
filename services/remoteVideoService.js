const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { uploadDir, ensureUploadDir } = require('../utils/tempDir');
const { cleanupFiles } = require('../utils/fileCleanup');
const { readTimeoutMs, withProviderTimeout } = require('../utils/providerTimeout');

const REMOTE_VIDEO_DOWNLOAD_TIMEOUT_MS = readTimeoutMs(
  process.env.REMOTE_VIDEO_DOWNLOAD_TIMEOUT_MS,
  120_000
);
const REMOTE_VIDEO_MAX_BYTES = readTimeoutMs(process.env.REMOTE_VIDEO_MAX_BYTES, 500 * 1024 * 1024);
const REMOTE_VIDEO_MAX_REDIRECTS = Math.max(
  0,
  Math.floor(Number(process.env.REMOTE_VIDEO_MAX_REDIRECTS) || 3)
);

const blockedAddresses = new net.BlockList();
[
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, 'ipv4'));
[
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, 'ipv6'));

class RemoteVideoError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'RemoteVideoError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isBlockedAddress(address, family) {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blockedAddresses.check(mapped[1], 'ipv4');
  const detectedFamily = net.isIP(address);
  if (!detectedFamily) return true;
  return blockedAddresses.check(address, detectedFamily === 6 ? 'ipv6' : 'ipv4');
}

function parseVideoUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new RemoteVideoError('INVALID_VIDEO_URL', 'videoUrl must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new RemoteVideoError('INVALID_VIDEO_URL', 'videoUrl must use HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new RemoteVideoError('INVALID_VIDEO_URL', 'videoUrl must not contain embedded credentials.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new RemoteVideoError('VIDEO_URL_BLOCKED', 'videoUrl points to a blocked network address.');
  }
  return parsed;
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

async function resolveSafeAddresses(parsedUrl, resolveHostname = defaultResolveHostname, signal) {
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await awaitWithAbort(resolveHostname(hostname), signal);

  if (!addresses.length || addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
    throw new RemoteVideoError('VIDEO_URL_BLOCKED', 'videoUrl points to a blocked network address.');
  }
  return addresses;
}

async function defaultResolveHostname(hostname) {
  try {
    return await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new RemoteVideoError('VIDEO_URL_UNREACHABLE', 'videoUrl hostname could not be resolved.');
  }
}

async function validateRemoteVideoUrl(value, options = {}) {
  const parsed = parseVideoUrl(value);
  await resolveSafeAddresses(parsed, options.resolveHostname);
  return parsed.toString();
}

function requestResponse(url, requestOptions, requestImpl) {
  return new Promise((resolve, reject) => {
    const request = requestImpl(url, requestOptions, resolve);
    request.once('error', reject);
    request.end();
  });
}

async function downloadResponse(
  parsedUrl,
  destinationPath,
  redirectCount,
  { signal, maxBytes, maxRedirects, requestImpl, resolveHostname }
) {
  const addresses = await resolveSafeAddresses(parsedUrl, resolveHostname, signal);
  const selected = addresses[0];
  const response = await requestResponse(
    parsedUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'video/*,application/octet-stream;q=0.8',
        'User-Agent': 'ClipAgent/1.0',
      },
      signal,
      lookup(hostname, options, callback) {
        if (options && options.all) {
          callback(null, [selected]);
          return;
        }
        callback(null, selected.address, selected.family);
      },
    },
    requestImpl
  );

  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (redirectCount >= maxRedirects) {
      throw new RemoteVideoError('VIDEO_REDIRECT_LIMIT', 'videoUrl exceeded the redirect limit.');
    }
    const location = response.headers.location;
    if (!location) {
      throw new RemoteVideoError('VIDEO_DOWNLOAD_FAILED', 'The video server returned an invalid redirect.', 502);
    }
    const redirected = parseVideoUrl(new URL(location, parsedUrl).toString());
    return downloadResponse(redirected, destinationPath, redirectCount + 1, {
      signal,
      maxBytes,
      maxRedirects,
      requestImpl,
      resolveHostname,
    });
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new RemoteVideoError(
      'VIDEO_DOWNLOAD_FAILED',
      `The video server returned HTTP ${response.statusCode}.`,
      502
    );
  }

  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType && !contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
    response.resume();
    throw new RemoteVideoError('UNSUPPORTED_VIDEO_TYPE', 'videoUrl did not return a supported video type.', 415);
  }

  const contentLength = Number(response.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.resume();
    throw new RemoteVideoError('VIDEO_TOO_LARGE', 'The remote video exceeds the configured size limit.', 413);
  }

  let downloadedBytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maxBytes) {
        callback(new RemoteVideoError('VIDEO_TOO_LARGE', 'The remote video exceeds the configured size limit.', 413));
        return;
      }
      callback(null, chunk);
    },
  });

  await pipeline(response, limiter, fs.createWriteStream(destinationPath, { flags: 'wx' }), { signal });
  return { bytes: downloadedBytes, contentType: contentType || 'application/octet-stream' };
}

async function downloadRemoteVideo(videoUrl, options = {}) {
  const timeoutMs = options.timeoutMs || REMOTE_VIDEO_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes || REMOTE_VIDEO_MAX_BYTES;
  const maxRedirects =
    options.maxRedirects === undefined ? REMOTE_VIDEO_MAX_REDIRECTS : options.maxRedirects;
  const requestImpl = options.requestImpl || https.request;
  const resolveHostname = options.resolveHostname || defaultResolveHostname;
  const cleanup = options.cleanupFiles || cleanupFiles;

  ensureUploadDir();
  const destinationPath = path.join(uploadDir, `${crypto.randomUUID()}.video`);
  try {
    const parsed = parseVideoUrl(videoUrl);
    const result = await withProviderTimeout(
      'Remote video download',
      timeoutMs,
      ({ signal }) =>
        downloadResponse(parsed, destinationPath, 0, {
          signal,
          maxBytes,
          maxRedirects,
          requestImpl,
          resolveHostname,
        }),
      { signal: options.signal, timerApi: options.timerApi }
    );
    return {
      path: destinationPath,
      filename: path.basename(destinationPath),
      originalname: 'remote-video',
      mimetype: result.contentType,
      size: result.bytes,
    };
  } catch (error) {
    await cleanup([destinationPath]);
    throw error;
  }
}

module.exports = {
  RemoteVideoError,
  validateRemoteVideoUrl,
  downloadRemoteVideo,
  isBlockedAddress,
  REMOTE_VIDEO_DOWNLOAD_TIMEOUT_MS,
  REMOTE_VIDEO_MAX_BYTES,
  REMOTE_VIDEO_MAX_REDIRECTS,
};
