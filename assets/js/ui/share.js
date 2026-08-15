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
