'use strict';

/* =========================================================
   TIKBOO — PROFILE INTRO LOOP
   ========================================================= */

(() => {
  /* =========================================================
     TIMING
     ========================================================= */

  const START_DELAY_MS = 2200;

  const FIRST_LINE_ENTER_STAGGER_MS = 95;
  const CHAR_ENTER_STAGGER_MS = 45;
  const CHAR_ENTER_ANIMATION_MS = 1100;
  const LINE_GAP_MS = 120;

  const SEQUENCE_HOLD_MS = 5000;

  const CHAR_EXIT_STAGGER_MS = 34;
  const CHAR_EXIT_ANIMATION_MS = 820;

  const WORDMARK_ANIMATION_MS = 1500;

  const SYMBOL_ANIMATION_MS = 2400;
  const SYMBOL_HOLD_MS = 5000;
  const SPLIT_EXIT_MS = 1100;

  const CHAR_ENTER_EASING = 'cubic-bezier(0.14, 0.92, 0.18, 1)';
  const CHAR_EXIT_EASING = 'cubic-bezier(0.4, 0, 0.6, 1)';

  /* =========================================================
     ELEMENTS
     ========================================================= */

  const intro = document.getElementById('profileIntro');
  const sequence = document.getElementById('profileSequence');
  const wordmarkStage = document.getElementById('profileWordmarkStage');
  const wordmark = document.getElementById('profileWordmark');
  const symbolStage = document.getElementById('profileSymbolStage');
  const symbol = document.getElementById('profileSymbol');

  const lines = [
    document.getElementById('profileLine1'),
    document.getElementById('profileLine2'),
    document.getElementById('profileLine3'),
    document.getElementById('profileLine4')
  ];

  if (!intro || !sequence || !wordmarkStage || !wordmark || !symbolStage || !symbol || lines.some((line) => !line)) return;

  /* =========================================================
     STATE
     ========================================================= */

  let destroyed = false;

  const timers = new Set();
  const animations = new Set();

  /* =========================================================
     HELPERS
     ========================================================= */

  const wait = (delay) =>
    new Promise((resolve) => {
      if (destroyed) {
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
      } catch (error) {
        /* no-op */
      }
    });

    animations.clear();
  };

  const nextFrame = () =>
    new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
      });
    });

  const waitForAnimation = (animation) =>
    new Promise((resolve) => {
      if (!animation) {
        resolve();
        return;
      }

      const finish = () => {
        animation.removeEventListener('finish', finish);
        animation.removeEventListener('cancel', finish);
        resolve();
      };

      animation.addEventListener('finish', finish, { once: true });
      animation.addEventListener('cancel', finish, { once: true });
    });

  /* =========================================================
     CHARACTER ENGINE
     ========================================================= */

  const getEnterOffset = () => window.innerWidth + 180;
  const getExitOffset = () => -(window.innerWidth + 180);

  const prepareLine = (line) => {
    const text = line.textContent.trim();

    line.setAttribute('aria-label', text);
    line.textContent = '';
    line.style.opacity = '1';
    line.style.transform = 'translate3d(0, 0, 0)';
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
      span.style.transform = `translate3d(${getEnterOffset()}px, 0, 0)`;
      span.style.transformOrigin = '50% 50%';
      span.style.willChange = 'transform, opacity';
      span.style.backfaceVisibility = 'hidden';
      span.style.webkitBackfaceVisibility = 'hidden';

      fragment.appendChild(span);
    });

    line.appendChild(fragment);

    return Array.from(line.querySelectorAll('.profile-intro__char'));
  };

  const characters = lines.map(prepareLine);

  /* =========================================================
     RESET
     ========================================================= */

  const resetCharacters = () => {
    cancelAnimations();

    characters.forEach((lineCharacters) => {
      lineCharacters.forEach((character) => {
        character.style.opacity = '0';
        character.style.transform = `translate3d(${getEnterOffset()}px, 0, 0)`;
        character.style.willChange = 'transform, opacity';
      });
    });
  };

  const resetSequence = () => {
    sequence.classList.remove('is-hidden');

    lines.forEach((line) => {
      line.classList.remove('is-visible', 'is-settled', 'is-exiting');
    });

    resetCharacters();
  };

  const resetWordmark = () => {
    wordmarkStage.hidden = false;
    wordmarkStage.classList.remove('is-visible', 'is-entering', 'is-settled', 'is-exiting', 'is-hidden');
  };

  const resetSymbol = () => {
    symbolStage.classList.remove('is-visible', 'is-entering', 'is-settled', 'is-exiting', 'is-hidden');
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
          transform: `translate3d(${getEnterOffset()}px, 0, 0)`
        },
        {
          opacity: 1,
          offset: 0.08
        },
        {
          opacity: 1,
          transform: 'translate3d(0, 0, 0)'
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
        character.style.transform = 'translate3d(0, 0, 0)';
        character.style.willChange = 'auto';
      },
      { once: true }
    );

    return animation;
  };

  const animateLineEnter = async (lineCharacters, staggerMs) => {
    for (const character of lineCharacters) {
      if (destroyed) return;

      animateCharacterEnter(character);
      await wait(staggerMs);
    }

    await wait(Math.max(0, CHAR_ENTER_ANIMATION_MS - staggerMs));
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
          transform: 'translate3d(0, 0, 0)'
        },
        {
          opacity: 1,
          offset: 0.72
        },
        {
          opacity: 0,
          transform: `translate3d(${getExitOffset()}px, 0, 0)`
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
        character.style.transform = `translate3d(${getExitOffset()}px, 0, 0)`;
        character.style.willChange = 'auto';
      },
      { once: true }
    );

    return animation;
  };

  const animateLineExit = async (lineCharacters) => {
    let lastAnimation = null;

    for (let index = 0; index < lineCharacters.length; index += 1) {
      if (destroyed) return;

      lastAnimation = animateCharacterExit(lineCharacters[index]);

      if (index < lineCharacters.length - 1) {
        await wait(CHAR_EXIT_STAGGER_MS);
      }
    }

    await waitForAnimation(lastAnimation);
  };

  /* =========================================================
     TEXT SEQUENCE
     ========================================================= */

  const showSequence = async () => {
    resetSequence();

    await nextFrame();

    for (let index = 0; index < characters.length; index += 1) {
      if (destroyed) return;

      lines[index].classList.add('is-visible');

      await animateLineEnter(
        characters[index],
        index === 0
          ? FIRST_LINE_ENTER_STAGGER_MS
          : CHAR_ENTER_STAGGER_MS
      );

      if (destroyed) return;

      lines[index].classList.add('is-settled');

      if (index < characters.length - 1) {
        await wait(LINE_GAP_MS);
      }
    }

    await wait(SEQUENCE_HOLD_MS);

    if (destroyed) return;

    for (let index = 0; index < characters.length; index += 1) {
      if (destroyed) return;

      lines[index].classList.remove('is-settled');
      lines[index].classList.add('is-exiting');

      await animateLineExit(characters[index]);
    }

    sequence.classList.add('is-hidden');

    await nextFrame();
  };

  /* =========================================================
     WORDMARK
     ========================================================= */

  const showWordmark = async () => {
    resetWordmark();

    wordmarkStage.classList.add('is-visible', 'is-entering');

    await wait(WORDMARK_ANIMATION_MS);

    if (destroyed) return;

    wordmarkStage.classList.remove('is-entering');
    wordmarkStage.classList.add('is-settled');

    await nextFrame();
  };

  /* =========================================================
     SYMBOL
     ========================================================= */

  const showSymbol = async () => {
    resetSymbol();

    symbolStage.classList.add('is-visible');

    await nextFrame();

    if (destroyed) return;

    symbolStage.classList.add('is-entering');

    await wait(SYMBOL_ANIMATION_MS);

    if (destroyed) return;

    symbolStage.classList.remove('is-entering');
    symbolStage.classList.add('is-settled');

    await nextFrame();

    if (destroyed) return;

    await wait(SYMBOL_HOLD_MS);

    if (destroyed) return;

    symbolStage.classList.add('is-exiting');
    wordmarkStage.classList.add('is-exiting');

    await wait(SPLIT_EXIT_MS);

    if (destroyed) return;

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

  const runLoop = async () => {
    await wait(START_DELAY_MS);

    while (!destroyed) {
      await showSequence();

      if (destroyed) break;

      await showWordmark();

      if (destroyed) break;

      await showSymbol();

      if (destroyed) break;

      resetAll();

      await nextFrame();
    }
  };

  /* =========================================================
     START
     ========================================================= */

  resetAll();
  runLoop();

  /* =========================================================
     CLEANUP
     ========================================================= */

  window.addEventListener(
    'pagehide',
    () => {
      destroyed = true;
      clearTimers();
      cancelAnimations();
    },
    { once: true }
  );
})();
