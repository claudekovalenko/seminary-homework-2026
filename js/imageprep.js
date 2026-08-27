// Clean a scanned page before the engine ever sees it.
//
// Tesseract is good at reading type and bad at arguing with a photocopier. It
// thresholds the whole page against one global level, so the dark band down the
// gutter of a book scan takes half a column with it; it reads slightly askew
// lines noticeably worse than straight ones; and it will faithfully report the
// dust on the glass as punctuation. None of that is the engine's fault, and all
// of it is fixable before it starts.
//
// Four passes, in the order that each makes the next one easier:
//
//   1. grey     — colour is noise here, and one channel is three times faster
//   2. deskew   — find the angle at which the lines of print line up, undo it
//   3. threshold— decide black or white locally, so a shadow is not a letter
//   4. despeckle— drop the marks too small to be type
//
// Everything works on typed arrays over one ImageData, and the local threshold
// is computed on a coarse grid and interpolated, so a 8-megapixel page costs a
// few megabytes of working memory rather than a few hundred.

/**
 * Below this, leave the page alone.
 *
 * Not because the tilt is imperceptible, but because rotating costs something:
 * resampling softens every edge, and the engine straightens each line of text
 * for itself anyway. Measured against a page read at a range of angles, a
 * degree is roughly where correcting starts paying for the blur it introduces —
 * under it the uncorrected page reads better, over it, much worse.
 */
const MIN_SKEW = 1;
/**
 * ...and above this it is not skew but a page put in sideways, which is a
 * different problem. Six degrees covers a photograph taken by hand, which is
 * the way most of these arrive.
 */
const MAX_SKEW = 6;
/** Sauvola's sensitivity. Lower keeps more ink, higher keeps less dirt. */
const SAUVOLA_K = 0.28;
/** The local window, as a fraction of page width: about a word and a half. */
const WINDOW_FRACTION = 0.06;
/** Dark marks smaller than this many pixels are dust, not type. */
const MIN_MARK_PIXELS = 5;

/** One 8-bit channel: what all of this actually operates on. */
function toGrey(data, width, height) {
  const grey = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < grey.length; i += 4, p++) {
    // Rec. 601 luma, integer-only.
    grey[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return grey;
}

/** Shrink by whole-pixel blocks, for the passes that only need the shape of the page. */
function shrink(grey, width, height, factor) {
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        const sy = y * factor + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          if (sx >= width) break;
          sum += grey[sy * width + sx];
          n++;
        }
      }
      out[y * w + x] = n ? sum / n : 255;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * The angle the lines of print sit at.
 *
 * Projected onto a horizontal axis, straight text gives a comb: dark where the
 * lines are, empty between them. Skewed text smears that comb flat. So shear
 * the page through a range of angles and keep the one whose profile has the
 * most contrast between its rows — that is the angle at which the lines line up.
 * Measured on a page shrunk to about 700 pixels wide, which is ample for an
 * angle and thirty times cheaper than the full page.
 */
export function estimateSkew(grey, width, height) {
  // Positive means the lines descend to the right, which is the direction a
  // canvas rotates for a positive angle — so undoing it is a rotation by -angle.
  const factor = Math.max(1, Math.round(width / 700));
  const small = shrink(grey, width, height, factor);
  const { data, width: w, height: h } = small;

  // Ink, as a number per pixel: how far below the page's own paper level it is.
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const paper = sum / data.length;
  const ink = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) ink[i] = Math.max(0, paper - data[i]);

  const rows = new Float64Array(h);
  const scoreAt = (degrees) => {
    rows.fill(0);
    // Undo the tilt rather than add to it: a line that descends to the right is
    // straightened by lifting its right-hand end, so the shear is subtracted.
    const slope = Math.tan((degrees * Math.PI) / 180);
    for (let x = 0; x < w; x++) {
      const shift = Math.round((x - w / 2) * slope);
      for (let y = 0; y < h; y++) {
        const ty = y - shift;
        if (ty < 0 || ty >= h) continue;
        rows[ty] += ink[y * w + x];
      }
    }
    // Sum of squares rewards a profile of sharp peaks over an even smear.
    let score = 0;
    for (let y = 0; y < h; y++) score += rows[y] * rows[y];
    return score;
  };

  let best = { angle: 0, score: scoreAt(0) };
  for (let a = -MAX_SKEW; a <= MAX_SKEW + 1e-9; a += 0.25) {
    const score = scoreAt(a);
    if (score > best.score) best = { angle: a, score };
  }
  // Refine around the winner, since a quarter of a degree still costs accuracy.
  for (let a = best.angle - 0.25; a <= best.angle + 0.25 + 1e-9; a += 0.05) {
    const score = scoreAt(a);
    if (score > best.score) best = { angle: a, score };
  }
  return Math.abs(best.angle) < MIN_SKEW ? 0 : best.angle;
}

