// /assets/js/swipe.js - MONSTER VERSION (RESTORED EFFECTS)
(function () {
  function initTikbooSwipe(options) {
    const { 
      refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
      bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
      ensureSoundOn, isInteractiveTarget 
    } = options;

    // --- MONSTER CONFIGURATION ---
    const THRESHOLD_RATIO = 0.15; 
    const MOVE_ACTIVATE_PX = 5;    
    const MIN_COMMIT_DY = 40;      
    const MIN_COMMIT_VY = 0.40;    
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

    // Pomocná pro bleskové transformace
    const setTr = (el, y) => { el.style.transform = `translate3d(0,${y}px,0)`; };

    // --- EFEKT: ZESVĚTLOVÁNÍ (OPACITY) ---
    // Najde ikony a avatary v dané vrstvě a nastaví jim průhlednost
    function updateLayerEffects(layer, opacity) {
      const sideMenu = layer.querySelector('.side');
      const avatar = layer.querySelector('.avatar-box'); // Pokud máš jinou třídu, uprav zde
      if (sideMenu) sideMenu.style.opacity = opacity;
      if (avatar) avatar.style.opacity = opacity;
    }

    function resetSeekUiImmediate() {
      if (seekPill) seekPill.classList.remove('is-active');
      if (seekTime) seekTime.classList.remove('is-active');
      document.querySelectorAll('.side').forEach(s => {
        s.classList.remove('scrubbing');
        s.style.opacity = '1';
        s.style.display = '';
      });
      // Reset i pro avatary v celém dokumentu pro jistotu
      document.querySelectorAll('.avatar-box').forEach(a => a.style.opacity = '1');
    }

    function resetTransformsNoAnim() {
      const height = vh();
      if (raf) cancelAnimationFrame(raf); raf = 0;
      clearTimeout(settleTimer);

      [refs.layerCurrent, refs.layerNext].forEach(l => {
        l.style.transition = 'none';
        l.style.willChange = 'auto';
        updateLayerEffects(l, 1); // Vrátíme viditelnost ikonám
      });

      setTr(refs.layerCurrent, 0);
      setTr(refs.layerNext, height);
    }

    // --- PREDIKTIVNÍ NABÍJENÍ ---
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
      
      if (nextLoadedIndex !== targetIndex) {
        setLayerContent(refs.layerNext, playlist[targetIndex], true);
        nextLoadedIndex = targetIndex;
        const vNext = refs.videoNext;
        if (playlist[targetIndex].type === 'video' && vNext) {
          vNext.play().then(() => vNext.pause()).catch(() => {});
        }
      }

      refs.layerNext.style.transition = 'none';
      setTr(refs.layerNext, dir > 0 ? height : -height);
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

      refs.layerCurrent.style.willChange = 'transform';
      refs.layerNext.style.willChange = 'transform';

      const monsterCurve = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
      refs.layerCurrent.style.transition = `transform ${duration}ms ${monsterCurve}`;
      refs.layerNext.style.transition = `transform ${duration}ms ${monsterCurve}`;

      // Při dokončení zůstanou ikony na 30% (místo 0)
      updateLayerEffects(refs.layerCurrent, 0.3);

      setTr(refs.layerCurrent, dir > 0 ? -height : height);
      setTr(refs.layerNext, 0);

      settleTimer = setTimeout(() => {
        if (videoToCleanup) {
          videoToCleanup.pause();
          videoToCleanup.removeAttribute('src');
          videoToCleanup.load();
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
      state.isAnimating = true;
      const duration = 200;
      
      refs.layerCurrent.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;
      refs.layerNext.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.2, 1)`;

      // Vrátíme opacity ikonám zpět na 1
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
          
          // --- VÝPOČET OPACITY EFEKTU ---
          // Progress 0 až 1, ale zastavíme se na 0.3 (efekt ducha)
          const progress = Math.min(Math.abs(dy) / (height * 0.4), 1);
          const currentOpacity = Math.max(1 - progress, 0.3);
          
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


