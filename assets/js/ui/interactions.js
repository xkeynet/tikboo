// /assets/js/ui/interactions.js

export function initInteractions({
  state,
  playlist,
  track = () => {},
  canInteract = () => true
}) {
  const likedByIndex = new Map();
  const baseLikesByIndex = new Map();

  function getBaseLikes(index) {
    if (!baseLikesByIndex.has(index)) {
      const raw = playlist[index]?.likes;
      const value = Number.isFinite(Number(raw)) ? Number(raw) : 0;
      baseLikesByIndex.set(index, value);
    }

    return baseLikesByIndex.get(index);
  }

  function getLikeCount(index) {
    return getBaseLikes(index) + (likedByIndex.get(index) ? 1 : 0);
  }

  function formatCount(value) {
    if (value >= 1000000) return (value / 1000000).toFixed(1).replace('.0', '') + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1).replace('.0', '') + 'K';
    return String(value);
  }

  function renderLikes() {
    const index = state.index;
    const isLiked = !!likedByIndex.get(index);
    const count = getLikeCount(index);

    document.querySelectorAll('.likeBtn').forEach((btn) => {
      btn.classList.toggle('is-liked', isLiked);
      btn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');

      const countEl = btn.closest('.stack')?.querySelector('.count');
      if (countEl) countEl.textContent = formatCount(count);
    });
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

    const index = state.index;
    const nextLiked = !likedByIndex.get(index);

    likedByIndex.set(index, nextLiked);

    bounce(likeBtn);
    renderLikes();

    track('like_toggle', {
      video_index: index,
      liked: nextLiked
    });
  }, true);

  let lastIndex = state.index;

  function watchIndex() {
    if (state.index !== lastIndex) {
      lastIndex = state.index;
      renderLikes();
    }

    requestAnimationFrame(watchIndex);
  }

  renderLikes();
  requestAnimationFrame(watchIndex);

  return {
    renderLikes
  };
}
