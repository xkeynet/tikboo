// /assets/js/ui/share.js

const TIKBOO_ORIGIN = 'https://tikboo.com';


/* =========================================================
   SHARE URL
   ========================================================== */

export function getVideoShareUrl(video) {
  if (video?.id) {
    return `${TIKBOO_ORIGIN}/v/${encodeURIComponent(video.id)}`;
  }

  return window.location.href;
}


/* =========================================================
   COPY LINK
   ========================================================== */

export async function copyVideoShareUrl(video) {
  const url = getVideoShareUrl(video);

  await navigator.clipboard.writeText(url);

  return url;
}


/* =========================================================
   NATIVE SYSTEM SHARE
   ========================================================== */

export async function openNativeVideoShare(video) {
  if (typeof navigator.share !== 'function') {
    return false;
  }

  const url = getVideoShareUrl(video);

  await navigator.share({
    title: 'Tikboo',
    url
  });

  return true;
}


/* =========================================================
   CUSTOM SHARE SHEET
   Disabled intentionally.
   ========================================================== */

export function initVideoShareSheet() {
  /* Native OS sharing only. */
}


/* =========================================================
   OPEN SHARE
   ========================================================== */

export async function openVideoShareSheet(video) {
  if (typeof navigator.share !== 'function') {
    return;
  }

  try {
    await openNativeVideoShare(video);
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }

    console.error(
      'Tikboo native share failed:',
      error
    );
  }
}


/* =========================================================
   CLOSE SHARE
   ========================================================== */

export function closeVideoShareSheet() {
  /* Native OS Share Sheet controls its own dismissal. */
}
