// /assets/js/worker/selection.js

import { WORKER_CONFIG } from './config.js';

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

export function selectVideos(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const byCreator = new Map();

  for (const candidate of candidates) {
    const creator = candidate?.creator_handle;
    if (!creator) continue;

    if (!byCreator.has(creator)) byCreator.set(creator, []);
    byCreator.get(creator).push(candidate);
  }

  let creators = [...byCreator.keys()];

  if (WORKER_CONFIG.SELECTION.SHUFFLE_CREATORS) {
    creators = shuffle(creators);
  }

  const selected = [];
  const perCreatorLimit = WORKER_CONFIG.SELECTION.MAX_VIDEOS_PER_CREATOR_PER_RUN;
  const dailyLimit = WORKER_CONFIG.DAILY_VIDEO_LIMIT;

  for (const creator of creators) {
    if (selected.length >= dailyLimit) break;

    const videos = shuffle(byCreator.get(creator));
    const take = Math.min(perCreatorLimit, videos.length);

    for (let i = 0; i < take && selected.length < dailyLimit; i += 1) {
      selected.push(videos[i]);
    }
  }

  return selected;
}
