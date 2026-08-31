// /worker/r2.js

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { WORKER_CONFIG } from './config.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`[Tikboo Worker] Missing environment variable: ${name}`);
  return value;
}

function createR2Client() {
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  });
}

function parseVideoKey(key) {
  const root = WORKER_CONFIG.R2.VIDEO_ROOT;
  const extension = WORKER_CONFIG.R2.VIDEO_EXTENSION;

  if (!key?.startsWith(`${root}/`) || !key.endsWith(extension)) return null;

  const relative = key.slice(root.length + 1);
  const parts = relative.split('/');

  if (parts.length !== 2) return null;

  const [creatorHandle, filename] = parts;
  if (!creatorHandle || !filename) return null;

  return {
    creator_handle: creatorHandle,
    filename,
    r2_key: key
  };
}

export async function listR2VideoCandidates() {
  const client = createR2Client();
  const bucket = requireEnv('R2_BUCKET_NAME');
  const candidates = [];

  let continuationToken;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${WORKER_CONFIG.R2.VIDEO_ROOT}/`,
      ContinuationToken: continuationToken
    }));

    for (const object of response.Contents || []) {
      const candidate = parseVideoKey(object.Key);
      if (candidate) candidates.push(candidate);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return candidates;
}
