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
        'Content-Type': 'application/json',
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

export async function copyVideoToStream({
  sourceUrl,
  creatorHandle,
  sourceKey
}) {
  if (!sourceUrl) throw new Error('[Tikboo Worker] Missing source URL.');
  if (!creatorHandle) throw new Error('[Tikboo Worker] Missing creator handle.');
  if (!sourceKey) throw new Error('[Tikboo Worker] Missing source key.');

  return streamRequest('/copy', {
    method: 'POST',
    body: JSON.stringify({
      input: sourceUrl,
      creator: creatorHandle,
      meta: {
        creator_handle: creatorHandle,
        source_key: sourceKey
      }
    })
  });
}

export async function getStreamVideo(streamUid) {
  if (!streamUid) throw new Error('[Tikboo Worker] Missing Stream UID.');

  return streamRequest(`/${encodeURIComponent(streamUid)}`, {
    method: 'GET'
  });
}

export function isStreamReady(video) {
  return video?.readyToStream === true && video?.status?.state === 'ready';
}

export function getStreamPlayback(video) {
  if (!video?.uid) {
    throw new Error('[Tikboo Worker] Stream video UID is missing.');
  }

  const hlsUrl = video?.playback?.hls || null;
  const posterUrl = video?.thumbnail || null;

  if (!hlsUrl) {
    throw new Error(`[Tikboo Worker] HLS URL missing for Stream UID ${video.uid}.`);
  }

  return {
    stream_uid: video.uid,
    hls_url: hlsUrl,
    poster_url: posterUrl
  };
}