/** The skew of what is currently on a canvas. Used to check the correction. */
export function skewOf(canvas, ctx) {
  const { width, height } = canvas;
  const image = ctx.getImageData(0, 0, width, height);
  return estimateSkew(toGrey(image.data, width, height), width, height);
}

/**
 * Whiten the black edge a copier leaves where the lid did not reach.
 *
 * Left alone it is the largest mark on the page, and the engine reads its ragged
 * inner edge as a column of punctuation. Only rows and columns that are almost
 * entirely dark are taken, working inward from each edge and stopping at the
 * first that is not — so a page whose text runs to the edge is left alone.
 */
export function clearBorders(grey, width, height, dark = 100) {
  const limit = { x: Math.floor(width * 0.06), y: Math.floor(height * 0.06) };
  const wipeRow = (y) => grey.fill(255, y * width, y * width + width);
  const wipeCol = (x) => {
    for (let y = 0; y < height; y++) grey[y * width + x] = 255;
  };
  const rowDark = (y) => {
    let n = 0;
    for (let x = 0; x < width; x++) if (grey[y * width + x] < dark) n++;
    return n / width;
  };
  const colDark = (x) => {
    let n = 0;
    for (let y = 0; y < height; y++) if (grey[y * width + x] < dark) n++;
    return n / height;
  };

  for (let y = 0; y < limit.y && rowDark(y) > 0.55; y++) wipeRow(y);
  for (let y = height - 1; y > height - 1 - limit.y && rowDark(y) > 0.55; y--) wipeRow(y);
  for (let x = 0; x < limit.x && colDark(x) > 0.55; x++) wipeCol(x);
  for (let x = width - 1; x > width - 1 - limit.x && colDark(x) > 0.55; x--) wipeCol(x);
}

/**
 * Black or white, decided by the neighbourhood rather than by the page.
 *
 * Sauvola's rule: a pixel is ink if it is darker than the local mean by a margin
 * that shrinks where the local contrast is low. That keeps faint type on a grey
 * page while refusing to turn an evenly grey page into a black one — which is
 * exactly the failure a global threshold has on a gutter shadow.
 *
 * The mean and deviation are computed on a grid every `step` pixels and read
 * back with bilinear interpolation. At a window of ~6% of the page the field is
 * far smoother than that grid, so nothing is lost but the memory.
 */
