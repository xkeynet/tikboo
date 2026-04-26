// /assets/js/swipe.js - MONSTER VERSION (TRIPLE-BUFFER READY)
(function () {
  function initTikbooSwipe(options) {
    const { 
      refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
      bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
      ensureSoundOn, isInteractiveTarget 
    } = options;

    // --- MONSTER CONFIGURATION ---
    const THRESHOLD_RATIO = 0.15; // Extrémně citlivé na dokončení
    const MOVE_ACTIVATE_PX = 5;    // Okamžitá reakce na dotyk
    const MIN_COMMIT_DY = 40;      // Kratší dráha pro potvrzení swipu
    const MIN_COMMIT_VY = 0.40;    // Švih (velocity) má vysokou prioritu
    const TAP_MAX_MOVE = 8;
    const TAP_MAX_TIME = 220;

    let dragging = false;
    let startY = 0, startX = 0, dy = 0, dx = 0;
    let preparedDir = 0, raf = 0, settleTimer = 0;
    let startT = 0, lastMoveY = 0;
    let nextLoadedIndex = null, nextLoadedDir = 0;
    let swipeSoundUnlocked = false;

    const seekPill = document.getElementById('seekPill');
    const seekTime = document.getElementById('seekTime');

    // Pomocná pro bleskové transformace - PŘIDÁNO layerPrev
    const setTr = (el, y) => { if(el) el.style.transform = `translate3d(0,${y}px,0)`; };

    function resetSeekUiImmediate() {
      if (seekPill) seekPill.classList.remove('is-active');
      if (seekTime) seekTime.classList.remove('is-active');
      document.querySelectorAll('.side').forEach(s => {
        s.classList.remove('scrubbing');
        s.style.opacity = '';
        s.style.display = '';
      });
    }

    function resetTransformsNoAnim() {
      const height = vh();
      if (raf) cancelAnimationFrame(raf); raf = 0;
      clearTimeout(settleTimer);

      // Resetujeme všechny 3 vrstvy
      const layerPrev = document.getElementById('layerPrev');
      [refs.layerCurrent, refs.layerNext, layerPrev].forEach(l => {
        if (l) {
          l.style.transition = 'none';
          l.style.willChange = 'auto';
        }
      });

      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, height);
      setTr(layerPrev, -height);
      if (refs.layerCurrent.querySelector('.side')) refs.layerCurrent.querySelector('.side').style.opacity = '1';
    }

    // --- PREDIKTIVNÍ NABÍJENÍ (Eliminace černých snímků) ---
    function warmForwardNext() {
      if (state.isAnimating || dragging) return;
      const height = vh();
      const targetIndex = normalizeIndex(state.index + 1);
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        
        const vNext = refs.videoNext;
        if (playlist[targetIndex].type === 'video' && vNext) {
          vNext.play().then(() => vNext.pause()).catch(() => {});
        }
      }

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, height);
      nextLoadedDir = 1;
    }

    function prepareNextForDirection(dir) {
      const height = vh();
      const targetIndex = normalizeIndex(state.index + dir);
      
      // Triple-Buffer: Určíme, který šuplík nabít (předchozí nebo následující)
      const targetLayer = dir > 0 ? refs.layerNext : document.getElementById('layerPrev');
      const targetVideo = dir > 0 ? refs.videoNext : document.getElementById('videoPrev');
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(targetLayer, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        
        if (playlist[targetIndex].type === 'video' && targetVideo) {
          targetVideo.play().then(() => targetVideo.pause()).catch(() => {});
        }
      }

      targetLayer.style.transition = 'none';
      setTr(targetLayer, dir > 0 ? height : -height);
      nextLoadedDir = dir;
      preparedDir = dir;
    }

    // --- BRUTAL COMMIT ENGINE ---
    function commit(dir) {
      if (state.isAnimating) return;
      state.isAnimating = true;
      
      clearAuto(); stopProg(); resetSeekUiImmediate();
      if (raf) cancelAnimationFrame(raf); raf = 0;
      clearTimeout(settleTimer);

      const height = vh();
      const duration = 160; 
      const videoToCleanup = refs.videoCurrent;
      const layerPrev = document.getElementById('layerPrev');

      // Vybereme aktivní šuplík pro animaci
      const layerToShow = dir > 0 ? refs.layerNext : layerPrev;

      refs.layerCurrent.style.willChange = 'transform';
      if(layerToShow) layerToShow.style.willChange = 'transform';

      const monsterCurve = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${monsterCurve}`;
      if(layerToShow) layerToShow.style.transition = `transform ${duration}ms ${monsterCurve}`;

      setTr(refs.layerCurrent, dir > 0 ? -height : height);
      if(layerToShow) setTr(layerToShow, 0);

      settleTimer = setTimeout(() => {
        if (videoToCleanup) {
          videoToCleanup.pause();
          videoToCleanup.removeAttribute('src');
          videoToCleanup.load();
        }

        state.index = normalizeIndex(state.index + dir);

        // Core Swap Logic pro 3 vrstvy
        if (dir > 0) {
          // Swipe dolů (další video)
          const tmpL = refs.layerCurrent; refs.layerCurrent = refs.layerNext; refs.layerNext = tmpL;
          const tmpV = refs.videoCurrent; refs.videoCurrent = refs.videoNext; refs.videoNext = tmpV;
          const tmpI = refs.imgCurrent; refs.imgCurrent = refs.imgNext; refs.imgNext = tmpI;
        } else {
          // Swipe nahoru (předchozí video)
          const vPrev = document.getElementById('videoPrev');
          const iPrev = document.getElementById('imgPrev');
          const tmpL = refs.layerCurrent; refs.layerCurrent = layerPrev; // Teď je layerCurrent ten horní
          // Poznámka: Pro plnou rotaci by zde mělo být prohození s refs, které obslouží app.js
        }

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
      state.isAnimating = true;
      const duration = 200;
      const layerPrev = document.getElementById('layerPrev');
      const layerToReset = preparedDir > 0 ? refs.layerNext : layerPrev;
      
      refs.layerCurrent.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;
      if(layerToReset) layerToReset.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;

      setTr(refs.layerCurrent, 0);
      if(layerToReset) setTr(layerToReset, preparedDir > 0 ? vh() : -vh());

      settleTimer = setTimeout(() => {
        preparedDir = 0;
        resetTransformsNoAnim();
        state.isAnimating = false;
        bindAutoAdvanceForCurrent();
        warmForwardNext();
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
               ensureSoundOn ? ensureSoundOn(true) : tryPlay(refs.videoCurrent);
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
      if (Math.abs(totalDy) >= vh() * THRESHOLD_RATIO || (Math.abs(totalDy) >= MIN_COMMIT_DY && Math.abs(vy) >= MIN_COMMIT_VY)) {
        commit(preparedDir);
      } else {
        snapBack();
      }
      dy = 0; dx = 0;
    }

    // --- OPTIMALIZOVANÉ LISTENERY ---
    document.addEventListener('touchstart', (e) => {
      // FIX PRO AGE GATE: Pokud klikáš na overlay nebo tlačítko, nepouštěj swipe
      if (e.target.closest('#gateOverlay') || e.target.closest('button')) return;
      
      if (state.isAnimating || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;

      dragging = true;
      preparedDir = 0;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      startT = performance.now();
      
      clearAuto(); stopProg();
      
      const layerPrev = document.getElementById('layerPrev');
      [refs.layerCurrent, refs.layerNext, layerPrev].forEach(l => {
        if(l) l.style.transition = 'none';
      });
      
      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';
      if(layerPrev) layerPrev.style.willChange = 'transform';
      
      warmForwardNext();
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating) return;
      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;
      const ddy = y - startY;
      const ddx = x - startX;

      if (Math.abs(ddx) > Math.abs(ddy) * 1.4 || Math.abs(ddy) < MOVE_ACTIVATE_PX) return;

      e.preventDefault();
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
          const layerPrev = document.getElementById('layerPrev');
          setTr(refs.layerCurrent, dy);
          
          if (preparedDir > 0) {
            setTr(refs.layerNext, height + dy);
          } else if (preparedDir < 0 && layerPrev) {
            setTr(layerPrev, -height + dy);
          }
        });
      }
    }, { passive: false });

    document.addEventListener('touchend', () => finishGesture(false), { passive: true });
    document.addEventListener('touchcancel', () => finishGesture(true), { passive: true });

    return { autoAdvance, warmForwardNext, commit, resetTransformsNoAnim, isDragging() { return dragging; } };
  }

  window.initTikbooSwipe = initTikbooSwipe;
})();
