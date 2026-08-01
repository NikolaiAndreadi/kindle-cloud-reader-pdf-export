function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

export const ui = {
  status: required<HTMLParagraphElement>('#status'),
  cache: required<HTMLParagraphElement>('#cache'),
  layout: required<HTMLParagraphElement>('#layout'),
  delay: required<HTMLInputElement>('#delay'),
  delayValue: required<HTMLOutputElement>('#delayValue'),
  jitter: required<HTMLInputElement>('#jitter'),
  jitterValue: required<HTMLOutputElement>('#jitterValue'),
  quality: required<HTMLSelectElement>('#quality'),
  split: required<HTMLInputElement>('#split'),
  open: required<HTMLButtonElement>('#open'),
  start: required<HTMLButtonElement>('#start'),
  stop: required<HTMLButtonElement>('#stop'),
  save: required<HTMLButtonElement>('#save'),
  clear: required<HTMLButtonElement>('#clear'),
  preview: required<HTMLButtonElement>('#preview')
};
