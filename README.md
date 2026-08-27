# Seminary Homework

A small offline-first PWA for the Fall 2026 course load. Add it to your phone's
home screen and it answers three questions: **what is due, how much reading is
that, and how much of it should I do today.**

- **Today** — the day's reading target in minutes, the exact pages to read, and
  everything falling due inside your warning window (7 days by default).
- **Plan** — for each course's next class: total pages, total time, and a
  day-by-day split of the reading. Long page ranges are cut at real page
  numbers, so a day says *"Bavinck pp. 530–546"*, not *"a third of Bavinck"*.
- **Schedule** — the whole term, both syllabi, expandable per class.
- **Settings** — reminders, study days, and your reading pace.

Tick items off as you go. The plan recalculates every time, so falling a day
behind quietly re-spreads the rest over the days you have left instead of
leaving you to work it out.

## Downloading it

Two ways to get it, depending on what you want:

**`dist/seminary.html`** — the whole app as one 75 KB file. Save it, open it,
done: no server, no install, no network. It carries the syllabus, the planner
and your ticked-off progress (kept in that browser's local storage). The one
thing it cannot do is notifications — browsers block those for pages opened out
of the filesystem — and the app says so in Settings when it detects it is
running that way. Rebuild it after any change with:

```sh
node tools/build.mjs
```

**The repo itself** — clone it, or use GitHub's *Code → Download ZIP*. This is
what you want for the full PWA: home-screen install, offline caching and
reminders, once it is served over https (see below).

## Running it

The source is plain HTML/CSS/ES modules with no dependencies. `tools/build.mjs`
concatenates `js/*.js` into `js/bundle.js`, which is what `index.html` actually
loads, versioned as `bundle.js?v=vN`. **Run it after editing anything in `js/`**
— the browser never sees the individual modules.

One file instead of a module graph is deliberate: it gives the whole app a
single cache key, so bumping the version invalidates all of it at once. When
index.html loaded six separate modules, a stale service worker could serve a
fresh page beside stale code and the app would half-update.

It needs to be *served*, not opened as a `file://` URL:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Putting it on your home screen

Push this branch and turn on GitHub Pages for the repo
(**Settings → Pages → Source: GitHub Actions**). The included workflow
publishes the site on every push to `main`. Then:

- **iPhone/iPad** — open the page in Safari → Share → *Add to Home Screen*.
  This step is required before notifications will work at all on iOS.
- **Android** — Chrome will offer *Install app*, or use the ⋮ menu.

## Updating a device that will not update

Every release bumps `BUILD` in `js/app.js` and `CACHE` in `sw.js` together.
If a phone is still showing an old version, open the site with the version
query — `.../seminary-homework-2026/?v=v6`. The query misses the old worker's
cache entirely, so the page and the bundle both come from the network, and the
new worker then replaces the old one for good. **Settings → App version** shows
what a device is really running, and has a button that clears the offline copy
outright.

## About the reminders

There is no server behind this app, which keeps it free and private but does
limit notifications:

- Reminders fire at **7 days, 3 days, 1 day and on the due date** (the 7 is the
  "warn me this far ahead" setting).
- They are raised **when the app runs** — when you open it, when you switch back
  to it, and on Android/Chrome when the browser wakes it in the background
  (roughly twice a day, via Periodic Background Sync).
- On iOS there is no background wake-up. The app must be installed to the home
  screen for notifications to be permitted at all, and reminders arrive the
  next time you open it. Opening it once a day is enough to never be surprised.
- Nothing is missed either way: a reminder that came due while you were away is
  still shown the next time the app runs, and each one fires only once.

True scheduled push (arriving with the app closed) needs a push server. That is
the natural next step if the current behaviour is not enough — as is the Google
Calendar export you mentioned.

## Your data

Progress, page corrections and settings live in `localStorage` on the device —
nothing is uploaded. **Settings → Export progress** writes a JSON file you can
import on another device or keep as a backup.

## Editing the syllabus

Everything the app knows lives in [`data/courses.json`](data/courses.json).
Adding a third course means appending one more object to `courses`.

```jsonc
{
  "id": "greek",                    // unique, stable — progress keys are built from it
  "name": "Intermediate Greek",
  "short": "Greek",
  "color": "#1f9d78",
  "meetingDay": "Tuesday",
  "classTime": null,                // null = unconfirmed; app assumes 18:00 and says so
  "sessions": [
    {
      "date": "2026-09-01",         // the class meeting; work is due before it
      "topic": "Genitive",
      "mode": "in-person",          // or "online" / "hybrid"; omit if unknown
      "readings": [
        {
          "order": 1,
          "source": "Bavinck, Reformed Dogmatics",
          "ref": "29–41; 97–110",   // shown to you
          "ranges": [[29, 41], [97, 110]],  // real page numbers -> exact daily splits
          "driver": true,           // the underlined "drives discussion" reading
          "format": "pdf"
        },
        { "order": 2, "source": "Webster, GWM", "ref": "ch. 3",
          "estPages": 15, "estimated": true },        // guessed length, shown with a ~
        { "order": 3, "source": "Romans 3:19–31 in Greek", "ref": "13 verses",
          "unit": "verses", "verses": 13 }            // paced per verse, not per page
      ],
      "bible": { "ref": "Deut 6; Mark 12", "chapters": 2 },
      "links": [                                            // somewhere to go and DO the work
        { "label": "Nominative — SPA + AAAH", "tag": "mnemonics",
          "url": "https://claudekovalenko.github.io/going-deeper-greek-concepts/#/learn/nominative",
          "note": "shown on hover" }
      ],
      "assignments": [
        { "title": "T&D: John 1:2", "type": "translation" },
        { "title": "Quiz: ch. 2", "type": "quiz", "atClass": true },
        { "title": "Final Paper", "type": "paper",
          "due": "2026-10-08", "dueTime": "23:59",
          "effortMinutes": 720, "startPlanning": "2026-09-08" }  // long-run work
      ]
    }
  ]
}
```

Rules of thumb:

- `ranges` beats everything — give real page numbers wherever the syllabus does
  and the daily split becomes exact.
- `estPages` + `estimated: true` is a guess. It shows as `~15 pp.` with an
  *estimated* tag, and the app still splits it (*"pages 1–5 of 15"*).
- An assignment with `effortMinutes` and `startPlanning` is treated as a project:
  instead of landing in the week it is due, it is paced from the start date, and
  you log time against it from the Today screen.
- Deleting or reordering readings inside a session shifts the keys that progress
  is stored under, so old ticks may land on the wrong line. Adding at the end is
  safe.

## Class times

Neither course's meeting time is confirmed yet, so the app **assumes 6:00 pm on
Tuesdays** and labels it as an assumption everywhere it shows (`06:00 PM
(assumed)`, and a `?` next to deadline times). Set the real times under
**Settings → Class times** the moment you know them — no file editing needed.

The time is not cosmetic. It decides two things:

- when a due-date reminder counts as passed, and
- whether class day itself is still available to read in. For an evening class
  it is, so the plan uses it — which is why the heaviest Theology week drops
  from ~54 to ~45 minutes a day under the evening assumption.

If a course turns out to meet in the morning, set it to e.g. `09:00` and the
plan stops counting class day and re-spreads over the days before it.

## In-person vs online

Each session can carry `"mode": "in-person"`, `"online"` or `"hybrid"`. The app
shows it as a badge on the Plan card and next to the topic in the Schedule.
Nothing carries a mode yet — send me the in-person/online schedule and it is a
data-only change to `data/courses.json`.

## Study links

The Files tab is where you go to *read* the work. Sometimes what you need is
somewhere to go and *do* it — a drill, a quiz, a vocabulary tool. Any course or
any session can carry a `links` array in `data/courses.json`:

```jsonc
"links": [
  { "label": "Case mnemonics", "tag": "mnemonics", "note": "shown on hover",
    "url": "https://claudekovalenko.github.io/going-deeper-greek-concepts/#/map" }
]
```

Nothing is inherited, and the difference is the point:

- **On a course** — shows every week, on the Plan card and under *Drill it* on
  Today. Use it for the thing you always want one tap away.
- **On a session** — shows in that session on the Schedule, and under *Drill it*
  from your warning window before the class until a week after it. The week
  *after* a class is when you are revising what it covered, which is why the
  window runs both ways.

Links open in a new tab, and carry a `?from=` pointing back here, so an app that
understands it can offer a way back to where you started rather than dropping
you on its own home screen.

Greek currently links to [going-deeper-greek-concepts][gd], the mnemonics and
drills for the case uses — the acrostics from the Map, the flashcards from
Drill, and the nominative/accusative cards from the 25 August session.

[gd]: https://github.com/claudekovalenko/going-deeper-greek-concepts

## Things worth checking against the paper syllabi

- **Greek, 10/27** — the syllabus reads *"James Matt 2:19–23"*. Recorded as
  Matt 2:19–23 and flagged in the app; worth confirming with the professor.
- **Page estimates** for chapter-only readings (Webster, Jamieson & Wittman,
  *Christian Dogmatics*, Calvin, GDNTG, and the like) are educated guesses.
  Tap any page count in the app to replace it with the real number — the
  correction is saved and the plan re-splits around it.
- **Reading pace** defaults to 3 min/page, 5 min per Greek verse, 5 min per
  English Bible chapter. Adjust in Settings once you know your real speed;
  every number in the app follows from these.
