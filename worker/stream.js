// /worker/stream.js

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`[Tikboo Worker] Missing environment variable: ${name}`);
  return value;
}

function getStreamConfig() {
  return {
    accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requireEnv('CLOUDFLARE_STREAM_API_TOKEN')
  };
}

async function streamRequest(path, options = {}) {
  const { accountId, apiToken } = getStreamConfig();

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...options.headers
      }
    }
  );

  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.success === false) {
    throw new Error(
      `[Tikboo Worker] Cloudflare Stream ${response.status}: ${JSON.stringify(payload)}`
    );
  }

  return payload?.result ?? null;
}

export async function uploadVideoToStream({
  body,
  contentLength,
  filename
}) {
  if (!body) throw new Error('[Tikboo Worker] Missing video body.');
  if (!contentLength) throw new Error('[Tikboo Worker] Missing video content length.');
  if (!filename) throw new Error('[Tikboo Worker] Missing video filename.');

  const form = new FormData();
  const blob = new Blob([body], { type: 'video/mp4' });

  form.append('file', blob, filename);

  return streamRequest('', {
    method: 'POST',
    body: form
  });
}

export async function getStreamVideo(streamUid) {
  if (!streamUid) throw new Error('[Tikboo Worker] Missing Stream UID.');

  return streamRequest(`/${encodeURIComponent(streamUid)}`, {
    method: 'GET'
  });
}

export function buildStreamUrls(streamUid, customerCode) {
  if (!streamUid) throw new Error('[Tikboo Worker] Missing Stream UID.');
  if (!customerCode) throw new Error('[Tikboo Worker] Missing Cloudflare Stream customer code.');

  const base = `https://customer-${customerCode}.cloudflarestream.com/${streamUid}`;

  return {
    hls_url: `${base}/manifest/video.m3u8`,
    poster_url: `${base}/thumbnails/thumbnail.jpg?time=0s&fit=crop&height=1080`
  };
}

export function isStreamReady(video) {
  return video?.readyToStream === true && video?.status?.state === 'ready';
}
