// /worker/index.js

import { WORKER_CONFIG } from './config.js';
import { buildSourceKey, getSourceObjectInfo, createPresignedSourceUrl } from './r2.js';
import {
  loadCreatorHandles,
  loadExistingVideos,
  loadCreatorHistory,
  countVideosCreatedToday,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finalizeStreamVideo(row) {
  const streamVideo = await getStreamVideo(row.stream_uid);

  if (!isStreamReady(streamVideo)) return false;

  const playback = getStreamPlayback(streamVideo);

  await updateVideo(row.id, {
    stream_uid: playback.stream_uid,
    hls_url: playback.hls_url,
    poster_url: playback.poster_url,
    status: 'ready'
  });

  console.log(
    `[Tikboo Worker] READY: ${row.creator_handle}/${String(row.video_number).padStart(3, '0')}`
  );

  return true;
}

async function reconcileProcessingVideos(existingVideos) {
  const processing = existingVideos.filter(
    (video) =>
      video.status === 'processing' &&
      video.stream_uid
  );

  for (const row of processing) {
    try {
      await finalizeStreamVideo(row);
    } catch (error) {
      console.error(
        `[Tikboo Worker] Reconcile failed for row ${row.id}:`,
        error
      );
    }
  }
}

function buildNextCandidates(creators, existingVideos) {
  const highestNumberByCreator = new Map();

  for (const video of existingVideos) {
    const creator = video.creator_handle;
    const number = Number(video.video_number);

    if (!creator || !Number.isInteger(number)) continue;

    const current = highestNumberByCreator.get(creator) || 0;

    if (number > current) {
      highestNumberByCreator.set(creator, number);
    }
  }

  return creators
    .map((creator_handle) => {
      const video_number =
        (highestNumberByCreator.get(creator_handle) || 0) + 1;

      if (video_number > 99) return null;

      return {
        creator_handle,
        video_number,
        source_key: buildSourceKey(
          creator_handle,
          video_number
        )
      };
    })
    .filter(Boolean);
}

async function waitUntilReady(row) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const streamVideo = await getStreamVideo(row.stream_uid);

    if (isStreamReady(streamVideo)) {
      const playback = getStreamPlayback(streamVideo);

      await updateVideo(row.id, {
        stream_uid: playback.stream_uid,
        hls_url: playback.hls_url,
        poster_url: playback.poster_url,
        status: 'ready'
      });

      console.log();
      console.log('[Tikboo Worker] VIDEO READY');
      console.log(`Creator: ${row.creator_handle}`);
      console.log(
        `Video:   ${String(row.video_number).padStart(3, '0')}`
      );
      console.log(`HLS:     ${playback.hls_url}`);
      console.log();

      return true;
    }

    const state = streamVideo?.status?.state;

    if (state === 'error') {
      await updateVideo(row.id, {
        status: 'error'
      });

      throw new Error(
        `[Tikboo Worker] Cloudflare Stream processing failed for ${row.stream_uid}.`
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.log(
    `[Tikboo Worker] Stream ${row.stream_uid} is still processing. It will be checked again on the next run.`
  );

  return false;
}

async function processCandidate(candidate) {
  const source = await getSourceObjectInfo(
    candidate.source_key
  );

  if (!source.exists) {
    console.log(
      `[Tikboo Worker] Source does not exist: ${candidate.source_key}`
    );

    return false;
  }

  console.log();
  console.log('[Tikboo Worker] SELECTED');
  console.log(`Creator: ${candidate.creator_handle}`);
  console.log(
    `Video:   ${String(candidate.video_number).padStart(3, '0')}`
  );
  console.log(`Source:  ${candidate.source_key}`);

  const row = await createQueuedVideo({
    creator_handle: candidate.creator_handle,
    source_key: candidate.source_key,
    video_number: candidate.video_number
  });

  try {
    const sourceUrl = await createPresignedSourceUrl(
      candidate.source_key
    );

    const streamVideo = await copyVideoToStream({
      sourceUrl,
      creatorHandle: candidate.creator_handle,
      sourceKey: candidate.source_key
    });

    if (!streamVideo?.uid) {
      throw new Error(
        '[Tikboo Worker] Cloudflare Stream did not return a video UID.'
      );
    }

    const processingRow = await updateVideo(row.id, {
      stream_uid: streamVideo.uid,
      status: 'processing'
    });

    console.log(
      `[Tikboo Worker] Stream UID: ${streamVideo.uid}`
    );

    await waitUntilReady(processingRow);

    return true;
  } catch (error) {
    await updateVideo(row.id, {
      status: 'error'
    });

    throw error;
  }
}

async function main() {
  console.log();
  console.log('========================================');
  console.log('TIKBOO MEDIA ORCHESTRATOR');
  console.log('========================================');
  console.log();

  const existingVideos = await loadExistingVideos();

  await reconcileProcessingVideos(existingVideos);

  const createdToday = await countVideosCreatedToday();

  console.log(
    `[Tikboo Worker] Daily usage: ${createdToday}/${WORKER_CONFIG.DAILY_VIDEO_LIMIT}`
  );

  if (createdToday >= WORKER_CONFIG.DAILY_VIDEO_LIMIT) {
    console.log('[Tikboo Worker] Daily video limit reached.');
    return;
  }

  const creators = await loadCreatorHandles();

  if (!creators.length) {
    console.log('[Tikboo Worker] No creators found.');
    return;
  }

  const freshVideos = await loadExistingVideos();
  const history = await loadCreatorHistory();

  const candidates = buildNextCandidates(
    creators,
    freshVideos
  );

  const orderedCandidates = selectVideos(
    candidates,
    history
  );

  if (!orderedCandidates.length) {
    console.log('[Tikboo Worker] No candidates available.');
    return;
  }

  /*
   * HARD RULE:
   * One worker execution may successfully start
   * processing MAXIMUM ONE new video.
   *
   * DAILY_VIDEO_LIMIT is enforced independently.
   */
  for (const candidate of orderedCandidates) {
    const exists = await getSourceObjectInfo(
      candidate.source_key
    );

    if (!exists.exists) continue;

    await processCandidate(candidate);
    return;
  }

  console.log(
    '[Tikboo Worker] No selected creator has another source video.'
  );
}

main()
  .then(() => {
    console.log('[Tikboo Worker] Run completed.');
  })
  .catch((error) => {
    console.error('[Tikboo Worker] FATAL:', error);
    process.exitCode = 1;
  });
