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

    let dragging = false;
    let startY = 0;
    let startX = 0;
    let dy = 0;
    let dx = 0;
    let preparedDir = 0;
    let raf = 0;
    let settleTimer = 0;

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

      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';
      refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
      refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;

      resetLayerSideOpacity(refs.layerCurrent);
      resetLayerSideOpacity(refs.layerNext);
    }

    function warmForwardNext() {
      if (state.isAnimating || dragging) return;

      const height = vh();
      const targetIndex = normalizeIndex(state.index + 1);
      const item = playlist[targetIndex];

      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, item, true);
        nextLoadedIndex = targetIndex;
      } else if (item.type === 'video' && typeof options.primeNextVideo === 'function') {
        options.primeNextVideo(refs.videoNext);
      }

      refs.layerNext.style.transition = 'none';
      refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;
      nextLoadedDir = 1;
      resetLayerSideOpacity(refs.layerNext);
    }

    function prepareNextForDirection(dir) {
      const height = vh();
      const targetIndex = normalizeIndex(state.index + dir);
      const item = playlist[targetIndex];

      if (nextLoadedIndex !== targetIndex) {
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
    }

    function applyDragTransforms() {
      const height = vh();

      refs.layerCurrent.style.transform = `translate3d(0,${dy}px,0)`;

      if (preparedDir > 0) {
        refs.layerNext.style.transform = `translate3d(0,${height + dy}px,0)`;
      } else if (preparedDir < 0) {
        refs.layerNext.style.transform = `translate3d(0,${-height + dy}px,0)`;
      }

      setLayerSideOpacity(refs.layerCurrent, 0.3);
      setLayerSideOpacity(refs.layerNext, 1);
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
        if (e.propertyName !== 'transform') return;
        finish();
      };

      refs.layerCurrent.addEventListener('transitionend', onEnd);
      refs.layerNext.addEventListener('transitionend', onEnd);

      settleTimer = setTimeout(finish, duration + 80);
    }

    function commit(dir) {
      if (state.isAnimating) return;

      state.isAnimating = true;
      clearAuto();
      stopProg();
      resetSeekUiImmediate();
      cancelRaf();
      clearSettleTimer();

      const height = vh();
      const duration = 140;

      refs.layerCurrent.style.transition = `transform ${duration}ms linear`;
      refs.layerNext.style.transition = `transform ${duration}ms linear`;

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

        refs.layerCurrent.style.transition = 'none';
        refs.layerCurrent.style.transform = 'translate3d(0,0,0)';

        refs.layerNext.style.transition = 'none';
        refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;

        preparedDir = 0;
        nextLoadedIndex = null;
        nextLoadedDir = 0;

        const currentItem = playlist[state.index];
        if (currentItem.type === 'video') {
          refs.videoCurrent.muted = state.isMuted;
          tryPlay(refs.videoCurrent);
        }

        resetLayerSideOpacity(refs.layerCurrent);
        resetLayerSideOpacity(refs.layerNext);
        resetSeekUiImmediate();

        syncSoundUI();
        showPlayOverlay(false);
        bindAutoAdvanceForCurrent();

        state.isAnimating = false;

        defer(() => {
          warmForwardNext();
        });
      });
    }

    function snapBack() {
      if (state.isAnimating) return;

      state.isAnimating = true;
      resetSeekUiImmediate();
      cancelRaf();
      clearSettleTimer();

      const height = vh();
      const duration = 200;

      refs.layerCurrent.style.transition = `transform ${duration}ms ease-out`;
      refs.layerNext.style.transition = `transform ${duration}ms ease-out`;

      refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
      refs.layerNext.style.transform =
        preparedDir > 0 ? `translate3d(0,${height}px,0)` :
        preparedDir < 0 ? `translate3d(0,${-height}px,0)` :
        `translate3d(0,${height}px,0)`;

      settleTransition(duration, () => {
        preparedDir = 0;
        resetTransformsNoAnim();
        resetSeekUiImmediate();

        state.isAnimating = false;
        bindAutoAdvanceForCurrent();

        defer(() => {
          warmForwardNext();
        });
      });
    }

    function autoAdvance() {
      if (state.isAnimating || dragging) return;

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
      if (!dragging || state.isAnimating) return;

      const totalDy = dy;
      const totalDx = dx;
      const endT = performance.now();
      const dt = Math.max(1, endT - startT);

      dragging = false;
      swipeSoundUnlocked = false;
      cancelRaf();

      if (cancelled) {
        if (preparedDir !== 0) {
          snapBack();
        } else {
          dy = 0;
          dx = 0;
          resetLayerSideOpacity(refs.layerCurrent);
          resetLayerSideOpacity(refs.layerNext);
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

        if (isTap) {
          const v = refs.videoCurrent;
          if (v) {
            if (v.paused || v.ended) {
              if (typeof ensureSoundOn === 'function') {
                ensureSoundOn(true);
              } else {
                tryPlay(v);
              }
              showPlayOverlay(false);
            } else {
              v.pause();
              stopProg();
              showPlayOverlay(true);
            }
          }
        }

        bindAutoAdvanceForCurrent();
        return;
      }

      const height = vh();
      const threshold = Math.round(height * THRESHOLD_RATIO);
      const vy = (lastMoveY - startY) / dt;
      const vAbs = Math.abs(vy);

      const distanceOK = Math.abs(totalDy) >= threshold;
      const velocityOK = (Math.abs(totalDy) >= MIN_COMMIT_DY) && (vAbs >= MIN_COMMIT_VY);

      if (distanceOK || velocityOK) commit(preparedDir);
      else snapBack();

      dy = 0;
      dx = 0;
    }

    document.addEventListener('touchstart', (e) => {
      if (state.isAnimating) return;
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
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating) return;
      if (!e.touches || e.touches.length !== 1) return;

      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;
      const ddy = y - startY;
      const ddx = x - startX;

      dx = ddx;

      if (Math.abs(ddx) > Math.abs(ddy)) return;
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

    document.addEventListener('touchend', () => {
      finishGesture(false);
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
      finishGesture(true);
    }, { passive: true });

    return {
      autoAdvance,
      warmForwardNext,
      prepareNextForDirection,
      applyDragTransforms,
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

