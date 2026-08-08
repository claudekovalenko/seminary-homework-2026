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

## Running it

It is plain HTML/CSS/ES modules — no build step, no dependencies. But it does
use `fetch` and a service worker, so it has to be *served*, not opened as a
`file://` URL:

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
  "classTime": "11:00",             // used to time the "due before class" deadline
  "sessions": [
    {
      "date": "2026-09-01",         // the class meeting; work is due before it
      "topic": "Genitive",
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

## Things worth checking against the paper syllabi

- **Class times** are placeholders (Theology 09:00, Greek 11:00) — they only
  affect the hour a due-date reminder considers "passed". Set the real ones in
  `classTime`.
- **Greek, 10/27** — the syllabus reads *"James Matt 2:19–23"*. Recorded as
  Matt 2:19–23 and flagged in the app; worth confirming with the professor.
- **Page estimates** for chapter-only readings (Webster, Jamieson & Wittman,
  *Christian Dogmatics*, Calvin, GDNTG, and the like) are educated guesses.
  Tap any page count in the app to replace it with the real number — the
  correction is saved and the plan re-splits around it.
- **Reading pace** defaults to 3 min/page, 5 min per Greek verse, 5 min per
  English Bible chapter. Adjust in Settings once you know your real speed;
  every number in the app follows from these.
