'use strict';

/* =========================================================
   TIKBOO — PROFILE INTRO OVERLAY
   ========================================================= */

(() => {
  const START_DELAY_MS = 2200;
  const FIRST_LINE_ENTER_STAGGER_MS = 95;
  const CHAR_ENTER_STAGGER_MS = 45;
  const CHAR_ENTER_ANIMATION_MS = 1100;
  const LINE_GAP_MS = 120;
  const SEQUENCE_HOLD_MS = 5000;
  const CHAR_EXIT_STAGGER_MS = 34;
  const CHAR_EXIT_ANIMATION_MS = 820;
  const BRAND_TRANSITION_MS = 550;
  const WORDMARK_ANIMATION_MS = 1500;
  const SYMBOL_ANIMATION_MS = 2400;
  const SYMBOL_HOLD_MS = 5000;
  const SPLIT_EXIT_MS = 1100;

  const CHAR_ENTER_EASING = 'cubic-bezier(0.14, 0.92, 0.18, 1)';
  const CHAR_EXIT_EASING = 'cubic-bezier(0.4, 0, 0.6, 1)';

  let intro = null;
  let sequence = null;
  let wordmarkStage = null;
  let wordmark = null;
  let symbolStage = null;
  let symbol = null;
  let lines = [];
  let characters = [];

  let active = false;
  let runId = 0;

  const timers = new Set();
  const animations = new Set();

  /* =========================================================
     CURRENT SWIPE LAYER
     ========================================================= */

  const getCurrentSwipeLayer = () => {
    const layers = Array.from(document.querySelectorAll('#video-stack .twincher-layer'));
    if (!layers.length) return null;

    const viewportCenter = window.innerHeight / 2;
    let currentLayer = null;
    let smallestDistance = Infinity;

    layers.forEach((layer) => {
      const rect = layer.getBoundingClientRect();
      const layerCenter = rect.top + rect.height / 2;
      const distance = Math.abs(layerCenter - viewportCenter);

      if (distance < smallestDistance) {
        smallestDistance = distance;
        currentLayer = layer;
      }
    });

    return currentLayer;
  };

  const attachOverlayToCurrentLayer = () => {
    if (!intro) return false;

    const currentLayer = getCurrentSwipeLayer();
    if (!currentLayer) return false;

    if (intro.parentElement !== currentLayer) {
      currentLayer.appendChild(intro);
    }

    return true;
  };

  /* =========================================================
     DOM
     ========================================================= */

  const createProfileOverlay = () => {
    const layer = getCurrentSwipeLayer();
    if (!layer) return false;

    intro = document.getElementById('profileIntro');

    if (!intro) {
      intro = document.createElement('div');
      intro.id = 'profileIntro';
      intro.className = 'profile-intro';
      intro.setAttribute('aria-hidden', 'true');

      intro.innerHTML = `
        <div class="profile-intro__content">
          <div class="profile-intro__sequence" id="profileSequence">
            <p class="profile-intro__line" id="profileLine1">Profile UI</p>
            <p class="profile-intro__line" id="profileLine2">is currently under</p>
            <p class="profile-intro__line" id="profileLine3">construction</p>
            <p class="profile-intro__line" id="profileLine4">...coming soon</p>
          </div>

          <div class="profile-intro__wordmark-stage" id="profileWordmarkStage" aria-hidden="true">
            <img class="profile-intro__wordmark" id="profileWordmark" src="/assets/Tikboo.png" alt="">
          </div>

          <div class="profile-intro__symbol-stage" id="profileSymbolStage" aria-hidden="true">
            <img class="profile-intro__symbol" id="profileSymbol" src="/assets/tikboo-logo.png" alt="">
          </div>
        </div>
      `;

      layer.appendChild(intro);
    } else {
      attachOverlayToCurrentLayer();
    }

    sequence = intro.querySelector('#profileSequence');
    wordmarkStage = intro.querySelector('#profileWordmarkStage');
    wordmark = intro.querySelector('#profileWordmark');
    symbolStage = intro.querySelector('#profileSymbolStage');
    symbol = intro.querySelector('#profileSymbol');

    lines = [
      intro.querySelector('#profileLine1'),
      intro.querySelector('#profileLine2'),
      intro.querySelector('#profileLine3'),
      intro.querySelector('#profileLine4')
    ];

    if (
      !sequence ||
      !wordmarkStage ||
      !wordmark ||
      !symbolStage ||
      !symbol ||
      lines.some((line) => !line)
    ) {
      return false;
    }

    characters = lines.map(prepareLine);

    return true;
  };

  /* =========================================================
     HELPERS
     ========================================================= */

  const isCurrentRun = (id) => active && id === runId;

  const wait = (delay, id) =>
    new Promise((resolve) => {
      if (!isCurrentRun(id)) {
        resolve();
        return;
      }

      const timer = window.setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, delay);

      timers.add(timer);
    });

  const clearTimers = () => {
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.clear();
  };

  const cancelAnimations = () => {
    animations.forEach((animation) => {
      try {
        animation.cancel();
      } catch (error) {}
    });

    animations.clear();
  };

  const nextFrame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

  const waitForAnimation = (animation) =>
    new Promise((resolve) => {
      if (!animation) {
        resolve();
        return;
      }

      const finish = () => resolve();

      animation.addEventListener('finish', finish, { once: true });
      animation.addEventListener('cancel', finish, { once: true });
    });

  const getEnterOffset = () => window.innerWidth + 180;
  const getExitOffset = () => -(window.innerWidth + 180);

  /* =========================================================
     CHARACTERS
     ========================================================= */

  function prepareLine(line) {
    const text = line.dataset.profileText || line.textContent.trim();

    line.dataset.profileText = text;
    line.setAttribute('aria-label', text);
    line.textContent = '';
    line.style.opacity = '1';
    line.style.transform = 'translate3d(0,0,0)';
    line.style.transition = 'none';

    const fragment = document.createDocumentFragment();

    Array.from(text).forEach((character) => {
      const span = document.createElement('span');
      const isSpace = character === ' ';

      span.className = 'profile-intro__char';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = isSpace ? '\u00A0' : character;

      span.style.display = 'inline-block';
      span.style.width = isSpace ? '0.22em' : 'auto';
      span.style.opacity = '0';
      span.style.transform = `translate3d(${getEnterOffset()}px,0,0)`;
      span.style.transformOrigin = '50% 50%';
      span.style.willChange = 'transform, opacity';
      span.style.backfaceVisibility = 'hidden';
      span.style.webkitBackfaceVisibility = 'hidden';

      fragment.appendChild(span);
    });

    line.appendChild(fragment);

    return Array.from(line.querySelectorAll('.profile-intro__char'));
  }

  const resetCharacters = () => {
    cancelAnimations();

    characters.forEach((lineCharacters) => {
      lineCharacters.forEach((character) => {
        character.style.opacity = '0';
        character.style.transform = `translate3d(${getEnterOffset()}px,0,0)`;
        character.style.willChange = 'transform, opacity';
      });
    });
  };

  const resetSequence = () => {
    if (!sequence) return;

    sequence.classList.remove('is-hidden');

    lines.forEach((line) => {
      line.classList.remove('is-visible', 'is-settled', 'is-exiting');
    });

    resetCharacters();
  };

  const resetWordmark = () => {
    if (!wordmarkStage) return;

    wordmarkStage.hidden = false;
    wordmarkStage.classList.remove(
      'is-visible',
      'is-entering',
      'is-settled',
      'is-exiting',
      'is-hidden'
    );
  };

  const resetSymbol = () => {
    if (!symbolStage) return;

    symbolStage.classList.remove(
      'is-visible',
      'is-entering',
      'is-settled',
      'is-exiting',
      'is-hidden'
    );

    symbolStage.style.opacity = '';
    symbolStage.style.visibility = '';
  };

  const resetAll = () => {
    resetSequence();
    resetWordmark();
    resetSymbol();
  };

  /* =========================================================
     CHARACTER ENTER
     ========================================================= */

  const animateCharacterEnter = (character) => {
    character.style.willChange = 'transform, opacity';

    const animation = character.animate(
      [
        {
          opacity: 0,
          transform: `translate3d(${getEnterOffset()}px,0,0)`
        },
        {
          opacity: 1,
          offset: 0.08
        },
        {
          opacity: 1,
          transform: 'translate3d(0,0,0)'
        }
      ],
      {
        duration: CHAR_ENTER_ANIMATION_MS,
        easing: CHAR_ENTER_EASING,
        fill: 'forwards'
      }
    );

    animations.add(animation);

    animation.addEventListener(
      'finish',
      () => {
        animations.delete(animation);
        character.style.opacity = '1';
        character.style.transform = 'translate3d(0,0,0)';
        character.style.willChange = 'auto';
      },
      { once: true }
    );

    return animation;
  };

  const animateLineEnter = async (lineCharacters, staggerMs, id) => {
    for (const character of lineCharacters) {
      if (!isCurrentRun(id)) return;

      animateCharacterEnter(character);
      await wait(staggerMs, id);
    }

    await wait(
      Math.max(0, CHAR_ENTER_ANIMATION_MS - staggerMs),
      id
    );
  };

  /* =========================================================
     CHARACTER EXIT
     ========================================================= */

  const animateCharacterExit = (character) => {
    character.style.willChange = 'transform, opacity';

    const animation = character.animate(
      [
        {
          opacity: 1,
          transform: 'translate3d(0,0,0)'
        },
        {
          opacity: 1,
          offset: 0.72
        },
        {
          opacity: 0,
          transform: `translate3d(${getExitOffset()}px,0,0)`
        }
      ],
      {
        duration: CHAR_EXIT_ANIMATION_MS,
        easing: CHAR_EXIT_EASING,
        fill: 'forwards'
      }
    );

    animations.add(animation);

    animation.addEventListener(
      'finish',
      () => {
        animations.delete(animation);
        character.style.opacity = '0';
        character.style.transform = `translate3d(${getExitOffset()}px,0,0)`;
        character.style.willChange = 'auto';
      },
      { once: true }
    );

    return animation;
  };

  const animateLineExit = async (lineCharacters, id) => {
    let lastAnimation = null;

    for (let index = 0; index < lineCharacters.length; index += 1) {
      if (!isCurrentRun(id)) return;

      lastAnimation = animateCharacterExit(lineCharacters[index]);

      if (index < lineCharacters.length - 1) {
        await wait(CHAR_EXIT_STAGGER_MS, id);
      }
    }

    await waitForAnimation(lastAnimation);
  };

  /* =========================================================
     TEXT SEQUENCE
     ========================================================= */

  const showSequence = async (id) => {
    resetSequence();
    await nextFrame();

    for (let index = 0; index < characters.length; index += 1) {
      if (!isCurrentRun(id)) return;

      lines[index].classList.add('is-visible');

      await animateLineEnter(
        characters[index],
        index === 0
          ? FIRST_LINE_ENTER_STAGGER_MS
          : CHAR_ENTER_STAGGER_MS,
        id
      );

      if (!isCurrentRun(id)) return;

      lines[index].classList.add('is-settled');

      if (index < characters.length - 1) {
        await wait(LINE_GAP_MS, id);
      }
    }

    await wait(SEQUENCE_HOLD_MS, id);

    if (!isCurrentRun(id)) return;

    for (let index = 0; index < characters.length; index += 1) {
      if (!isCurrentRun(id)) return;

      lines[index].classList.remove('is-settled');
      lines[index].classList.add('is-exiting');

      await animateLineExit(characters[index], id);
    }

    if (!isCurrentRun(id)) return;

    sequence.classList.add('is-hidden');
    await nextFrame();
  };

  /* =========================================================
     BRAND
     ========================================================= */

  const showBrandBackground = async (id) => {
    intro.classList.add('is-brand');
    await wait(BRAND_TRANSITION_MS, id);
  };

  const hideBrandBackground = async (id) => {
    intro.classList.remove('is-brand');
    await wait(BRAND_TRANSITION_MS, id);
  };

  const showWordmark = async (id) => {
    resetWordmark();

    wordmarkStage.classList.add('is-visible', 'is-entering');

    await wait(WORDMARK_ANIMATION_MS, id);

    if (!isCurrentRun(id)) return;

    wordmarkStage.classList.remove('is-entering');
    wordmarkStage.classList.add('is-settled');

    await nextFrame();
  };

  const showSymbol = async (id) => {
    resetSymbol();

    symbolStage.style.opacity = '0';
    symbolStage.style.visibility = 'hidden';

    symbolStage.classList.add('is-visible', 'is-entering');

    void symbolStage.offsetWidth;

    symbolStage.style.opacity = '';
    symbolStage.style.visibility = '';

    await wait(SYMBOL_ANIMATION_MS, id);

    if (!isCurrentRun(id)) return;

    symbolStage.classList.remove('is-entering');
    symbolStage.classList.add('is-settled');

    await nextFrame();

    if (!isCurrentRun(id)) return;

    await wait(SYMBOL_HOLD_MS, id);

    if (!isCurrentRun(id)) return;

    symbolStage.classList.add('is-exiting');
    wordmarkStage.classList.add('is-exiting');

    await wait(SPLIT_EXIT_MS, id);

    if (!isCurrentRun(id)) return;

    symbolStage.style.transition = 'none';
    symbolStage.style.opacity = '0';
    symbolStage.style.visibility = 'hidden';

    wordmarkStage.style.transition = 'none';
    wordmarkStage.style.opacity = '0';
    wordmarkStage.style.visibility = 'hidden';

    resetSymbol();
    resetWordmark();

    void symbolStage.offsetWidth;
    void wordmarkStage.offsetWidth;

    await nextFrame();

    symbolStage.style.transition = '';
    symbolStage.style.opacity = '';
    symbolStage.style.visibility = '';

    wordmarkStage.style.transition = '';
    wordmarkStage.style.opacity = '';
    wordmarkStage.style.visibility = '';

    await nextFrame();
  };

  /* =========================================================
     LOOP
     ========================================================= */

  const runLoop = async (id) => {
    intro.classList.remove('is-brand');

    await wait(START_DELAY_MS, id);

    while (isCurrentRun(id)) {
      await showSequence(id);
      if (!isCurrentRun(id)) break;

      await showBrandBackground(id);
      if (!isCurrentRun(id)) break;

      await showWordmark(id);
      if (!isCurrentRun(id)) break;

      await showSymbol(id);
      if (!isCurrentRun(id)) break;

      await hideBrandBackground(id);
      if (!isCurrentRun(id)) break;

      resetAll();
      await nextFrame();
    }
  };

  /* =========================================================
     DESTROY / HARD RESET
     ========================================================= */

  const destroyProfileOverlay = () => {
    if (intro) {
      intro.remove();
    }

    intro = null;
    sequence = null;
    wordmarkStage = null;
    wordmark = null;
    symbolStage = null;
    symbol = null;
    lines = [];
    characters = [];
  };

  /* =========================================================
     OPEN / CLOSE
     ========================================================= */

  const openProfile = () => {
    if (active) return;

    if (!intro && !createProfileOverlay()) return;
    if (!attachOverlayToCurrentLayer()) return;

    active = true;
    runId += 1;

    clearTimers();
    cancelAnimations();
    resetAll();

    intro.classList.remove('is-brand');
    intro.classList.add('is-open');
    intro.setAttribute('aria-hidden', 'false');

    runLoop(runId);
  };

  const closeProfile = () => {
    if (!active || !intro) return;

    active = false;
    runId += 1;

    clearTimers();
    cancelAnimations();
    resetAll();

    intro.classList.remove('is-open', 'is-brand');
    intro.setAttribute('aria-hidden', 'true');

    destroyProfileOverlay();
  };

  /* =========================================================
     SWIPE SYNC
     ========================================================= */

  document.addEventListener('tikboo:swipe:commit', () => {
    if (!active) return;

    closeProfile();
  });

  /* =========================================================
     EXISTING BOTTOM NAV
     ========================================================= */

  document.addEventListener(
    'click',
    (event) => {
      const profileButton = event.target.closest('#profileBtn');

      if (profileButton) {
        event.preventDefault();
        event.stopImmediatePropagation();

        openProfile();
        return;
      }

      const homeButton = event.target.closest(
        '.nav button[aria-label="Home"]'
      );

      if (homeButton && active) {
        event.preventDefault();
        event.stopImmediatePropagation();

        closeProfile();
      }
    },
    true
  );

  /* =========================================================
     PUBLIC API
     ========================================================= */

  window.TikbooProfile = {
    open: openProfile,
    close: closeProfile,
    isOpen: () => active
  };

  /* =========================================================
     CLEANUP
     ========================================================= */

  window.addEventListener(
    'pagehide',
    () => {
      active = false;
      runId += 1;

      clearTimers();
      cancelAnimations();
      destroyProfileOverlay();
    },
    { once: true }
  );
})();
