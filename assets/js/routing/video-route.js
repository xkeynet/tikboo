// /assets/js/routing/video-route.js

export function getVideoIdFromUrl() {
  const match = window.location.pathname.match(/^\/v\/([^/]+)\/?$/);

  if (!match) {
    return null;
  }

  return decodeURIComponent(match[1]);
}
