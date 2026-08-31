// /worker/supabase.js

import { WORKER_CONFIG } from './config.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`[Tikboo Worker] Missing environment variable: ${name}`);
  return value;
}

function getSupabaseConfig() {
  return {
    url: requireEnv('SUPABASE_URL').replace(/\/+$/, ''),
    serviceKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  };
}

async function request(path, options = {}) {
  const { url, serviceKey } = getSupabaseConfig();

  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[Tikboo Worker] Supabase ${response.status}: ${body}`);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function loadCreatorHandles() {
  const table = WORKER_CONFIG.SUPABASE.CREATORS_TABLE;

  const data = await request(
    `${table}?select=handle&handle=not.is.null&order=handle.asc`,
    { method: 'GET' }
  );

  return (Array.isArray(data) ? data : [])
    .map((row) => row.handle)
    .filter(Boolean);
}

export async function loadExistingVideos() {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const data = await request(
    `${table}?select=id,created_at,creator_handle,source_key,video_number,status,stream_uid&order=created_at.desc`,
    { method: 'GET' }
  );

  return Array.isArray(data) ? data : [];
}

export async function loadExistingSourceKeys() {
  const rows = await loadExistingVideos();

  return new Set(
    rows
      .map((row) => row.source_key)
      .filter(Boolean)
  );
}

export async function loadCreatorHistory() {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const data = await request(
    `${table}?select=creator_handle,created_at&creator_handle=not.is.null&order=created_at.desc&limit=1000`,
    { method: 'GET' }
  );

  return Array.isArray(data) ? data : [];
}

export async function countVideosCreatedToday() {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0
  ));

  const data = await request(
    `${table}?select=id&created_at=gte.${encodeURIComponent(start.toISOString())}`,
    { method: 'GET' }
  );

  return Array.isArray(data) ? data.length : 0;
}

export async function createQueuedVideo({
  creator_handle,
  source_key,
  video_number
}) {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const data = await request(table, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      creator_handle,
      source_key,
      video_number,
      status: 'queued'
    })
  });

  if (!Array.isArray(data) || !data[0]) {
    throw new Error('[Tikboo Worker] Supabase did not return created video row.');
  }

  return data[0];
}

export async function updateVideo(id, changes) {
  if (!id) throw new Error('[Tikboo Worker] Missing video id.');

  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const data = await request(
    `${table}?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify(changes)
    }
  );

  return Array.isArray(data) ? data[0] || null : null;
}
