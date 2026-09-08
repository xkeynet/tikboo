// /assets/safety/block.js

// =========================================================
// TIKBOO SAFETY — KILL ZOOM
// iOS Safari: block pinch + gesture zoom
// =========================================================

document.addEventListener('touchmove', (e) => {
  if (e.scale && e.scale !== 1) e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

// =========================================================
// TIKBOO SAFETY — KILL SAVE IMAGE / LONG PRESS / DRAG
// =========================================================

(() => {
  const targets = [
    document.querySelector('.top img'),
    document.querySelector('#gateOverlay .top-g img')
  ].filter(Boolean);

  targets.forEach((img) => {
    img.setAttribute('draggable', 'false');

    img.style.webkitTouchCallout = 'none';
    img.style.webkitUserSelect = 'none';
    img.style.userSelect = 'none';
    img.style.webkitTapHighlightColor = 'transparent';

    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    img.addEventListener('contextmenu', stop, { passive: false });
    img.addEventListener('dragstart', stop, { passive: false });
    img.addEventListener('touchstart', () => {}, { passive: true });
  });
})();
