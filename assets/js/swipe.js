// /assets/js/swipe.js - ATOMIC VERSION
(function () {
  function initTikbooSwipe(options) {
    const {
      refs,
      state,
      playlist,
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
      isInteractiveTarget
    } = options;

    const THRESHOLD_RATIO = 0.50;
    const MOVE_ACTIVATE_PX = 3;
    const MIN_COMMIT_DY = 70;
    const MIN_COMMIT_VY = 0.42;
    const TAP_MAX_MOVE = 8;
    const TAP_MAX_TIME = 220;

    const BACKWARD_THRESHOLD_RATIO = 0.50;
    const BACKWARD_MIN_COMMIT_DY = 55;
    const BACKWARD_MIN_COMMIT_VY = 0.34;

    const DIRECTION_FLIP_DAMPING_PX = 12;
    const QUEUE_MOVE_ACTIVATE_PX = 2;
    const MAX_MOVE_STEP_PX = 260;

    const COMMIT_COOLDOWN = 55;
    const COMMIT_READY_RETRY_MS = 55;
    const COMMIT_READY_MAX_RETRIES = 4;

    let dragging = false;

    let startY = 0;
    let startX = 0;
    let dy = 0;
    let dx = 0;

    let preparedDir = 0;
    let raf = 0;
    let settleTimer = 0;

    let startT = 0;
    let lastMoveY = 0;

    let nextLoadedIndex = null;
    let prevLoadedIndex = null;

    let swipeSoundUnlocked = false;
    let lastCommitTime = 0;

    let pendingCommitTimer = 0;
    let pendingCommitDir = 0;
    let pendingCommitRetries = 0;

    let queuedDir = 0;
    let queueHasStart = false;
    let queueStartY = 0;
    let queueStartX = 0;

    let activeCommitDir = 0;
    let activeCommitTargetIndex = null;
    let activeCommitVideoToPause = null;

    let playbackGuardTimer = 0;

    let gestureHeight = 0;
    let touchBlocked = false;

    const seekPill = document.getElementById('seekPill');
    const seekTime = document.getElementById('seekTime');

    const layerEffectCache = new WeakMap();

    const setTr = (el, y) => {
      if (!el) return;
      el.style.transform = `translate3d(0,${y}px,0)`;
    };

    function getLayerEffectEls(layer) {
      if (!layer) return null;

      let cached = layerEffectCache.get(layer);
      if (cached) return cached;

      cached = {
        sideMenu: layer.querySelector('.side'),
        videoMeta: layer.querySelector('.video-meta')
      };

      layerEffectCache.set(layer, cached);

      return cached;
    }

    function updateLayerEffects(layer, opacity) {
      const els = getLayerEffectEls(layer);
      if (!els) return;

      if (els.sideMenu) {
        els.sideMenu.style.opacity = opacity;
      }

      if (els.videoMeta) {
        els.videoMeta.style.opacity = opacity;
      }
    }

    function resetSeekUiImmediate() {
      if (seekPill) {
        seekPill.classList.remove('is-active');
      }

      if (seekTime) {
        seekTime.classList.remove('is-active');
      }

      document.querySelectorAll('.side').forEach((side) => {
        side.classList.remove('scrubbing');
        side.style.opacity = '1';
        side.style.display = '';
      });

      document.querySelectorAll('.video-meta').forEach((meta) => {
        meta.classList.remove('scrubbing');
        meta.style.opacity = '1';
        meta.style.display = '';
      });
    }

    function clearPendingCommit() {
      if (pendingCommitTimer) {
        clearTimeout(pendingCommitTimer);
        pendingCommitTimer = 0;
      }

      pendingCommitDir = 0;
      pendingCommitRetries = 0;
    }

    function clearPlaybackGuard() {
      if (playbackGuardTimer) {
        clearTimeout(playbackGuardTimer);
        playbackGuardTimer = 0;
      }
    }

    function resetQueue() {
      queuedDir = 0;
      queueHasStart = false;
      queueStartY = 0;
      queueStartX = 0;
    }

    function resetActiveCommit() {
      activeCommitDir = 0;
      activeCommitTargetIndex = null;
      activeCommitVideoToPause = null;
    }

    function guardCurrentPlayback() {
      clearPlaybackGuard();

      playbackGuardTimer = setTimeout(() => {
        playbackGuardTimer = 0;

        if (state.isAnimating || dragging) return;

        const item = playlist[state.index];
        const video = refs.videoCurrent;

        if (!item || item.type !== 'video' || !video) return;

        video.muted = state.isMuted;
        video.playsInline = true;

        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');

        if (
          video.paused &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          tryPlay(video);
        }
      }, 180);
    }

    function resetTransformsNoAnim() {
      const height = vh();

      if (raf) {
        cancelAnimationFrame(raf);
      }

      raf = 0;

      clearTimeout(settleTimer);
      settleTimer = 0;

      clearPendingCommit();

      [
        refs.layerPrev,
        refs.layerCurrent,
        refs.layerNext
      ]
        .filter(Boolean)
        .forEach((layer) => {
          layer.style.transition = 'none';
          layer.style.willChange = 'auto';
          updateLayerEffects(layer, 1);
        });

      setTr(refs.layerPrev, -height);
      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, height);
    }

    function recoverVisibleState() {
      if (raf) {
        cancelAnimationFrame(raf);
      }

      raf = 0;

      clearTimeout(settleTimer);
      settleTimer = 0;

      clearPendingCommit();
      clearPlaybackGuard();

      dragging = false;

      dy = 0;
      dx = 0;

      preparedDir = 0;
      swipeSoundUnlocked = false;
      gestureHeight = 0;
      touchBlocked = false;

      resetQueue();
      resetActiveCommit();

      state.isAnimating = false;

      resetSeekUiImmediate();
      resetTransformsNoAnim();

      bindAutoAdvanceForCurrent();
      guardCurrentPlayback();

      requestAnimationFrame(() => {
        warmForwardNext();
        warmBackwardNext();
      });
    }

    function prewarmVideo(videoEl, item) {
      if (!videoEl || !item || item.type !== 'video') return;

      videoEl.muted = true;
      videoEl.preload = 'auto';
      videoEl.playsInline = true;

      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('webkit-playsinline', '');
      videoEl.setAttribute('disablepictureinpicture', '');
      videoEl.setAttribute('x-webkit-airplay', 'deny');

      if (
        videoEl.networkState === HTMLMediaElement.NETWORK_EMPTY &&
        videoEl.getAttribute('src')
      ) {
        try {
          videoEl.load();
        } catch (e) {}
      }
    }

    function prepareForwardLayer(heightOverride) {
      const height = heightOverride || vh();
      const targetIndex = normalizeIndex(state.index + 1);

      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(
          refs.layerNext,
          playlist[targetIndex],
          true
        );

        nextLoadedIndex = targetIndex;

        prewarmVideo(
          refs.videoNext,
          playlist[targetIndex]
        );
      }

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, height);
    }

    function prepareBackwardLayer(heightOverride) {
      if (!refs.layerPrev || !refs.videoPrev) return;

      const height = heightOverride || vh();
      const targetIndex = normalizeIndex(state.index - 1);

      if (prevLoadedIndex !== targetIndex) {
        setLayerContent(
          refs.layerPrev,
          playlist[targetIndex],
          true
        );

        prevLoadedIndex = targetIndex;

        prewarmVideo(
          refs.videoPrev,
          playlist[targetIndex]
        );
      }

      refs.layerPrev.style.transition = 'none';
      setTr(refs.layerPrev, -height);
    }

    function warmForwardNext() {
      if (state.isAnimating) return;
      prepareForwardLayer();
    }

    function warmBackwardNext() {
      if (state.isAnimating) return;
      prepareBackwardLayer();
    }

    function prepareBothDirections(heightOverride) {
      const height = heightOverride || vh();

      prepareForwardLayer(height);
      prepareBackwardLayer(height);
    }

    function prepareNextForDirection(dir) {
      const height = gestureHeight || vh();

      if (dir > 0) {
        refs.layerNext.style.transition = 'none';
        setTr(refs.layerNext, height);
      } else if (refs.layerPrev) {
        refs.layerPrev.style.transition = 'none';
        setTr(refs.layerPrev, -height);
      }

      preparedDir = dir;
    }

    function isTargetFrameReady(item, video) {
      if (!item || item.type !== 'video') {
        return true;
      }

      if (!video) {
        return false;
      }

      return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    function queueCommitUntilReady(dir) {
      if (pendingCommitTimer && pendingCommitDir === dir) {
        return;
      }

      if (pendingCommitDir !== dir) {
        clearPendingCommit();
        pendingCommitDir = dir;
      }

      pendingCommitTimer = setTimeout(() => {
        pendingCommitTimer = 0;
        pendingCommitRetries += 1;

        if (state.isAnimating) {
          clearPendingCommit();
          return;
        }

        const targetIndex = normalizeIndex(state.index + dir);
        const targetItem = playlist[targetIndex];
        const targetVideo = dir > 0
          ? refs.videoNext
          : refs.videoPrev;

        if (isTargetFrameReady(targetItem, targetVideo)) {
          pendingCommitDir = 0;
          pendingCommitRetries = 0;
          commit(dir);
          return;
        }

        if (pendingCommitRetries >= COMMIT_READY_MAX_RETRIES) {
          clearPendingCommit();
          snapBack();
          return;
        }

        queueCommitUntilReady(dir);
      }, COMMIT_READY_RETRY_MS);
    }

    function finishCommit(dir, targetIndex, videoToPause) {
      if (videoToPause) {
        videoToPause.pause();
      }

      state.index = targetIndex;

      if (dir > 0) {
        const oldPrevLayer = refs.layerPrev;
        const oldPrevVideo = refs.videoPrev;
        const oldPrevImg = refs.imgPrev;

        const oldCurrentLayer = refs.layerCurrent;
        const oldCurrentVideo = refs.videoCurrent;
        const oldCurrentImg = refs.imgCurrent;

        refs.layerCurrent = refs.layerNext;
        refs.videoCurrent = refs.videoNext;
        refs.imgCurrent = refs.imgNext;

        refs.layerPrev = oldCurrentLayer;
        refs.videoPrev = oldCurrentVideo;
        refs.imgPrev = oldCurrentImg;

        refs.layerNext = oldPrevLayer;
        refs.videoNext = oldPrevVideo;
        refs.imgNext = oldPrevImg;

        prevLoadedIndex = normalizeIndex(state.index - 1);
        nextLoadedIndex = null;
      } else {
        const oldNextLayer = refs.layerNext;
        const oldNextVideo = refs.videoNext;
        const oldNextImg = refs.imgNext;

        const oldCurrentLayer = refs.layerCurrent;
        const oldCurrentVideo = refs.videoCurrent;
        const oldCurrentImg = refs.imgCurrent;

        refs.layerCurrent = refs.layerPrev;
        refs.videoCurrent = refs.videoPrev;
        refs.imgCurrent = refs.imgPrev;

        refs.layerNext = oldCurrentLayer;
        refs.videoNext = oldCurrentVideo;
        refs.imgNext = oldCurrentImg;

        refs.layerPrev = oldNextLayer;
        refs.videoPrev = oldNextVideo;
        refs.imgPrev = oldNextImg;

        nextLoadedIndex = normalizeIndex(state.index + 1);
        prevLoadedIndex = null;
      }

      if (refs.playOverlay) {
        refs.layerCurrent.appendChild(refs.playOverlay);
      }

      resetTransformsNoAnim();
      resetSeekUiImmediate();

      syncSoundUI();
      showPlayOverlay(false);

      state.isAnimating = false;
      resetActiveCommit();

      document.dispatchEvent(
        new CustomEvent('tikboo:swipe:commit')
      );

      bindAutoAdvanceForCurrent();

      if (playlist[state.index].type === 'video') {
        refs.videoCurrent.muted = state.isMuted;

        if (refs.videoCurrent.paused) {
          tryPlay(refs.videoCurrent);
        }

        guardCurrentPlayback();
      }

      const queued = queuedDir;
      resetQueue();

      requestAnimationFrame(() => {
        warmForwardNext();
        warmBackwardNext();

        if (queued !== 0 && !state.isAnimating) {
          preparedDir = queued;
          commit(queued);
        }
      });
    }

    function interruptActiveCommit() {
      if (
        !state.isAnimating ||
        activeCommitDir === 0 ||
        activeCommitTargetIndex === null
      ) {
        return false;
      }

      if (raf) {
        cancelAnimationFrame(raf);
      }

      raf = 0;

      clearTimeout(settleTimer);
      settleTimer = 0;

      clearPendingCommit();

      finishCommit(
        activeCommitDir,
        activeCommitTargetIndex,
        activeCommitVideoToPause
      );

      return true;
    }

    function commit(dir) {
      const now = performance.now();

      if (now - lastCommitTime < COMMIT_COOLDOWN) {
        return;
      }

      if (state.isAnimating) {
        return;
      }

      const targetIndex = normalizeIndex(state.index + dir);
      const targetItem = playlist[targetIndex];

      const targetLayer = dir > 0
        ? refs.layerNext
        : refs.layerPrev;

      const targetVideo = dir > 0
        ? refs.videoNext
        : refs.videoPrev;

      if (!targetLayer) {
        snapBack();
        return;
      }

      if (!isTargetFrameReady(targetItem, targetVideo)) {
        queueCommitUntilReady(dir);
        return;
      }

      clearPendingCommit();
      clearPlaybackGuard();

      lastCommitTime = now;
      state.isAnimating = true;

      clearAuto();
      stopProg();
      resetSeekUiImmediate();

      if (raf) {
        cancelAnimationFrame(raf);
      }

      raf = 0;

      clearTimeout(settleTimer);
      settleTimer = 0;

      const height = gestureHeight || vh();
      const duration = 160;
      const videoToPause = refs.videoCurrent;

      activeCommitDir = dir;
      activeCommitTargetIndex = targetIndex;
      activeCommitVideoToPause = videoToPause;

      if (targetItem?.type === 'video' && targetVideo) {
        targetVideo.muted = state.isMuted;
        targetVideo.playsInline = true;

        targetVideo.setAttribute('playsinline', '');
        targetVideo.setAttribute('webkit-playsinline', '');

        if (targetVideo.paused) {
          tryPlay(targetVideo);
        }
      }

      refs.layerCurrent.style.willChange = 'transform';
      targetLayer.style.willChange = 'transform';

      const monsterCurve =
        'cubic-bezier(0.15, 0.85, 0.2, 1)';

      refs.layerCurrent.style.transition =
        `transform ${duration}ms ${monsterCurve}`;

      targetLayer.style.transition =
        `transform ${duration}ms ${monsterCurve}`;

      updateLayerEffects(refs.layerCurrent, 0.3);

      setTr(
        refs.layerCurrent,
        dir > 0 ? -height : height
      );

      setTr(targetLayer, 0);

      settleTimer = setTimeout(() => {
        settleTimer = 0;

        finishCommit(
          dir,
          targetIndex,
          videoToPause
        );
      }, duration);
    }

    function snapBack() {
      if (state.isAnimating) return;

      clearPendingCommit();
      resetQueue();

      state.isAnimating = true;

      const duration = 200;
      const snapDir = preparedDir;

      const targetLayer = preparedDir > 0
        ? refs.layerNext
        : refs.layerPrev;

      const height = gestureHeight || vh();

      refs.layerCurrent.style.transition =
        `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;

      if (targetLayer) {
        targetLayer.style.transition =
          `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;
      }

      updateLayerEffects(refs.layerCurrent, 1);

      setTr(refs.layerCurrent, 0);

      if (targetLayer) {
        setTr(
          targetLayer,
          preparedDir > 0 ? height : -height
        );
      }

      settleTimer = setTimeout(() => {
        settleTimer = 0;
        preparedDir = 0;

        resetTransformsNoAnim();

        state.isAnimating = false;

        bindAutoAdvanceForCurrent();
        guardCurrentPlayback();

        if (snapDir < 0) {
          warmBackwardNext();
        } else {
          warmForwardNext();
        }
      }, duration);
    }

    function autoAdvance() {
      if (state.isAnimating || dragging) return;

      warmForwardNext();

      preparedDir = 1;
      commit(1);
    }

    function finishGesture(cancelled) {
      if (!dragging || state.isAnimating) return;

      const totalDy = dy;
      const endT = performance.now();
      const dt = Math.max(1, endT - startT);
      const height = gestureHeight || vh();

      dragging = false;
      swipeSoundUnlocked = false;
      touchBlocked = false;

      if (cancelled || preparedDir === 0) {
        if (preparedDir !== 0) {
          snapBack();
        } else {
          const isTap =
            Math.abs(totalDy) < TAP_MAX_MOVE &&
            dt < TAP_MAX_TIME;

          if (isTap && refs.videoCurrent) {
            if (refs.videoCurrent.paused) {
              if (ensureSoundOn) {
                ensureSoundOn(true);
              } else {
                tryPlay(refs.videoCurrent);
              }

              showPlayOverlay(false);
              guardCurrentPlayback();
            } else {
              clearPlaybackGuard();

              refs.videoCurrent.pause();
              stopProg();
              showPlayOverlay(true);
            }
          }

          resetTransformsNoAnim();
          bindAutoAdvanceForCurrent();
        }

        return;
      }

      const vy = (lastMoveY - startY) / dt;
      const isBackward = preparedDir === -1;

      const thresholdRatio = isBackward
        ? BACKWARD_THRESHOLD_RATIO
        : THRESHOLD_RATIO;

      const minDy = isBackward
        ? BACKWARD_MIN_COMMIT_DY
        : MIN_COMMIT_DY;

      const minVy = isBackward
        ? BACKWARD_MIN_COMMIT_VY
        : MIN_COMMIT_VY;

      if (
        Math.abs(totalDy) >= height * thresholdRatio ||
        (
          Math.abs(totalDy) >= minDy &&
          Math.abs(vy) >= minVy
        )
      ) {
        commit(preparedDir);
      } else {
        snapBack();
      }

      dy = 0;
      dx = 0;
    }

    document.addEventListener('touchstart', (e) => {
      touchBlocked =
        e.touches.length !== 1 ||
        isInteractiveTarget(e.target);

      if (touchBlocked) return;

      gestureHeight = vh();

      if (state.isAnimating) {
        const interrupted = interruptActiveCommit();

        if (!interrupted || state.isAnimating) {
          queueHasStart = true;
          queueStartY = e.touches[0].clientY;
          queueStartX = e.touches[0].clientX;
          queuedDir = 0;
          return;
        }
      }

      dragging = true;
      preparedDir = 0;

      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;

      startT = performance.now();
      lastMoveY = startY;

      dy = 0;
      dx = 0;

      clearAuto();
      stopProg();
      clearPendingCommit();

      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';

      if (refs.layerPrev) {
        refs.layerPrev.style.transition = 'none';
      }

      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';

      if (refs.layerPrev) {
        refs.layerPrev.style.willChange = 'transform';
      }

      prepareBothDirections(gestureHeight);
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (touchBlocked) return;

      if (state.isAnimating) {
        if (!e.touches || e.touches.length !== 1) return;

        const qy = e.touches[0].clientY;
        const qx = e.touches[0].clientX;

        if (!queueHasStart) {
          queueHasStart = true;
          queueStartY = qy;
          queueStartX = qx;
          queuedDir = 0;
          return;
        }

        const qdy = qy - queueStartY;
        const qdx = qx - queueStartX;

        if (
          Math.abs(qdx) > Math.abs(qdy) * 1.4 ||
          Math.abs(qdy) < QUEUE_MOVE_ACTIVATE_PX
        ) {
          return;
        }

        const nextQueuedDir = qdy < 0 ? 1 : -1;

        if (
          queuedDir !== 0 &&
          queuedDir !== nextQueuedDir
        ) {
          queueStartY = qy;
          queueStartX = qx;
        }

        queuedDir = nextQueuedDir;
        return;
      }

      if (!dragging) {
        if (!e.touches || e.touches.length !== 1) return;

        dragging = true;
        preparedDir = 0;

        gestureHeight = gestureHeight || vh();

        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;

        startT = performance.now();
        lastMoveY = startY;

        dy = 0;
        dx = 0;

        clearAuto();
        stopProg();
        clearPendingCommit();

        refs.layerCurrent.style.transition = 'none';
        refs.layerNext.style.transition = 'none';

        if (refs.layerPrev) {
          refs.layerPrev.style.transition = 'none';
        }

        prepareBothDirections(gestureHeight);
      }

      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;

      const ddy = y - startY;
      const ddx = x - startX;

      if (
        Math.abs(ddx) > Math.abs(ddy) * 1.4 ||
        Math.abs(ddy) < MOVE_ACTIVATE_PX
      ) {
        return;
      }

      e.preventDefault();

      const previousDy = dy;
      const nextDy = ddy;

      if (
        Math.abs(nextDy - previousDy) >
        MAX_MOVE_STEP_PX
      ) {
        dy =
          previousDy +
          Math.sign(nextDy - previousDy) *
            MAX_MOVE_STEP_PX;
      } else {
        dy = nextDy;
      }

      dx = ddx;
      lastMoveY = y;

      if (
        !swipeSoundUnlocked &&
        typeof ensureSoundOn === 'function'
      ) {
        ensureSoundOn(true);
        swipeSoundUnlocked = true;
      }

      const rawDir = dy < 0 ? 1 : -1;

      const isDirectionFlip =
        preparedDir !== 0 &&
        preparedDir !== rawDir;

      const dir =
        isDirectionFlip &&
        Math.abs(dy) < DIRECTION_FLIP_DAMPING_PX
          ? preparedDir
          : rawDir;

      if (preparedDir !== dir) {
        prepareNextForDirection(dir);
      }

      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;

          const height = gestureHeight;

          const progress = Math.min(
            Math.abs(dy) / (height * 0.4),
            1
          );

          const currentOpacity = Math.max(
            1 - progress,
            0.3
          );

          const targetLayer = preparedDir > 0
            ? refs.layerNext
            : refs.layerPrev;

          updateLayerEffects(
            refs.layerCurrent,
            currentOpacity
          );

          setTr(refs.layerCurrent, dy);

          if (targetLayer) {
            if (preparedDir > 0) {
              setTr(targetLayer, height + dy);
            } else if (preparedDir < 0) {
              setTr(targetLayer, -height + dy);
            }
          }
        });
      }
    }, { passive: false });

    document.addEventListener('touchend', () => {
      touchBlocked = false;
      finishGesture(false);
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
      touchBlocked = false;
      finishGesture(true);
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        recoverVisibleState();
      } else {
        clearPlaybackGuard();
        clearPendingCommit();
        resetQueue();
      }
    }, { passive: true });

    window.addEventListener('pageshow', () => {
      recoverVisibleState();
    }, { passive: true });

    return {
      autoAdvance,
      warmForwardNext,
      warmBackwardNext,
      commit,
      resetTransformsNoAnim,

      isDragging() {
        return dragging;
      }
    };
  }

  window.initTikbooSwipe = initTikbooSwipe;
})();
