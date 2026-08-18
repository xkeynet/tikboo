// /assets/js/ui/share.js

const TIKBOO_ORIGIN = 'https://tikboo.com';


/* =========================================================
   SHARED VIDEO VIEWPORT NORMALIZATION
   ========================================================== */

function normalizeSharedVideoViewport() {
  const isVideoDeepLink =
    /^\/v\/[^/]+\/?$/.test(window.location.pathname);

  if (!isVideoDeepLink) {
    return;
  }

  const physicalViewportWidth = Math.min(
    window.screen.width,
    window.screen.height
  );

  if (
    physicalViewportWidth > 390 &&
    document.body.classList.contains('device-small')
  ) {
    document.body.classList.remove('device-small');
  }
}

normalizeSharedVideoViewport();


/* =========================================================
   SHARE URL
   ========================================================== */

export function getVideoShareUrl(video) {
  if (!video?.id) {
    return TIKBOO_ORIGIN;
  }

  return `${TIKBOO_ORIGIN}/v/${encodeURIComponent(video.id)}`;
}


/* =========================================================
   COPY VIDEO LINK
   ========================================================== */

export async function copyVideoShareUrl(video) {
  const url = getVideoShareUrl(video);

  if (
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    await navigator.clipboard.writeText(url);

    return url;
  }

  const textarea = document.createElement('textarea');

  textarea.value = url;

  textarea.setAttribute('readonly', '');

  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);

  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const copied = document.execCommand('copy');

  textarea.remove();

  if (!copied) {
    throw new Error('Tikboo clipboard copy failed.');
  }

  return url;
}


/* =========================================================
   NATIVE SHARE
   iOS / Safari renders the real Apple Share Sheet.
   ========================================================== */

export async function openNativeVideoShare(video) {
  if (!video?.id) {
    throw new Error('Tikboo share video ID is missing.');
  }

  if (typeof navigator.share !== 'function') {
    throw new Error('Native Web Share API is not available.');
  }

  const url = getVideoShareUrl(video);

  const shareData = {
    title: 'Tikboo',
    text: 'Watch this on Tikboo',
    url
  };

  if (
    typeof navigator.canShare === 'function' &&
    !navigator.canShare(shareData)
  ) {
    throw new Error('This content cannot be shared by the device.');
  }

  await navigator.share(shareData);

  return url;
}


/* =========================================================
   SHARE SHEET STATE
   ========================================================== */

let currentShareVideo = null;
let shareSheetInitialized = false;
let nativeShareInProgress = false;


/* =========================================================
   SHARE SHEET ELEMENTS
   ========================================================== */

function getShareSheetElements() {
  return {
    sheet: document.getElementById('shareSheet'),
    backdrop: document.getElementById('shareSheetBackdrop'),
    closeBtn: document.getElementById('shareCloseBtn'),
    copyBtn: document.getElementById('shareCopyBtn'),
    nativeBtn: document.getElementById('shareNativeBtn')
  };
}


/* =========================================================
   SHARE SHEET STATUS
   ========================================================== */

function isShareSheetOpen() {
  const { sheet } = getShareSheetElements();

  return Boolean(
    sheet &&
    sheet.getAttribute('aria-hidden') === 'false'
  );
}


/* =========================================================
   CLOSE TIKBOO SHARE SHEET
   ========================================================== */

export function closeVideoShareSheet() {
  const { sheet } = getShareSheetElements();

  if (!sheet) {
    return;
  }

  sheet.setAttribute('aria-hidden', 'true');

  currentShareVideo = null;
}


/* =========================================================
   OPEN TIKBOO SHARE SHEET
   ========================================================== */

export function openVideoShareSheet(video) {
  const { sheet } = getShareSheetElements();

  if (!sheet || !video?.id) {
    return;
  }

  currentShareVideo = video;

  sheet.setAttribute('aria-hidden', 'false');
}


/* =========================================================
   INITIALIZE SHARE SHEET
   ========================================================== */

export function initVideoShareSheet() {
  if (shareSheetInitialized) {
    return;
  }

  const {
    sheet,
    backdrop,
    closeBtn,
    copyBtn,
    nativeBtn
  } = getShareSheetElements();

  if (
    !sheet ||
    !backdrop ||
    !closeBtn ||
    !copyBtn ||
    !nativeBtn
  ) {
    return;
  }

  shareSheetInitialized = true;


  /* =======================================================
     BACKDROP CLOSE
     ======================================================== */

  backdrop.addEventListener('click', () => {
    if (nativeShareInProgress) {
      return;
    }

    closeVideoShareSheet();
  });


  /* =======================================================
     CLOSE BUTTON
     ======================================================== */

  closeBtn.addEventListener('click', () => {
    if (nativeShareInProgress) {
      return;
    }

    closeVideoShareSheet();
  });


  /* =======================================================
     COPY CURRENT VIDEO DEEP LINK
     ======================================================== */

  copyBtn.addEventListener('click', async () => {
    if (!currentShareVideo) {
      return;
    }

    const video = currentShareVideo;

    try {
      await copyVideoShareUrl(video);

      closeVideoShareSheet();
    } catch (error) {
      console.error(
        'Tikboo share copy failed:',
        error
      );
    }
  });


  /* =======================================================
     REAL NATIVE APPLE / SYSTEM SHARE SHEET
     ======================================================== */

  nativeBtn.addEventListener('click', async () => {
    if (
      !currentShareVideo ||
      nativeShareInProgress
    ) {
      return;
    }

    if (typeof navigator.share !== 'function') {
      console.error(
        'Tikboo native share failed: Web Share API unavailable.'
      );

      return;
    }

    const video = currentShareVideo;

    nativeShareInProgress = true;

    try {
      await openNativeVideoShare(video);

      closeVideoShareSheet();
    } catch (error) {
      if (error?.name === 'AbortError') {
        closeVideoShareSheet();

        return;
      }

      console.error(
        'Tikboo native share failed:',
        error
      );
    } finally {
      nativeShareInProgress = false;
    }
  });


  /* =======================================================
     ESCAPE
     ======================================================== */

  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      isShareSheetOpen() &&
      !nativeShareInProgress
    ) {
      closeVideoShareSheet();
    }
  });
}
