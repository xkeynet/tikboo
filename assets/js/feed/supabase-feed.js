// /assets/js/feed/supabase-feed.js

import { supabase } from '../utils/supabaseClient.js';

const PAGE_SIZE = 1000;

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
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data?.length) break;

    videos.push(...data);

    if (data.length < PAGE_SIZE) break;
  }

  return videos;
}

export async function loadSupabaseFeed() {
  const videos = await loadAllReadyVideos();

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
