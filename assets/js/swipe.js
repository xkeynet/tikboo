// /assets/js/swipe.js - ATOMIC TITAN VERSION (UI PRESERVED)
(function () {
  function initTikbooSwipe(options) {
    const { 
      refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
      bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
      ensureSoundOn, isInteractiveTarget 
    } = options;

    // --- TITAN CONFIGURATION (iPhone Optimized) ---
    const THRESHOLD_RATIO = 0.12; // Agresivnější než 0.15
    const MOVE_ACTIVATE_PX = 3;   // Citlivější na začátek pohybu 
    const MIN_COMMIT_DY = 30;      
    const MIN_COMMIT_VY = 0.35;    
    const TAP_MAX_MOVE = 8;
    const TAP_MAX_TIME = 220;

    // --- BACKWARD SWIPE TUNING (Pro bleskový návrat) ---
    const BACKWARD_THRESHOLD_RATIO = 0.06;
    const BACKWARD_MIN_COMMIT_DY = 18;
    const BACKWARD_MIN_COMMIT_VY = 0.20;

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

    const setTr = (el, y) => { if(el) el.style.transform = `translate3d(0,${y}px,0)`; };

    // --- EFEKT: ZESVĚTLOVÁNÍ (ZACHOVÁNO) ---
    function updateLayerEffects(layer, opacity) {
      if(!layer) return;
      const sideMenu = layer.querySelector('.side');
      const avatar = layer.querySelector('.avatar-box');
      const info = layer.querySelector('.bottom-info'); // Přidáno pro komplexní efekt
      if (sideMenu) sideMenu.style.opacity = opacity;
      if (avatar) avatar.style.opacity = opacity;
      if (info) info.style.opacity = opacity;
    }

    function resetSeekUiImmediate() {
      if (seekPill) seekPill.classList.remove('is-active');
      if (seekTime) seekTime.classList.remove('is-active');
      document.querySelectorAll('.side, .avatar-box, .bottom-info').forEach(el => {
        el.style.opacity = '1';
        if (el.classList.contains('side')) el.classList.remove('scrubbing');
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
        if(!l) return;
        l.style.transition = 'none';
        l.style.willChange = 'auto';
        updateLayerEffects(l, 1);
      });

      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, height);
    }

    // --- TITAN PRE-WARM (The Black Frame Killer) ---
    function warmVideo(v) {
      if (!v) return;
      v.preload = "auto";
      // Klíčový trik: Nastavíme mikro-čas, aby GPU vykreslilo první frame hned
      v.currentTime = 0.001; 
      v.play().then(() => v.pause()).catch(() => {});
    }

    function prepareNextForDirection(dir) {
      const height = vh();
      const targetIndex = normalizeIndex(state.index + dir);
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        if (playlist[targetIndex].type === 'video') warmVideo(refs.videoNext);
      }

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, dir > 0 ? height : -height);
      nextLoadedDir = dir;
      preparedDir = dir;
    }

    // Funkce pro prediktivní nabíjení (vpřed i vzad)
    function warmForwardNext() { prepareNextForDirection(1); }
    function warmBackwardNext() { prepareNextForDirection(-1); }

    function retryBackwardCommitOnce(dir) {
      clearPendingCommit();
      pendingCommitTimer = setTimeout(() => {
        pendingCommitTimer = 0;
        if (state.isAnimating) return;
        if (refs.videoNext && refs.videoNext.readyState >= 1) { commit(dir); return; }
        snapBack();
      }, 50); // Zkráceno pro rychlejší reakci
    }

    // --- BRUTAL COMMIT ENGINE (Titan Optimized) ---
    function commit(dir) {
      const now = performance.now();
      if (now - lastCommitTime < COMMIT_COOLDOWN) return;

      // Pokud video není ready, dáme mu šanci jen při pohybu zpět
      if (refs.videoNext && refs.videoNext.readyState < 2 && dir < 0) {
        retryBackwardCommitOnce(dir); return;
      }

      clearPendingCommit();
      lastCommitTime = now;
      if (state.isAnimating) return;
      state.isAnimating = true;
      
      clearAuto(); stopProg(); resetSeekUiImmediate();
      if (raf) cancelAnimationFrame(raf); raf = 0;

      const height = vh();
      const duration = 170; 
      const videoToCleanup = refs.videoCurrent;

      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';

      // Apple-style curve
      const monsterCurve = 'cubic-bezier(0.19, 1, 0.22, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${monsterCurve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${monsterCurve}`;

      updateLayerEffects(refs.layerCurrent, 0.3);

      setTr(refs.layerCurrent, dir > 0 ? -height : height);
      setTr(refs.layerNext, 0);

      settleTimer = setTimeout(() => {
        if (videoToCleanup) {
          videoToCleanup.pause();
          // SMART CLEAN: Čistíme jen při pohybu vpřed, aby se šetřila RAM.
          // Při pohybu zpět necháme video v cache pro okamžitý návrat.
          if (dir > 0) { videoToCleanup.removeAttribute('src'); videoToCleanup.load(); }
        }

        state.index = normalizeIndex(state.index + dir);

        const tmpL = refs.layerCurrent; refs.layerCurrent = refs.layerNext; refs.layerNext = tmpL;
        const tmpV = refs.videoCurrent; refs.videoCurrent = refs.videoNext; refs.videoNext = tmpV;
        const tmpI = refs.imgCurrent; refs.imgCurrent = refs.imgNext; refs.imgNext = tmpI;

        if (refs.playOverlay) refs.layerCurrent.appendChild(refs.playOverlay);

        resetTransformsNoAnim();

        if (playlist[state.index].type === 'video') {
          refs.videoCurrent.muted = state.isMuted;
          tryPlay(refs.videoCurrent);
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
      clearPendingCommit();
      state.isAnimating = true;
      const duration = 220;
      const snapCurve = 'cubic-bezier(0.2, 1, 0.4, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${snapCurve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${snapCurve}`;
      
      updateLayerEffects(refs.layerCurrent, 1);
      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, preparedDir > 0 ? vh() : -vh());

      settleTimer = setTimeout(() => {
        const snapDir = preparedDir;
        preparedDir = 0;
        resetTransformsNoAnim();
        state.isAnimating = false;
        bindAutoAdvanceForCurrent();
        if (snapDir < 0) warmBackwardNext(); else warmForwardNext();
      }, duration);
    }

    function autoAdvance() {
      if (state.isAnimating || dragging) return;
      warmForwardNext(); preparedDir = 1; commit(1);
    }

    function finishGesture(cancelled) {
      if (!dragging || state.isAnimating) return;
      const totalDy = dy;
      const dt = Math.max(1, performance.now() - startT);
      dragging = false;
      swipeSoundUnlocked = false;

      if (cancelled || preparedDir === 0) {
        if (preparedDir !== 0) snapBack();
        else {
          const isTap = Math.abs(totalDy) < TAP_MAX_MOVE && dt < TAP_MAX_TIME;
          if (isTap && refs.videoCurrent) {
             if (refs.videoCurrent.paused) { 
               if (typeof ensureSoundOn === 'function') ensureSoundOn(true);
               tryPlay(refs.videoCurrent);
               showPlayOverlay(false);
             } else {
               refs.videoCurrent.pause(); stopProg(); showPlayOverlay(true);
             }
          }
          resetTransformsNoAnim();
          bindAutoAdvanceForCurrent();
        }
        return;
      }

      const vy = (lastMoveY - startY) / dt;
      const isBack = preparedDir === -1;
      const tRatio = isBack ? BACKWARD_THRESHOLD_RATIO : THRESHOLD_RATIO;
      const mDy = isBack ? BACKWARD_MIN_COMMIT_DY : MIN_COMMIT_DY;
      const mVy = isBack ? BACKWARD_MIN_COMMIT_VY : MIN_COMMIT_VY;

      if (Math.abs(totalDy) >= vh() * tRatio || (Math.abs(totalDy) >= mDy && Math.abs(vy) >= mVy)) {
        commit(preparedDir);
      } else {
        snapBack();
      }
      dy = 0; dx = 0;
    }

    document.addEventListener('touchstart', (e) => {
      if (state.isAnimating || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;
      dragging = true; preparedDir = 0;
      startY = e.touches[0].clientY; startX = e.touches[0].clientX;
      startT = performance.now();
      clearAuto(); stopProg();
      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';
      if (startY < vh() * 0.45) warmBackwardNext(); else warmForwardNext();
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating) return;
      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;
      dy = y - startY; dx = x - startX;

      if (Math.abs(dx) > Math.abs(dy) * 1.4 || Math.abs(dy) < MOVE_ACTIVATE_PX) return;
      if (e.cancelable) e.preventDefault();
      lastMoveY = y;

      if (!swipeSoundUnlocked && typeof ensureSoundOn === 'function') {
        ensureSoundOn(true); swipeSoundUnlocked = true;
      }

      const dir = dy < 0 ? 1 : -1;
      if (preparedDir !== dir) prepareNextForDirection(dir);

      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const height = vh();
          // --- TVŮJ UI EFEKT (ZACHOVÁNO) ---
          const progress = Math.min(Math.abs(dy) / (height * 0.4), 1);
          const currentOpacity = Math.max(1 - progress, 0.3);
          updateLayerEffects(refs.layerCurrent, currentOpacity);

          setTr(refs.layerCurrent, dy);
          setTr(refs.layerNext, (preparedDir > 0 ? height : -height) + dy);
        });
      }
    }, { passive: false });

    document.addEventListener('touchend', () => finishGesture(false), { passive: true });
    document.addEventListener('touchcancel', () => finishGesture(true), { passive: true });

    return { autoAdvance, warmForwardNext, commit, resetTransformsNoAnim, isDragging() { return dragging; } };
  }
  window.initTikbooSwipe = initTikbooSwipe;
})();
