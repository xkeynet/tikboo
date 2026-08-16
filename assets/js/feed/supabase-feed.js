// /assets/js/feed/supabase-feed.js

import { supabase } from '../utils/supabaseClient.js';

export async function loadSupabaseFeed() {
  const { data: videos, error: videosError } = await supabase
    .from('videos')
    .select(`
      id,
      created_at,
      creator_handle,
      hls_url,
      poster_url
    `)
    .eq('processing_status', 'ready')
    .eq('hls_ready', true)
    .eq('is_active', true)
    .order('last_processed_at', { ascending: false, nullsFirst: false });

  if (videosError) {
    throw videosError;
  }

  const { data: creators, error: creatorsError } = await supabase
    .from('creators')
    .select(`
      handle,
      avatar_url,
      follow_url
    `);

  if (creatorsError) {
    throw creatorsError;
  }

  const creatorsByHandle = new Map(
    creators.map((creator) => [
      creator.handle,
      creator
    ])
  );

  return videos.map((video) => {
    const creator = creatorsByHandle.get(
      video.creator_handle
    );

    return {
      id: video.id,
      type: 'video',
      creator: video.creator_handle,
      caption: `@${video.creator_handle}`,
      followUrl: creator?.follow_url || '',
      avatar: creator?.avatar_url || '',
      manifest: video.hls_url,
      poster: video.poster_url
    };
  });
}
