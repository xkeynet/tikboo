// /worker/r2.js

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  });
}

export function buildSourceKey(creatorHandle, videoNumber) {
  if (!creatorHandle) {
    throw new Error('[Tikboo Worker] Missing creator handle.');
  }

  if (
    !Number.isInteger(videoNumber) ||
    videoNumber < 1 ||
    videoNumber > 99
  ) {
    throw new Error(
      `[Tikboo Worker] Invalid video number: ${videoNumber}`
    );
  }

  const number = String(videoNumber).padStart(3, '0');

  return (
    `${WORKER_CONFIG.R2.VIDEO_ROOT}/` +
    `${creatorHandle}/` +
    `${number}${WORKER_CONFIG.R2.VIDEO_EXTENSION}`
  );
}

export async function listSourceVideos() {
  const client = createR2Client();
  const bucket = requireEnv('R2_BUCKET_NAME');
  const prefix = `${WORKER_CONFIG.R2.VIDEO_ROOT}/`;

  const videos = [];
  let continuationToken;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000
      })
    );

    for (const object of response.Contents || []) {
      const key = object.Key;
      if (!key || !key.endsWith(WORKER_CONFIG.R2.VIDEO_EXTENSION)) continue;

      const relativePath = key.slice(prefix.length);
      const parts = relativePath.split('/');

      if (parts.length !== 2) continue;

      const [creatorHandle, filename] = parts;
      if (!creatorHandle) continue;

      const numberString = filename.slice(
        0,
        -WORKER_CONFIG.R2.VIDEO_EXTENSION.length
      );

      if (!/^\d{3}$/.test(numberString)) continue;

      const videoNumber = Number(numberString);

      if (videoNumber < 1 || videoNumber > 99) continue;

      videos.push({
        creator_handle: creatorHandle,
        video_number: videoNumber,
        source_key: key,
        content_length: Number(object.Size || 0),
        last_modified: object.LastModified || null
      });
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;

    if (response.IsTruncated && !continuationToken) {
      throw new Error('[Tikboo Worker] R2 pagination token missing.');
    }
  } while (continuationToken);

  console.log(`[Tikboo Worker] R2 discovery: ${videos.length} source videos found.`);

  return videos;
}

export async function getSourceObjectInfo(sourceKey) {
  if (!sourceKey) {
    throw new Error('[Tikboo Worker] Missing R2 source key.');
  }

  const client = createR2Client();
  const bucket = requireEnv('R2_BUCKET_NAME');

  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: sourceKey
      })
    );

    return {
      exists: true,
      source_key: sourceKey,
      content_length: Number(response.ContentLength || 0),
      content_type: response.ContentType || 'video/mp4',
      etag: response.ETag || null
    };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;

    if (
      status === 404 ||
      error?.name === 'NotFound' ||
      error?.name === 'NoSuchKey'
    ) {
      return {
        exists: false,
        source_key: sourceKey
      };
    }

    throw error;
  }
}

export async function createPresignedSourceUrl(
  sourceKey,
  expiresInSeconds = 3600
) {
  if (!sourceKey) {
    throw new Error('[Tikboo Worker] Missing R2 source key.');
  }

  const client = createR2Client();
  const bucket = requireEnv('R2_BUCKET_NAME');

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: sourceKey
  });

  return getSignedUrl(
    client,
    command,
    {
      expiresIn: expiresInSeconds
    }
  );
}
