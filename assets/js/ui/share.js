// /assets/js/ui/share.js

const TIKBOO_ORIGIN = 'https://tikboo.com';

export function getVideoShareUrl(video) {
  return `${TIKBOO_ORIGIN}/v/${video.id}`;
}

export async function copyVideoShareUrl(video) {
  const url = getVideoShareUrl(video);

  await navigator.clipboard.writeText(url);

  return url;
}

export async function openNativeVideoShare(video) {
  const url = getVideoShareUrl(video);

  const shareData = {
    title: 'Tikboo',
    text: 'Watch this',
    url
  };

  await navigator.share(shareData);

  return url;
}


/* =========================================================
   SHARE SHEET
   ========================================================== */

let currentShareVideo = null;
let shareSheetInitialized = false;

function getShareSheetElements() {
  return {
    sheet: document.getElementById('shareSheet'),
    backdrop: document.getElementById('shareSheetBackdrop'),
    closeBtn: document.getElementById('shareCloseBtn'),
    copyBtn: document.getElementById('shareCopyBtn'),
    nativeBtn: document.getElementById('shareNativeBtn')
  };
}

function isShareSheetOpen() {
  const { sheet } = getShareSheetElements();

  return Boolean(
    sheet &&
    sheet.getAttribute('aria-hidden') === 'false'
  );
}

export function closeVideoShareSheet() {
  const { sheet } = getShareSheetElements();

  if (!sheet) {
    return;
  }

  sheet.setAttribute('aria-hidden', 'true');

  currentShareVideo = null;
}

export function openVideoShareSheet(video) {
  const { sheet } = getShareSheetElements();

  if (!sheet || !video) {
    return;
  }

  currentShareVideo = video;

  sheet.setAttribute('aria-hidden', 'false');
}

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

  backdrop.addEventListener('click', () => {
    closeVideoShareSheet();
  });

  closeBtn.addEventListener('click', () => {
    closeVideoShareSheet();
  });

  copyBtn.addEventListener('click', async () => {
    if (!currentShareVideo) {
      return;
    }

    try {
      await copyVideoShareUrl(currentShareVideo);
      closeVideoShareSheet();
    } catch (error) {
      console.error('Tikboo share copy failed:', error);
    }
  });

  nativeBtn.addEventListener('click', async () => {
    if (!currentShareVideo) {
      return;
    }

    if (typeof navigator.share !== 'function') {
      return;
    }

    try {
      await openNativeVideoShare(currentShareVideo);
      closeVideoShareSheet();
    } catch (error) {
      if (error?.name === 'AbortError') {
        return;
      }

      console.error('Tikboo native share failed:', error);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      isShareSheetOpen()
    ) {
      closeVideoShareSheet();
    }
  });
}
