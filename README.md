# Hilton Crew Board

A gamified internal team tracker for Hilton crews — a single, self-contained web app
(no build step, no backend). Open `index.html` in a browser and it runs.

It's an English, Hilton-themed remake of an internal "team board" concept: a kanban
board wrapped in light gamification to keep a shift crew motivated.

## Features

- **World clocks** — live time for McLean HQ, London, Dubai and Singapore.
- **Shared focus timer** — a Pomodoro-style timer with 15 / 25 / 50-minute presets.
- **Road to the goal** — set a shared goal with a start date and deadline. The team
  marker travels a progress timeline toward the finish as linked tasks are closed, and
  **reward chests** (e.g. team lunch, gift cards, an early Friday) unlock at % milestones.
- **Kanban board** — add / rename / reorder / delete lists; add task cards. Each task has
  a title, notes, priority, urgency, project/area, assignee, a link, and a per-task timer.
- **Dust** — every task carries a "dust" rating for how much of a grind it is. Open dust
  piles up as little **dust bunnies** drifting along the bottom of the board; finishing a
  task sweeps its dust away.
- **Crew card (profile)** — display name, status, up to 3 avatar emoji, and a **shift
  streak** (with a pause toggle for leave/sick so the streak doesn't reset).
- **Achievements** — hospitality-flavored badges: First check-in, On a roll, Housekeeping
  hero, **Diamond status**, Deep clean, Spotless, Early check-in, **Night auditor**, Week on fire.

## Run it

It's a static file. Any of these work:

```bash
# just open it
open index.html            # macOS
xdg-open index.html        # Linux

# or serve it
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Notes

- State is saved in the browser's `localStorage`, so your board, goal, streak and
  achievements persist on that device/browser between visits.
- No external services or API keys are needed. The only network request is to Google
  Fonts for the display typefaces.
