// /assets/js/cookie-consent.js

(() => {
  'use strict';

  // =========================================================
  // Tikboo Cookie Consent
  // Isolated component logic
  // =========================================================

  const AGE_GATE_STORAGE_KEY = 'swipe_age_ok';
  const COOKIE_CONSENT_STORAGE_KEY = 'tikboo_cookie_consent';

  const COOKIE_REVEAL_DELAY = 3000;
  const COOKIE_CLOSE_DURATION = 960;

  const COOKIE_THEME_COLOR = '#00B4D8';
  const DEFAULT_THEME_COLOR = '#000000';

  function readUnlockedState() {
    try {
      return localStorage.getItem(AGE_GATE_STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function createCookieConsent(options = {}) {
    const {
      track = null,
      onComplete = null
    } = options;

    const gate = document.getElementById('gateOverlay');
    const cookieSheet = document.getElementById('cookieSheet');
    const declineOptionalBtn = document.getElementById('declineOptionalBtn');
    const acceptAllBtn = document.getElementById('acceptAllBtn');
    const themeColorMeta = document.getElementById('themeColorMeta');

    let cookieRevealTimer = 0;
    let cookieClosing = false;
    let unlocked = readUnlockedState();

    function setThemeColor(color) {
      if (!themeColorMeta) return;

      themeColorMeta.setAttribute('content', color);
    }

    function enableCookiePageBackground() {
      document.documentElement.classList.add('cookie-consent-open');
      document.body.classList.add('cookie-consent-open');

      setThemeColor(COOKIE_THEME_COLOR);
    }

    function disableCookiePageBackground() {
      document.documentElement.classList.remove('cookie-consent-open');
      document.body.classList.remove('cookie-consent-open');

      setThemeColor(DEFAULT_THEME_COLOR);
    }

    function clearCookieRevealTimer() {
      if (!cookieRevealTimer) return;

      clearTimeout(cookieRevealTimer);
      cookieRevealTimer = 0;
    }

    function setCookieButtonsDisabled(disabled) {
      if (declineOptionalBtn) {
        declineOptionalBtn.disabled = disabled;
      }

      if (acceptAllBtn) {
        acceptAllBtn.disabled = disabled;
      }
    }

    function resetVisualState() {
      if (gate) {
        gate.classList.remove('is-closing');
      }

      if (cookieSheet) {
        cookieSheet.classList.remove('is-visible', 'is-closing');
      }

      setCookieButtonsDisabled(false);
      cookieClosing = false;

      if (unlocked) {
        disableCookiePageBackground();
      }
    }

    function hide() {
      clearCookieRevealTimer();
      disableCookiePageBackground();

      if (!gate) return;

      gate.classList.add('hidden');
    }

    function show() {
      if (!gate || unlocked) {
        disableCookiePageBackground();
        return;
      }

      clearCookieRevealTimer();
      resetVisualState();

      enableCookiePageBackground();
      gate.classList.remove('hidden');

      cookieRevealTimer = window.setTimeout(() => {
        cookieRevealTimer = 0;

        if (
          unlocked ||
          cookieClosing ||
          !cookieSheet
        ) {
          return;
        }

        requestAnimationFrame(() => {
          cookieSheet.classList.add('is-visible');
        });
      }, COOKIE_REVEAL_DELAY);
    }

    function saveChoice(choice) {
      try {
        localStorage.setItem(AGE_GATE_STORAGE_KEY, '1');
        localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, choice);
      } catch (error) {
        // Storage může být v soukromém režimu omezené.
      }
    }

    function completeChoice(choice) {
      if (unlocked || cookieClosing) return;

      cookieClosing = true;
      clearCookieRevealTimer();
      setCookieButtonsDisabled(true);

      if (typeof track === 'function') {
        track('cookie_consent', {
          choice,
          method: 'button'
        });
      }

      saveChoice(choice);
      unlocked = true;

      if (cookieSheet) {
        cookieSheet.classList.remove('is-visible');
        cookieSheet.classList.add('is-closing');
      }

      if (gate) {
        gate.classList.add('is-closing');
      }

      window.setTimeout(() => {
        disableCookiePageBackground();

        if (typeof onComplete === 'function') {
          onComplete(choice);
        }
      }, COOKIE_CLOSE_DURATION);
    }

    function handleDeclineOptional() {
      completeChoice('decline_optional');
    }

    function handleAcceptAll() {
      completeChoice('accept_all');
    }

    if (declineOptionalBtn) {
      declineOptionalBtn.addEventListener(
        'click',
        handleDeclineOptional
      );
    }

    if (acceptAllBtn) {
      acceptAllBtn.addEventListener(
        'click',
        handleAcceptAll
      );
    }

    if (unlocked) {
      disableCookiePageBackground();
    }

    return {
      show,
      hide,
      resetVisualState,
      completeChoice,

      isUnlocked() {
        return unlocked;
      }
    };
  }

  window.TikbooCookieConsent = {
    create: createCookieConsent,
    isUnlocked: readUnlockedState
  };
})();