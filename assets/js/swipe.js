// /assets/js/swipe.js - ATOMIC BOLD VERSION 2026 - FINAL BLACKFRAME KILLER
(function () {
  function initTikbooSwipe(options) {
    const { 
      refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
      bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
      ensureSoundOn, isInteractiveTarget 
    } = options;

    // --- ATOMIC CONFIGURATION: THE PRECISION ENGINE ---
    const THRESHOLD_RATIO = 0.15; 
    const MOVE_ACTIVATE_PX = 2;    
    const MIN_COMMIT_DY = 40;      
    const MIN_COMMIT_VY = 0.30;    
    const TAP_MAX_MOVE = 8;
    const TAP_MAX_TIME = 220;

    // --- BACKWARD SWIPE TUNING: THE BLACKFRAME KILLER ---
    const BACKWARD_THRESHOLD_RATIO = 0.06; 
    const BACKWARD_MIN_COMMIT_DY = 15;     
    const BACKWARD_MIN_COMMIT_VY = 0.15;   

    let dragging = false;
    let startY = 0, startX = 0, dy = 0, dx = 0;
    let preparedDir = 0, raf = 0, settleTimer = 0;
    let startT = 0, lastMoveY = 0;
    let nextLoadedIndex = null, nextLoadedDir = 0;
    let swipeSoundUnlocked = false;
    let lastCommitTime = 0;
    let pendingCommitTimer = 0;
    const COMMIT_COOLDOWN = 100; 

    const seekPill = document.getElementById('seekPill');
    const seekTime = document.getElementById('seekTime');

    // Akcelerovaný transform s nulovou latencí
    const setTr = (el, y) => { 
      if (el) el.style.transform = `translate3d(0,${y}px,0)`; 
    };

    function updateLayerEffects(layer, opacity) {
      if (!layer) return;
      const elements = layer.querySelectorAll('.side, .avatar-box, .bottom-info');
      elements.forEach(el => { el.style.opacity = opacity; });
    }

    function resetSeekUiImmediate() {
      if (seekPill) seekPill.classList.remove('is-active');
      if (seekTime) seekTime.classList.remove('is-active');
      document.querySelectorAll('.side, .avatar-box, .bottom-info').forEach(el => {
        el.style.opacity = '1';
        el.classList.remove('scrubbing');
      });
    }

    function clearPendingCommit() {
      if (pendingCommitTimer) { clearTimeout(pendingCommitTimer); pendingCommitTimer = 0; }
    }

    function resetTransformsNoAnim() {
      const height = vh();
      if (raf) cancelAnimationFrame(raf); raf = 0;
      clearTimeout(settleTimer);
      clearPendingCommit();

      [refs.layerCurrent, refs.layerNext].forEach(l => {
        if (l) {
          l.style.transition = 'none';
          l.style.willChange = 'auto';
          updateLayerEffects(l, 1); 
        }
      });

      if (refs.layerCurrent) setTr(refs.layerCurrent, 0);
      if (refs.layerNext) setTr(refs.layerNext, height);
    }

    // --- KLÍČOVÁ FUNKCE: VYNUCENÉ VYKRESLENÍ (PRE-RENDER) ---
    async function forceVideoReady(video) {
      if (!video) return;
      return new Promise((resolve) => {
        video.preload = "auto";
        video.currentTime = 0.001; // Posun o kousek z nuly vynutí dekodér vykreslit frame
        
        const onReady = () => {
          video.removeEventListener('canplaythrough', onReady);
          resolve();
        };

        if (video.readyState >= 3) {
          resolve();
        } else {
          video.addEventListener('canplaythrough', onReady);
          video.load(); // Vynucené načtení
        }
      });
    }

    function warmForwardNext() {
      if (state.isAnimating || dragging) return;
      const targetIndex = normalizeIndex(state.index + 1);
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        if (refs.videoNext) forceVideoReady(refs.videoNext);
      }
      setTr(refs.layerNext, vh());
      nextLoadedDir = 1;
    }

    function warmBackwardNext() {
      if (state.isAnimating || dragging) return;
      const targetIndex = normalizeIndex(state.index - 1);
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        // Tady je to kritické: Zpětné video musí být ready OKAMŽITĚ
        if (refs.videoNext) forceVideoReady(refs.videoNext);
      }
      setTr(refs.layerNext, -vh());
      nextLoadedDir = -1;
    }

    function prepareNextForDirection(dir) {
      const targetIndex = normalizeIndex(state.index + dir);
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        if (refs.videoNext) forceVideoReady(refs.videoNext);
      }
      setTr(refs.layerNext, dir > 0 ? vh() : -vh());
      nextLoadedDir = dir;
      preparedDir = dir;
    }

    // --- COMMIT ENGINE: THE FINAL SMOOTHNESS ---
    function commit(dir) {
      const now = performance.now();
      if (now - lastCommitTime < COMMIT_COOLDOWN) return;
      
      // Zpřísněná kontrola readyState pro BACKWARD swipe
      if (refs.videoNext && refs.videoNext.readyState < 2) {
        if (dir < 0) {
          clearPendingCommit();
          pendingCommitTimer = setTimeout(() => commit(dir), 30);
          return;
        }
        snapBack();
        return;
      }

      clearPendingCommit();
      lastCommitTime = now;
      if (state.isAnimating) return;
      state.isAnimating = true;
      
      clearAuto(); stopProg(); resetSeekUiImmediate();
      if (raf) cancelAnimationFrame(raf); raf = 0;

      const height = vh();
      const duration = 200; 
      const videoToCleanup = refs.videoCurrent;

      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';

      // Apple-smooth curve
      const monsterCurve = 'cubic-bezier(0.23, 1, 0.32, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${monsterCurve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${monsterCurve}`;

      updateLayerEffects(refs.layerCurrent, 0.2);

      setTr(refs.layerCurrent, dir > 0 ? -height : height);
      setTr(refs.layerNext, 0);

      settleTimer = setTimeout(() => {
        if (videoToCleanup) {
          videoToCleanup.pause();
          if (dir < 0) { videoToCleanup.removeAttribute('src'); videoToCleanup.load(); }
        }

        state.index = normalizeIndex(state.index + dir);

        const tmpL = refs.layerCurrent; refs.layerCurrent = refs.layerNext; refs.layerNext = tmpL;
        const tmpV = refs.videoCurrent; refs.videoCurrent = refs.videoNext; refs.videoNext = tmpV;
        
        if (refs.playOverlay && refs.layerCurrent) refs.layerCurrent.appendChild(refs.playOverlay);

        resetTransformsNoAnim();

        if (playlist[state.index].type === 'video') {
          refs.videoCurrent.muted = state.isMuted;
          try {
            const p = refs.videoCurrent.play();
            if (p !== undefined) p.catch(() => showPlayOverlay(true));
          } catch(e) {}
        }

        resetSeekUiImmediate();
        syncSoundUI();
        showPlayOverlay(false);
        bindAutoAdvanceForCurrent();

        state.isAnimating = false;
        requestAnimationFrame(() => warmForwardNext());
      }, duration + 10); 
    }

    function snapBack() {
      if (state.isAnimating) return;
      state.isAnimating = true;
      const duration = 250;
      refs.layerCurrent.style.transition = `transform ${duration}ms cubic-bezier(0.25, 1, 0.5, 1)`;
      refs.layerNext.style.transition = `transform ${duration}ms cubic-bezier(0.25, 1, 0.5, 1)`;
      updateLayerEffects(refs.layerCurrent, 1);
      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, preparedDir > 0 ? vh() : -vh());

      settleTimer = setTimeout(() => {
        preparedDir = 0;
        resetTransformsNoAnim();
        state.isAnimating = false;
        bindAutoAdvanceForCurrent();
        warmForwardNext();
      }, duration);
    }

    function finishGesture(cancelled) {
      if (!dragging || state.isAnimating) return;
      const totalDy = dy;
      const endT = performance.now();
      const dt = Math.max(1, endT - startT);
      dragging = false;

      if (cancelled || preparedDir === 0) {
        if (preparedDir !== 0) snapBack();
        else {
          const isTap = Math.abs(totalDy) < TAP_MAX_MOVE && dt < TAP_MAX_TIME;
          if (isTap && refs.videoCurrent) {
            if (refs.videoCurrent.paused) { tryPlay(refs.videoCurrent); showPlayOverlay(false); }
            else { refs.videoCurrent.pause(); stopProg(); showPlayOverlay(true); }
          }
          resetTransformsNoAnim();
          bindAutoAdvanceForCurrent();
        }
        return;
      }

      const vy = (lastMoveY - startY) / dt;
      const isBackward = preparedDir === -1;
      const tRatio = isBackward ? BACKWARD_THRESHOLD_RATIO : THRESHOLD_RATIO;
      const mDy = isBackward ? BACKWARD_MIN_COMMIT_DY : MIN_COMMIT_DY;
      const mVy = isBackward ? BACKWARD_MIN_COMMIT_VY : MIN_COMMIT_VY;

      if (Math.abs(totalDy) >= vh() * tRatio || (Math.abs(totalDy) >= mDy && Math.abs(vy) >= mVy)) {
        commit(preparedDir);
      } else {
        snapBack();
      }
      dy = 0;
    }

    document.addEventListener('touchstart', (e) => {
      if (state.isAnimating || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;
      dragging = true;
      preparedDir = 0;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      startT = performance.now();
      clearAuto(); stopProg();
      resetTransformsNoAnim();
      
      // Detekce směru hned na startu pro bleskový pre-render
      if (startY < vh() * 0.40) warmBackwardNext(); else warmForwardNext();
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating) return;
      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;
      dy = y - startY;
      dx = x - startX;

      if (Math.abs(dx) > Math.abs(dy) * 1.5 || Math.abs(dy) < MOVE_ACTIVATE_PX) return;
      if (e.cancelable) e.preventDefault();
      lastMoveY = y;

      const dir = dy < 0 ? 1 : -1;
      if (preparedDir !== dir) prepareNextForDirection(dir);

      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const h = vh();
          const progress = Math.min(Math.abs(dy) / (h * 0.5), 1);
          updateLayerEffects(refs.layerCurrent, Math.max(1 - progress, 0.25));
          setTr(refs.layerCurrent, dy);
          setTr(refs.layerNext, (preparedDir > 0 ? h : -h) + dy);
        });
      }
    }, { passive: false });

    document.addEventListener('touchend', () => finishGesture(false), { passive: true });
    document.addEventListener('touchcancel', () => finishGesture(true), { passive: true });

    return { autoAdvance: () => commit(1), warmForwardNext, commit, resetTransformsNoAnim };
  }
  window.initTikbooSwipe = initTikbooSwipe;
})();
