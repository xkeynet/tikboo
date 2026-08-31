// /assets/js/worker/config.js

export const WORKER_CONFIG = Object.freeze({
  // Processing
  DAILY_VIDEO_LIMIT: 4,
  CREATOR_FIRST: true,

  // Source storage
  R2: Object.freeze({
    VIDEO_ROOT: 'creators',
    VIDEO_EXTENSION: '.mp4'
  }),

  // Cloudflare Stream
  STREAM: Object.freeze({
    ENABLED: true
  }),

  // Supabase
  SUPABASE: Object.freeze({
    CREATORS_TABLE: 'creators',
    VIDEOS_TABLE: 'videos',
    READY_STATUS: 'ready'
  }),

  // Selection
  SELECTION: Object.freeze({
    SHUFFLE_CREATORS: true,
    MAX_VIDEOS_PER_CREATOR_PER_RUN: 1
  })
});
