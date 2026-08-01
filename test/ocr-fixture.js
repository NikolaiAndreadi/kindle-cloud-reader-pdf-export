const LINES = [
  'CHAPTER ONE',
  '',
  'It was a bright cold day in April, and the clocks',
  'were striking thirteen. Winston Smith, his chin',
  'nuzzled into his breast in an effort to escape the',
  'vile wind, slipped quickly through the glass doors.',
  '',
  'The hallway smelt of boiled cabbage and old rag',
  'mats — “again”, he said, quoting nobody at all.',
  '',
  '                          14'
];

const canvas = document.getElementById('page');
const status = document.getElementById('status');
const out = document.getElementById('out');

function draw() {
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111';
  context.font = '38px Georgia, serif';
  context.textBaseline = 'alphabetic';
  let y = 260;
  for (const line of LINES) {
    context.fillText(line, 150, y);
    y += 62;
  }
}

async function run() {
  status.textContent = 'loading the engine…';
  out.textContent = '';
  const asset = (name) => `../vendor/tesseract/${name}`;
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: asset('worker.min.js'),
    corePath: asset('tesseract-core-simd-lstm.wasm.js'),
    langPath: '../vendor/tesseract',
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (message) => { status.textContent = `${message.status} ${Math.round(message.progress * 100)}%`; }
  });
  await worker.setParameters({
    tessedit_pageseg_mode: '3',
    preserve_interword_spaces: '1'
  });

  const started = performance.now();
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
  const elapsed = Math.round(performance.now() - started);

  const words = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          words.push({
            t: word.text, c: Math.round(word.confidence), box: word.bbox,
            line: line.bbox, base: line.baseline, row: line.rowAttributes
          });
        }
      }
    }
  }

  const expected = LINES.join(' ').replace(/\s+/g, ' ').trim();
  const got = words.map((word) => word.t).join(' ').replace(/\s+/g, ' ').trim();
  const report = [
    `${words.length} words in ${elapsed} ms`,
    `expected: ${expected}`,
    `got:      ${got}`,
    got === expected ? 'EXACT MATCH' : 'DIFFERS — compare the two lines above',
    '',
    ...words.slice(0, 8).map((word) =>
      `${word.t.padEnd(12)} conf ${String(word.c).padStart(3)}  word ${JSON.stringify(word.box)}\n${''.padEnd(19)}line ${JSON.stringify(word.line)} base ${JSON.stringify(word.base)} row ${JSON.stringify(word.row)}`)
  ].join('\n');

  out.textContent = report;
  out.className = got === expected ? 'ok' : 'bad';
  status.textContent = 'done';
  console.log('[ocr-fixture]', report);
  await worker.terminate();
}

draw();
document.getElementById('run').addEventListener('click', () => {
  run().catch((error) => {
    status.textContent = 'failed';
    out.className = 'bad';
    out.textContent = String(error && error.stack || error);
    console.error('[ocr-fixture]', error);
  });
});
