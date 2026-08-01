const NOTICE_ID = 'personal-reader-export-status';
const NOTICE_MS = 5000;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
}

export function notify(text: string): void {
  clearTimer();
  let node = document.getElementById(NOTICE_ID);
  if (!node) {
    node = document.createElement('div');
    node.id = NOTICE_ID;
    Object.assign(node.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: 2147483647,
      padding: '10px 14px', borderRadius: '7px', background: '#171717',
      color: '#fff', font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 3px 14px #0007',
      maxWidth: '340px'
    });
    (document.body || document.documentElement).appendChild(node);
  }
  node.textContent = text;
}

export function removeNoticeLater(): void {
  clearTimer();
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    document.getElementById(NOTICE_ID)?.remove();
  }, NOTICE_MS);
}
