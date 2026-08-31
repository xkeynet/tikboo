// /assets/js/feed/supabase-feed.js

import { supabase } from '../utils/supabaseClient.js';

const PAGE_SIZE = 1000;

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

async function loadAllReadyVideos() {
  const videos = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('videos')
      .select(`
        id,
        created_at,
        creator_handle,
        hls_url,
        poster_url
      `)
      .eq('status', 'ready')
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    videos.push(...data);

    if (data.length < PAGE_SIZE) break;
  }

  return videos;
}

function buildCreatorBalancedFeed(videos) {
  const byCreator = new Map();

  for (const video of videos) {
    if (!video.creator_handle) continue;

    if (!byCreator.has(video.creator_handle)) {
      byCreator.set(video.creator_handle, []);
    }

    byCreator.get(video.creator_handle).push(video);
  }

  const creators = shuffle([...byCreator.keys()]);

  for (const creator of creators) {
    byCreator.set(creator, shuffle(byCreator.get(creator)));
  }

  const ordered = [];
  let added = true;

  while (added) {
    added = false;

    for (const creator of creators) {
      const creatorVideos = byCreator.get(creator);

      if (!creatorVideos.length) continue;

      ordered.push(creatorVideos.shift());
      added = true;
    }
  }

  return ordered;
}

export async function loadSupabaseFeed() {
  const videos = buildCreatorBalancedFeed(await loadAllReadyVideos());

  const { data: creators, error: creatorsError } = await supabase
    .from('creators')
    .select(`
      handle,
      avatar_url,
      follow_url,
      is_live
    `);

  if (creatorsError) throw creatorsError;

  const creatorsByHandle = new Map(
    creators.map((creator) => [creator.handle, creator])
  );

  return videos.map((video) => {
    const creator = creatorsByHandle.get(video.creator_handle);

    return {
      id: video.id,
      type: 'video',
      creator: video.creator_handle,
      caption: `@${video.creator_handle}`,
      followUrl: creator?.follow_url || '',
      avatar: creator?.avatar_url || '',
      isLive: creator?.is_live === true,
      manifest: video.hls_url,
      poster: video.poster_url
    };
  });
}
