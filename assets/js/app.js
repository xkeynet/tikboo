// /assets/js/app.js

import { PLAYLIST } from './data/playlist.js';

import { initInteractions } from './ui/interactions.js';

// === iOS SAFARI: KILL ZOOM (pinch + gesture) ===
document.addEventListener('touchmove', (e) => {
  if (e.scale && e.scale !== 1) e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

document.addEventListener('DOMContentLoaded', () => {
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

  let swipeEngine = null;

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

  let ageGateUnlocked = false;

  // =========================================================
  // === Age Gate Storage ===
  // =========================================================
  const KEY = 'swipe_age_ok';
  const gate = document.getElementById('gateOverlay');
  const enterBtn = document.getElementById('enterBtn');

  function hideGate() {
    if (!gate) return;
    gate.classList.add('hidden');
  }

  function showGate() {
    if (!gate) return;
    gate.classList.remove('hidden');
  }

  try {
    ageGateUnlocked = localStorage.getItem(KEY) === '1';
  } catch (e) {
    ageGateUnlocked = false;
  }

  // =========================================================
  // === HIDDEN PRELOAD BUFFERS ===
  // =========================================================
  const preloadPrev = document.createElement('video');
  const preloadNext = document.createElement('video');

  [preloadPrev, preloadNext].forEach((v) => {
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;

    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');

    v.style.position = 'absolute';
    v.style.width = '1px';
    v.style.height = '1px';
    v.style.opacity = '0';
    v.style.pointerEvents = 'none';

    document.body.appendChild(v);
  });

  function warmMemoryBuffers() {
    const prevIndex = normalizeIndex(state.index - 1);
    const nextIndex = normalizeIndex(state.index + 1);

    const prevItem = PLAYLIST[prevIndex];
    const nextItem = PLAYLIST[nextIndex];

    if (prevItem?.type === 'video') {
      if (preloadPrev.src !== prevItem.manifest) {
        preloadPrev.src = prevItem.manifest;
        preloadPrev.load();
      }
    }

    if (nextItem?.type === 'video') {
      if (preloadNext.src !== nextItem.manifest) {
        preloadNext.src = nextItem.manifest;
        preloadNext.load();
      }
    }
  }

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
  refs.videoCurrent.preload = 'auto';
  refs.videoNext.preload = 'metadata';

  [refs.videoCurrent, refs.videoNext].forEach((v) => {
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('disablepictureinpicture', '');
    v.setAttribute('x-webkit-airplay', 'deny');
  });

  refs.imgCurrent.decoding = 'async';
  refs.imgNext.decoding = 'async';

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
        avatarEl.src = avatar;
        avatarEl.alt = creator ? `${creator} avatar` : 'Creator avatar';

        if (avatarStack) {
          avatarStack.style.display = '';
        }
      } else {
        avatarEl.removeAttribute('src');
        avatarEl.alt = '';

        if (avatarStack) {
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
      const p = Math.max(0, Math.min(1, refs.videoCurrent.currentTime / d));
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
    return Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
  }

  function normalizeIndex(i) {
    const len = PLAYLIST.length;
    return (i % len + len) % len;
  }

  function tryPlay(el) {
    return el.play().catch(() => {});
  }

  function isInteractiveTarget(target) {
    return !!target?.closest('button, a, input, textarea, select, label, .nav, .side, .video-meta-caption, .modal, .modal-backdrop, #gateOverlay');
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
        const p = Math.max(0, Math.min(1, refs.videoCurrent.currentTime / d));
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
        seekTime.innerHTML = `<span class="t-cur">00:00</span><span class="t-sep"> / </span><span class="t-tot">00:00</span>`;
      }
      return;
    }

    const t = Math.max(0, Math.min(d, refs.videoCurrent.currentTime || 0));

    if (seekTime) {
      seekTime.innerHTML = `<span class="t-cur">${fmtTime(t)}</span><span class="t-sep"> / </span><span class="t-tot">${fmtTime(d)}</span>`;
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
    if (seekFill) seekFill.style.width = (p * 100) + '%';

    if (seekTime) {
      seekTime.innerHTML = `<span class="t-cur">${fmtTime(t)}</span><span class="t-sep"> / </span><span class="t-tot">${fmtTime(d)}</span>`;
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
  // === CODEC PICKER (HEVC primary, H264 fallback) ===
  // =========================================================
  function supportsHEVC() {
    const v = document.createElement('video');
    const can = v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
    return !!can && can !== 'no';
  }

  const USE_HEVC = false;

  function deriveHevcSrc(h264Src) {
    if (!h264Src || !h264Src.endsWith('.mp4')) return h264Src;
    return h264Src.replace(/\.mp4$/i, '-hevc.mp4');
  }

  function setVideoSmart(el, h264Src) {
    if (!h264Src) return;

    const hevcSrc = deriveHevcSrc(h264Src);
    const wantHevc = USE_HEVC && hevcSrc !== h264Src;

    el.dataset.codecFallback = '0';

    const current = el.getAttribute('src') || '';
    const desired = wantHevc ? hevcSrc : h264Src;
    if (current && current.endsWith(desired)) return;

    if (wantHevc) {
      el.dataset.codecFallback = 'hevc_try';

      const onErr = () => {
        el.dataset.codecFallback = '1';

        const now = el.getAttribute('src') || '';
        if (!now.endsWith(h264Src)) {
          el.src = h264Src;
          el.load();
        }
      };

      el.addEventListener('error', onErr, { once: true });
      el.src = hevcSrc;
      el.load();
      return;
    }

    el.src = h264Src;
    el.load();
  }

  function setVideo(el, src) {
    setVideoSmart(el, src);
  }

  function clearVideo(el) {
    el.pause?.();
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

    setLayerVideoMeta(layer, item);

    hideAll(layer);

    if (item.type === 'video') {
      im.style.display = 'none';
      v.style.display = 'block';
      v.muted = forNext ? true : state.isMuted;
      setVideo(v, item.manifest);

      if (!forNext) {
        tryPlay(v);
      } else {
        primeNextVideo(v);
      }

      return;
    }

    v.style.display = 'none';
    clearVideo(v);
    setImageSafe(im, item.manifest);
  }

  function bindPreviewLoopForCurrent() {
    clearAuto();
    stopProg();

    if (timeupdateBoundEl) {
      timeupdateBoundEl.removeEventListener('timeupdate', updateSeekFill);
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
      timeupdateBoundEl.removeEventListener('timeupdate', updateSeekFill);
      timeupdateBoundEl = null;
    }

    if (item.type === 'video') {
      showSeek(true);
      autoBoundVideo = refs.videoCurrent;
      autoBoundVideo.loop = true;

      autoBoundVideo.onended = null;

      autoBoundVideo.onerror = () => {
        const flag = refs.videoCurrent?.dataset?.codecFallback;
        if (flag === '1' || flag === 'hevc_try') {
          refs.videoCurrent.dataset.codecFallback = '0';
          return;
        }

        if (swipeEngine) swipeEngine.autoAdvance();
      };

      autoBoundVideo.onplay = () => startProg();
      autoBoundVideo.onpause = () => stopProg();

      autoBoundVideo.onloadedmetadata = () => {
        if (refs.videoCurrent?.dataset) refs.videoCurrent.dataset.codecFallback = '0';
        startProg();
      };

      autoBoundVideo.onseeked = () => startProg();

      startProg();

      refs.videoCurrent.addEventListener('timeupdate', updateSeekFill);
      timeupdateBoundEl = refs.videoCurrent;
    } else {
      showSeek(false);
      autoTimer = setTimeout(() => {
        if (swipeEngine) swipeEngine.autoAdvance();
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

      wasPlayingBeforeSeek = !(refs.videoCurrent.paused || refs.videoCurrent.ended);
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
        if (Math.abs(dx) >= 2 && Math.abs(dx) >= Math.abs(dy2)) {
          pillSeeking = true;
        } else if (Math.abs(dy2) > Math.abs(dx) && Math.abs(dy2) > 6) {
          pillTouching = false;
          setSeekActive(false);
          if (wasPlayingBeforeSeek) tryPlay(refs.videoCurrent);
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

      if (!pillMoved && e && e.changedTouches && e.changedTouches[0]) {
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
        if (Math.abs(dx) > Math.abs(dy2) && Math.abs(dx) > 6) pillSeeking = true;
        else if (Math.abs(dy2) > Math.abs(dx) && Math.abs(dy2) > 6) {
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
        if (e && typeof e.preventDefault === 'function') e.preventDefault();

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

  function activatePreviewMode() {
    ageGateUnlocked = false;

    state.index = 0;
    state.isMuted = true;

    refs.videoCurrent.loop = true;
    refs.videoCurrent.muted = true;

    bindPreviewLoopForCurrent();
    showGate();
  }

  function activateFullFeed() {
    ageGateUnlocked = true;

    refs.videoCurrent.loop = false;
    refs.videoCurrent.muted = state.isMuted;

    hideGate();

    if (PLAYLIST[state.index]?.type === 'video') {
      tryPlay(refs.videoCurrent);
      showPlayOverlay(false);
    }

    defer(() => {
      swipeEngine.warmForwardNext();
      swipeEngine.warmBackwardNext();
      warmMemoryBuffers();
    });

    bindAutoAdvanceForCurrent();
  }

  function initFirst() {
    state.isMuted = true;
    syncSoundUI();

    setLayerContent(refs.layerCurrent, PLAYLIST[state.index], false);
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
    profileBtn.addEventListener('click', () => openProfile('bottom_nav'));
  }

  document.addEventListener('click', (e) => {
    const avatarBtn = e.target.closest('.avatarBtn');
    if (!avatarBtn) return;
    openProfile('avatar');
  });

  document.addEventListener('click', async (e) => {
    if (!ageGateUnlocked) return;

    const shareBtn = e.target.closest('[aria-label="Share"]');
    if (!shareBtn) return;

    e.preventDefault();
    e.stopPropagation();

    const shareData = {
      title: 'Tikboo',
      text: 'Watch this',
      url: 'https://tikboo.com/'
    };

    try {
      track('share_tap', {
        source: 'side_button'
      });

      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }

      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareData.url);
        alert('Link copied');
        return;
      }

      alert(shareData.url);
    } catch (err) {
      console.log('Share failed:', err);
    }
  }, true);

  if (closeProfile) closeProfile.addEventListener('click', closeProfileFn);

  if (profileModal) {
    profileModal.addEventListener('click', (e) => {
      if (e.target === profileModal) closeProfileFn();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (profileModal && profileModal.classList.contains('show')) closeProfileFn();
    }
  });

  if (enterBtn) {
    enterBtn.addEventListener('click', function () {
      track('age_gate_enter', {
        gate: 'adult_enter',
        method: 'button'
      });

      try {
        localStorage.setItem(KEY, '1');
      } catch (e) {}

      this.textContent = 'ENTERED';
      this.disabled = true;
      this.style.opacity = '0.75';

      activateFullFeed();
    });
  }
});

/* === KILL: disable iOS “Save Image” on current top/gate images === */
(() => {
  const targets = [
    document.querySelector('.top img'),
    document.querySelector('#gateOverlay .top-g img'),
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

    img.addEventListener('contextmenu', stop, { passive: false });
    img.addEventListener('dragstart', stop, { passive: false });
    img.addEventListener('touchstart', () => {}, { passive: true });
  });
})();
