// /assets/js/swipe.js — TIKBOO POOL ENGINE v3
// ─────────────────────────────────────────────────────────────────────────────
// Architektura: 3-vrstvý video pool (A / B / C) + poster bridge + rate limiter
// Safari fix: video objekty se NIKDY neničí → dekodér žije trvale v paměti
// ─────────────────────────────────────────────────────────────────────────────
(function () {

// ═══════════════════════════════════════════════════════════════════════════
// SEKCE 1: DOM BOOTSTRAP — vytvoření třetí vrstvy (C) přímo v JS
// index.html má layerCurrent (A) + layerNext (B), přidáme layerPool (C)
// ═══════════════════════════════════════════════════════════════════════════
function bootstrapThirdLayer() {
const stack = document.getElementById(‘video-stack’);
if (!stack || document.getElementById(‘layerPool’)) return;

```
const layer = document.createElement('div');
layer.id = 'layerPool';
layer.className = 'twincher-layer';
layer.style.transform = 'translateY(200%)'; // park mimo displej

// Video element
const v = document.createElement('video');
v.id = 'videoPool';
v.setAttribute('playsinline', '');
v.setAttribute('webkit-playsinline', '');
v.setAttribute('disablepictureinpicture', '');
v.setAttribute('x-webkit-airplay', 'deny');
v.preload = 'auto';
v.muted = true;

// Poster img
const poster = document.createElement('div');
poster.className = 'layer-poster';

// Cover img (fallback)
const img = document.createElement('img');
img.id = 'imgPool';
img.alt = '';
img.draggable = false;

layer.appendChild(poster);
layer.appendChild(v);
layer.appendChild(img);
stack.appendChild(layer);
```

}

bootstrapThirdLayer();

// ═══════════════════════════════════════════════════════════════════════════
// SEKCE 2: CSS INJEKT — poster bridge styles
// ═══════════════════════════════════════════════════════════════════════════
(function injectPosterCSS() {
if (document.getElementById(‘tikboo-pool-css’)) return;
const s = document.createElement(‘style’);
s.id = ‘tikboo-pool-css’;
s.textContent = `
/* Poster bridge: obrázek sedí NAD videem, zmizí až při onplaying */
.layer-poster {
position: absolute;
inset: 0;
z-index: 2;
background-size: cover;
background-position: center;
background-repeat: no-repeat;
opacity: 0;
transition: opacity 80ms linear;
pointer-events: none;
will-change: opacity;
}
.layer-poster.visible {
opacity: 1;
}
.layer-poster.fade-out {
opacity: 0;
transition: opacity 180ms linear;
}

```
  /* Třetí vrstva je taky fullscreen */
  #layerPool {
    position: absolute;
    inset: 0;
    will-change: transform;
    background: #000;
    isolation: isolate;
  }
  #layerPool > video,
  #layerPool > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #000;
    display: none;
    z-index: 1;
  }
  #layerPool > img {
    opacity: 0;
    -webkit-user-drag: none;
    user-select: none;
  }
`;
document.head.appendChild(s);
```

})();

