// /assets/js/app.js

// === iOS SAFARI: KILL ZOOM (pinch + gesture) ===
document.addEventListener('touchmove', (e) => {
  if (e.scale && e.scale !== 1) e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

document.addEventListener('DOMContentLoaded', () => {
  // =========================================================
  // === State / Playlist ===
  // =========================================================
  const PLAYLIST = [
    { type: 'video', src: 'assets/video/swipe1.mp4' },
    { type: 'video', src: 'assets/video/swipe2.mp4' },
    { type: 'video', src: 'assets/video/swipe3.mp4' },
    { type: 'video', src: 'assets/video/swipe4.mp4' },
    { type: 'video', src: 'assets/video/swipe5.mp4' },
    { type: 'video', src: 'assets/video/swipe6.mp4' },
    { type: 'video', src: 'assets/video/swipe7.mp4' },
    { type: 'video', src: 'assets/video/swipe8.mp4' },
    { type: 'video', src: 'assets/video/swipe9.mp4' },
    { type: 'video', src: 'assets/video/swipe10.mp4' },
    { type: 'video', src: 'assets/video/swipe11.mp4' },
    { type: 'video', src: 'assets/video/swipe12.mp4' },
    { type: 'video', src: 'assets/video/swipe13.mp4' },
    { type: 'video', src: 'assets/video/swipe14.mp4' },
    { type: 'video', src: 'assets/video/swipe15.mp4' },
    { type: 'video', src: 'assets/video/swipe16.mp4' }
  ];

  const refs = {
    layerCurrent: document.getElementById('layerCurrent'),
    layerNext: document.getElementById('layerNext'),
    videoCurrent: document.getElementById('videoCurrent'),
    videoNext: document.getElementById('videoNext'),
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
  [refs.videoCurrent, refs.videoNext].forEach((v) => {
    v.preload = 'auto';
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
    return !!target?.closest('button, a, input, textarea, select, label, .nav, .side, .modal, .modal-backdrop, #gateOverlay');
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

  function hideAll(layer) {
    const v = layer.querySelector('video');
    const im = layer.querySelector('img');

    v.style.display = 'none';
    im.style.display = 'none';
    im.style.opacity = '0';
    im.onload = null;
    im.onerror = null;
  }

  // =========================================================
  // === CODEC PICKER (HEVC primary, H264 fallback) ===
  // =========================================================
  function supportsHEVC() {
    const v = document.createElement('video');
    const can = v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
    return !!can && can !== 'no';
  }

  const USE_HEVC = supportsHEVC();

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
    const v = layer.querySelector('video');
    const im = layer.querySelector('img');

    hideAll(layer);

    if (item.type === 'video') {
      im.style.display = 'none';
      v.style.display = 'block';
      v.muted = forNext ? true : state.isMuted;
      setVideo(v, item.src);

      if (!forNext) {
        tryPlay(v);
      } else {
        primeNextVideo(v);

        v.addEventListener('loadeddata', () => {
          if (v.readyState >= 2) {
            try {
              const p = v.play();
              if (p && typeof p.then === 'function') {
                p.then(() => { v.pause(); }).catch(() => {});
              } else {
                v.pause();
              }
            } catch (e) {}
          }
        }, { once: true });
      }

      return;
    }

    v.style.display = 'none';
    clearVideo(v);
    setImageSafe(im, item.src);
  }

  function bindAutoAdvanceForCurrent() {
    clearAuto();
    stopProg();

    const item = PLAYLIST[state.index];

    if (timeupdateBoundEl) {
      timeupdateBoundEl.removeEventListener('timeupdate', updateSeekFill);
      timeupdateBoundEl = null;
    }

    if (item.type === 'video') {
      showSeek(true);
      autoBoundVideo = refs.videoCurrent;

      autoBoundVideo.onended = () => {
        if (swipeEngine) swipeEngine.autoAdvance();
      };

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

  function initFirst() {
    state.isMuted = true;
    syncSoundUI();

    setLayerContent(refs.layerCurrent, PLAYLIST[state.index], false);
    swipeEngine.resetTransformsNoAnim();

    defer(() => {
      swipeEngine.warmForwardNext();
    });

    bindAutoAdvanceForCurrent();
    showPlayOverlay(false);
  }

  initFirst();

  const profileBtn = document.getElementById('profileBtn');
  const profileModal = document.getElementById('profileModal');
  const closeProfile = document.getElementById('closeProfile');

  function openProfile(source = 'unknown') {
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
    if (localStorage.getItem(KEY) === '1') hideGate();
    else showGate();
  } catch (e) {
    showGate();
  }

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
      hideGate();

      if (PLAYLIST[state.index]?.type === 'video') {
        refs.videoCurrent.muted = state.isMuted;
        tryPlay(refs.videoCurrent);
        showPlayOverlay(false);
        bindAutoAdvanceForCurrent();
      }
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

