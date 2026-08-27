// Build a believable photocopy of a book page, from text we already know.
//
// The point is a number: read this page, compare what came back with what went
// in, and you can tell whether a change to the pipeline helped or only felt
// like it. Everything here is deterministic — same seed, same speckles — so two
// runs differ only by the code under test.

/** Mulberry32: a small seeded PRNG, so a "random" scan is the same scan twice. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lay out justified text on a canvas the way a book page is set. */
/**
 * "**bold**" and "*italic*", stripped down to the word and how it is set.
 *
 * A run can span several words — "*ad extra*" is two — so the marks are read as
 * they are met and the face stays open until it is closed again. That is what a
 * typesetter does with them, and it is what the reader has to recover.
 */
let openFace = 'roman';
export function styleOf(word) {
  const opens = { '**': 'bold', '*': 'italic' };
  let style = openFace;
  let text = word;
  const lead = text.startsWith('**') ? '**' : text.startsWith('*') ? '*' : null;
  if (lead) {
    style = opens[lead];
    openFace = style;
    text = text.slice(lead.length);
  }
  const tail = text.match(/(\*\*|\*)([.,;:]?)$/);
  if (tail) {
    text = text.slice(0, -tail[0].length) + tail[2];
    openFace = 'roman';
  }
  return { text, style };
}

/** Start a fresh page: nothing is open at the top of one. */
export function resetFaces() {
  openFace = 'roman';
}

export function typeset(ctx, opts) {
  const { text, x, y, width, size, leading, font = 'Liberation Serif, Times New Roman, serif', indent = 0 } = opts;
  const faceFor = (style) =>
    `${style === 'italic' ? 'italic ' : ''}${style === 'bold' ? 'bold ' : ''}${size}px ${font}`;
  ctx.font = faceFor('roman');
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'alphabetic';

  const measure = (word) => {
    const was = openFace;
    const { text: plain, style } = styleOf(word);
    openFace = was;
    ctx.font = faceFor(style);
    const w = ctx.measureText(plain).width;
    ctx.font = faceFor('roman');
    return w;
  };
  const measureAll = (words) => words.reduce((sum, w) => sum + measure(w), 0) + (words.length - 1) * ctx.measureText(' ').width;

  const paragraphs = text.split('\n\n');
  let cursor = y;
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = [];
    let first = true;
    const room = () => width - (first ? indent : 0);
    for (let i = 0; i < words.length; i++) {
      const next = [...line, words[i]];
      if (measureAll(next) <= room() || !line.length) {
        line = next;
        continue;
      }
      lines.push({ words: line, indent: first ? indent : 0, justify: true });
      first = false;
      line = [words[i]];
    }
    if (line.length) lines.push({ words: line, indent: first ? indent : 0, justify: false });
  }

  for (const line of lines) {
    const left = x + line.indent;
    const room = width - line.indent;
    const slack = line.justify && line.words.length > 1 ? room - measureAll(line.words) : 0;
    const gap = line.words.length > 1 ? slack / (line.words.length - 1) : 0;
    let cx = left;
    for (const word of line.words) {
      const { text: plain, style } = styleOf(word);
      ctx.font = faceFor(style);
      ctx.fillText(plain, cx, cursor);
      cx += ctx.measureText(plain).width + gap;
      ctx.font = faceFor('roman');
      cx += ctx.measureText(' ').width;
    }
    cursor += leading;
  }
  return cursor;
}

/**
 * Put the page through what a photocopier and a phone camera do to it: a little
 * rotation, uneven lighting, softening, grain, dust, and a JPEG at the end.
 */
export function degrade(canvas, seed = 7, skew = 0.9) {
  const rand = rng(seed);
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');

  // Paper, then the page laid on it very slightly askew.
  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.save();
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((skew * Math.PI) / 180);
  ctx.filter = 'blur(0.7px)';
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  ctx.restore();
  ctx.filter = 'none';

  // The gutter shadow every book scan has: one side darker than the other.
  const shade = ctx.createLinearGradient(0, 0, out.width, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.30)');
  shade.addColorStop(0.22, 'rgba(0,0,0,0.05)');
  shade.addColorStop(1, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, out.width, out.height);

  // The black edge a photocopier leaves where the lid did not reach.
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, 14, out.height);
  ctx.fillRect(out.width - 9, 0, 9, out.height);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  // Grain, and a general loss of contrast.
  for (let i = 0; i < d.length; i += 4) {
    const noise = (rand() - 0.5) * 46;
    for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, d[i + c] * 0.9 + 16 + noise));
  }
  ctx.putImageData(img, 0, 0);

  // Dust on the glass: the specks that come back as stray letters.
  ctx.fillStyle = 'rgba(20,20,20,0.85)';
  for (let i = 0; i < 260; i++) {
    const r = 0.6 + rand() * 1.9;
    ctx.beginPath();
    ctx.arc(rand() * out.width, rand() * out.height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return out;
}

/** Wrap the pages in the smallest PDF that can hold them, so the real path is tested. */
export async function imageToPdf(canvases, quality = 0.55) {
  const pages = Array.isArray(canvases) ? canvases : [canvases];
  const jpegs = [];
  for (const canvas of pages) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    jpegs.push(new Uint8Array(await blob.arrayBuffer()));
  }

  const W = 612;
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (part) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n, body, extra) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (extra) {
      push(extra);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  // 1 catalog, 2 pages; then three objects per page: the page, its image, its
  // content stream.
  const pageId = (i) => 3 + i * 3;
  const imageId = (i) => 4 + i * 3;
  const contentId = (i) => 5 + i * 3;

  push('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(
    2,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`
  );
  pages.forEach((canvas, i) => {
    const H = Math.round((canvas.height / canvas.width) * W);
    object(
      pageId(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
        `/Resources << /XObject << /Im0 ${imageId(i)} 0 R >> >> /Contents ${contentId(i)} 0 R >>`
    );
    object(
      imageId(i),
      `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegs[i].length} >>\nstream`,
      jpegs[i]
    );
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    object(contentId(i), `<< /Length ${content.length} >>\nstream`, enc.encode(content));
  });

  const count = 2 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const all = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new Blob([all], { type: 'application/pdf' });
}
