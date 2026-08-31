// /worker/selection.js

import { WORKER_CONFIG } from './config.js';

function normalizeHistory(history) {
  const lastSeen = new Map();

  for (let i = 0; i < history.length; i += 1) {
    const handle = history[i]?.creator_handle;
    if (!handle || lastSeen.has(handle)) continue;
    lastSeen.set(handle, i);
  }

  return lastSeen;
}

export function selectVideos(candidates, history = []) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const byCreator = new Map();

  for (const candidate of candidates) {
    const creator = candidate?.creator_handle;
    if (!creator) continue;

    if (!byCreator.has(creator)) byCreator.set(creator, []);
    byCreator.get(creator).push(candidate);
  }

  const lastSeen = normalizeHistory(history);

  const creators = [...byCreator.keys()].sort((a, b) => {
    const aSeen = lastSeen.has(a);
    const bSeen = lastSeen.has(b);

    if (!aSeen && !bSeen) return a.localeCompare(b);
    if (!aSeen) return -1;
    if (!bSeen) return 1;

    const positionDiff = lastSeen.get(b) - lastSeen.get(a);
    return positionDiff || a.localeCompare(b);
  });

  const selected = [];
  const perCreatorLimit = WORKER_CONFIG.SELECTION.MAX_VIDEOS_PER_CREATOR_PER_RUN;
  const runLimit = WORKER_CONFIG.DAILY_VIDEO_LIMIT;

  for (const creator of creators) {
    if (selected.length >= runLimit) break;

    const videos = [...byCreator.get(creator)].sort(
      (a, b) => a.video_number - b.video_number
    );

    for (
      let i = 0;
      i < Math.min(perCreatorLimit, videos.length) &&
      selected.length < runLimit;
      i += 1
    ) {
      selected.push(videos[i]);
    }
  }

  return selected;
}
