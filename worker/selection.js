// /worker/selection.js

import { WORKER_CONFIG } from './config.js';

function normalizeHistory(history) {
  const lastSeen = new Map();

  if (!Array.isArray(history)) return lastSeen;

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
    const sourceKey = candidate?.source_key;
    const videoNumber = Number(candidate?.video_number);

    if (!creator || !sourceKey || !Number.isInteger(videoNumber) || videoNumber < 1) continue;

    if (!byCreator.has(creator)) byCreator.set(creator, new Map());

    const videos = byCreator.get(creator);

    if (!videos.has(sourceKey)) {
      videos.set(sourceKey, { ...candidate, video_number: videoNumber });
    }
  }

  if (!byCreator.size) return [];

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

  const queues = creators.map((creator) => ({
    creator,
    videos: [...byCreator.get(creator).values()].sort(
      (a, b) => a.video_number - b.video_number || a.source_key.localeCompare(b.source_key)
    ),
    position: 0
  }));

  const selected = [];
  const perCreatorLimit = WORKER_CONFIG.SELECTION.MAX_VIDEOS_PER_CREATOR_PER_RUN;

  if (!Number.isInteger(perCreatorLimit) || perCreatorLimit < 1) {
    throw new Error('[Tikboo Predator] Invalid per-creator selection limit.');
  }

  // First pass: distribute candidates across creators.
  for (const queue of queues) {
    const count = Math.min(perCreatorLimit, queue.videos.length);

    for (let i = 0; i < count; i += 1) {
      selected.push(queue.videos[queue.position++]);
    }
  }

  // Fallback passes: continue hunting through remaining videos.
  // DAILY_VIDEO_LIMIT is enforced by the orchestrator, not candidate discovery.
  let remaining = true;

  while (remaining) {
    remaining = false;

    for (const queue of queues) {
      if (queue.position >= queue.videos.length) continue;

      remaining = true;

      const count = Math.min(
        perCreatorLimit,
        queue.videos.length - queue.position
      );

      for (let i = 0; i < count; i += 1) {
        selected.push(queue.videos[queue.position++]);
      }
    }
  }

  console.log(
    `[Tikboo Predator] Selection: ${selected.length} candidates across ${creators.length} creators.`
  );

  return selected;
}
