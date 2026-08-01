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

    let cookieRevealTimer = 0;
    let cookieClosing = false;
    let unlocked = readUnlockedState();

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
    }

    function hide() {
      clearCookieRevealTimer();

      if (!gate) return;

      gate.classList.add('hidden');
    }

    function show() {
      if (!gate || unlocked) return;

      clearCookieRevealTimer();
      resetVisualState();

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
