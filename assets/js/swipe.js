// /assets/js/swipe.js - ATOMIC BOLD VERSION 2026
(function () {
  function initTikbooSwipe(options) {
    const { 
      refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
      bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
      ensureSoundOn, isInteractiveTarget 
    } = options;

    // --- ATOMIC CONFIGURATION: THE PRECISION ENGINE ---
    const THRESHOLD_RATIO = 0.15; 
    const MOVE_ACTIVATE_PX = 3;    // Zvýšená citlivost pro iPhone 16 Plus
    const MIN_COMMIT_DY = 35;      
    const MIN_COMMIT_VY = 0.35;    
    const TAP_MAX_MOVE = 8;
    const TAP_MAX_TIME = 220;

    // --- BACKWARD SWIPE TUNING: ELIMINATING BLACK FRAMES ---
    // Zpětný chod musí být mnohem citlivější, aby se předešlo "zaseknutí" v meziprostoru
    const BACKWARD_THRESHOLD_RATIO = 0.06;
    const BACKWARD_MIN_COMMIT_DY = 20;
    const BACKWARD_MIN_COMMIT_VY = 0.20;

    let dragging = false;
    let startY = 0, startX = 0, dy = 0, dx = 0;
    let preparedDir = 0, raf = 0, settleTimer = 0;
    let startT = 0, lastMoveY = 0;
    let nextLoadedIndex = null, nextLoadedDir = 0;
    let swipeSoundUnlocked = false;
    let lastCommitTime = 0;
    let pendingCommitTimer = 0;
    const COMMIT_COOLDOWN = 140; // Ochrana proti double-swipu

    const seekPill = document.getElementById('seekPill');
    const seekTime = document.getElementById('seekTime');

    // Pomocná pro bleskové transformace s hardware akcelerací
    const setTr = (el, y) => { 
      if (el) el.style.transform = `translate3d(0,${y}px,0)`; 
    };

    // --- EFEKT: ZESVĚTLOVÁNÍ (OPACITY) ---
    function updateLayerEffects(layer, opacity) {
      if (!layer) return;
      const sideMenu = layer.querySelector('.side');
      const avatar = layer.querySelector('.avatar-box');
      const bottomInfo = layer.querySelector('.bottom-info');
      if (sideMenu) sideMenu.style.opacity = opacity;
      if (avatar) avatar.style.opacity = opacity;
      if (bottomInfo) bottomInfo.style.opacity = opacity;
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
      if (pendingCommitTimer) {
        clearTimeout(pendingCommitTimer);
        pendingCommitTimer = 0;
      }
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

    // --- PREDIKTIVNÍ NABÍJENÍ (WARM-UP) ---
    // Klíčem k eliminaci black framu jecurrentTime = 0.001 a tiché play/pause
    function warmForwardNext() {
      if (state.isAnimating || dragging) return;
      const height = vh();
      const targetIndex = normalizeIndex(state.index + 1);
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        
        const vNext = refs.videoNext;
        if (playlist[targetIndex].type === 'video' && vNext) {
          vNext.currentTime = 0.001; // Triky z TikToku: vynutí dekodér vykreslit první frame
          vNext.play().then(() => vNext.pause()).catch(() => {});
        }
      }

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, height);
      nextLoadedDir = 1;
    }

    function warmBackwardNext() {
      if (state.isAnimating || dragging) return;
      const height = vh();
      const targetIndex = normalizeIndex(state.index - 1);
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        
        const vNext = refs.videoNext;
        if (playlist[targetIndex].type === 'video' && vNext) {
          vNext.currentTime = 0.001; 
          vNext.play().then(() => vNext.pause()).catch(() => {});
        }
      }

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, -height);
      nextLoadedDir = -1;
    }

    function prepareNextForDirection(dir) {
      const height = vh();
      const targetIndex = normalizeIndex(state.index + dir);
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        const vNext = refs.videoNext;
        if (playlist[targetIndex].type === 'video' && vNext) {
          vNext.currentTime = 0.001;
          vNext.play().then(() => vNext.pause()).catch(() => {});
        }
      }

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, dir > 0 ? height : -height);
      nextLoadedDir = dir;
      preparedDir = dir;
    }

    function retryBackwardCommitOnce(dir) {
      clearPendingCommit();
      pendingCommitTimer = setTimeout(() => {
        pendingCommitTimer = 0;
        if (state.isAnimating) return;
        // Pokud je video ready alespoň na úrovni metadata/frame, jdeme do toho
        if (refs.videoNext && refs.videoNext.readyState >= 1) {
          commit(dir);
          return;
        }
        snapBack();
      }, 75); // Super krátký delay pro bleskovou reakci
    }

    // --- BRUTAL COMMIT ENGINE ---
    function commit(dir) {
      const now = performance.now();
      if (now - lastCommitTime < COMMIT_COOLDOWN) return;

      if (refs.videoNext && refs.videoNext.readyState < 1) {
        if (dir < 0) {
          retryBackwardCommitOnce(dir);
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
      clearTimeout(settleTimer);

      const height = vh();
      const duration = 180; // Luxusní plynulost
      const videoToCleanup = refs.videoCurrent;

      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';

      // "The Apple Curve" - Bezprecedentní plynulost tahu
      const monsterCurve = 'cubic-bezier(0.19, 1, 0.22, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${monsterCurve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${monsterCurve}`;

      updateLayerEffects(refs.layerCurrent, 0.3);

      setTr(refs.layerCurrent, dir > 0 ? -height : height);
      setTr(refs.layerNext, 0);

      settleTimer = setTimeout(() => {
        if (videoToCleanup) {
          videoToCleanup.pause();
          // PONECHÁME ZVUK: Na rozdíl od minule neodstraňujeme src drasticky,
          // jen pokud jdeme dopředu, abychom uvolnili paměť.
          if (dir > 0) {
             videoToCleanup.removeAttribute('src');
             videoToCleanup.load();
          }
        }

        state.index = normalizeIndex(state.index + dir);

        // ATOMIC SWAP
        const tmpL = refs.layerCurrent; refs.layerCurrent = refs.layerNext; refs.layerNext = tmpL;
        const tmpV = refs.videoCurrent; refs.videoCurrent = refs.videoNext; refs.videoNext = tmpV;
        const tmpI = refs.imgCurrent; refs.imgCurrent = refs.imgNext; refs.imgNext = tmpI;

        if (refs.playOverlay && refs.layerCurrent) {
           refs.layerCurrent.appendChild(refs.playOverlay);
        }

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
        // Blesková příprava dalšího v řadě
        requestAnimationFrame(() => warmForwardNext());
      }, duration + 10); 
    }

    function snapBack() {
      if (state.isAnimating) return;
      clearPendingCommit();

      state.isAnimating = true;
      const duration = 240;
      const snapDir = preparedDir;
      
      const snapCurve = 'cubic-bezier(0.25, 1, 0.5, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${snapCurve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${snapCurve}`;

      updateLayerEffects(refs.layerCurrent, 1);

      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, preparedDir > 0 ? vh() : -vh());

      settleTimer = setTimeout(() => {
        preparedDir = 0;
        resetTransformsNoAnim();
        state.isAnimating = false;
        bindAutoAdvanceForCurrent();
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
      const isBackward = preparedDir === -1;
      const thresholdRatio = isBackward ? BACKWARD_THRESHOLD_RATIO : THRESHOLD_RATIO;
      const minDy = isBackward ? BACKWARD_MIN_COMMIT_DY : MIN_COMMIT_DY;
      const minVy = isBackward ? BACKWARD_MIN_COMMIT_VY : MIN_COMMIT_VY;

      if (Math.abs(totalDy) >= vh() * thresholdRatio || (Math.abs(totalDy) >= minDy && Math.abs(vy) >= minVy)) {
        commit(preparedDir);
      } else {
        snapBack();
      }
      dy = 0; dx = 0;
    }

    document.addEventListener('touchstart', (e) => {
      if (state.isAnimating || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;

      dragging = true;
      preparedDir = 0;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      startT = performance.now();
      
      clearAuto(); stopProg();
      
      refs.layerCurrent.style.transition = 'none';
      refs.layerNext.style.transition = 'none';
      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';
      
      // Ultra-citlivá detekce směru
      if (startY < vh() * 0.42) {
        warmBackwardNext();
      } else {
        warmForwardNext();
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating) return;
      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;
      const ddy = y - startY;
      const ddx = x - startX;

      if (Math.abs(ddx) > Math.abs(ddy) * 1.5 || Math.abs(ddy) < MOVE_ACTIVATE_PX) return;

      if (e.cancelable) e.preventDefault();
      dy = ddy;
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
          
          // --- LUXUSNÍ UI EFEKT ---
          const progress = Math.min(Math.abs(dy) / (height * 0.5), 1);
          const currentOpacity = Math.max(1 - (progress * 1.3), 0.3);
          
          updateLayerEffects(refs.layerCurrent, currentOpacity);

          setTr(refs.layerCurrent, dy);
          if (preparedDir > 0) setTr(refs.layerNext, height + dy);
          else if (preparedDir < 0) setTr(refs.layerNext, -height + dy);
        });
      }
    }, { passive: false });

    document.addEventListener('touchend', () => finishGesture(false), { passive: true });
    document.addEventListener('touchcancel', () => finishGesture(true), { passive: true });

    return { autoAdvance, warmForwardNext, commit, resetTransformsNoAnim, isDragging() { return dragging; } };
  }

  window.initTikbooSwipe = initTikbooSwipe;
})();