// ═══════════════════════════════════════════════════════════════════════════
// SEKCE 3: HLAVNÍ ENGINE
// ═══════════════════════════════════════════════════════════════════════════
function initTikbooSwipe(options) {
const {
refs, state, playlist, vh, normalizeIndex,
tryPlay, clearAuto, stopProg,
bindAutoAdvanceForCurrent, syncSoundUI,
showPlayOverlay, setLayerContent,
ensureSoundOn, isInteractiveTarget
} = options;

```
// ─────────────────────────────────────────────────────────────────────────
// KONFIGURACE
// ─────────────────────────────────────────────────────────────────────────
const THRESHOLD_RATIO  = 0.15;
const MOVE_ACTIVATE_PX = 5;
const MIN_COMMIT_DY    = 40;
const MIN_COMMIT_VY    = 0.40;
const TAP_MAX_MOVE     = 8;
const TAP_MAX_TIME     = 220;
const RATE_LIMIT_MS    = 333;   // max 3 swipe/s → Safari dekodér nestíhá více
const SETTLE_MS        = 170;   // o 10 ms více než animace (160 ms)
const ANIM_MS          = 160;
const EASING           = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
const SNAP_EASING      = 'cubic-bezier(0.2, 0, 0.2, 1)';

// ─────────────────────────────────────────────────────────────────────────
// POOL: 3 vrstvy jako kruhový buffer — NIKDY se neničí
// ─────────────────────────────────────────────────────────────────────────
//
// pool[i].layer  = DOM element .twincher-layer
// pool[i].video  = <video> uvnitř vrstvy
// pool[i].img    = <img>   uvnitř vrstvy
// pool[i].poster = <div.layer-poster> uvnitř vrstvy
// pool[i].pIdx   = index do playlist, který je v této vrstvě načten (-1 = prázdná)
//
const pool = [
  {
    layer:  document.getElementById('layerCurrent'),
    video:  document.getElementById('videoCurrent'),
    img:    document.getElementById('imgCurrent'),
    poster: null,   // bude injektován níže
    pIdx:   -1
  },
  {
    layer:  document.getElementById('layerNext'),
    video:  document.getElementById('videoNext'),
    img:    document.getElementById('imgNext'),
    poster: null,
    pIdx:   -1
  },
  {
    layer:  document.getElementById('layerPool'),
    video:  document.getElementById('videoPool'),
    img:    document.getElementById('imgPool'),
    poster: null,
    pIdx:   -1
  }
];

// Přidáme poster div do vrstev A a B (C již má z bootstrapu)
pool.forEach((slot, i) => {
  // Najdi nebo vytvoř poster
  let p = slot.layer.querySelector('.layer-poster');
  if (!p) {
    p = document.createElement('div');
    p.className = 'layer-poster';
    slot.layer.insertBefore(p, slot.layer.firstChild);
  }
  slot.poster = p;

  // Nastav video atributy
  const v = slot.video;
  v.preload = 'auto';
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.setAttribute('disablepictureinpicture', '');
  v.setAttribute('x-webkit-airplay', 'deny');
});

// currentSlot = index do pool[], který právě hraje (vidí uživatel)
let currentSlot = 0;

// Pomocné: vrátí slot pro daný playlist index (nebo -1)
function slotForPIdx(pIdx) {
  return pool.findIndex(s => s.pIdx === pIdx);
}

// Pomocné: vrátí slot, který není current ani připravený dopředu
function freeSlot(excludeSlots) {
  for (let i = 0; i < 3; i++) {
    if (!excludeSlots.includes(i)) return i;
  }
  return (currentSlot + 2) % 3; // fallback
}

// ─────────────────────────────────────────────────────────────────────────
// POSTER BRIDGE
// ─────────────────────────────────────────────────────────────────────────
function showPoster(slot, posterUrl) {
  const p = pool[slot].poster;
  if (!p) return;
  if (posterUrl) {
    p.style.backgroundImage = `url(${posterUrl})`;
  }
  p.classList.remove('fade-out');
  p.classList.add('visible');
}

function hidePoster(slot) {
  const p = pool[slot].poster;
  if (!p) return;
  p.classList.remove('visible');
  p.classList.add('fade-out');
  setTimeout(() => { p.classList.remove('fade-out'); }, 200);
}

function bindPosterBridge(slot) {
  const v = pool[slot].video;
  if (!v) return;

  // Odstraň starý listener
  if (v._poolPlaying) {
    v.removeEventListener('playing', v._poolPlaying);
    v._poolPlaying = null;
  }

  v._poolPlaying = function onPlaying() {
    hidePoster(slot);
    v.removeEventListener('playing', v._poolPlaying);
    v._poolPlaying = null;
  };
  v.addEventListener('playing', v._poolPlaying, { once: false });
}

// ─────────────────────────────────────────────────────────────────────────
// LOAD DO SLOTU — nahradí src, ALE video element žije dál (pool princip)
// ─────────────────────────────────────────────────────────────────────────
function loadIntoSlot(slotIdx, pIdx, forPreload) {
  const slot  = pool[slotIdx];
  const item  = playlist[pIdx];

  // Pokud je již načteno → nic neměň
  if (slot.pIdx === pIdx) return;

  slot.pIdx = pIdx;

  const v   = slot.video;
  const img = slot.img;

  // Zruš stávající poster handler
  if (v._poolPlaying) {
    v.removeEventListener('playing', v._poolPlaying);
    v._poolPlaying = null;
  }

  if (item.type === 'video') {
    img.style.display = 'none';
    v.style.display   = 'block';

    // Ukážeme poster ihned (dokud video nezačne hrát)
    // Poster = první frame (poster atribut) nebo thumbnailová URL z playlistu
    const posterUrl = item.poster || null;
    showPoster(slotIdx, posterUrl);
    bindPosterBridge(slotIdx);

    // Změna src bez destrukce elementu
    const newSrc = item.src;
    if (v.getAttribute('src') !== newSrc) {
      v.muted = true; // vždy muted při načítání
      v.src   = newSrc;
      v.load();
    }

    if (forPreload) {
      // Decode první frame → pause → Safari drží dekodér "teplý"
      v.addEventListener('loadeddata', function warmUp() {
        v.removeEventListener('loadeddata', warmUp);
        v.play().then(() => {
          setTimeout(() => v.pause(), 50);
        }).catch(() => {});
      }, { once: true });
    }
  } else {
    // Statický obrázek
    v.style.display = 'none';
    img.style.display = 'block';
    img.style.opacity = '0';
    hidePoster(slotIdx);

    if (img.getAttribute('src') !== item.src) {
      img.src = item.src;
    }

    img.onload = () => { img.style.opacity = '1'; };
    img.onerror = () => { img.style.display = 'none'; };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TRANSFORM HELPER
// ─────────────────────────────────────────────────────────────────────────
const setTr = (el, y) => {
  el.style.transform = `translate3d(0,${y}px,0)`;
};

// Parkuj slot mimo displej (2 × výška dolů = bezpečné místo)
function parkSlot(slotIdx) {
  pool[slotIdx].layer.style.transition = 'none';
  setTr(pool[slotIdx].layer, vh() * 2);
}

// ─────────────────────────────────────────────────────────────────────────
// SEEK UI RESET
// ─────────────────────────────────────────────────────────────────────────
const seekPill = document.getElementById('seekPill');
const seekTime = document.getElementById('seekTime');

function resetSeekUiImmediate() {
  if (seekPill) seekPill.classList.remove('is-active');
  if (seekTime) seekTime.classList.remove('is-active');
  document.querySelectorAll('.side').forEach(s => {
    s.classList.remove('scrubbing');
    s.style.opacity  = '';
    s.style.display  = '';
    s.style.pointerEvents = '';
  });
}

// ─────────────────────────────────────────────────────────────────────────
// OPACITY EFEKT při swipe
// ─────────────────────────────────────────────────────────────────────────
function updateLayerEffects(layer, opacity) {
  const side = layer.querySelector('.side');
  if (side) side.style.opacity = opacity;
}

// ─────────────────────────────────────────────────────────────────────────
// RATE LIMITER
// ─────────────────────────────────────────────────────────────────────────
let lastCommitTime = 0;

function canCommit() {
  const now = Date.now();
  if (now - lastCommitTime < RATE_LIMIT_MS) return false;
  lastCommitTime = now;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// RESET TRANSFORMS (bez animace)
// ─────────────────────────────────────────────────────────────────────────
let raf = 0, settleTimer = 0;

function resetTransformsNoAnim() {
  const h = vh();
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  clearTimeout(settleTimer);

  pool.forEach((slot, i) => {
    slot.layer.style.transition = 'none';
    slot.layer.style.willChange = 'auto';
    updateLayerEffects(slot.layer, 1);
  });

  // current = 0, next (forward) = +h, pool (backward/free) = +2h
  const nextSlot = (currentSlot + 1) % 3;
  const freeS    = (currentSlot + 2) % 3;

  setTr(pool[currentSlot].layer, 0);
  setTr(pool[nextSlot].layer, h);
  setTr(pool[freeS].layer, h * 2);
}

// ─────────────────────────────────────────────────────────────────────────
// WARM FORWARD NEXT — prediktivní preload dalšího videa
// ─────────────────────────────────────────────────────────────────────────
function warmForwardNext() {
  if (state.isAnimating || dragging) return;
  const h         = vh();
  const targetIdx = normalizeIndex(state.index + 1);
  const nextSlot  = (currentSlot + 1) % 3;

  loadIntoSlot(nextSlot, targetIdx, true);

  pool[nextSlot].layer.style.transition = 'none';
  setTr(pool[nextSlot].layer, h);

  preparedDir  = 1;
  preparedSlot = nextSlot;
}

// ─────────────────────────────────────────────────────────────────────────
// PREPARE — před gesty, na základě směru
// ─────────────────────────────────────────────────────────────────────────
let preparedDir  = 0;
let preparedSlot = -1;

function prepareNextForDirection(dir) {
  const h          = vh();
  const targetIdx  = normalizeIndex(state.index + dir);
  const targetSlot = slotForPIdx(targetIdx);

  // Pokud cílový slot je currentSlot → chyba, použij volný slot
  let useSlot;
  if (targetSlot !== -1 && targetSlot !== currentSlot) {
    useSlot = targetSlot;
  } else {
    useSlot = freeSlot([currentSlot]);
  }

  loadIntoSlot(useSlot, targetIdx, true);

  pool[useSlot].layer.style.transition = 'none';
  setTr(pool[useSlot].layer, dir > 0 ? h : -h);

  preparedDir  = dir;
  preparedSlot = useSlot;
}

// ─────────────────────────────────────────────────────────────────────────
// COMMIT — finální přepnutí videa
// ─────────────────────────────────────────────────────────────────────────
function commit(dir) {
  if (state.isAnimating) return;
  if (!canCommit()) {
    // Rate limit: snapBack místo swipe
    snapBack();
    return;
  }

  state.isAnimating = true;
  clearAuto(); stopProg(); resetSeekUiImmediate();
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  clearTimeout(settleTimer);

  const h         = vh();
  const fromSlot  = currentSlot;
  const toSlot    = preparedSlot !== -1 ? preparedSlot : (currentSlot + 1) % 3;
  const oldSlot   = freeSlot([fromSlot, toSlot]);

  // Nastav willChange před animací
  pool[fromSlot].layer.style.willChange = 'transform';
  pool[toSlot].layer.style.willChange   = 'transform';

  pool[fromSlot].layer.style.transition = `transform ${ANIM_MS}ms ${EASING}`;
  pool[toSlot].layer.style.transition   = `transform ${ANIM_MS}ms ${EASING}`;

  // Efekt: odcházející vrstva zhasne
  updateLayerEffects(pool[fromSlot].layer, 0.3);

  setTr(pool[fromSlot].layer, dir > 0 ? -h : h);
  setTr(pool[toSlot].layer, 0);

  settleTimer = setTimeout(() => {
    // ── KLÍČOVÉ: video se NEPAUZUJE přes src='' ──
    // Pouze mute + pause. Src zůstane! Pool princip.
    const oldVideo = pool[fromSlot].video;
    oldVideo.pause();
    // src ZÁMĚRNĚ NEMĚNÍME → Safari drží dekodér nahoře

    // Aktualizuj stav
    state.index  = normalizeIndex(state.index + dir);
    currentSlot  = toSlot;
    preparedDir  = 0;
    preparedSlot = -1;

    // Synchronizuj refs s app.js (app.js používá refs.videoCurrent atd.)
    refs.layerCurrent = pool[currentSlot].layer;
    refs.videoCurrent = pool[currentSlot].video;
    refs.imgCurrent   = pool[currentSlot].img;

    // Přesuň playOverlay do aktivní vrstvy
    if (refs.playOverlay && refs.playOverlay.parentNode !== pool[currentSlot].layer) {
      pool[currentSlot].layer.appendChild(refs.playOverlay);
    }

    // Odparkuj aktuální vrstvu
    resetTransformsNoAnim();

    // Spusť video (odmutuj pokud má být zvuk)
    const curVid = pool[currentSlot].video;
    curVid.muted = state.isMuted;
    showPoster(currentSlot, null); // ukáž poster dokud se video nespustí
    tryPlay(curVid);

    resetSeekUiImmediate();
    syncSoundUI();
    showPlayOverlay(false);
    bindAutoAdvanceForCurrent();

    state.isAnimating = false;

    // Preload dalšího
    requestAnimationFrame(() => warmForwardNext());
  }, SETTLE_MS);
}

// ─────────────────────────────────────────────────────────────────────────
// SNAP BACK — vrácení gesta
// ─────────────────────────────────────────────────────────────────────────
function snapBack() {
  if (state.isAnimating) return;
  state.isAnimating = true;
  const h = vh();

  pool[currentSlot].layer.style.transition = `transform 200ms ${SNAP_EASING}`;
  if (preparedSlot !== -1) {
    pool[preparedSlot].layer.style.transition = `transform 200ms ${SNAP_EASING}`;
  }

  updateLayerEffects(pool[currentSlot].layer, 1);
  setTr(pool[currentSlot].layer, 0);

  if (preparedSlot !== -1) {
    setTr(pool[preparedSlot].layer, preparedDir > 0 ? h : -h);
  }

  settleTimer = setTimeout(() => {
    preparedDir  = 0;
    preparedSlot = -1;
    resetTransformsNoAnim();
    state.isAnimating = false;
    bindAutoAdvanceForCurrent();
    warmForwardNext();
  }, 200);
}

// ─────────────────────────────────────────────────────────────────────────
// AUTO ADVANCE
// ─────────────────────────────────────────────────────────────────────────
function autoAdvance() {
  if (state.isAnimating || dragging) return;
  warmForwardNext();
  preparedDir  = 1;
  preparedSlot = (currentSlot + 1) % 3;
  commit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// TOUCH GESTA
// ─────────────────────────────────────────────────────────────────────────
let dragging = false;
let startY = 0, startX = 0, dy = 0, dx = 0;
let startT = 0, lastMoveY = 0;
let swipeSoundUnlocked = false;

function finishGesture(cancelled) {
  if (!dragging || state.isAnimating) return;

  const totalDy = dy;
  const endT    = performance.now();
  const dt      = Math.max(1, endT - startT);

  dragging           = false;
  swipeSoundUnlocked = false;

  if (cancelled || preparedDir === 0) {
    if (preparedSlot !== -1) snapBack();
    else {
      const isTap = Math.abs(totalDy) < TAP_MAX_MOVE && dt < TAP_MAX_TIME;
      if (isTap && pool[currentSlot].video) {
        const v = pool[currentSlot].video;
        if (v.paused || v.ended) {
          ensureSoundOn ? ensureSoundOn(true) : tryPlay(v);
          showPlayOverlay(false);
        } else {
          v.pause(); stopProg(); showPlayOverlay(true);
        }
      }
      resetTransformsNoAnim();
      bindAutoAdvanceForCurrent();
    }
    dy = 0; dx = 0;
    return;
  }

  const vy = (lastMoveY - startY) / dt;
  if (
    Math.abs(totalDy) >= vh() * THRESHOLD_RATIO ||
    (Math.abs(totalDy) >= MIN_COMMIT_DY && Math.abs(vy) >= MIN_COMMIT_VY)
  ) {
    commit(preparedDir);
  } else {
    snapBack();
  }
  dy = 0; dx = 0;
}

document.addEventListener('touchstart', (e) => {
  if (state.isAnimating || e.touches.length !== 1 || isInteractiveTarget(e.target)) return;

  dragging   = true;
  preparedDir  = 0;
  preparedSlot = -1;
  startY     = e.touches[0].clientY;
  startX     = e.touches[0].clientX;
  startT     = performance.now();

  clearAuto(); stopProg();

  pool.forEach(s => {
    s.layer.style.transition  = 'none';
    s.layer.style.willChange  = 'transform';
  });

  warmForwardNext();
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!dragging || state.isAnimating) return;

  const y   = e.touches[0].clientY;
  const x   = e.touches[0].clientX;
  const ddy = y - startY;
  const ddx = x - startX;

  if (Math.abs(ddx) > Math.abs(ddy) * 1.4 || Math.abs(ddy) < MOVE_ACTIVATE_PX) return;

  e.preventDefault();
  dy        = ddy;
  lastMoveY = y;

  if (!swipeSoundUnlocked && typeof ensureSoundOn === 'function') {
    ensureSoundOn(true);
    swipeSoundUnlocked = true;
  }

  const dir = dy < 0 ? 1 : -1;
  if (preparedDir !== dir) prepareNextForDirection(dir);

  if (!raf) {
    raf = requestAnimationFrame(() => {
      raf = 0;
      const h        = vh();
      const progress = Math.min(Math.abs(dy) / (h * 0.4), 1);
      const opacity  = Math.max(1 - progress, 0.3);

      updateLayerEffects(pool[currentSlot].layer, opacity);
      setTr(pool[currentSlot].layer, dy);

      if (preparedSlot !== -1) {
        const baseY = preparedDir > 0 ? h : -h;
        setTr(pool[preparedSlot].layer, baseY + dy);
      }
    });
  }
}, { passive: false });

document.addEventListener('touchend',    () => finishGesture(false), { passive: true });
document.addEventListener('touchcancel', () => finishGesture(true),  { passive: true });

// ─────────────────────────────────────────────────────────────────────────
// INICIALIZACE PRVNÍHO VIDEA
// ─────────────────────────────────────────────────────────────────────────
// Slot 0 = current (layerCurrent), nastavíme pIdx
pool[0].pIdx = state.index;

// Sync refs pro app.js
refs.layerCurrent = pool[0].layer;
refs.videoCurrent = pool[0].video;
refs.imgCurrent   = pool[0].img;
refs.layerNext    = pool[1].layer;
refs.videoNext    = pool[1].video;
refs.imgNext      = pool[1].img;

// ─────────────────────────────────────────────────────────────────────────
// VEŘEJNÉ API
// ─────────────────────────────────────────────────────────────────────────
return {
  autoAdvance,
  warmForwardNext,
  commit,
  resetTransformsNoAnim,
  isDragging() { return dragging; }
};
```

}

window.initTikbooSwipe = initTikbooSwipe;
})();
