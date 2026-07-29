const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { createProviderFetch, readTimeoutMs } = require('../utils/providerTimeout');

let client = null;
const SUPABASE_TIMEOUT_MS = readTimeoutMs(process.env.SUPABASE_TIMEOUT_MS, 90_000);
const SUPABASE_UPLOAD_MAX_ATTEMPTS = Number(process.env.SUPABASE_UPLOAD_MAX_ATTEMPTS || 4);
const SUPABASE_UPLOAD_RETRY_BASE_MS = Number(process.env.SUPABASE_UPLOAD_RETRY_BASE_MS || 1_000);

function getClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set.');
  }
  client = createClient(url, key, {
    global: { fetch: createProviderFetch('Supabase', SUPABASE_TIMEOUT_MS) },
  });
  return client;
}

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'clips';

let bucketEnsured = false;

/**
 * Verifies — via real Supabase Storage API calls, not assumption — that the
 * target bucket exists and is public before any upload is attempted:
 *  1. getBucket() to check for existence and read its actual `public` flag.
 *  2. If missing, createBucket(..., {public:true}), then re-fetch to confirm.
 *  3. If it exists but public===false, updateBucket to public:true, then
 *     re-fetch to confirm the change actually took effect.
 * Throws with the real Supabase error message on any failure — never
 * silently proceeds on an unverified assumption.
 */
async function ensureBucket() {
  if (bucketEnsured) return;
  const supabase = getClient();

  const { data: existing, error: getError } = await supabase.storage.getBucket(BUCKET);

  if (getError || !existing) {
    const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (createError && !/already exists/i.test(createError.message || '')) {
      throw new Error(`Failed to create Supabase Storage bucket "${BUCKET}": ${createError.message}`);
    }

    const { data: verifyCreated, error: verifyCreatedError } = await supabase.storage.getBucket(BUCKET);
    if (verifyCreatedError || !verifyCreated) {
      throw new Error(`Bucket "${BUCKET}" creation could not be verified: ${verifyCreatedError ? verifyCreatedError.message : 'getBucket returned no data'}`);
    }
    if (!verifyCreated.public) {
      throw new Error(`Bucket "${BUCKET}" was created but is not public (verified via getBucket).`);
    }

    bucketEnsured = true;
    return;
  }

  if (!existing.public) {
    const { error: updateError } = await supabase.storage.updateBucket(BUCKET, { public: true });
    if (updateError) {
      throw new Error(`Bucket "${BUCKET}" exists but is private, and updating it to public failed: ${updateError.message}`);
    }

    const { data: verifyUpdated, error: verifyUpdatedError } = await supabase.storage.getBucket(BUCKET);
    if (verifyUpdatedError || !verifyUpdated || !verifyUpdated.public) {
      throw new Error(`Bucket "${BUCKET}" update to public could not be verified via getBucket (still shows private or errored).`);
    }
  }

  bucketEnsured = true;
}

async function uploadClipInner(localPath, storageKey) {
  const supabase = getClient();
  await ensureBucket();

  const fileBuffer = await fs.promises.readFile(localPath);

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storageKey, fileBuffer, {
    contentType: 'video/mp4',
    upsert: true,
  });

  if (uploadError) {
    const error = new Error(`Supabase upload failed for "${storageKey}": ${uploadError.message}`);
    error.statusCode = Number(uploadError.statusCode || uploadError.status || 0) || null;
    error.code = uploadError.code || null;
    throw error;
  }

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(storageKey);
  const publicUrl = publicUrlData && publicUrlData.publicUrl;
  if (!publicUrl) {
    throw new Error(`Supabase upload succeeded for "${storageKey}" but no public URL was returned.`);
  }

  return { bucket: BUCKET, storagePath: storageKey, publicUrl };
}

function isTransientSupabaseError(error) {
  const status = Number(error?.statusCode || error?.status || error?.providerStatus);
  if (status === 429 || status >= 500) return true;
  if ([401, 403, 400, 404, 409, 422].includes(status)) return false;
  return /timeout|timed out|network|fetch failed|econnreset|econnrefused|enotfound|socket/i
    .test(String(error?.message || ''));
}

function retryDelay(attempt, baseMs = SUPABASE_UPLOAD_RETRY_BASE_MS, random = Math.random) {
  const exponential = Math.min(baseMs * (2 ** Math.max(0, attempt - 1)), 30_000);
  return Math.round(exponential * (0.75 + random() * 0.5));
}

async function withSupabaseRetry(operation, {
  maxAttempts = SUPABASE_UPLOAD_MAX_ATTEMPTS,
  baseMs = SUPABASE_UPLOAD_RETRY_BASE_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientSupabaseError(error) || attempt >= maxAttempts) throw error;
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelay(attempt, baseMs, random));
    }
  }
  throw lastError;
}

/**
 * Uploads a local clip file to Supabase Storage and returns its public URL.
 * Throws (never returns a fabricated/partial success) if the upload or the
 * public-URL resolution fails — including on timeout, so a stalled connection
 * fails the job instead of hanging it in
 * "processing" forever.
 */
async function uploadClip(localPath, storageKey) {
  return withSupabaseRetry(() => uploadClipInner(localPath, storageKey));
}

async function verifyUploadedClip({
  bucket = BUCKET,
  storagePath,
  publicUrl,
  expectedSizeBytes,
} = {}) {
  if (bucket !== BUCKET || !storagePath || !publicUrl) return false;
  const parsed = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const directory = storagePath.includes('/')
    ? storagePath.slice(0, storagePath.lastIndexOf('/'))
    : '';
  const filename = storagePath.split('/').at(-1);
  const { data, error } = await getClient().storage.from(bucket).list(directory, {
    search: filename,
    limit: 10,
  });
  if (error) return false;
  const object = data?.find((item) => item.name === filename);
  if (!object) return false;
  const remoteSize = Number(object.metadata?.size ?? object.metadata?.contentLength);
  return !Number.isSafeInteger(expectedSizeBytes) ||
    !Number.isFinite(remoteSize) ||
    remoteSize === expectedSizeBytes;
}

async function checkStorageReadiness() {
  const supabase = getClient();
  const { data, error } = await supabase.storage.getBucket(BUCKET);
  if (error || !data) {
    throw new Error(
      `Finished-clip storage bucket "${BUCKET}" is unavailable: ${error?.message || 'not found'}`
    );
  }
  if (!data.public) {
    throw new Error(`Finished-clip storage bucket "${BUCKET}" must be public.`);
  }
  return { bucket: BUCKET, public: true };
}

module.exports = {
  uploadClip,
  uploadClipInner,
  verifyUploadedClip,
  withSupabaseRetry,
  isTransientSupabaseError,
  retryDelay,
  checkStorageReadiness,
  BUCKET,
  SUPABASE_TIMEOUT_MS,
  SUPABASE_UPLOAD_MAX_ATTEMPTS,
};
