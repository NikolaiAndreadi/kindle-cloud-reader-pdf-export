const HOLD_MS = 2000;

export function bindHoldToDelete(button: HTMLButtonElement, remove: () => void): () => void {
  button.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function reset(): void {
    clearTimeout(timer);
    timer = undefined;
    button.classList.remove('holding');
  }

  function start(): void {
    if (timer !== undefined || button.disabled) return;
    button.classList.add('holding');
    timer = setTimeout(() => {
      reset();
      if (!button.disabled) remove();
    }, HOLD_MS);
  }

  button.addEventListener('pointerdown', (event) => {
    if (event.isPrimary && event.button === 0) start();
  });
  for (const event of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) {
    button.addEventListener(event, reset);
  }
  window.addEventListener('blur', reset);

  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!event.repeat) start();
  });
  button.addEventListener('keyup', reset);
  return reset;
}
