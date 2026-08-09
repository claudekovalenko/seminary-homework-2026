// Build vendor/lexicon/en.txt — the word list js/lexicon.js corrects OCR against.
//
//   node tools/lexicon.mjs <wikipedia-word-frequency.txt> <words_alpha.txt>
//
// Sources (fetched once, not committed — they are ~39 MB together):
//   https://raw.githubusercontent.com/IlyaSemenov/wikipedia-word-frequency/master/results/enwiki-2023-04-13.txt
//   https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt
//
// Neither alone is enough. A plain dictionary says "hete" is a word, so it would
// never be corrected to "here"; a frequency list alone omits the vocabulary a
// theology reader is full of — "incomprehensibility" appears 103 times in all of
// Wikipedia. So: a word is kept if it is a real dictionary word that occurs at
// all in practice, or common enough that it is worth knowing whether or not a
// dictionary lists it (names, mostly). Frequency is kept alongside, because
// every correction is a judgement about which reading is likelier.
//
// The file is front-coded — each line stores how many leading characters it
// shares with the line before it — which nearly halves it before compression.
// Frequencies live on their own first line, one character per word, because a
// frequency character mixed in among the letters would be impossible to tell
// apart from them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [freqPath, dictPath] = process.argv.slice(2);
if (!freqPath || !dictPath) throw new Error('usage: node tools/lexicon.mjs <freq.txt> <words_alpha.txt>');

const MIN_DICT = 20; // a dictionary word must actually turn up this often
const MIN_ANY = 479; // ...or be common enough to stand on its own
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

// Terms a divinity library is full of and a general word list has never heard
// of. They are here to be recognised, not to be suggested: a word the corrector
// knows is one it will leave alone, which is the whole point — without this,
// "analogia" gets helpfully rewritten to "analogic". The frequency given is
// deliberately low, so none of these can ever win as a correction of something
// else.
const SUPPLEMENT = `
adiaphora aetiology agraphon anhypostatic anhypostasis apokatastasis apophaticism
autotheos catechetical cataphatic christocentric christotelic circumincession
communicatio consubstantial creatio deutero deuterocanonical diachronic
dogmatics ectype ectypal enhypostatic enhypostasis epexegetical epiousios
equivocity eschaton exitus extracalvinisticum federalism fideism filioque
haustafel hapax hendiadys hermeneutic hesychastic heilsgeschichte homoiousios
homoousios hypostatically idiomata immanentize impassibility inseparability
kenotic kerygmatic koine logia missio monergism monergistic monothelite
paraenesis paraenetic pactum pericope perichoretic pneumatological
prolegomena prosopon protoevangelium protology reditus regula
sacramentum scriptura sensus septuagintal soteriological subsistit
supralapsarian sublapsarian infralapsarian synergism synoptic testamenta
theandric theologia theopneustos theosis traducianism tritheism typology
usus verbum vestigia vinculum voluntarism
ablaut aktionsart anarthrous aorist articular asyndeton attributive
circumstantial cohortative constative deponent enclitic epexegetic gnomic
ingressive iterative middle nominative genitive dative accusative vocative
optative paratactic hypotactic periphrastic pluperfect proclitic
substantival telic
nihilo esse dei verbi gratia sola fide solus christus soli deo gloria
extra nos coram deo simul iustus peccator ordo salutis
behold begat brethren conies doth durst hallowed hast hath hearken hither
holpen howbeit kine knowest lovingkindness mercies nigh peradventure propitiation
saith shalt shew shewed shewing sith smite smote sojourn sojourner
succour suffer thee thence thereof thereto thereunto thine thither thou thy
travail unto verily vouchsafe wast whence wherefore wherein whereof
whither whosoever wilt wist wot ye yea
fora nota sensu ibid passim viz supra infra ante circa cetera
seriatim mutatis mutandis prima facie qua quoad
`
  .split(/\s+/)
  .filter(Boolean);

// High enough that the corrector treats these as settled words and never
// second-guesses them; far too low for one to be proposed as a correction.
const SUPPLEMENT_FREQ = 2000;

const dict = new Set(readFileSync(dictPath, 'utf8').split('\n').map((w) => w.trim()).filter(Boolean));

const freq = new Map();
for (const line of readFileSync(freqPath, 'utf8').split('\n')) {
  const [word, count] = line.split(' ');
  if (!word || !count) continue;
  if (!/^[a-z][a-z'-]*$/.test(word) || word.length > 22) continue;
  freq.set(word, Number(count));
}

for (const word of SUPPLEMENT) freq.set(word, Math.max(SUPPLEMENT_FREQ, freq.get(word) || 0));

const keep = [...freq.keys()]
  .filter((w) => freq.get(w) >= MIN_ANY || (freq.get(w) >= MIN_DICT && (dict.has(w) || SUPPLEMENT.includes(w))))
  .sort();

// Counts span eight orders of magnitude, and only their ratio ever matters, so a
// log scale in one printable character is all the precision that is called for.
// Each step is a factor of 2^(1/3), near enough to a quarter.
const code = (n) => String.fromCharCode(35 + Math.min(88, Math.max(0, Math.round(Math.log2(n) * 3))));

const codes = keep.map((w) => code(freq.get(w))).join('');

const lines = [];
let prev = '';
for (const word of keep) {
  let shared = 0;
  while (shared < prev.length && shared < word.length && shared < 35 && prev[shared] === word[shared]) shared++;
  lines.push(B36[shared] + word.slice(shared));
  prev = word;
}

const out = `${codes}\n${lines.join('\n')}`;
mkdirSync(resolve(ROOT, 'vendor/lexicon'), { recursive: true });
writeFileSync(resolve(ROOT, 'vendor/lexicon/en.txt'), out);
console.log(`vendor/lexicon/en.txt  ${keep.length} words, ${(out.length / 1024).toFixed(0)} KB`);
