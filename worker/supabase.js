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
    `${table}?select=handle&handle=not.is.null`,
    { method: 'GET' }
  );

  return new Set(
    (Array.isArray(data) ? data : [])
      .map((row) => row.handle)
      .filter(Boolean)
  );
}

export async function loadExistingSourceKeys() {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const data = await request(
    `${table}?select=source_key&source_key=not.is.null`,
    { method: 'GET' }
  );

  return new Set(
    (Array.isArray(data) ? data : [])
      .map((row) => row.source_key)
      .filter(Boolean)
  );
}

export async function createQueuedVideo({
  creator_handle,
  source_key,
  video_number
}) {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const [row] = await request(table, {
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

  return row;
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
