// /assets/js/swipe.js
(function () {
  function initTikbooSwipe(options) {
    const refs = options.refs;
    const state = options.state;

    const defer = options.defer || ((fn) => setTimeout(fn, 0));
    const vh = options.vh;
    const normalizeIndex = options.normalizeIndex;
    const tryPlay = options.tryPlay;
    const clearAuto = options.clearAuto;
    const stopProg = options.stopProg;
    const bindAutoAdvanceForCurrent = options.bindAutoAdvanceForCurrent;
    const syncSoundUI = options.syncSoundUI;
    const showPlayOverlay = options.showPlayOverlay || (() => {});
    const setLayerContent = options.setLayerContent;
    const ensureSoundOn = options.ensureSoundOn;
    const isInteractiveTarget = options.isInteractiveTarget;
    const playlist = options.playlist;

    const enforceSinglePlayback = options.enforceSinglePlayback || (() => {});
    const hardStopNextVideo = options.hardStopNextVideo || (() => {});
    const clearVideo = options.clearVideo || ((video) => {
      if (!video) return;
      try { video.pause(); } catch (e) {}
      video.removeAttribute('src');
      try { video.load(); } catch (e) {}
    });

    let dragging = false;
    let startY = 0;
    let startX = 0;
    let dy = 0;
    let dx = 0;
    let preparedDir = 0;
    let raf = 0;
    let settleTimer = 0;
    let transitionLock = false;

    const THRESHOLD_RATIO = 0.25;
    const MOVE_ACTIVATE_PX = 10;
    const MIN_COMMIT_DY = 60;
    const MIN_COMMIT_VY = 0.65;
    const TAP_MAX_MOVE = 10;
    const TAP_MAX_TIME = 250;

    let startT = 0;
    let lastMoveY = 0;
    let nextLoadedIndex = null;
    let nextLoadedDir = 0;
    let swipeSoundUnlocked = false;

    const seekPill = document.getElementById('seekPill');
    const seekTime = document.getElementById('seekTime');

    function cancelRaf() {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    }

    function clearSettleTimer() {
      if (!settleTimer) return;
      clearTimeout(settleTimer);
      settleTimer = 0;
    }

    function forceLayerGPU(layer) {
      if (!layer) return;
      layer.style.willChange = 'transform';
      layer.style.backfaceVisibility = 'hidden';
      layer.style.webkitBackfaceVisibility = 'hidden';
    }

    function setLayerSideOpacity(layer, opacity) {
      const side = layer?.querySelector('.side');
      if (!side) return;
      side.style.opacity = String(opacity);
    }

    function resetLayerSideOpacity(layer) {
      const side = layer?.querySelector('.side');
      if (!side) return;
      side.style.opacity = '1';
    }

    function resetAllSideScrubbing() {
      document.querySelectorAll('.side').forEach((side) => {
        side.classList.remove('scrubbing');
        side.style.opacity = '';
        side.style.pointerEvents = '';
        side.style.display = '';
      });
    }

    function resetSeekUiImmediate() {
      if (seekPill) seekPill.classList.remove('is-active');
      if (seekTime) seekTime.classList.remove('is-active');
      resetAllSideScrubbing();
    }

    function resetTransformsNoAnim() {
      const height = vh();

      cancelRaf();
      clearSettleTimer();

      transitionLock = false;
      preparedDir = 0;

      forceLayerGPU(refs.layerCurrent);
      forceLayerGPU(refs.layerNext);

      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';

      refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
      refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;

      resetLayerSideOpacity(refs.layerCurrent);
      resetLayerSideOpacity(refs.layerNext);

      hardStopNextVideo();
      enforceSinglePlayback();
    }

    function warmForwardNext() {
      if (state.isAnimating || dragging || transitionLock) return;

      const height = vh();
      const targetIndex = normalizeIndex(state.index + 1);
      const item = playlist[targetIndex];

      if (nextLoadedIndex !== targetIndex || nextLoadedDir !== 1) {
        setLayerContent(refs.layerNext, item, true);
        nextLoadedIndex = targetIndex;
      } else if (item.type === 'video' && typeof options.primeNextVideo === 'function') {
        options.primeNextVideo(refs.videoNext);
      }

      refs.layerNext.style.transition = 'none';
      refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;

      nextLoadedDir = 1;

      resetLayerSideOpacity(refs.layerNext);
      hardStopNextVideo();
    }

    function prepareNextForDirection(dir) {
      const height = vh();
      const targetIndex = normalizeIndex(state.index + dir);
      const item = playlist[targetIndex];

      if (nextLoadedIndex !== targetIndex || nextLoadedDir !== dir) {
        setLayerContent(refs.layerNext, item, true);
        nextLoadedIndex = targetIndex;
      } else if (item.type === 'video' && typeof options.primeNextVideo === 'function') {
        options.primeNextVideo(refs.videoNext);
      }

      refs.layerNext.style.transition = 'none';
      refs.layerNext.style.transform =
        dir > 0 ? `translate3d(0,${height}px,0)` : `translate3d(0,${-height}px,0)`;

      nextLoadedDir = dir;
      preparedDir = dir;

      resetLayerSideOpacity(refs.layerNext);
      hardStopNextVideo();
    }

    function applyDragTransforms() {
      const height = vh();

      refs.layerCurrent.style.transform = `translate3d(0,${dy}px,0)`;

      if (preparedDir > 0) {
        refs.layerNext.style.transform = `translate3d(0,${height + dy}px,0)`;
      } else if (preparedDir < 0) {
        refs.layerNext.style.transform = `translate3d(0,${-height + dy}px,0)`;
      }

      setLayerSideOpacity(refs.layerCurrent, 0.4);
      setLayerSideOpacity(refs.layerNext, 1);
    }

    function flushPendingDragFrame() {
      if (!raf) return;

      cancelAnimationFrame(raf);
      raf = 0;

      if (preparedDir !== 0) applyDragTransforms();
    }

    function settleTransition(duration, onDone) {
      let doneOnce = false;

      const finish = () => {
        if (doneOnce) return;

        doneOnce = true;
        clearSettleTimer();

        refs.layerCurrent.removeEventListener('transitionend', onEnd);
        refs.layerNext.removeEventListener('transitionend', onEnd);

        onDone();
      };

      const onEnd = (e) => {
        if (e.propertyName && e.propertyName.includes('transform')) finish();
      };

      refs.layerCurrent.addEventListener('transitionend', onEnd);
      refs.layerNext.addEventListener('transitionend', onEnd);

      settleTimer = setTimeout(finish, duration + 120);
    }

    function commit(dir) {
      if (state.isAnimating || transitionLock) return;

      state.isAnimating = true;
      transitionLock = true;

      clearAuto();
      stopProg();
      resetSeekUiImmediate();
      cancelRaf();
      clearSettleTimer();

      const height = vh();
      const duration = 150;

      const oldLayer = refs.layerCurrent;
      const oldVideo = refs.videoCurrent;

      hardStopNextVideo();

      refs.layerCurrent.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
      refs.layerNext.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;

      refs.layerCurrent.style.transform = `translate3d(0,${dir > 0 ? -height : height}px,0)`;
      refs.layerNext.style.transform = 'translate3d(0,0,0)';

      settleTransition(duration, () => {
        state.index = normalizeIndex(state.index + dir);

        const tmpLayer = refs.layerCurrent;
        refs.layerCurrent = refs.layerNext;
        refs.layerNext = tmpLayer;

        if (refs.playOverlay) refs.layerCurrent.appendChild(refs.playOverlay);

        const tmpV = refs.videoCurrent;
        refs.videoCurrent = refs.videoNext;
        refs.videoNext = tmpV;

        const tmpI = refs.imgCurrent;
        refs.imgCurrent = refs.imgNext;
        refs.imgNext = tmpI;

        clearVideo(oldVideo);

        refs.layerCurrent.style.transition = 'none';
        refs.layerNext.style.transition = 'none';

        refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
        refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;

        resetLayerSideOpacity(refs.layerCurrent);
        resetLayerSideOpacity(refs.layerNext);
        resetSeekUiImmediate();

        preparedDir = 0;
        nextLoadedIndex = null;
        nextLoadedDir = 0;
        dy = 0;
        dx = 0;

        const currentItem = playlist[state.index];

        if (currentItem.type === 'video') {
          refs.videoCurrent.muted = state.isMuted;
          enforceSinglePlayback();
          tryPlay(refs.videoCurrent);
        } else {
          enforceSinglePlayback();
        }

        syncSoundUI();
        showPlayOverlay(false);
        bindAutoAdvanceForCurrent();

        state.isAnimating = false;
        transitionLock = false;

        defer(() => {
          warmForwardNext();
          hardStopNextVideo();
          enforceSinglePlayback();
        });

        if (oldLayer) {
          oldLayer.style.transition = 'none';
        }
      });
    }

    function snapBack() {
      if (state.isAnimating || transitionLock) return;

      state.isAnimating = true;
      transitionLock = true;

      resetSeekUiImmediate();
      cancelRaf();
      clearSettleTimer();

      const height = vh();
      const duration = 220;

      hardStopNextVideo();

      refs.layerCurrent.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
      refs.layerNext.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;

      refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
      refs.layerNext.style.transform =
        preparedDir > 0 ? `translate3d(0,${height}px,0)` :
        preparedDir < 0 ? `translate3d(0,${-height}px,0)` :
        `translate3d(0,${height}px,0)`;

      settleTransition(duration, () => {
        preparedDir = 0;
        dy = 0;
        dx = 0;

        resetTransformsNoAnim();
        resetSeekUiImmediate();

        state.isAnimating = false;
        transitionLock = false;

        bindAutoAdvanceForCurrent();

        defer(() => {
          warmForwardNext();
          hardStopNextVideo();
          enforceSinglePlayback();
        });
      });
    }

    function autoAdvance() {
      if (state.isAnimating || dragging || transitionLock) return;

      resetSeekUiImmediate();

      warmForwardNext();

      preparedDir = 1;

      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';

      refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
      refs.layerNext.style.transform = `translate3d(0,${vh()}px,0)`;

      void refs.layerCurrent.offsetHeight;

      commit(1);
    }

    function finishGesture(cancelled) {
      if (!dragging || state.isAnimating || transitionLock) return;

      const totalDy = dy;
      const totalDx = dx;
      const endT = performance.now();
      const dt = Math.max(1, endT - startT);

      dragging = false;
      swipeSoundUnlocked = false;

      flushPendingDragFrame();

      if (cancelled) {
        if (preparedDir !== 0) {
          snapBack();
        } else {
          dy = 0;
          dx = 0;

          resetLayerSideOpacity(refs.layerCurrent);
          resetLayerSideOpacity(refs.layerNext);

          hardStopNextVideo();
          enforceSinglePlayback();
          bindAutoAdvanceForCurrent();
        }

        return;
      }

      const isTap =
        Math.abs(totalDy) < TAP_MAX_MOVE &&
        Math.abs(totalDx) < TAP_MAX_MOVE &&
        dt < TAP_MAX_TIME;

      if (preparedDir === 0) {
        dy = 0;
        dx = 0;

        resetLayerSideOpacity(refs.layerCurrent);
        resetLayerSideOpacity(refs.layerNext);
        hardStopNextVideo();

        if (isTap) {
          const v = refs.videoCurrent;

          if (v) {
            if (v.paused || v.ended) {
              if (ensureSoundOn) ensureSoundOn(true);
              else tryPlay(v);

              showPlayOverlay(false);
            } else {
              v.pause();
              stopProg();
              showPlayOverlay(true);
            }
          }
        }

        enforceSinglePlayback();
        bindAutoAdvanceForCurrent();

        return;
      }

      const height = vh();
      const threshold = Math.round(height * THRESHOLD_RATIO);
      const vy = (lastMoveY - startY) / dt;
      const vAbs = Math.abs(vy);

      if (Math.abs(totalDy) >= threshold || (Math.abs(totalDy) >= MIN_COMMIT_DY && vAbs >= MIN_COMMIT_VY)) {
        commit(preparedDir);
      } else {
        snapBack();
      }

      dy = 0;
      dx = 0;
    }

    document.addEventListener('touchstart', (e) => {
      if (state.isAnimating || transitionLock) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (isInteractiveTarget(e.target)) return;

      dragging = true;
      preparedDir = 0;
      swipeSoundUnlocked = false;

      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;

      dy = 0;
      dx = 0;

      startT = performance.now();
      lastMoveY = startY;

      cancelRaf();
      clearSettleTimer();
      clearAuto();
      stopProg();

      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';

      warmForwardNext();
      hardStopNextVideo();
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating || transitionLock) return;
      if (!e.touches || e.touches.length !== 1) return;

      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;

      const ddy = y - startY;
      const ddx = x - startX;

      dx = ddx;

      if (Math.abs(ddx) > Math.abs(ddy) * 1.5) return;
      if (Math.abs(ddy) < MOVE_ACTIVATE_PX) return;

      resetSeekUiImmediate();

      e.preventDefault();

      dy = ddy;
      lastMoveY = y;

      if (!swipeSoundUnlocked && typeof ensureSoundOn === 'function') {
        ensureSoundOn(true);
        swipeSoundUnlocked = true;
      }

      const dir = dy < 0 ? 1 : -1;

      if (preparedDir !== dir || nextLoadedDir !== dir) {
        prepareNextForDirection(dir);
      }

      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          applyDragTransforms();
        });
      }
    }, { passive: false });

    document.addEventListener('touchend', () => finishGesture(false), { passive: true });
    document.addEventListener('touchcancel', () => finishGesture(true), { passive: true });

    return {
      autoAdvance,
      warmForwardNext,
      commit,
      snapBack,
      resetTransformsNoAnim,
      isDragging() {
        return dragging;
      }
    };
  }

  window.initTikbooSwipe = initTikbooSwipe;
})();
