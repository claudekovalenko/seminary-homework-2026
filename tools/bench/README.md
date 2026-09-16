# tools/bench — how well does it read?

The OCR pipeline is a stack of judgement calls: how hard to threshold, when to
straighten a page, when a small line is a footnote and when it is a page number.
Every one of them is easy to argue about and impossible to settle by looking at
one page and squinting. So they are settled here instead.

`page.js` prints a page of known text — justified body type, a running head, a
folio, footnotes in small type — then puts it through what a library
photocopier and a phone camera do to it: a tilt, a gutter shadow, the black edge
where the lid did not reach, softening, grain, dust on the glass, and a JPEG at
the end. Everything is seeded, so the same page comes back every time and two
runs differ only by the code under test. `truth.js` is what it printed, and
therefore the answer.

```sh
node tools/bench/run.mjs "what I changed"     # a photocopy, tilted 0.9 degrees
BENCH_SKEW=3 node tools/bench/run.mjs         # a more crooked one
BENCH_MODE=columns node tools/bench/run.mjs   # two columns, where reading order matters
BENCH_MODE=clean node tools/bench/run.mjs     # a clean scan, to check for harm
BENCH_LANGS=eng node tools/bench/run.mjs      # without the Greek model
node tools/bench/inspect.mjs                  # why a page came out that way
```

The scan runs print two pages: an English page, and a page of Koine — single
words inside an English sentence, then a quotation of its own — scored on its
Greek alone.

It prints character and word error rates for the body and the footnotes
separately, because they fail differently: the body suffers from bad
thresholding, the footnotes from being mistaken for something else. Emphasis is
scored on its own terms — how many of the words actually set in italic and bold
came back marked, and how many ordinary words were marked by mistake.

It needs `playwright-core` (`npm i playwright-core`) and a Chromium to point it
at, since Tesseract and the canvas passes are browser code. Nothing in `js/`
depends on any of this; it is a measuring instrument, not part of the app.

Numbers from the run that introduced the cleaning pass. Character error rate on
the body text, then on the footnotes:

| page                          | before          | after           |
| ----------------------------- | --------------- | --------------- |
| photocopy, tilted 0.9 degrees | 18.78% / 70.03% | 0.26% / 3.26%   |
| photocopy, tilted 3 degrees   | 25.95% / 100%   | 0.26% / 3.58%   |
| two columns                   | 82.23% / 100%   | 5.54% / 28.34%  |
| a clean scan                  | 2.09% / 6.51%   | 0.00% / 2.28%   |
| a page of Greek               | 100%            | 5.36%           |

A footnote rate of 100% means the block was not found at all and its text ended
up in the body, which is why the body rate beside it is so high.

Emphasis, on the same photocopy: 5 of 5 italic words found and 1 of 1 bold, with
nothing else marked. There is no "before" to compare that against — the engine
reports every word as ordinary, so before this there was nothing at all. The
same goes for the Greek page, where "before" is every Greek character on it
lost; adding the model leaves the English page's own score untouched.
