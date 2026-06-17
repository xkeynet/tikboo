// /assets/js/ui/interactions.js

import { supabase } from '../utils/supabaseClient.js';

export function initInteractions({
  refs,
  state,
  playlist,
  track = () => {},
  canInteract = () => true
}) {
  const likedByIndex = new Map();
  const baseLikesByIndex = new Map();

  const LIKE_STORAGE_KEY = 'tikboo_liked_videos_v1';

  function normalizeIndex(index) {
    const len = playlist.length;
    return (index % len + len) % len;
  }

  function getVideoId(index) {
    const safeIndex = normalizeIndex(index);
    const item = playlist[safeIndex];

    return String(
      item?.id ||
      item?.video_id ||
      item?.src ||
      `video_${safeIndex}`
    );
  }

  function loadLocalLikedState() {
    try {
      const raw = localStorage.getItem(LIKE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};

      Object.entries(parsed).forEach(([videoId, liked]) => {
        if (!liked) return;

        const index = playlist.findIndex((item, i) => getVideoId(i) === videoId);
        if (index >= 0) likedByIndex.set(index, true);
      });
    } catch (e) {}
  }

  function saveLocalLikedState() {
    try {
      const data = {};

      likedByIndex.forEach((liked, index) => {
        if (!liked) return;
        data[getVideoId(index)] = true;
      });

      localStorage.setItem(LIKE_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {}
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

  function setBaseLikes(index, value) {
    const safeIndex = normalizeIndex(index);
    const safeValue = Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
    baseLikesByIndex.set(safeIndex, safeValue);
  }

  function getLikeCount(index) {
    return getBaseLikes(index);
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

    window.setTimeout(() => {
      btn.classList.remove('is-bouncing');
    }, 360);
  }

  async function loadRemoteLikes() {
    const { data, error } = await supabase
      .from('video_likes')
      .select('video_id, likes');

    if (error) {
      console.warn('Tikboo likes load failed:', error);
      return;
    }

    if (!Array.isArray(data)) return;

    data.forEach((row) => {
      const index = playlist.findIndex((item, i) => getVideoId(i) === row.video_id);
      if (index < 0) return;

      setBaseLikes(index, row.likes);
    });

    renderLikes();
  }

  async function persistLike(index, nextCount) {
    const safeIndex = normalizeIndex(index);
    const videoId = getVideoId(safeIndex);

    const { data, error } = await supabase
      .from('video_likes')
      .select('id, likes')
      .eq('video_id', videoId)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('Tikboo likes read failed:', error);
      return;
    }

    if (data?.id) {
      const { error: updateError } = await supabase
        .from('video_likes')
        .update({ likes: nextCount })
        .eq('id', data.id);

      if (updateError) {
        console.warn('Tikboo likes update failed:', updateError);
      }

      return;
    }

    const { error: insertError } = await supabase
      .from('video_likes')
      .insert({
        video_id: videoId,
        likes: nextCount
      });

    if (insertError) {
      console.warn('Tikboo likes insert failed:', insertError);
    }
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
    const wasLiked = !!likedByIndex.get(safeIndex);
    const nextLiked = !wasLiked;

    const currentCount = getBaseLikes(safeIndex);
    const nextCount = Math.max(0, currentCount + (nextLiked ? 1 : -1));

    likedByIndex.set(safeIndex, nextLiked);
    setBaseLikes(safeIndex, nextCount);
    saveLocalLikedState();

    bounce(likeBtn);
    renderLikes();

    persistLike(safeIndex, nextCount);

    track('like_toggle', {
      video_index: safeIndex,
      video_id: getVideoId(safeIndex),
      liked: nextLiked,
      likes: nextCount
    });
  }, true);

  function watchLayers() {
    renderLikes();
    requestAnimationFrame(watchLayers);
  }

  loadLocalLikedState();
  renderLikes();
  loadRemoteLikes();
  requestAnimationFrame(watchLayers);

  return {
    renderLikes
  };
}
