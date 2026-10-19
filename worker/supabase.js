// /worker/supabase.js

import { WORKER_CONFIG } from './config.js';

const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 30000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`[Tikboo Predator] Missing environment variable: ${name}`);
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[Tikboo Predator] Supabase ${response.status}: ${body}`);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function loadAllPages(table, query) {
  const rows = [];
  let offset = 0;

  while (true) {
    const separator = query ? '&' : '?';
    const path = `${table}${query}${separator}limit=${PAGE_SIZE}&offset=${offset}`;

    const data = await request(path, { method: 'GET' });

    if (!Array.isArray(data)) {
      throw new Error(`[Tikboo Predator] Unexpected Supabase response for ${table}.`);
    }

    rows.push(...data);

    if (data.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
  }

  return rows;
}

export async function loadCreatorHandles() {
  const table = WORKER_CONFIG.SUPABASE.CREATORS_TABLE;

  const data = await loadAllPages(
    table,
    '?select=handle&handle=not.is.null&order=handle.asc'
  );

  return [...new Set(data.map((row) => row.handle).filter(Boolean))];
}

export async function loadExistingVideos() {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  return loadAllPages(
    table,
    '?select=id,created_at,creator_handle,source_key,video_number,status,stream_uid&order=created_at.desc,id.desc'
  );
}

export async function loadExistingSourceKeys() {
  const rows = await loadExistingVideos();
  return new Set(rows.map((row) => row.source_key).filter(Boolean));
}

export async function loadCreatorHistory() {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  return loadAllPages(
    table,
    '?select=creator_handle,created_at&creator_handle=not.is.null&order=created_at.desc,id.desc'
  );
}

export async function countVideosCreatedToday() {
  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;
  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));

  const statuses = ['processing', 'ready'];
  const query = `?select=id&created_at=gte.${encodeURIComponent(start.toISOString())}&status=in.(${statuses.join(',')})`;

  const rows = await loadAllPages(table, query);
  return rows.length;
}

export async function createQueuedVideo({ creator_handle, source_key, video_number }) {
  if (!creator_handle || !source_key || !Number.isInteger(video_number) || video_number < 1) {
    throw new Error('[Tikboo Predator] Invalid video candidate.');
  }

  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const data = await request(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      creator_handle,
      source_key,
      video_number,
      status: 'queued'
    })
  });

  if (!Array.isArray(data) || !data[0]?.id) {
    throw new Error('[Tikboo Predator] Supabase did not return created video row.');
  }

  return data[0];
}

export async function updateVideo(id, changes) {
  if (!id) throw new Error('[Tikboo Predator] Missing video id.');

  const table = WORKER_CONFIG.SUPABASE.VIDEOS_TABLE;

  const data = await request(
    `${table}?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(changes)
    }
  );

  if (!Array.isArray(data) || !data[0]?.id) {
    throw new Error(`[Tikboo Predator] Video update failed for row ${id}.`);
  }

  return data[0];
}
