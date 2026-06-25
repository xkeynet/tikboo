// /assets/js/swipe.js - ATOMIC VERSION
(function () {
  function initTikbooSwipe(options) {
    const { 
      refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
      bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
      ensureSoundOn, isInteractiveTarget 
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

    let dragging = false;
    let startY = 0, startX = 0, dy = 0, dx = 0;
    let preparedDir = 0, raf = 0, settleTimer = 0;
    let startT = 0, lastMoveY = 0;
    let nextLoadedIndex = null;
    let prevLoadedIndex = null;
    let nextLoadedDir = 0;
    let swipeSoundUnlocked = false;
    let lastCommitTime = 0;
    let pendingCommitTimer = 0;
    let queuedDir = 0;
    let queueHasStart = false;
    let queueStartY = 0;
    let queueStartX = 0;
    let memoryForwardIndex = null;
    let memoryBackwardIndex = null;
    let activeCommitDir = 0;
    let activeCommitTargetIndex = null;
    let activeCommitVideoToPause = null;
    let playbackGuardTimer = 0;
    let playbackGuardTimers = [];
    const COMMIT_COOLDOWN = 55;

    const seekPill = document.getElementById('seekPill');
    const seekTime = document.getElementById('seekTime');

    const memoryForwardVideo = document.createElement('video');
    const memoryBackwardVideo = document.createElement('video');

    [memoryForwardVideo, memoryBackwardVideo].forEach(v => {
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
      v.style.left = '-9999px';
      v.style.top = '-9999px';
      document.body.appendChild(v);
    });

    const setTr = (el, y) => {
      if (!el) return;
      el.style.transform = `translate3d(0,${y}px,0)`;
    };

    function updateLayerEffects(layer, opacity) {
      if (!layer) return;

      const sideMenu = layer.querySelector('.side');
      if (sideMenu) sideMenu.style.opacity = opacity;

      const videoMeta = layer.querySelector('.video-meta');
      if (videoMeta) videoMeta.style.opacity = opacity;
    }

    function resetSeekUiImmediate() {
      if (seekPill) seekPill.classList.remove('is-active');
      if (seekTime) seekTime.classList.remove('is-active');

      document.querySelectorAll('.side').forEach(s => {
        s.classList.remove('scrubbing');
        s.style.opacity = '1';
        s.style.display = '';
      });

      document.querySelectorAll('.video-meta').forEach(m => {
        m.classList.remove('scrubbing');
        m.style.opacity = '1';
        m.style.display = '';
      });
    }

    function clearPendingCommit() {
      if (pendingCommitTimer) {
        clearTimeout(pendingCommitTimer);
        pendingCommitTimer = 0;
      }
    }

    function clearPlaybackGuard() {
      if (playbackGuardTimer) {
        clearTimeout(playbackGuardTimer);
        playbackGuardTimer = 0;
      }

      playbackGuardTimers.forEach(t => clearTimeout(t));
      playbackGuardTimers = [];
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

    function guardCurrentPlayback(reason) {
      clearPlaybackGuard();

      const delays = [0, 40, 120, 260, 520];

      const attempt = () => {
        if (state.isAnimating || dragging) return;

        const item = playlist[state.index];
        const video = refs.videoCurrent;

        if (!item || item.type !== 'video' || !video) return;

        video.muted = state.isMuted;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');

        if (video.readyState < 2) {
          try {
            video.load();
          } catch (e) {}
        }

        if (video.paused || video.readyState < 2) {
          tryPlay(video);
        }
      };

      delays.forEach((delay) => {
        const timer = setTimeout(() => {
          playbackGuardTimers = playbackGuardTimers.filter(t => t !== timer);
          attempt();
        }, delay);

        playbackGuardTimers.push(timer);
      });
    }

    function warmMemoryVideo(videoEl, item) {
      if (!videoEl || !item || item.type !== 'video' || !item.src) return;

      const current = videoEl.getAttribute('src') || '';
      if (current === item.src || current.endsWith(item.src)) return;

      videoEl.pause();

      try {
        videoEl.src = item.src;
        videoEl.load();
      } catch (e) {}
    }

    function warmMemoryForward() {
      const targetIndex = normalizeIndex(state.index + 2);
      if (memoryForwardIndex === targetIndex) return;

      memoryForwardIndex = targetIndex;
      warmMemoryVideo(memoryForwardVideo, playlist[targetIndex]);
    }

    function warmMemoryBackward() {
      const targetIndex = normalizeIndex(state.index - 2);
      if (memoryBackwardIndex === targetIndex) return;

      memoryBackwardIndex = targetIndex;
      warmMemoryVideo(memoryBackwardVideo, playlist[targetIndex]);
    }

    function resetTransformsNoAnim() {
      const height = vh();

      if (raf) cancelAnimationFrame(raf);
      raf = 0;

      clearTimeout(settleTimer);
      clearPendingCommit();

      [refs.layerPrev, refs.layerCurrent, refs.layerNext].filter(Boolean).forEach(l => {
        l.style.transition = 'none';
        l.style.willChange = 'auto';
        updateLayerEffects(l, 1);
      });

      setTr(refs.layerPrev, -height);
      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, height);
    }

    function recoverVisibleState() {
      if (raf) cancelAnimationFrame(raf);
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

      resetQueue();
      resetActiveCommit();

      state.isAnimating = false;

      resetSeekUiImmediate();
      resetTransformsNoAnim();
      bindAutoAdvanceForCurrent();
      guardCurrentPlayback('recoverVisibleState');

      requestAnimationFrame(() => {
        warmForwardNext();
        warmBackwardNext();
      });
    }

    function prewarmVideo(videoEl, item) {
      if (!videoEl || !item || item.type !== 'video') return;

      if (videoEl !== refs.videoCurrent) {
        videoEl.pause();
        videoEl.currentTime = 0;
      }
    }

    function prepareForwardLayer() {
      const height = vh();
      const targetIndex = normalizeIndex(state.index + 1);
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        prewarmVideo(refs.videoNext, playlist[targetIndex]);
      }

      warmMemoryForward();

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, height);
      nextLoadedDir = 1;
    }

    function prepareBackwardLayer() {
      if (!refs.layerPrev || !refs.videoPrev) return;

      const height = vh();
      const targetIndex = normalizeIndex(state.index - 1);
      
      if (prevLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerPrev, playlist[targetIndex], true);
        prevLoadedIndex = targetIndex;
        prewarmVideo(refs.videoPrev, playlist[targetIndex]);
      }

      warmMemoryBackward();

      refs.layerPrev.style.transition = 'none';
      setTr(refs.layerPrev, -height);
      nextLoadedDir = -1;
    }

    function warmForwardNext() {
      if (state.isAnimating) return;
      prepareForwardLayer();
    }

    function warmBackwardNext() {
      if (state.isAnimating) return;
      prepareBackwardLayer();
    }

    function prepareNextForDirection(dir) {
      if (dir > 0) {
        prepareForwardLayer();
      } else {
        prepareBackwardLayer();
      }

      preparedDir = dir;
    }

    function retryCommitOnce(dir) {
      clearPendingCommit();

      pendingCommitTimer = setTimeout(() => {
        pendingCommitTimer = 0;

        if (state.isAnimating) return;

        commit(dir);
      }, 90);
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

      if (refs.playOverlay) refs.layerCurrent.appendChild(refs.playOverlay);

      resetTransformsNoAnim();
      resetSeekUiImmediate();
      syncSoundUI();
      showPlayOverlay(false);

      state.isAnimating = false;
      resetActiveCommit();

      bindAutoAdvanceForCurrent();

      if (playlist[state.index].type === 'video') {
        refs.videoCurrent.muted = state.isMuted;
        tryPlay(refs.videoCurrent);
        guardCurrentPlayback('finishCommit');
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
      if (!state.isAnimating || activeCommitDir === 0 || activeCommitTargetIndex === null) return false;

      if (raf) cancelAnimationFrame(raf);
      raf = 0;

      clearTimeout(settleTimer);
      settleTimer = 0;
      clearPendingCommit();

      finishCommit(activeCommitDir, activeCommitTargetIndex, activeCommitVideoToPause);
      return true;
    }

    function commit(dir) {
      const now = performance.now();

      if (now - lastCommitTime < COMMIT_COOLDOWN) {
        return;
      }

      const targetIndex = normalizeIndex(state.index + dir);
      const targetItem = playlist[targetIndex];
      const targetLayer = dir > 0 ? refs.layerNext : refs.layerPrev;
      const targetVideo = dir > 0 ? refs.videoNext : refs.videoPrev;

      if (!targetLayer) {
        snapBack();
        return;
      }

      if (targetItem?.type === 'video' && targetVideo && targetVideo.readyState < 1) {
        retryCommitOnce(dir);
      }

      clearPendingCommit();
      clearPlaybackGuard();
      lastCommitTime = now;

      if (state.isAnimating) return;
      state.isAnimating = true;
      
      clearAuto();
      stopProg();
      resetSeekUiImmediate();

      if (raf) cancelAnimationFrame(raf);
      raf = 0;

      clearTimeout(settleTimer);

      const height = vh();
      const duration = 120; 
      const videoToPause = refs.videoCurrent;

      activeCommitDir = dir;
      activeCommitTargetIndex = targetIndex;
      activeCommitVideoToPause = videoToPause;

      if (targetItem?.type === 'video' && targetVideo) {
        targetVideo.muted = state.isMuted;

        try {
          if (targetVideo.readyState < 1) {
            targetVideo.load();
          }
        } catch (e) {}

        setTimeout(() => {
          if (!state.isAnimating) return;
          tryPlay(targetVideo);
        }, 8);

        setTimeout(() => {
          if (!state.isAnimating) return;
          if (targetVideo.paused || targetVideo.readyState < 2) {
            tryPlay(targetVideo);
          }
        }, 60);

        setTimeout(() => {
          if (!state.isAnimating) return;
          if (targetVideo.paused || targetVideo.readyState < 2) {
            tryPlay(targetVideo);
          }
        }, 140);
      }

      refs.layerCurrent.style.willChange = 'transform';
      targetLayer.style.willChange = 'transform';

      const monsterCurve = 'cubic-bezier(0.2, 0.9, 0.3, 1)';

      refs.layerCurrent.style.transition = `transform ${duration}ms ${monsterCurve}`;
      targetLayer.style.transition = `transform ${duration}ms ${monsterCurve}`;

      updateLayerEffects(refs.layerCurrent, 0.3);

      setTr(refs.layerCurrent, dir > 0 ? -height : height);
      setTr(targetLayer, 0);

      settleTimer = setTimeout(() => {
        finishCommit(dir, targetIndex, videoToPause);
      }, duration); 
    }

    function snapBack() {
      if (state.isAnimating) return;

      clearPendingCommit();
      resetQueue();

      state.isAnimating = true;

      const duration = 200;
      const snapDir = preparedDir;
      const targetLayer = preparedDir > 0 ? refs.layerNext : refs.layerPrev;
      
      refs.layerCurrent.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;
      if (targetLayer) {
        targetLayer.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;
      }

      updateLayerEffects(refs.layerCurrent, 1);

      setTr(refs.layerCurrent, 0);

      if (targetLayer) {
        setTr(targetLayer, preparedDir > 0 ? vh() : -vh());
      }

      settleTimer = setTimeout(() => {
        preparedDir = 0;
        resetTransformsNoAnim();
        state.isAnimating = false;
        bindAutoAdvanceForCurrent();
        guardCurrentPlayback('snapBack');

        if (snapDir < 0) warmBackwardNext();
        else warmForwardNext();
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
      
      dragging = false;
      swipeSoundUnlocked = false;

      if (cancelled || preparedDir === 0) {
        if (preparedDir !== 0) {
          snapBack();
        } else {
          const isTap = Math.abs(totalDy) < TAP_MAX_MOVE && dt < TAP_MAX_TIME;

          if (isTap && refs.videoCurrent) {
            if (refs.videoCurrent.paused) { 
              ensureSoundOn ? ensureSoundOn(true) : tryPlay(refs.videoCurrent);
              showPlayOverlay(false);
              guardCurrentPlayback('tapPlay');
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

      const thresholdRatio = isBackward ? BACKWARD_THRESHOLD_RATIO : THRESHOLD_RATIO;
      const minDy = isBackward ? BACKWARD_MIN_COMMIT_DY : MIN_COMMIT_DY;
      const minVy = isBackward ? BACKWARD_MIN_COMMIT_VY : MIN_COMMIT_VY;

      if (
        Math.abs(totalDy) >= vh() * thresholdRatio ||
        (Math.abs(totalDy) >= minDy && Math.abs(vy) >= minVy)
      ) {
        commit(preparedDir);
      } else {
        snapBack();
      }

      dy = 0;
      dx = 0;
    }

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || isInteractiveTarget(e.target)) return;

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
      
      clearAuto();
      stopProg();

      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';
      if (refs.layerPrev) refs.layerPrev.style.transition = 'none';
      
      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';
      if (refs.layerPrev) refs.layerPrev.style.willChange = 'transform';
      
      if (startY < vh() * 0.45) {
        warmBackwardNext();
      } else {
        warmForwardNext();
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (state.isAnimating) {
        if (!e.touches || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;

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

        if (Math.abs(qdx) > Math.abs(qdy) * 1.4 || Math.abs(qdy) < QUEUE_MOVE_ACTIVATE_PX) return;

        const nextQueuedDir = qdy < 0 ? 1 : -1;

        if (queuedDir !== 0 && queuedDir !== nextQueuedDir) {
          queueStartY = qy;
          queueStartX = qx;
        }

        queuedDir = nextQueuedDir;
        return;
      }

      if (!dragging) {
        if (!e.touches || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;

        dragging = true;
        preparedDir = 0;

        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        startT = performance.now();
        lastMoveY = startY;

        clearAuto();
        stopProg();

        refs.layerCurrent.style.transition = 'none';
        refs.layerNext.style.transition = 'none';
        if (refs.layerPrev) refs.layerPrev.style.transition = 'none';
      }

      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;

      const ddy = y - startY;
      const ddx = x - startX;

      if (Math.abs(ddx) > Math.abs(ddy) * 1.4 || Math.abs(ddy) < MOVE_ACTIVATE_PX) return;

      e.preventDefault();

      const previousDy = dy;
      const nextDy = ddy;

      if (Math.abs(nextDy - previousDy) > MAX_MOVE_STEP_PX) {
        dy = previousDy + Math.sign(nextDy - previousDy) * MAX_MOVE_STEP_PX;
      } else {
        dy = nextDy;
      }

      dx = ddx;
      lastMoveY = y;

      if (!swipeSoundUnlocked && typeof ensureSoundOn === 'function') {
        ensureSoundOn(true);
        swipeSoundUnlocked = true;
      }

      const rawDir = dy < 0 ? 1 : -1;
      const isDirectionFlip = preparedDir !== 0 && preparedDir !== rawDir;
      const dir = isDirectionFlip && Math.abs(dy) < DIRECTION_FLIP_DAMPING_PX ? preparedDir : rawDir;

      if (preparedDir !== dir) prepareNextForDirection(dir);

      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;

          const height = vh();
          const progress = Math.min(Math.abs(dy) / (height * 0.4), 1);
          const currentOpacity = Math.max(1 - progress, 0.3);
          const targetLayer = preparedDir > 0 ? refs.layerNext : refs.layerPrev;
          
          updateLayerEffects(refs.layerCurrent, currentOpacity);

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

    document.addEventListener('touchend', () => finishGesture(false), { passive: true });
    document.addEventListener('touchcancel', () => finishGesture(true), { passive: true });

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
