// /assets/js/swipe.js - Reels
(function () {
  'use strict';

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

    /* =========================================================
       VÁCLAV BUCHTELÍK — SWIPE ENGINE
       PREVIOUS + CURRENT + NEXT
       INTERRUPTIBLE CINEMATIC MOTION
       VIDEO ADAPTER FOR TIKBOO
       ========================================================= */

    const DEFAULTS = {
      axisLockPx: 4,

      commitDistanceRatio: 0.10,
      commitMinDistancePx: 28,
      flickMinDistancePx: 10,
      flickVelocityPxMs: 0.20,
      velocitySmoothing: 0.38,

      commitMinDurationMs: 420,
      commitMaxDurationMs: 680,
      commitDistanceDurationMs: 560,
      commitVelocityInfluence: 0.18,

      snapMinDurationMs: 260,
      snapMaxDurationMs: 420,

      cinematicPower: 4.2,
      cinematicTailStrength: 0.16,

      takeoverMinDistancePx: 6
    };

    const config = { ...DEFAULTS };

    const clamp = (value, min, max) =>
      Math.max(min, Math.min(max, value));

    const isDirection = direction =>
      direction === 1 || direction === -1;

    const getViewportHeight = () =>
      Math.max(
        1,
        typeof vh === 'function' ? vh() : 0,
        window.visualViewport?.height || 0,
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0
      );

    /* =========================================================
       EASING
       ========================================================= */

    const easeOutCubic = t =>
      1 - Math.pow(1 - t, 3);

    const createCinematicEase = (power, tailStrength) => {
      const p = Math.max(2, power);
      const tail = clamp(tailStrength, 0, 0.4);

      return t => {
        const base = 1 - Math.pow(1 - t, p);
        const tailShape =
          Math.sin(Math.PI * t) * (1 - t);

        return clamp(
          base - tailShape * tail,
          0,
          1
        );
      };
    };

    const cinematicEase = createCinematicEase(
      config.cinematicPower,
      config.cinematicTailStrength
    );

    /* =========================================================
       STATE
       ========================================================= */

    let dragging = false;
    let animating = false;
    let takingOver = false;

    let axis = null;

    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastTime = 0;

    let dragY = 0;
    let velocityY = 0;
    let viewportHeight = 1;

    let raf = 0;
    let motionToken = 0;

    let motionDirection = 0;
    let takeoverOrigin = 0;

    let nextLoadedIndex = null;
    let prevLoadedIndex = null;

    let touchBlocked = false;
    let swipeSoundUnlocked = false;

    /* =========================================================
       LAYERS
       ========================================================= */

    const layers = () => [
      refs.layerPrev,
      refs.layerCurrent,
      refs.layerNext
    ].filter(Boolean);

    const hasLayers = () =>
      Boolean(
        refs.layerPrev &&
        refs.layerCurrent &&
        refs.layerNext
      );

    const setTransform = (layer, y) => {
      if (!layer) return;

      layer.style.transform =
        `translate3d(0,${y.toFixed(3)}px,0)`;
    };

    const prepareLayers = active => {
      layers().forEach(layer => {
        layer.style.transition = 'none';
        layer.style.willChange =
          active ? 'transform' : 'auto';
      });
    };

    const renderTrack = offset => {
      setTransform(
        refs.layerPrev,
        -viewportHeight + offset
      );

      setTransform(
        refs.layerCurrent,
        offset
      );

      setTransform(
        refs.layerNext,
        viewportHeight + offset
      );
    };

    /* =========================================================
       VIDEO PREPARATION
       ========================================================= */

    function prewarmVideo(videoEl, item) {
      if (
        !videoEl ||
        !item ||
        item.type !== 'video'
      ) {
        return;
      }

      videoEl.playsInline = true;
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute(
        'webkit-playsinline',
        ''
      );

      if (videoEl !== refs.videoCurrent) {
        videoEl.muted = true;

        try {
          if (videoEl.readyState === 0) {
            videoEl.load();
          }
        } catch (e) {}
      }
    }

    function prepareForwardLayer() {
      const targetIndex =
        normalizeIndex(state.index + 1);

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
    }

    function prepareBackwardLayer() {
      const targetIndex =
        normalizeIndex(state.index - 1);

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
    }

    function warmForwardNext() {
      if (animating) return;
      prepareForwardLayer();
    }

    function warmBackwardNext() {
      if (animating) return;
      prepareBackwardLayer();
    }

    /* =========================================================
       MOTION
       ========================================================= */

    const cancelMotion = () => {
      motionToken++;

      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const resetGesture = () => {
      dragging = false;
      takingOver = false;
      axis = null;

      startX = 0;
      startY = 0;
      lastY = 0;
      lastTime = 0;

      velocityY = 0;
      takeoverOrigin = 0;

      touchBlocked = false;
      swipeSoundUnlocked = false;
    };

    function resetTransformsNoAnim() {
      if (!hasLayers()) return;

      cancelMotion();

      viewportHeight = getViewportHeight();

      dragY = 0;
      velocityY = 0;
      motionDirection = 0;

      prepareLayers(false);
      renderTrack(0);
    }

    const prepareMotion = () => {
      viewportHeight = getViewportHeight();
      prepareLayers(true);
    };

    /* =========================================================
       CINEMATIC RAF
       ========================================================= */

    const animate = ({
      from,
      to,
      duration,
      easing,
      complete
    }) => {
      cancelMotion();

      const token = motionToken;
      const startedAt = performance.now();
      const distance = to - from;

      prepareLayers(true);

      const frame = now => {
        if (
          !animating ||
          token !== motionToken
        ) {
          raf = 0;
          return;
        }

        const progress = clamp(
          (now - startedAt) /
            Math.max(1, duration),
          0,
          1
        );

        dragY =
          from +
          distance * easing(progress);

        renderTrack(dragY);

        if (progress < 1) {
          raf = requestAnimationFrame(frame);
          return;
        }

        raf = 0;
        dragY = to;

        renderTrack(to);

        if (typeof complete === 'function') {
          complete();
        }
      };

      raf = requestAnimationFrame(frame);
    };

    /* =========================================================
       DURATION
       ========================================================= */

    const getCommitDuration =
      remainingDistance => {
        const distanceRatio = clamp(
          remainingDistance /
            Math.max(1, viewportHeight),
          0,
          1
        );

        const velocityReduction = clamp(
          Math.abs(velocityY) *
            config.commitVelocityInfluence *
            100,
          0,
          110
        );

        const duration =
          config.commitMinDurationMs +
          distanceRatio *
            (
              config.commitDistanceDurationMs -
              config.commitMinDurationMs
            ) -
          velocityReduction;

        return clamp(
          duration,
          config.commitMinDurationMs,
          config.commitMaxDurationMs
        );
      };

    /* =========================================================
       VIDEO RECYCLE
       ========================================================= */

    function recycle(direction) {
      if (!isDirection(direction)) {
        return false;
      }

      const oldCurrentVideo =
        refs.videoCurrent;

      if (oldCurrentVideo) {
        oldCurrentVideo.pause();
      }

      state.index = normalizeIndex(
        state.index + direction
      );

      if (direction > 0) {
        const oldPrevLayer =
          refs.layerPrev;
        const oldPrevVideo =
          refs.videoPrev;
        const oldPrevImg =
          refs.imgPrev;

        const oldCurrentLayer =
          refs.layerCurrent;
        const oldCurrentVideoRef =
          refs.videoCurrent;
        const oldCurrentImg =
          refs.imgCurrent;

        refs.layerCurrent =
          refs.layerNext;
        refs.videoCurrent =
          refs.videoNext;
        refs.imgCurrent =
          refs.imgNext;

        refs.layerPrev =
          oldCurrentLayer;
        refs.videoPrev =
          oldCurrentVideoRef;
        refs.imgPrev =
          oldCurrentImg;

        refs.layerNext =
          oldPrevLayer;
        refs.videoNext =
          oldPrevVideo;
        refs.imgNext =
          oldPrevImg;

        prevLoadedIndex =
          normalizeIndex(
            state.index - 1
          );

        nextLoadedIndex = null;
      } else {
        const oldNextLayer =
          refs.layerNext;
        const oldNextVideo =
          refs.videoNext;
        const oldNextImg =
          refs.imgNext;

        const oldCurrentLayer =
          refs.layerCurrent;
        const oldCurrentVideoRef =
          refs.videoCurrent;
        const oldCurrentImg =
          refs.imgCurrent;

        refs.layerCurrent =
          refs.layerPrev;
        refs.videoCurrent =
          refs.videoPrev;
        refs.imgCurrent =
          refs.imgPrev;

        refs.layerNext =
          oldCurrentLayer;
        refs.videoNext =
          oldCurrentVideoRef;
        refs.imgNext =
          oldCurrentImg;

        refs.layerPrev =
          oldNextLayer;
        refs.videoPrev =
          oldNextVideo;
        refs.imgPrev =
          oldNextImg;

        nextLoadedIndex =
          normalizeIndex(
            state.index + 1
          );

        prevLoadedIndex = null;
      }

      if (
        refs.playOverlay &&
        refs.layerCurrent
      ) {
        refs.layerCurrent.appendChild(
          refs.playOverlay
        );
      }

      viewportHeight =
        getViewportHeight();

      dragY = 0;
      velocityY = 0;

      renderTrack(0);

      syncSoundUI();
      showPlayOverlay(false);

      document.dispatchEvent(
        new CustomEvent(
          'tikboo:swipe:commit'
        )
      );

      bindAutoAdvanceForCurrent();

      const currentItem =
        playlist[state.index];

      if (
        currentItem?.type === 'video' &&
        refs.videoCurrent
      ) {
        refs.videoCurrent.muted =
          state.isMuted;

        tryPlay(refs.videoCurrent);
      }

      requestAnimationFrame(() => {
        prepareForwardLayer();
        prepareBackwardLayer();
      });

      return true;
    }

    /* =========================================================
       COMMIT
       ========================================================= */

    const finishCommit = direction => {
      animating = false;
      state.isAnimating = false;
      motionDirection = 0;

      recycle(direction);

      if (!hasLayers()) return;

      resetGesture();
      prepareLayers(false);
    };

    function commit(direction) {
      if (
        !hasLayers() ||
        !isDirection(direction)
      ) {
        return false;
      }

      if (animating) {
        return false;
      }

      if (direction > 0) {
        prepareForwardLayer();
      } else {
        prepareBackwardLayer();
      }

      viewportHeight =
        getViewportHeight();

      const destination =
        direction > 0
          ? -viewportHeight
          : viewportHeight;

      const from = clamp(
        dragY,
        -viewportHeight,
        viewportHeight
      );

      const remainingDistance =
        Math.abs(
          destination - from
        );

      animating = true;
      state.isAnimating = true;

      dragging = false;
      takingOver = false;
      motionDirection = direction;

      clearAuto();
      stopProg();

      animate({
        from,
        to: destination,
        duration:
          getCommitDuration(
            remainingDistance
          ),
        easing: cinematicEase,
        complete: () =>
          finishCommit(direction)
      });

      return true;
    }

    /* =========================================================
       SNAP BACK
       ========================================================= */

    const finishSnapBack = () => {
      animating = false;
      state.isAnimating = false;
      motionDirection = 0;

      dragY = 0;
      velocityY = 0;

      resetGesture();
      renderTrack(0);
      prepareLayers(false);

      bindAutoAdvanceForCurrent();
    };

    const snapBack = () => {
      if (
        animating ||
        !hasLayers()
      ) {
        return;
      }

      viewportHeight =
        getViewportHeight();

      const from = clamp(
        dragY,
        -viewportHeight,
        viewportHeight
      );

      const ratio =
        Math.abs(from) /
        Math.max(1, viewportHeight);

      const duration = clamp(
        config.snapMinDurationMs +
          ratio *
            (
              config.snapMaxDurationMs -
              config.snapMinDurationMs
            ),
        config.snapMinDurationMs,
        config.snapMaxDurationMs
      );

      animating = true;
      state.isAnimating = true;

      dragging = false;
      takingOver = false;
      motionDirection = 0;

      animate({
        from,
        to: 0,
        duration,
        easing: easeOutCubic,
        complete: finishSnapBack
      });
    };

    /* =========================================================
       TAKEOVER
       ========================================================= */

    const beginTakeover = (x, y) => {
      if (
        !animating ||
        !isDirection(motionDirection)
      ) {
        return false;
      }

      takingOver = true;
      dragging = false;
      axis = null;

      startX = x;
      startY = y;

      lastY = y;
      lastTime = performance.now();

      takeoverOrigin = dragY;
      velocityY = 0;

      return true;
    };

    const activateTakeover =
      (x, y, dy) => {
        const direction =
          motionDirection;

        takeoverOrigin = dragY;

        cancelMotion();

        animating = false;
        state.isAnimating = false;
        motionDirection = 0;

        if (!recycle(direction)) {
          takingOver = false;
          dragging = false;
          axis = null;
          return false;
        }

        prepareMotion();

        takingOver = false;
        dragging = true;
        axis = 'vertical';

        const transferredDistance =
          Math.sign(dy) *
          Math.max(
            0,
            Math.abs(dy) -
              config.takeoverMinDistancePx
          );

        startX = x;
        startY =
          y - transferredDistance;

        lastY = y;
        lastTime =
          performance.now();

        dragY = clamp(
          transferredDistance,
          -viewportHeight,
          viewportHeight
        );

        velocityY = 0;

        renderTrack(dragY);

        return true;
      };

    const updateTakeover =
      (x, y) => {
        if (
          !takingOver ||
          !isDirection(motionDirection)
        ) {
          return false;
        }

        const dx = x - startX;
        const dy = y - startY;

        if (!axis) {
          if (
            Math.abs(dx) <
              config.axisLockPx &&
            Math.abs(dy) <
              config.axisLockPx
          ) {
            return false;
          }

          axis =
            Math.abs(dy) >
            Math.abs(dx)
              ? 'vertical'
              : 'horizontal';

          if (axis !== 'vertical') {
            takingOver = false;
            axis = null;
            return false;
          }
        }

        const gestureDirection =
          dy < 0 ? 1 : -1;

        if (
          gestureDirection !==
            motionDirection ||
          Math.abs(dy) <
            config.takeoverMinDistancePx
        ) {
          return true;
        }

        return activateTakeover(
          x,
          y,
          dy
        );
      };

    /* =========================================================
       NORMAL GESTURE
       ========================================================= */

    const beginGesture = (x, y) => {
      if (animating) {
        return beginTakeover(x, y);
      }

      cancelMotion();
      prepareMotion();

      dragging = true;
      takingOver = false;
      axis = null;

      startX = x;
      startY = y;

      lastY = y;
      lastTime =
        performance.now();

      dragY = 0;
      velocityY = 0;

      clearAuto();
      stopProg();

      prepareForwardLayer();
      prepareBackwardLayer();

      return true;
    };

    const updateDrag = (x, y) => {
      if (!dragging) {
        return false;
      }

      const dx = x - startX;
      const dy = y - startY;

      if (!axis) {
        if (
          Math.abs(dx) <
            config.axisLockPx &&
          Math.abs(dy) <
            config.axisLockPx
        ) {
          return false;
        }

        axis =
          Math.abs(dy) >
          Math.abs(dx)
            ? 'vertical'
            : 'horizontal';

        if (axis !== 'vertical') {
          dragging = false;
          resetTransformsNoAnim();
          return false;
        }
      }

      const now =
        performance.now();

      const dt =
        Math.max(
          1,
          now - lastTime
        );

      const instantVelocity =
        (y - lastY) / dt;

      velocityY =
        velocityY *
          (
            1 -
            config.velocitySmoothing
          ) +
        instantVelocity *
          config.velocitySmoothing;

      lastY = y;
      lastTime = now;

      dragY = clamp(
        dy,
        -viewportHeight,
        viewportHeight
      );

      renderTrack(dragY);

      return true;
    };

    const updateGesture =
      (x, y) => {
        if (
          takingOver &&
          animating
        ) {
          return updateTakeover(
            x,
            y
          );
        }

        if (
          dragging &&
          !animating
        ) {
          return updateDrag(
            x,
            y
          );
        }

        return false;
      };

    /* =========================================================
       END GESTURE
       ========================================================= */

    const endGesture =
      cancelled => {
        if (
          takingOver &&
          animating
        ) {
          takingOver = false;
          axis = null;
          return;
        }

        if (
          !dragging ||
          animating
        ) {
          return;
        }

        const distance =
          Math.abs(dragY);

        const threshold =
          Math.max(
            config.commitMinDistancePx,
            viewportHeight *
              config.commitDistanceRatio
          );

        const distanceCommit =
          distance >= threshold;

        const flickCommit =
          distance >=
            config.flickMinDistancePx &&
          Math.abs(velocityY) >=
            config.flickVelocityPxMs &&
          Math.sign(velocityY) ===
            Math.sign(dragY);

        if (
          !cancelled &&
          axis === 'vertical' &&
          dragY !== 0 &&
          (
            distanceCommit ||
            flickCommit
          )
        ) {
          commit(
            dragY < 0 ? 1 : -1
          );

          return;
        }

        if (
          axis === 'vertical' &&
          dragY !== 0
        ) {
          snapBack();
          return;
        }

        const isTap =
          Math.abs(dragY) <
          config.axisLockPx;

        resetGesture();
        resetTransformsNoAnim();

        if (
          isTap &&
          refs.videoCurrent
        ) {
          if (
            refs.videoCurrent.paused
          ) {
            if (
              typeof ensureSoundOn ===
              'function'
            ) {
              ensureSoundOn(true);
            } else {
              tryPlay(
                refs.videoCurrent
              );
            }

            showPlayOverlay(false);
          } else {
            refs.videoCurrent.pause();
            stopProg();
            showPlayOverlay(true);
          }
        }

        bindAutoAdvanceForCurrent();
      };

    /* =========================================================
       EXCLUDED TARGET
       ========================================================= */

    const isExcludedTarget =
      target => {
        if (
          typeof isInteractiveTarget ===
          'function'
        ) {
          return isInteractiveTarget(
            target
          );
        }

        return false;
      };

    /* =========================================================
       TOUCH
       ========================================================= */

    const handleTouchStart =
      event => {
        touchBlocked =
          event.touches.length !== 1 ||
          isExcludedTarget(
            event.target
          );

        if (touchBlocked) {
          return;
        }

        const touch =
          event.touches[0];

        beginGesture(
          touch.clientX,
          touch.clientY
        );
      };

    const handleTouchMove =
      event => {
        if (
          touchBlocked ||
          event.touches.length !== 1 ||
          (
            !dragging &&
            !takingOver
          )
        ) {
          return;
        }

        const touch =
          event.touches[0];

        if (
          !swipeSoundUnlocked &&
          typeof ensureSoundOn ===
            'function' &&
          (
            dragging ||
            takingOver
          )
        ) {
          ensureSoundOn(true);
          swipeSoundUnlocked = true;
        }

        if (
          updateGesture(
            touch.clientX,
            touch.clientY
          )
        ) {
          event.preventDefault();
        }
      };

    const handleTouchEnd = () => {
      touchBlocked = false;
      endGesture(false);
    };

    const handleTouchCancel = () => {
      touchBlocked = false;
      endGesture(true);
    };

    /* =========================================================
       LISTENERS
       ========================================================= */

    document.addEventListener(
      'touchstart',
      handleTouchStart,
      { passive: true }
    );

    document.addEventListener(
      'touchmove',
      handleTouchMove,
      { passive: false }
    );

    document.addEventListener(
      'touchend',
      handleTouchEnd,
      { passive: true }
    );

    document.addEventListener(
      'touchcancel',
      handleTouchCancel,
      { passive: true }
    );

    /* =========================================================
       AUTO ADVANCE
       ========================================================= */

    function autoAdvance() {
      if (
        animating ||
        dragging ||
        takingOver
      ) {
        return;
      }

      prepareForwardLayer();
      commit(1);
    }

    /* =========================================================
       VISIBILITY / RECOVERY
       ========================================================= */

    function recoverVisibleState() {
      cancelMotion();

      animating = false;
      state.isAnimating = false;
      motionDirection = 0;

      resetGesture();
      resetTransformsNoAnim();

      bindAutoAdvanceForCurrent();

      const item =
        playlist[state.index];

      if (
        item?.type === 'video' &&
        refs.videoCurrent
      ) {
        refs.videoCurrent.muted =
          state.isMuted;

        tryPlay(
          refs.videoCurrent
        );
      }

      requestAnimationFrame(() => {
        prepareForwardLayer();
        prepareBackwardLayer();
      });
    }

    document.addEventListener(
      'visibilitychange',
      () => {
        if (
          document.visibilityState ===
          'visible'
        ) {
          recoverVisibleState();
        }
      },
      { passive: true }
    );

    window.addEventListener(
      'pageshow',
      recoverVisibleState,
      { passive: true }
    );

    /* =========================================================
       INITIAL GEOMETRY
       ========================================================= */

    viewportHeight =
      getViewportHeight();

    resetTransformsNoAnim();

    /* =========================================================
       PUBLIC API — COMPATIBLE WITH APP.JS
       ========================================================= */

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

  window.initTikbooSwipe =
    initTikbooSwipe;
})();
