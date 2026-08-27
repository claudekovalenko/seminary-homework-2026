// The page the benchmark prints, and therefore the answer it grades against.
// Deliberately ordinary theological prose: long words, a hyphenated compound, a
// quotation, numbers, and footnotes carrying the usual citation clutter.

export const HEAD = 'THE DOCTRINE OF GOD';
export const FOLIO = '47';

export const BODY = `Theology does not begin with a question about God but with a confession that God has spoken. The order matters. If the enquiry came first, the God at the end of it would be whatever the enquiry could reach, and the reach of any creature is short. Because the confession comes first, the subject of theology is not a conclusion but a giver, and the discipline is answerable to him rather than to its own method.

This is why the older writers treated the divine attributes as a single doctrine and not as a list. Simplicity is not one perfection among many; it is the claim that in God there are no parts to be counted, so that his wisdom is his goodness and his goodness is his life. Whatever is said afterwards about mercy or justice is said of the same undivided act of being, and a theology that forgets this ends by dividing God against himself, setting a severe attribute over against a kind one as though the two were in negotiation.

The self-existence of God is the hinge of the whole. Everything else that exists holds its being on loan, and is therefore explained by something outside itself; God alone is explained by nothing, having no cause, no lack, and no becoming. Aquinas puts the point without ornament: whatever is moved is moved by another, and the series does not run backwards for ever. The doctrine is not speculation about a first item in a sequence. It is the confession that the one who addresses us in the gospel is not a member of the world he addresses.`;

// Marked up the way the bench typesets it: *italic*, **bold**. Both the plain
// text and the emphasis are graded, since a reading that loses the italics
// loses the difference between a title and a sentence about one.
export const EMPHASIS = `The distinction matters most where the words are least
remarkable. When Bavinck writes of the *communicable* attributes he does not
mean the ones God shares out, and when he writes *ad extra* he is not naming a
direction. The **whole** doctrine turns on that reading, and a translation which
flattens it into ordinary prose has not made it easier but emptier. Compare the
opening of *De Trinitate*, where Augustine says the same thing at greater
length and with more patience than we have.`;

export const NOTES = `1. Bavinck, Reformed Dogmatics, II.29-41; compare Turretin, Institutes, III.vii.

2. This is the burden of the whole of Webster's essay on the immensity of God, to which the argument above is indebted throughout.

3. Summa theologiae Ia.2.3, in the translation of the English Dominican Province (1920), 13-14.`;
