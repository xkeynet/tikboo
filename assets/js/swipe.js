// /assets/js/swipe.js - TRUE TRIPLE-BUFFER ENGINE
(function () {
  function initTikbooSwipe(options) {
    const { 
      refs, state, playlist, vh, normalizeIndex, tryPlay, clearAuto, stopProg, 
      bindAutoAdvanceForCurrent, syncSoundUI, showPlayOverlay, setLayerContent, 
      ensureSoundOn, isInteractiveTarget 
    } = options;

    // --- CONFIGURATION ---
    const THRESHOLD_RATIO = 0.15;
    const DURATION = 250; // Optimální rychlost pro lidské oko a procesor
    const monsterCurve = 'cubic-bezier(0.2, 0.9, 0.3, 1)';

    let dragging = false;
    let startY = 0, dy = 0, startT = 0;
    let raf = 0, settleTimer = 0;

    // Správa vrstev v poli (Triple-Buffer Kolečko)
    // Index 0: Prev, Index 1: Current, Index 2: Next
    let stack = [
      { container: document.getElementById('layerPrev'), video: document.getElementById('videoPrev'), img: document.getElementById('imgPrev') },
      { container: document.getElementById('layerCurrent'), video: document.getElementById('videoCurrent'), img: document.getElementById('imgCurrent') },
      { container: document.getElementById('layerNext'), video: document.getElementById('videoNext'), img: document.getElementById('imgNext') }
    ];

    const setTr = (el, y) => { el.style.transform = `translate3d(0,${y}px,0)`; };

    function resetPositions() {
      const h = vh();
      stack.forEach(s => s.container.style.transition = 'none');
      setTr(stack[0].container, -h); // Prev
      setTr(stack[1].container, 0);  // Current
      setTr(stack[2].container, h);  // Next
      
      // Synchronizace refs pro zbytek aplikace (aby fungovaly lajky atd.)
      refs.layerCurrent = stack[1].container;
      refs.videoCurrent = stack[1].video;
      refs.imgCurrent = stack[1].img;
      refs.layerNext = stack[2].container; // Pro kompatibilitu
    }

    // --- PREDIKTIVNÍ NABÍJENÍ OBOU STRAN ---
    function preloadNeighbors() {
      const prevIdx = normalizeIndex(state.index - 1);
      const nextIdx = normalizeIndex(state.index + 1);
      
      // Nabijeme horní šuplík
      setLayerContent(stack[0].container, playlist[prevIdx], true);
      // Nabijeme dolní šuplík
      setLayerContent(stack[2].container, playlist[nextIdx], true);
    }

    function commit(dir) {
      if (state.isAnimating) return;
      state.isAnimating = true;
      
      clearAuto(); stopProg();
      const h = vh();

      stack.forEach(s => {
        s.container.style.transition = `transform ${DURATION}ms ${monsterCurve}`;
      });

      if (dir > 0) { // Swipe UP (další video)
        setTr(stack[1].container, -h);
        setTr(stack[2].container, 0);
      } else { // Swipe DOWN (předchozí video)
        setTr(stack[1].container, h);
        setTr(stack[0].container, 0);
      }

      settleTimer = setTimeout(() => {
        // Zastavíme staré video
        stack[1].video.pause();
        stack[1].video.removeAttribute('src');
        stack[1].video.load();

        // ROTACE POLE (To je ta magie)
        if (dir > 0) {
          const first = stack.shift();
          stack.push(first); // [Prev, Curr, Next] -> [Curr, Next, Prev]
        } else {
          const last = stack.pop();
          stack.unshift(last); // [Prev, Curr, Next] -> [Next, Prev, Curr]
        }

        state.index = normalizeIndex(state.index + dir);
        
        // Fixujeme UI prvky (playOverlay se musí stěhovat do nového Current)
        if (refs.playOverlay) stack[1].container.appendChild(refs.playOverlay);

        resetPositions();

        // Start nového videa
        if (playlist[state.index].type === 'video') {
          stack[1].video.muted = state.isMuted;
          tryPlay(stack[1].video);
        }

        syncSoundUI();
        showPlayOverlay(false);
        bindAutoAdvanceForCurrent();
        
        state.isAnimating = false;
        preloadNeighbors(); // Nabijeme okolí pro další swipe
      }, DURATION);
    }

    function snapBack() {
      const h = vh();
      stack.forEach(s => s.container.style.transition = `transform ${DURATION}ms ease-out`);
      setTr(stack[0].container, -h);
      setTr(stack[1].container, 0);
      setTr(stack[2].container, h);
      setTimeout(() => { state.isAnimating = false; }, DURATION);
    }

    // --- LISTENERS ---
    document.addEventListener('touchstart', (e) => {
      if (state.isAnimating || isInteractiveTarget(e.target)) return;
      dragging = true;
      startY = e.touches[0].clientY;
      startT = performance.now();
      stack.forEach(s => s.container.style.transition = 'none');
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging || state.isAnimating) return;
      dy = e.touches[0].clientY - startY;
      
      const h = vh();
      setTr(stack[1].container, dy);
      setTr(stack[0].container, -h + dy); // Táhneme horní
      setTr(stack[2].container, h + dy);  // Táhneme spodní
      
      if (typeof ensureSoundOn === 'function') ensureSoundOn(true);
    }, { passive: false });

    document.addEventListener('touchend', () => {
      if (!dragging || state.isAnimating) return;
      dragging = false;
      const dt = performance.now() - startT;
      
      if (Math.abs(dy) > vh() * THRESHOLD_RATIO || (Math.abs(dy) > 50 && dt < 250)) {
        commit(dy < 0 ? 1 : -1);
      } else {
        snapBack();
      }
      dy = 0;
    });

    // Inicializace
    resetPositions();
    preloadNeighbors();

    return { 
      autoAdvance: () => commit(1), 
      isDragging: () => dragging 
    };
  }

  window.initTikbooSwipe = initTikbooSwipe;
})();
