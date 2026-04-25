// /assets/js/swipe.js
(function () {
  function initTikbooSwipe(options) {
    const { refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
            bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
            ensureSoundOn, isInteractiveTarget } = options;

    const defer = options.defer || ((fn) => setTimeout(fn, 0));

    // --- Rozšířené možnosti odstraňující lagy ---
    const enforceSinglePlayback = options.enforceSinglePlayback || (() => {});
    const hardStopNextVideo = options.hardStopNextVideo || (() => {});
    const clearVideo = options.clearVideo || ((video) => {
      if (!video) return;
      try { video.pause(); } catch (e) {}
      video.removeAttribute('src');
      try { video.load(); } catch (e) {}
    });

    let dragging = false;
    let startY = 0, startX = 0, dy = 0, dx = 0;
    let preparedDir = 0, raf = 0, settleTimer = 0;
    let transitionLock = false; // Kritické pro ochranu event loopu

    // --- Konfigurace citlivosti (Optimalizováno pro 120ms pocit) ---
    const THRESHOLD_RATIO = 0.20; // Sníženo z 0.25 (stačí kratší swipe pro přepnutí)
    const MOVE_ACTIVATE_PX = 8;   // Rychlejší detekce začátku pohybu
    const MIN_COMMIT_DY = 50;     // Minimální dráha pro "švih"
    const MIN_COMMIT_VY = 0.55;   // Minimální rychlost pro "švih"
    const TAP_MAX_MOVE = 10;
    const TAP_MAX_TIME = 250;

    let startT = 0, lastMoveY = 0;
    let nextLoadedIndex = null, nextLoadedDir = 0;
    let swipeSoundUnlocked = false;

    function cancelRaf() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    function clearSettleTimer() { if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; } }

    // Vynucení GPU renderingu bez čekání
    function forceLayerGPU(layer) {
      if (!layer) return;
      layer.style.willChange = 'transform';
      layer.style.backfaceVisibility = 'hidden';
    }

    function setLayerSideOpacity(layer, opacity) {
      const side = layer?.querySelector('.side');
      if (side) side.style.opacity = String(opacity);
    }

    function resetLayerSideOpacity(layer) {
      const side = layer?.querySelector('.side');
      if (side) side.style.opacity = '1';
    }

    function resetTransformsNoAnim() {
      const height = vh();
      cancelRaf(); clearSettleTimer();
      transitionLock = false;
      preparedDir = 0;

      forceLayerGPU(refs.layerCurrent);
      forceLayerGPU(refs.layerNext);

      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';
      refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
      refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;

      resetLayerSideOpacity(refs.layerCurrent);
      hardStopNextVideo();
      enforceSinglePlayback();
    }

    function warmForwardNext() {
      if (state.isAnimating || dragging || transitionLock) return;
      const height = vh();
      const targetIndex = normalizeIndex(state.index + 1);
      
      if (nextLoadedIndex !== targetIndex || nextLoadedDir !== 1) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
      }
      
      refs.layerNext.style.transition = 'none';
      refs.layerNext.style.transform = `translate3d(0,${height}px,0)`;
      nextLoadedDir = 1;
      hardStopNextVideo();
    }

    function prepareNextForDirection(dir) {
      const height = vh();
      const targetIndex = normalizeIndex(state.index + dir);
      
      if (nextLoadedIndex !== targetIndex || nextLoadedDir !== dir) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
      }

      refs.layerNext.style.transition = 'none';
      refs.layerNext.style.transform = dir > 0 ? `translate3d(0,${height}px,0)` : `translate3d(0,${-height}px,0)`;
      
      nextLoadedDir = dir;
      preparedDir = dir;
      hardStopNextVideo();
    }

    function applyDragTransforms() {
      const height = vh();
      refs.layerCurrent.style.transform = `translate3d(0,${dy}px,0)`;
      if (preparedDir > 0) refs.layerNext.style.transform = `translate3d(0,${height + dy}px,0)`;
      else if (preparedDir < 0) refs.layerNext.style.transform = `translate3d(0,${-height + dy}px,0)`;
      
      setLayerSideOpacity(refs.layerCurrent, 0.4);
    }

    // --- KLÍČOVÁ ZMĚNA: Agresivní commit ---
    function commit(dir) {
      if (state.isAnimating || transitionLock) return;
      state.isAnimating = true;
      transitionLock = true;

      clearAuto(); stopProg(); cancelRaf(); clearSettleTimer();
      const height = vh();
      const duration = 160; // Optimální rychlost pro lidské oko

      const oldVideo = refs.videoCurrent;

      // Agresivní křivka: Okamžitý start, hladké dojetí (Cubic-Bezier upraven)
      const fastCurve = 'cubic-bezier(0.15, 0.85, 0.35, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${fastCurve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${fastCurve}`;

      refs.layerCurrent.style.transform = `translate3d(0,${dir > 0 ? -height : height}px,0)`;
      refs.layerNext.style.transform = 'translate3d(0,0,0)';

      // Settle timer snížen na minimum (+20ms rezerva místo +120ms)
      settleTimer = setTimeout(() => {
        state.index = normalizeIndex(state.index + dir);

        // SWAP DOM
        const tmpL = refs.layerCurrent; refs.layerCurrent = refs.layerNext; refs.layerNext = tmpL;
        const tmpV = refs.videoCurrent; refs.videoCurrent = refs.videoNext; refs.videoNext = tmpV;
        const tmpI = refs.imgCurrent; refs.imgCurrent = refs.imgNext; refs.imgNext = tmpI;

        if (refs.playOverlay) refs.layerCurrent.appendChild(refs.playOverlay);

        clearVideo(oldVideo);
        resetTransformsNoAnim();

        if (playlist[state.index].type === 'video') {
          refs.videoCurrent.muted = state.isMuted;
          tryPlay(refs.videoCurrent);
        }

        showPlayOverlay(false);
        bindAutoAdvanceForCurrent();
        
        state.isAnimating = false;
        transitionLock = false;
        defer(() => warmForwardNext());
      }, duration + 20); 
    }

    function snapBack() {
      state.isAnimating = true;
      const duration = 200;
      const curve = 'cubic-bezier(0.2, 0.8, 0.4, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${curve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${curve}`;
      refs.layerCurrent.style.transform = 'translate3d(0,0,0)';
      refs.layerNext.style.transform = preparedDir > 0 ? `translate3d(0,${vh()}px,0)` : `translate3d(0,${-vh()}px,0)`;

      setTimeout(() => {
        resetTransformsNoAnim();
        state.isAnimating = false;
        bindAutoAdvanceForCurrent();
      }, duration + 20);
    }

    // --- EVENT LISTENERS (LOCK ZONE) ---
    document.addEventListener('touchstart', (e) => {
      if (state.isAnimating || transitionLock || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;
      dragging = true; preparedDir = 0;
      startY = e.touches[0].clientY; startX = e.touches[0].clientX;
      startT = performance.now(); lastMoveY = startY;
      clearAuto(); stopProg();
      
      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating || transitionLock) return;
      const y = e.touches[0].clientY, x = e.touches[0].clientX;
      const ddy = y - startY, ddx = x - startX;

      if (Math.abs(ddx) > Math.abs(ddy) * 1.5 || Math.abs(ddy) < MOVE_ACTIVATE_PX) return;
      
      e.preventDefault();
      dy = ddy; lastMoveY = y;
      if (!swipeSoundUnlocked) { ensureSoundOn(true); swipeSoundUnlocked = true; }

      const dir = dy < 0 ? 1 : -1;
      if (preparedDir !== dir) prepareNextForDirection(dir);

      if (!raf) {
        raf = requestAnimationFrame(() => { raf = 0; applyDragTransforms(); });
      }
    }, { passive: false });

    document.addEventListener('touchend', () => {
      if (!dragging || state.isAnimating || transitionLock) return;
      const totalDy = dy, dt = performance.now() - startT;
      dragging = false;

      // Detekce Tapu (Pause/Play)
      if (Math.abs(totalDy) < TAP_MAX_MOVE && dt < TAP_MAX_TIME) {
        const v = refs.videoCurrent;
        if (v) {
          if (v.paused) { tryPlay(v); showPlayOverlay(false); }
          else { v.pause(); showPlayOverlay(true); }
        }
        snapBack(); return;
      }

      const vy = (lastMoveY - startY) / dt;
      if (Math.abs(totalDy) > vh() * THRESHOLD_RATIO || (Math.abs(totalDy) > MIN_COMMIT_DY && Math.abs(vy) > MIN_COMMIT_VY)) {
        commit(preparedDir);
      } else {
        snapBack();
      }
    });

    return { autoAdvance: () => commit(1), warmForwardNext, resetTransformsNoAnim };
  }
  window.initTikbooSwipe = initTikbooSwipe;
})();
