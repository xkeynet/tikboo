// /assets/js/ui/interactions.js

export function initInteractions({
  refs,
  state,
  playlist,
  track = () => {},
  canInteract = () => true
}) {
  const likedByIndex = new Map();
  const baseLikesByIndex = new Map();

  function normalizeIndex(index) {
    const len = playlist.length;
    return (index % len + len) % len;
  }

  function getBaseLikes(index) {
    const safeIndex = normalizeIndex(index);

    if (!baseLikesByIndex.has(safeIndex)) {
      const raw = playlist[safeIndex]?.likes;
      const value = Number.isFinite(Number(raw)) ? Number(raw) : 0;
      baseLikesByIndex.set(safeIndex, value);
    }

    return baseLikesByIndex.get(safeIndex);
  }

  function getLikeCount(index) {
    const safeIndex = normalizeIndex(index);
    return getBaseLikes(safeIndex) + (likedByIndex.get(safeIndex) ? 1 : 0);
  }

  function formatCount(value) {
    if (value >= 1000000) return (value / 1000000).toFixed(1).replace('.0', '') + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1).replace('.0', '') + 'K';
    return String(value);
  }

  function renderLayerLike(layer, index) {
    if (!layer) return;

    const safeIndex = normalizeIndex(index);
    const isLiked = !!likedByIndex.get(safeIndex);
    const count = getLikeCount(safeIndex);

    layer.querySelectorAll('.likeBtn').forEach((btn) => {
      btn.classList.toggle('is-liked', isLiked);
      btn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');

      const countEl = btn.closest('.stack')?.querySelector('.count');
      if (countEl) countEl.textContent = formatCount(count);
    });
  }

  function renderLikes() {
    renderLayerLike(refs.layerPrev, state.index - 1);
    renderLayerLike(refs.layerCurrent, state.index);
    renderLayerLike(refs.layerNext, state.index + 1);
  }

  function bounce(btn) {
    btn.classList.remove('is-bouncing');
    void btn.offsetWidth;
    btn.classList.add('is-bouncing');
  }

  document.addEventListener('click', (e) => {
    const likeBtn = e.target.closest('.likeBtn');
    if (!likeBtn) return;

    if (!canInteract()) return;

    e.preventDefault();
    e.stopPropagation();

    let index = state.index;

    if (refs.layerPrev?.contains(likeBtn)) index = state.index - 1;
    if (refs.layerCurrent?.contains(likeBtn)) index = state.index;
    if (refs.layerNext?.contains(likeBtn)) index = state.index + 1;

    const safeIndex = normalizeIndex(index);
    const nextLiked = !likedByIndex.get(safeIndex);

    likedByIndex.set(safeIndex, nextLiked);

    bounce(likeBtn);
    renderLikes();

    track('like_toggle', {
      video_index: safeIndex,
      liked: nextLiked
    });
  }, true);

  function watchLayers() {
    renderLikes();
    requestAnimationFrame(watchLayers);
  }

  renderLikes();
  requestAnimationFrame(watchLayers);

  return {
    renderLikes
  };
}
