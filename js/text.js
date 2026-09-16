// Emphasis, as it travels from the page to the screen.
//
// Italic and bold survive the whole pipeline as two private-use codepoints,
// paired like a tag. They cannot occur in real text, so no page can be mistaken
// for marked-up text, and nothing in between — the word repair, the hyphen
// resolver, the paragraph joiner — has to know they exist. The reader turns
// them into italic and bold; copying turns them into ordinary markdown.

export const EM = '';
export const STRONG = '';

/** The text as it reads, with the markers taken out. */
export const bareText = (text) => String(text || '').replaceAll(EM, '').replaceAll(STRONG, '');

/** Out of the app the markers mean nothing, so they leave as markdown. */
export const toMarkdown = (text) => String(text || '').replaceAll(STRONG, '**').replaceAll(EM, '*');

/**
 * Split marked-up text into the plain string and the runs of emphasis over it.
 *
 * Offsets are into the plain string — what the reader renders, and what a
 * highlight is measured against — so a highlight stays where it was put
 * whatever the markers around it do.
 */
export function emphasisRuns(text) {
  let plain = '';
  const runs = [];
  const open = {};
  for (const ch of String(text || '')) {
    if (ch === EM || ch === STRONG) {
      const kind = ch === EM ? 'em' : 'strong';
      if (open[kind] === undefined) {
        open[kind] = plain.length;
      } else {
        if (plain.length > open[kind]) runs.push({ start: open[kind], end: plain.length, kind });
        delete open[kind];
      }
      continue;
    }
    plain += ch;
  }
  // A marker left open by a page that ended mid-emphasis closes at the end.
  for (const [kind, start] of Object.entries(open)) {
    if (plain.length > start) runs.push({ start, end: plain.length, kind });
  }
  return { plain, runs };
}
