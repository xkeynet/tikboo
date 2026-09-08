// /assets/js/app.js

import { loadSupabaseFeed } from './feed/supabase-feed.js';
import { getVideoIdFromUrl } from './routing/video-route.js';

import { initInteractions } from './ui/interactions.js';
import {
  initVideoShareSheet,
  openVideoShareSheet
} from './ui/share.js';

// === iOS SAFARI: KILL ZOOM (pinch + gesture) ===
document.addEventListener('touchmove', (e) => {
  if (e.scale && e.scale !== 1) e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

document.addEventListener('DOMContentLoaded', async () => {
  let PLAYLIST;

  try {
    PLAYLIST = await loadSupabaseFeed();
  } catch (error) {
    console.error('[Tikboo] Supabase feed load failed:', error);
    return;
  }

  if (!Array.isArray(PLAYLIST) || !PLAYLIST.length) {
    console.info('[Tikboo] Supabase feed is empty. Waiting for ready videos.');
    return;
  }

  // =========================================================
  // === State ===
  // =========================================================
  const refs = {
    layerPrev: document.getElementById('layerPrev'),
    layerCurrent: document.getElementById('layerCurrent'),
    layerNext: document.getElementById('layerNext'),

    videoPrev: document.getElementById('videoPrev'),
    videoCurrent: document.getElementById('videoCurrent'),
    videoNext: document.getElementById('videoNext'),

    imgPrev: document.getElementById('imgPrev'),
    imgCurrent: document.getElementById('imgCurrent'),
    imgNext: document.getElementById('imgNext'),

    playOverlay: document.getElementById('playOverlay')
  };

  const seekWrap = document.getElementById('seekWrap');
  const seekPill = document.getElementById('seekPill');
  const seekFill = document.getElementById('seekFill');
  const seekTime = document.getElementById('seekTime');

  const state = {
    index: 0,
    isAnimating: false,
    isMuted: true
  };

  const requestedVideoId = getVideoIdFromUrl();

  if (requestedVideoId !== null) {
    const requestedIndex = PLAYLIST.findIndex(
      (item) => String(item.id) === requestedVideoId
    );

    if (requestedIndex !== -1) {
      state.index = requestedIndex;
    }
  }

  let swipeEngine = null;
  let cookieConsent = null;

  let autoTimer = 0;
  let autoBoundVideo = null;

  let progRaf = 0;
  let pillTouching = false;
  let pillSeeking = false;
  let pillStartX = 0;
  let pillStartY = 0;
  let pillMoved = false;
  let wasPlayingBeforeSeek = false;

  let seekRaf = 0;
  let seekLatestX = 0;

  let seekActiveOffTimer = 0;
  let timeupdateBoundEl = null;

  let ageGateUnlocked = window.TikbooCookieConsent.isUnlocked();

  // =========================================================
  // === GA4 SAFE HELPER ===
  // =========================================================
  function track(eventName, params = {}) {
    if (typeof window.gtag !== 'function') return;

    window.gtag('event', eventName, {
      page_title: document.title,
      page_location: window.location.href,
      page_path: window.location.pathname,
      ...params
    });
  }

  function showPlayOverlay(show) {
    if (!refs.playOverlay) return;
    refs.playOverlay.style.opacity = show ? '1' : '0';
  }

  function getAllSides() {
    return [
      refs.layerCurrent?.querySelector('.side'),
      refs.layerNext?.querySelector('.side')
    ].filter(Boolean);
  }

  function setAllSidesScrubbing(on) {
    getAllSides().forEach((sideEl) => {
      sideEl.classList.toggle('scrubbing', !!on);
      sideEl.style.opacity = on ? '0' : '';
      sideEl.style.pointerEvents = on ? 'none' : '';
      sideEl.style.display = on ? 'none' : '';

      const layer = sideEl.closest('.twincher-layer');
      const videoMeta = layer?.querySelector('.video-meta');

      if (videoMeta) {
        videoMeta.classList.toggle('scrubbing', !!on);
        videoMeta.style.opacity = on ? '0' : '';
        videoMeta.style.pointerEvents = on ? 'none' : '';
        videoMeta.style.display = on ? 'none' : '';
      }
    });
  }

  function clearSeekInactiveTimer() {
    if (seekActiveOffTimer) {
      clearTimeout(seekActiveOffTimer);
      seekActiveOffTimer = 0;
    }
  }

  function queueSeekInactive() {
    clearSeekInactiveTimer();

    if (seekTime) seekTime.classList.remove('is-active');
    setAllSidesScrubbing(false);

    seekActiveOffTimer = setTimeout(() => {
      if (seekPill) seekPill.classList.remove('is-active');
      seekActiveOffTimer = 0;
    }, 3000);
  }

  // === HARDEN VIDEO ELEMENTS FOR iOS / SMOOTHNESS ===
  refs.videoPrev.preload = 'auto';
  refs.videoCurrent.preload = 'auto';
  refs.videoNext.preload = 'auto';

  [refs.videoPrev, refs.videoCurrent, refs.videoNext].forEach((v) => {
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('disablepictureinpicture', '');
    v.setAttribute('x-webkit-airplay', 'deny');
  });

  [refs.imgPrev, refs.imgCurrent, refs.imgNext].forEach((img) => {
    img.decoding = 'async';
  });

  function defer(fn) {
    setTimeout(fn, 0);
  }

  // =========================================================
  // === Video Metadata Layer ===
  // =========================================================
  function collapseAllVideoMeta() {
    document.querySelectorAll('.video-meta.expanded').forEach((meta) => {
      meta.classList.remove('expanded');
    });
  }

  function setLayerVideoMeta(layer, item) {
    if (!layer || !item) return;

    const meta = layer.querySelector('.video-meta');
    if (!meta) return;

    const creatorEl = meta.querySelector('.video-meta-creator');
    const captionEl = meta.querySelector('.video-meta-caption');
    const followEl = meta.querySelector('.video-meta-follow');
    const avatarEl = layer.querySelector('.avatar');
    const avatarStack = avatarEl?.closest('.avatar-stack');

    const creator = item.creator || '';
    const caption = item.caption || '';
    const followUrl = item.followUrl || '';
    const avatar = item.avatar || '';

    meta.classList.remove('expanded');

    if (creatorEl) {
      creatorEl.textContent = creator;
    }

    if (captionEl) {
      captionEl.textContent = caption;
      captionEl.style.display = caption ? '' : 'none';
    }

    if (followEl) {
      if (followUrl) {
        followEl.href = followUrl;
        followEl.setAttribute('target', '_blank');
        followEl.setAttribute('rel', 'noopener noreferrer');
        followEl.setAttribute('aria-disabled', 'false');
      } else {
        followEl.href = '#';
        followEl.removeAttribute('target');
        followEl.setAttribute('rel', 'noopener noreferrer');
        followEl.setAttribute('aria-disabled', 'true');
      }
    }

    if (avatarEl) {
      if (avatar) {
        avatarEl.dataset.pendingAvatar = avatar;

        if (avatarStack) {
          avatarStack.style.visibility = 'hidden';
          avatarStack.style.display = '';
        }

        const loader = new Image();
        loader.decoding = 'async';

        const applyAvatar = () => {
          if (avatarEl.dataset.pendingAvatar !== avatar) return;

          avatarEl.src = avatar;
          avatarEl.alt = creator ? `${creator} avatar` : 'Creator avatar';

          if (avatarStack) {
            avatarStack.style.visibility = 'visible';
          }
        };

        loader.onload = () => {
          if (typeof loader.decode === 'function') {
            loader.decode()
              .then(applyAvatar)
              .catch(applyAvatar);
          } else {
            applyAvatar();
          }
        };

        loader.onerror = () => {
          if (avatarEl.dataset.pendingAvatar !== avatar) return;

          avatarEl.removeAttribute('src');
          avatarEl.alt = '';

          if (avatarStack) {
            avatarStack.style.visibility = 'hidden';
          }
        };

        loader.src = avatar;

        if (loader.complete && loader.naturalWidth > 0) {
          applyAvatar();
        }
      } else {
        delete avatarEl.dataset.pendingAvatar;
        avatarEl.removeAttribute('src');
        avatarEl.alt = '';

        if (avatarStack) {
          avatarStack.style.visibility = 'hidden';
          avatarStack.style.display = 'none';
        }
      }
    }
  }

  document.addEventListener('click', (e) => {
    const followEl = e.target.closest('.video-meta-follow');
    if (!followEl) return;

    const href = followEl.getAttribute('href') || '';
    const disabled = followEl.getAttribute('aria-disabled') === 'true';

    if (disabled || !href || href === '#') {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  document.addEventListener('click', (e) => {
    const captionEl = e.target.closest('.video-meta-caption');
    if (!captionEl) return;

    e.preventDefault();
    e.stopPropagation();

    const meta = captionEl.closest('.video-meta');
    if (!meta) return;

    if (meta.classList.contains('expanded')) {
      meta.classList.remove('expanded');
      return;
    }

    const isOverflowing = captionEl.scrollWidth > captionEl.clientWidth + 1;
    if (!isOverflowing) return;

    collapseAllVideoMeta();
    meta.classList.add('expanded');
  }, true);

  // =========================================================
  // === Video Engine ===
  // =========================================================
  function updateSeekFill() {
    const d = refs.videoCurrent.duration;

    if (d && isFinite(d) && d > 0) {
      const p = Math.max(
        0,
        Math.min(1, refs.videoCurrent.currentTime / d)
      );

      seekFill.style.width = (p * 100) + '%';
    } else {
      seekFill.style.width = '0%';
    }
  }

  function syncSoundUI() {
    /* sound UI removed intentionally */
  }

  function ensureSoundOn(shouldPlay) {
    if (!ageGateUnlocked) {
      if (shouldPlay) tryPlay(refs.videoCurrent);
      return;
    }

    if (!state.isMuted) {
      if (shouldPlay) tryPlay(refs.videoCurrent);
      return;
    }

    state.isMuted = false;

    if (PLAYLIST[state.index].type === 'video') {
      refs.videoCurrent.muted = false;
      tryPlay(refs.videoCurrent);
    }

    syncSoundUI();
  }

  function vh() {
    return Math.max(
      window.innerHeight || 0,
      document.documentElement.clientHeight || 0
    );
  }

  function normalizeIndex(i) {
    const len = PLAYLIST.length;
    return (i % len + len) % len;
  }

  function tryPlay(el) {
    if (!el) return Promise.resolve();
    return el.play().catch(() => {});
  }

  function isInteractiveTarget(target) {
    return !!target?.closest(
      'button, a, input, textarea, select, label, .nav, .side, .video-meta-caption, .modal, .modal-backdrop, .share-sheet, #gateOverlay'
    );
  }

  function clearAuto() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = 0;
    }

    if (autoBoundVideo) {
      autoBoundVideo.onended = null;
      autoBoundVideo.onerror = null;
      autoBoundVideo = null;
    }
  }

  function stopProg() {
    if (progRaf) cancelAnimationFrame(progRaf);
    progRaf = 0;
  }

  function startProg() {
    stopProg();

    const tick = () => {
      progRaf = 0;

      const item = PLAYLIST[state.index];
      if (item.type !== 'video') return;

      const d = refs.videoCurrent.duration;

      if (d && isFinite(d) && d > 0) {
        const p = Math.max(
          0,
          Math.min(1, refs.videoCurrent.currentTime / d)
        );

        seekFill.style.width = (p * 100) + '%';
      } else {
        seekFill.style.width = '0%';
      }

      if (!refs.videoCurrent.paused && !refs.videoCurrent.ended) {
        progRaf = requestAnimationFrame(tick);
      }
    };

    progRaf = requestAnimationFrame(tick);
  }

  function showSeek(show) {
    if (!seekWrap) return;

    seekWrap.style.display = show ? 'flex' : 'none';
    seekWrap.setAttribute('aria-hidden', show ? 'false' : 'true');

    if (!show) {
      clearSeekInactiveTimer();
      setSeekActive(false);
      seekFill.style.width = '0%';
      stopProg();
    }
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);

    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;

    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');

    return h > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function updateSeekUIFromCurrent() {
    const d = refs.videoCurrent.duration;

    if (!d || !isFinite(d) || d <= 0) {
      if (seekTime) {
        seekTime.innerHTML =
          '<span class="t-cur">00:00</span>' +
          '<span class="t-sep"> / </span>' +
          '<span class="t-tot">00:00</span>';
      }

      return;
    }

    const t = Math.max(
      0,
      Math.min(d, refs.videoCurrent.currentTime || 0)
    );

    if (seekTime) {
      seekTime.innerHTML =
        `<span class="t-cur">${fmtTime(t)}</span>` +
        '<span class="t-sep"> / </span>' +
        `<span class="t-tot">${fmtTime(d)}</span>`;
    }
  }

  function setSeekActive(on) {
    if (seekPill) seekPill.classList.toggle('is-active', !!on);
    if (seekTime) seekTime.classList.toggle('is-active', !!on);

    setAllSidesScrubbing(!!on);

    if (on) updateSeekUIFromCurrent();
  }

  function seekToClientX(clientX) {
    const d = refs.videoCurrent.duration;
    if (!d || !isFinite(d) || d <= 0) return;

    const r = seekPill.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    const t = (x / r.width) * d;

    refs.videoCurrent.currentTime = t;

    const p = Math.max(0, Math.min(1, t / d));

    if (seekFill) {
      seekFill.style.width = (p * 100) + '%';
    }

    if (seekTime) {
      seekTime.innerHTML =
        `<span class="t-cur">${fmtTime(t)}</span>` +
        '<span class="t-sep"> / </span>' +
        `<span class="t-tot">${fmtTime(d)}</span>`;
    }
  }

  function queueSeek(clientX) {
    seekLatestX = clientX;

    if (seekRaf) return;

    seekRaf = requestAnimationFrame(() => {
      seekRaf = 0;
      seekToClientX(seekLatestX);
    });
  }

  function togglePlayPause() {
    const item = PLAYLIST[state.index];
    if (item.type !== 'video') return;

    if (refs.videoCurrent.paused || refs.videoCurrent.ended) {
      tryPlay(refs.videoCurrent);
      startProg();
    } else {
      refs.videoCurrent.pause();
      stopProg();
    }
  }

  function getLayerMedia(layer) {
    if (layer === refs.layerPrev) {
      return {
        video: refs.videoPrev,
        image: refs.imgPrev
      };
    }

    if (layer === refs.layerCurrent) {
      return {
        video: refs.videoCurrent,
        image: refs.imgCurrent
      };
    }

    if (layer === refs.layerNext) {
      return {
        video: refs.videoNext,
        image: refs.imgNext
      };
    }

    return {
      video: null,
      image: null
    };
  }

  function hideAll(layer) {
    const media = getLayerMedia(layer);
    const v = media.video;
    const im = media.image;

    if (v) {
      v.style.display = 'none';
    }

    if (im) {
      im.style.display = 'none';
      im.style.opacity = '0';
      im.onload = null;
      im.onerror = null;
    }
  }

  // =========================================================
  // === HLS-ONLY PIPELINE / POSTER COVER ===
  // =========================================================
  const hlsByVideo = new WeakMap();
  const frameCleanupByVideo = new WeakMap();

  const ua = navigator.userAgent || '';

  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (
      navigator.platform === 'MacIntel' &&
      navigator.maxTouchPoints > 1
    );

  function derivePoster(manifest) {
    if (!manifest) return '';

    try {
      const url = new URL(manifest, window.location.href);

      url.pathname = url.pathname.replace(
        /\/manifest\/video\.m3u8$/i,
        '/thumbnails/thumbnail.jpg'
      );

      url.search = '';
      url.searchParams.set('time', '0s');
      url.searchParams.set('fit', 'crop');
      url.searchParams.set('height', '1080');

      return url.toString();
    } catch (e) {
      return manifest.replace(
        /\/manifest\/video\.m3u8(?:\?.*)?$/i,
        '/thumbnails/thumbnail.jpg?time=0s&fit=crop&height=1080'
      );
    }
  }

  function destroyHls(el) {
    const hls = hlsByVideo.get(el);

    if (hls) {
      hls.destroy();
      hlsByVideo.delete(el);
    }
  }

  function clearFrameWatch(el) {
    const cleanup = frameCleanupByVideo.get(el);

    if (cleanup) {
      cleanup();
      frameCleanupByVideo.delete(el);
    }
  }

  function showPoster(img, src) {
    if (!img || !src) return;

    img.onload = null;
    img.onerror = null;
    img.style.transition = 'none';
    img.style.display = 'block';
    img.style.opacity = '1';

    img.onerror = () => {
      img.style.opacity = '1';
      img.style.display = 'block';
    };

    if (img.getAttribute('src') !== src) {
      img.src = src;
    }
  }

  function hidePoster(img) {
    if (!img) return;

    img.style.transition = 'opacity 120ms linear';
    img.style.opacity = '0';

    const finish = () => {
      if (img.style.opacity === '0') {
        img.style.display = 'none';
      }
    };

    img.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 160);
  }

  function watchFirstRenderedFrame(video, poster) {
    clearFrameWatch(video);

    let revealed = false;
    let frameRequest = 0;

    const reveal = () => {
      if (revealed || video.currentTime <= 0.05) return;

      revealed = true;
      clearFrameWatch(video);
      hidePoster(poster);
    };

    const onTimeUpdate = () => {
      reveal();
    };

    const onLoadedData = () => {
      if (
        typeof video.requestVideoFrameCallback !== 'function'
      ) {
        return;
      }

      frameRequest = video.requestVideoFrameCallback(
        (now, metadata) => {
          if (
            (metadata?.mediaTime ?? video.currentTime) > 0.05
          ) {
            reveal();
          }
        }
      );
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadeddata', onLoadedData);

    frameCleanupByVideo.set(video, () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadeddata', onLoadedData);

      if (
        frameRequest &&
        typeof video.cancelVideoFrameCallback === 'function'
      ) {
        video.cancelVideoFrameCallback(frameRequest);
      }
    });

    if (video.currentTime > 0.05) {
      reveal();
    }
  }

  function setVideo(el, manifest) {
    if (!el || !manifest) return;

    const currentManifest = el.dataset.manifest || '';

    if (currentManifest === manifest) {
      return;
    }

    clearFrameWatch(el);
    destroyHls(el);

    el.pause();
    el.dataset.manifest = manifest;
    el.removeAttribute('src');
    el.load();

    if (
      isIOS &&
      el.canPlayType('application/vnd.apple.mpegurl')
    ) {
      el.src = manifest;
      el.load();
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        startLevel: -1,
        maxBufferLength: 5,
        maxMaxBufferLength: 10,
        backBufferLength: 0
      });

      hlsByVideo.set(el, hls);

      hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
        if (el.dataset.manifest === manifest) {
          hls.loadSource(manifest);
        }
      });

      hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (!data?.fatal) return;

        if (
          data.type === window.Hls.ErrorTypes.NETWORK_ERROR
        ) {
          hls.startLoad();
          return;
        }

        if (
          data.type === window.Hls.ErrorTypes.MEDIA_ERROR
        ) {
          hls.recoverMediaError();
          return;
        }

        destroyHls(el);
      });

      hls.attachMedia(el);
      return;
    }

    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = manifest;
      el.load();
    }
  }

  function clearVideo(el) {
    if (!el) return;

    clearFrameWatch(el);
    destroyHls(el);

    el.pause();
    delete el.dataset.manifest;
    el.removeAttribute('src');
    el.load();
  }

  function clearImage(el) {
    el.onload = null;
    el.onerror = null;
    el.style.opacity = '0';
    el.style.display = 'none';
    el.removeAttribute('src');
  }

  function setImageSafe(el, src) {
    el.onload = null;
    el.onerror = null;
    el.style.opacity = '0';
    el.style.display = 'block';

    el.onload = () => {
      el.style.opacity = '1';
    };

    el.onerror = () => {
      el.style.opacity = '0';
      el.style.display = 'none';
    };

    if (el.getAttribute('src') !== src) {
      el.src = src;
    }
  }

  function primeNextVideo(v) {
    if (!v) return;

    v.muted = true;

    if (v.readyState >= 2) return;

    try {
      v.load();
    } catch (e) {}
  }

  function setLayerContent(layer, item, forNext) {
    const media = getLayerMedia(layer);
    const v = media.video;
    const im = media.image;

    if (!v || !im) return;

    layer.classList.toggle(
      'is-live',
      item.isLive === true
    );

    setLayerVideoMeta(layer, item);

    hideAll(layer);

    if (item.type === 'video') {
      const poster =
        item.poster ||
        derivePoster(item.manifest);

      showPoster(im, poster);

      v.style.display = 'block';
      v.muted = forNext ? true : state.isMuted;

      setVideo(v, item.manifest);
      watchFirstRenderedFrame(v, im);

      if (!forNext) {
        tryPlay(v);
      } else {
        primeNextVideo(v);
      }

      return;
    }

    v.style.display = 'none';

    clearVideo(v);
    clearImage(im);
    setImageSafe(im, item.manifest);
  }

  function bindPreviewLoopForCurrent() {
    clearAuto();
    stopProg();

    if (timeupdateBoundEl) {
      timeupdateBoundEl.removeEventListener(
        'timeupdate',
        updateSeekFill
      );

      timeupdateBoundEl = null;
    }

    showSeek(false);

    const item = PLAYLIST[state.index];
    if (item.type !== 'video') return;

    autoBoundVideo = refs.videoCurrent;
    autoBoundVideo.loop = false;
    autoBoundVideo.muted = true;
    autoBoundVideo.onended = null;
    autoBoundVideo.onerror = null;
    autoBoundVideo.onplay = null;
    autoBoundVideo.onpause = null;
    autoBoundVideo.onloadedmetadata = null;
    autoBoundVideo.onseeked = null;

    autoBoundVideo.ontimeupdate = () => {
      const d = autoBoundVideo.duration;

      if (!d || !isFinite(d) || d <= 0) return;

      if (d - autoBoundVideo.currentTime <= 0.30) {
        autoBoundVideo.currentTime = 0.02;
        tryPlay(autoBoundVideo);
      }
    };

    refs.videoCurrent.muted = true;

    tryPlay(refs.videoCurrent);
    showPlayOverlay(false);
  }

  function bindAutoAdvanceForCurrent() {
    clearAuto();
    stopProg();

    if (!ageGateUnlocked) {
      bindPreviewLoopForCurrent();
      return;
    }

    const item = PLAYLIST[state.index];

    if (timeupdateBoundEl) {
      timeupdateBoundEl.removeEventListener(
        'timeupdate',
        updateSeekFill
      );

      timeupdateBoundEl = null;
    }

    if (item.type === 'video') {
      showSeek(true);

      autoBoundVideo = refs.videoCurrent;
      autoBoundVideo.loop = true;
      autoBoundVideo.onended = null;

      autoBoundVideo.onerror = () => {
        if (swipeEngine) {
          swipeEngine.autoAdvance();
        }
      };

      autoBoundVideo.onplay = () => startProg();
      autoBoundVideo.onpause = () => stopProg();
      autoBoundVideo.onloadedmetadata = () => startProg();
      autoBoundVideo.onseeked = () => startProg();

      startProg();

      refs.videoCurrent.addEventListener(
        'timeupdate',
        updateSeekFill
      );

      timeupdateBoundEl = refs.videoCurrent;
    } else {
      showSeek(false);

      autoTimer = setTimeout(() => {
        if (swipeEngine) {
          swipeEngine.autoAdvance();
        }
      }, 3000);
    }
  }

  // =========================================================
  // === UI Actions ===
  // =========================================================
  if (seekWrap) {
    seekWrap.addEventListener('touchstart', (e) => {
      if (!ageGateUnlocked) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (PLAYLIST[state.index].type !== 'video') return;

      ensureSoundOn(true);

      pillTouching = true;
      pillSeeking = false;
      pillMoved = false;
      pillStartX = e.touches[0].clientX;
      pillStartY = e.touches[0].clientY;

      clearSeekInactiveTimer();
      setSeekActive(true);

      wasPlayingBeforeSeek = !(
        refs.videoCurrent.paused ||
        refs.videoCurrent.ended
      );

      refs.videoCurrent.pause();
      stopProg();

      queueSeek(e.touches[0].clientX);
    }, { passive: false });

    seekWrap.addEventListener('touchmove', (e) => {
      if (!ageGateUnlocked) return;
      if (!pillTouching) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (PLAYLIST[state.index].type !== 'video') return;

      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const dx = x - pillStartX;
      const dy2 = y - pillStartY;

      if (!pillSeeking) {
        if (
          Math.abs(dx) >= 2 &&
          Math.abs(dx) >= Math.abs(dy2)
        ) {
          pillSeeking = true;
        } else if (
          Math.abs(dy2) > Math.abs(dx) &&
          Math.abs(dy2) > 6
        ) {
          pillTouching = false;
          setSeekActive(false);

          if (wasPlayingBeforeSeek) {
            tryPlay(refs.videoCurrent);
          }

          startProg();
          return;
        } else {
          return;
        }
      }

      pillMoved = pillMoved || Math.abs(dx) >= 2;

      e.preventDefault();
      e.stopPropagation();

      queueSeek(x);
    }, { passive: false });

    seekWrap.addEventListener('touchend', (e) => {
      if (!ageGateUnlocked) return;

      pillTouching = false;
      pillSeeking = false;

      if (
        !pillMoved &&
        e &&
        e.changedTouches &&
        e.changedTouches[0]
      ) {
        queueSeek(e.changedTouches[0].clientX);
      }

      pillMoved = false;

      queueSeekInactive();

      if (wasPlayingBeforeSeek) {
        tryPlay(refs.videoCurrent);
        showPlayOverlay(false);
      }

      startProg();
    }, { passive: false });

    seekWrap.addEventListener('touchcancel', () => {
      if (!ageGateUnlocked) return;

      pillTouching = false;
      pillSeeking = false;
      pillMoved = false;

      queueSeekInactive();

      if (wasPlayingBeforeSeek) {
        tryPlay(refs.videoCurrent);
        showPlayOverlay(false);
      }

      startProg();
    }, { passive: true });
  }

  if (seekPill) {
    seekPill.addEventListener('touchstart', (e) => {
      if (!ageGateUnlocked) return;
      if (PLAYLIST[state.index].type !== 'video') return;
      if (!e.touches || e.touches.length !== 1) return;

      ensureSoundOn(true);

      pillTouching = true;
      pillSeeking = false;
      pillMoved = false;
      pillStartX = e.touches[0].clientX;
      pillStartY = e.touches[0].clientY;
    }, { passive: true });

    seekPill.addEventListener('touchmove', (e) => {
      if (!ageGateUnlocked) return;
      if (!pillTouching) return;
      if (PLAYLIST[state.index].type !== 'video') return;
      if (!e.touches || e.touches.length !== 1) return;

      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const dx = x - pillStartX;
      const dy2 = y - pillStartY;

      if (!pillSeeking) {
        if (
          Math.abs(dx) > Math.abs(dy2) &&
          Math.abs(dx) > 6
        ) {
          pillSeeking = true;
        } else if (
          Math.abs(dy2) > Math.abs(dx) &&
          Math.abs(dy2) > 6
        ) {
          pillTouching = false;
          return;
        } else {
          return;
        }
      }

      pillMoved = true;

      e.preventDefault();
      e.stopPropagation();

      seekToClientX(x);
    }, { passive: false });

    seekPill.addEventListener('touchend', (e) => {
      if (!ageGateUnlocked) return;

      if (PLAYLIST[state.index].type !== 'video') {
        pillTouching = false;
        pillSeeking = false;
        return;
      }

      const wasMoved = pillMoved;

      pillTouching = false;
      pillSeeking = false;
      pillMoved = false;

      if (!wasMoved) {
        if (
          e &&
          typeof e.preventDefault === 'function'
        ) {
          e.preventDefault();
        }

        if (state.isMuted) {
          ensureSoundOn(true);
        } else {
          togglePlayPause();
        }
      }
    }, { passive: false });

    seekPill.addEventListener('click', (e) => {
      if (!ageGateUnlocked) return;
      if (PLAYLIST[state.index].type !== 'video') return;
      if (pillMoved) return;

      e.preventDefault();

      if (state.isMuted) {
        ensureSoundOn(true);
      } else {
        togglePlayPause();
      }
    });
  }

  swipeEngine = window.initTikbooSwipe({
    refs,
    state,
    playlist: PLAYLIST,
    defer,
    vh,
    normalizeIndex,
    tryPlay,
    clearAuto,
    stopProg,
    bindAutoAdvanceForCurrent,
    syncSoundUI,
    showPlayOverlay,
    setLayerContent,
    ensureSoundOn,
    isInteractiveTarget,
    primeNextVideo
  });

  // =========================================================
  // === Age Gate / Cookie Consent Integration ===
  // =========================================================
  function activatePreviewMode() {
    ageGateUnlocked = false;

    state.isMuted = true;

    refs.videoCurrent.loop = true;
    refs.videoCurrent.muted = true;

    bindPreviewLoopForCurrent();
    cookieConsent.show();
  }

  function activateFullFeed() {
    ageGateUnlocked = true;

    refs.videoCurrent.loop = false;
    refs.videoCurrent.muted = state.isMuted;

    cookieConsent.hide();

    if (PLAYLIST[state.index]?.type === 'video') {
      tryPlay(refs.videoCurrent);
      showPlayOverlay(false);
    }

    defer(() => {
      swipeEngine.warmForwardNext();
      swipeEngine.warmBackwardNext();
    });

    bindAutoAdvanceForCurrent();
  }

  cookieConsent = window.TikbooCookieConsent.create({
    track,
    onComplete: () => {
      activateFullFeed();
    }
  });

  function initFirst() {
    state.isMuted = true;
    syncSoundUI();

    setLayerContent(
      refs.layerCurrent,
      PLAYLIST[state.index],
      false
    );

    swipeEngine.resetTransformsNoAnim();
    showPlayOverlay(false);

    if (ageGateUnlocked) {
      activateFullFeed();
    } else {
      activatePreviewMode();
    }
  }

  initFirst();

  initInteractions({
    refs,
    state,
    playlist: PLAYLIST,
    track,
    canInteract: () => ageGateUnlocked
  });

  initVideoShareSheet();

  // =========================================================
  // === Profile Modal ===
  // =========================================================
  const profileBtn = document.getElementById('profileBtn');
  const profileModal = document.getElementById('profileModal');
  const closeProfile = document.getElementById('closeProfile');

  function openProfile(source = 'unknown') {
    if (!ageGateUnlocked) return;
    if (!profileModal) return;

    profileModal.classList.add('show');

    track('profile_open', {
      source
    });
  }

  function closeProfileFn() {
    if (!profileModal) return;

    profileModal.classList.remove('show');
  }

  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      openProfile('bottom_nav');
    });
  }

  document.addEventListener('click', (e) => {
    const avatarBtn = e.target.closest('.avatarBtn');
    if (!avatarBtn) return;

    openProfile('avatar');
  });

  // =========================================================
  // === Share ===
  // =========================================================
  document.addEventListener('click', (e) => {
    if (!ageGateUnlocked) return;

    const shareBtn = e.target.closest(
      '[aria-label="Share"]'
    );

    if (!shareBtn) return;

    e.preventDefault();
    e.stopPropagation();

    const currentItem = PLAYLIST[state.index];

    track('share_tap', {
      source: 'side_button',
      video_id: currentItem.id
    });

    openVideoShareSheet(currentItem);
  }, true);

  if (closeProfile) {
    closeProfile.addEventListener(
      'click',
      closeProfileFn
    );
  }

  if (profileModal) {
    profileModal.addEventListener('click', (e) => {
      if (e.target === profileModal) {
        closeProfileFn();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    if (
      profileModal &&
      profileModal.classList.contains('show')
    ) {
      closeProfileFn();
    }
  });
});

/* === KILL: disable iOS “Save Image” on current top/gate images === */
(() => {
  const targets = [
    document.querySelector('.top img'),
    document.querySelector('#gateOverlay .top-g img')
  ].filter(Boolean);

  targets.forEach((img) => {
    img.setAttribute('draggable', 'false');

    img.style.webkitTouchCallout = 'none';
    img.style.webkitUserSelect = 'none';
    img.style.userSelect = 'none';
    img.style.webkitTapHighlightColor = 'transparent';

    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    img.addEventListener(
      'contextmenu',
      stop,
      { passive: false }
    );

    img.addEventListener(
      'dragstart',
      stop,
      { passive: false }
    );

    img.addEventListener(
      'touchstart',
      () => {},
      { passive: true }
    );
  });
})();

// =========================================================
// Service Worker
// =========================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => {
        console.log(
          '[Tikboo] Service Worker registered'
        );
      })
      .catch((err) => {
        console.error(
          '[Tikboo] Service Worker failed',
          err
        );
      });
  });
}
