// /worker/index.js

import { WORKER_CONFIG } from './config.js';

import {
  listSourceVideos,
  getSourceObjectInfo,
  createPresignedSourceUrl
} from './r2.js';

import {
  loadCreatorHandles,
  loadExistingVideos,
  loadCreatorHistory,
  createQueuedVideo,
  updateVideo
} from './supabase.js';

import {
  copyVideoToStream,
  getStreamVideo,
  isStreamReady,
  getStreamPlayback
} from './stream.js';

import { selectVideos } from './selection.js';

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 180000;

const MAX_UPLOADS_PER_RUN = 1;
const MAX_RECONCILE_PER_RUN = 100;
const MAX_CANDIDATE_FAILURES = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[Tikboo Predator] ${message}`);
}

function logError(context, error) {
  console.error(
    `[Tikboo Predator] ${context}:`,
    error?.message || error
  );
}

function videoLabel(video) {
  return `${video.creator_handle}/${String(video.video_number).padStart(3, '0')}`;
}

function countDailyReservations(videos) {
  const now = new Date();

  const startOfDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  return videos.filter((video) => {
    const createdAt = Date.parse(video.created_at);

    if (!Number.isFinite(createdAt)) {
      return false;
    }

    if (createdAt < startOfDay) {
      return false;
    }

    if (createdAt > Date.now()) {
      return false;
    }

    return [
      'queued',
      'processing',
      'ready'
    ].includes(video.status);
  }).length;
}

async function finalizeStreamVideo(row) {
  const streamVideo = await getStreamVideo(row.stream_uid);

  if (isStreamReady(streamVideo)) {
    const playback = getStreamPlayback(streamVideo);

    await updateVideo(row.id, {
      stream_uid: playback.stream_uid,
      hls_url: playback.hls_url,
      poster_url: playback.poster_url,
      status: WORKER_CONFIG.SUPABASE.READY_STATUS
    });

    log(`READY: ${videoLabel(row)}`);

    return 'ready';
  }

  if (streamVideo?.status?.state === 'error') {
    await updateVideo(row.id, {
      status: 'error'
    });

    log(`STREAM ERROR: ${videoLabel(row)}`);

    return 'error';
  }

  return 'processing';
}

async function reconcileProcessingVideos(existingVideos) {
  const processing = existingVideos
    .filter(
      (video) =>
        video.status === 'processing' &&
        video.stream_uid
    )
    .slice(0, MAX_RECONCILE_PER_RUN);

  let ready = 0;
  let pending = 0;
  let failed = 0;

  for (const row of processing) {
    try {
      const result = await finalizeStreamVideo(row);

      if (result === 'ready') {
        ready += 1;
      } else if (result === 'error') {
        failed += 1;
      } else {
        pending += 1;
      }
    } catch (error) {
      failed += 1;

      logError(
        `Reconcile failed: ${videoLabel(row)}`,
        error
      );
    }
  }

  log(
    `Reconcile: ready=${ready}, pending=${pending}, errors=${failed}`
  );
}

async function waitUntilReady(row) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      const result = await finalizeStreamVideo(row);

      if (result === 'ready') {
        return true;
      }

      if (result === 'error') {
        return false;
      }
    } catch (error) {
      logError(
        `Polling failed: ${videoLabel(row)}`,
        error
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  log(
    `PENDING: ${videoLabel(row)} — will reconcile on next run.`
  );

  return false;
}

async function processCandidate(candidate) {
  const label = videoLabel(candidate);

  let row = null;
  let uploadAttempted = false;
  let streamUid = null;

  try {
    const source = await getSourceObjectInfo(
      candidate.source_key
    );

    if (!source.exists) {
      log(`SKIP: ${label} — source missing.`);

      return {
        status: 'skip'
      };
    }

    if (source.content_length <= 0) {
      log(`SKIP: ${label} — source empty.`);

      return {
        status: 'skip'
      };
    }

    const sourceUrl = await createPresignedSourceUrl(
      candidate.source_key
    );

    row = await createQueuedVideo({
      creator_handle: candidate.creator_handle,
      source_key: candidate.source_key,
      video_number: candidate.video_number
    });

    log(`HUNT: ${label}`);

    uploadAttempted = true;

    const streamVideo = await copyVideoToStream({
      sourceUrl,
      creatorHandle: candidate.creator_handle,
      sourceKey: candidate.source_key
    });

    if (!streamVideo?.uid) {
      throw new Error(
        'Cloudflare Stream did not return a video UID.'
      );
    }

    streamUid = streamVideo.uid;

    log(`STREAM ACCEPTED: ${label} — ${streamUid}`);

    const processingRow = await updateVideo(row.id, {
      stream_uid: streamUid,
      status: 'processing'
    });

    try {
      await waitUntilReady(processingRow);
    } catch (error) {
      logError(
        `Post-upload processing failed: ${label}`,
        error
      );
    }

    return {
      status: 'accepted'
    };
  } catch (error) {
    logError(`Candidate failed: ${label}`, error);

    if (!row) {
      return {
        status: 'skip'
      };
    }

    if (streamUid) {
      try {
        await updateVideo(row.id, {
          stream_uid: streamUid,
          status: 'processing'
        });
      } catch (updateError) {
        logError(
          `Unable to preserve Stream UID: ${label}`,
          updateError
        );
      }

      return {
        status: 'accepted'
      };
    }

    if (uploadAttempted) {
      log(
        `UNCERTAIN: ${label} — preserving queued record to prevent duplicate upload.`
      );

      return {
        status: 'uncertain'
      };
    }

    try {
      await updateVideo(row.id, {
        status: 'error'
      });
    } catch (updateError) {
      logError(
        `Unable to mark candidate error: ${label}`,
        updateError
      );
    }

    return {
      status: 'skip'
    };
  }
}

async function main() {
  console.log('');
  console.log('========================================');
  console.log('TIKBOO PREDATOR ENGINE');
  console.log('========================================');
  console.log('');

  log('Initializing hunting protocol.');

  const existingVideos = await loadExistingVideos();

  await reconcileProcessingVideos(existingVideos);

  const freshVideos = await loadExistingVideos();

  const todayCount = countDailyReservations(freshVideos);

  log(
    `Daily reservations: ${todayCount}/${WORKER_CONFIG.DAILY_VIDEO_LIMIT}`
  );

  if (todayCount >= WORKER_CONFIG.DAILY_VIDEO_LIMIT) {
    log(
      'Daily limit reached. Hunting suspended until next UTC day.'
    );

    return;
  }

  const [
    creators,
    sourceVideos,
    history
  ] = await Promise.all([
    loadCreatorHandles(),
    listSourceVideos(),
    loadCreatorHistory()
  ]);

  if (!creators.length) {
    log('No creators available.');

    return;
  }

  const allowedCreators = new Set(creators);

  const existingKeys = new Set(
    freshVideos
      .map((video) => video.source_key)
      .filter(Boolean)
  );

  const candidates = sourceVideos.filter(
    (video) =>
      allowedCreators.has(video.creator_handle) &&
      !existingKeys.has(video.source_key)
  );

  log(
    `Discovery: ${sourceVideos.length} sources, ${candidates.length} candidates.`
  );

  const selected = selectVideos(
    candidates,
    history
  );

  if (!selected.length) {
    log('No eligible targets.');

    return;
  }

  let accepted = 0;
  let skipped = 0;
  let uncertain = 0;
  let failures = 0;

  for (const candidate of selected) {
    if (accepted >= MAX_UPLOADS_PER_RUN) {
      break;
    }

    if (failures >= MAX_CANDIDATE_FAILURES) {
      log('Candidate failure limit reached.');

      break;
    }

    const result = await processCandidate(candidate);

    if (result.status === 'accepted') {
      accepted += 1;

      break;
    }

    if (result.status === 'uncertain') {
      uncertain += 1;

      // The upload may already exist in Cloudflare Stream.
      // Never start another upload during this run.

      break;
    }

    skipped += 1;
    failures += 1;
  }

  log('----------------------------------------');

  log(
    `Hunt complete: accepted=${accepted}, skipped=${skipped}, uncertain=${uncertain}`
  );

  log('----------------------------------------');
}

main()
  .then(() => {
    log('Run completed.');
  })
  .catch((error) => {
    logError('FATAL', error);

    process.exitCode = 1;
  });