export function sauvola(grey, width, height) {
  const step = Math.max(2, Math.round(width / 256));
  const radius = Math.max(8, Math.round(width * WINDOW_FRACTION * 0.5));
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);

  // Integral images over the coarse grid, one for the sum and one for squares.
  const cols = gw + 1;
  const sum = new Float64Array(cols * (gh + 1));
  const sq = new Float64Array(cols * (gh + 1));
  for (let gy = 0; gy < gh; gy++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let gx = 0; gx < gw; gx++) {
      const v = grey[Math.min(height - 1, gy * step) * width + Math.min(width - 1, gx * step)];
      rowSum += v;
      rowSq += v * v;
      sum[(gy + 1) * cols + gx + 1] = sum[gy * cols + gx + 1] + rowSum;
      sq[(gy + 1) * cols + gx + 1] = sq[gy * cols + gx + 1] + rowSq;
    }
  }

  const gr = Math.max(1, Math.round(radius / step));
  const thresholds = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.max(0, gy - gr);
    const y1 = Math.min(gh, gy + gr + 1);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.max(0, gx - gr);
      const x1 = Math.min(gw, gx + gr + 1);
      const n = (x1 - x0) * (y1 - y0);
      const total = sum[y1 * cols + x1] - sum[y0 * cols + x1] - sum[y1 * cols + x0] + sum[y0 * cols + x0];
      const totalSq = sq[y1 * cols + x1] - sq[y0 * cols + x1] - sq[y1 * cols + x0] + sq[y0 * cols + x0];
      const mean = total / n;
      const variance = Math.max(0, totalSq / n - mean * mean);
      // R = 128: half the dynamic range, as in the paper.
      thresholds[gy * gw + gx] = mean * (1 + SAUVOLA_K * (Math.sqrt(variance) / 128 - 1));
    }
  }

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(gh - 1.001, y / step);
    const gy = Math.floor(fy);
    const wy = fy - gy;
    const gy1 = Math.min(gh - 1, gy + 1);
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gw - 1.001, x / step);
      const gx = Math.floor(fx);
      const wx = fx - gx;
      const gx1 = Math.min(gw - 1, gx + 1);
      const t =
        thresholds[gy * gw + gx] * (1 - wx) * (1 - wy) +
        thresholds[gy * gw + gx1] * wx * (1 - wy) +
        thresholds[gy1 * gw + gx] * (1 - wx) * wy +
        thresholds[gy1 * gw + gx1] * wx * wy;
      out[y * width + x] = grey[y * width + x] < t ? 0 : 255;
    }
  }
  return out;
}

/**
 * Drop the marks too small to be type.
 *
 * Conservative on purpose: a full stop at 300 dpi runs to thirty pixels or so,
 * and the dot of an i is its own mark, so anything close to that size is left
 * where it is. Only the handful of pixels that grain and dust leave behind go.
 */
export function despeckle(binary, width, height, minPixels = MIN_MARK_PIXELS) {
  const seen = new Uint8Array(width * height);
  const found = new Int32Array(minPixels + 1);
  // The frontier of a flood fill, not its area: even a page-sized blob keeps
  // only its edge here. Draining every component to the end matters — stopping
  // early would leave its tail to be picked up as a separate small mark and
  // quietly erased, which is how despeckling eats the serifs off type.
  const stack = [];
  let removed = 0;

  for (let start = 0; start < binary.length; start++) {
    if (binary[start] !== 0 || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let size = 0;
    while (stack.length) {
      const at = stack.pop();
      if (size <= minPixels) found[size] = at;
      size++;
      const x = at % width;
      const y = (at - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((!dx && !dy) || nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (binary[next] !== 0 || seen[next]) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    if (size > minPixels) continue;
    for (let i = 0; i < size; i++) binary[found[i]] = 255;
    removed++;
  }
  return removed;
}

/**
 * Straighten, threshold and clean one rendered page, in place on its canvas.
 * Returns what it did, so the run can report it and the tests can assert it.
 */
export function prepare(canvas, ctx, { deskew = true, threshold = true, clean = true } = {}) {
  const { width, height } = canvas;
  let image = ctx.getImageData(0, 0, width, height);
  let grey = toGrey(image.data, width, height);

  let angle = 0;
  if (deskew) {
    angle = estimateSkew(grey, width, height);
    if (angle) {
      // Rotate the page itself rather than the pixels by hand: the canvas does
      // it with proper interpolation, and a rotation is only worth doing well.
      const spare = document.createElement('canvas');
      spare.width = width;
      spare.height = height;
      const sctx = spare.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(canvas, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate((-angle * Math.PI) / 180);
      ctx.drawImage(spare, -width / 2, -height / 2);
      ctx.restore();
      spare.width = spare.height = 0;
      image = ctx.getImageData(0, 0, width, height);
      grey = toGrey(image.data, width, height);
    }
  }

  clearBorders(grey, width, height);

  let removed = 0;
  const out = threshold ? sauvola(grey, width, height) : grey;
  if (threshold && clean) removed = despeckle(out, width, height);

  const data = image.data;
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    data[i] = data[i + 1] = data[i + 2] = out[p];
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return { angle, specks: removed };
}
