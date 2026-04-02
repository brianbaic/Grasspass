# GrassPass

A lawn-care management app for tracking treatments, mowing, watering schedules, and fertilization programs. Built with Node.js and SQLite — no external database required.

## Features

- **Treatment Planner** — schedule and track fertilizer, herbicide, and other lawn treatments with optional recurring schedules
- **Mowing Log** — log mowing sessions with height, duration, and notes
- **Watering Events** — manual watering entries with optional Rachio sync
- **Zone Registry** — define lawn zones with area and grass type
- **Product Library** — track bags/jugs of product and coverage rates
- **Weather Integration** — automatic forecast display via Open-Meteo (no key required)
- **Hort or Hoax** — daily horticultural fact-checker game
- **Portable Export/Import** — backup and restore your data as JSON

## Requirements

- [Node.js](https://nodejs.org/) v18 or later

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (optional — see notes below)
cp .env.example .env
# Edit .env with your values

# 3. Start the server
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser and register an admin account on first run.

## Environment Variables

All environment variables are **optional**. The app runs fully without them using free fallback services.

| Variable | Purpose | Fallback |
|---|---|---|
| `MAPBOX_ACCESS_TOKEN` | Location autocomplete (higher quality) | Open-Meteo geocoding |
| `RACHIO_API_KEY` | Pre-fill Rachio API key server-side | User enters key in Settings |
| `PORT` | HTTP port | `3000` |

See `.env.example` for details.

## Data Storage

All data is stored locally in `_private/runtime/grasspass.db` (SQLite). No external database or cloud account is required. The `_private/runtime/` directory is excluded from version control via `.gitignore`.

## Scripts

```bash
npm start          # Start production server
npm run preview    # Start dev server with live reload
npm run smoke      # Run smoke tests against a temporary in-memory instance
```

## Tech Stack

- **Backend**: Node.js (stdlib HTTP + `better-sqlite3`)
- **Frontend**: Vanilla JS, HTML, CSS (no build step)
- **Database**: SQLite via `better-sqlite3`
- **Weather**: [Open-Meteo](https://open-meteo.com/) (free, no key required)
- **Maps**: [Mapbox](https://mapbox.com/) (optional, free tier available)
- **Irrigation**: [Rachio](https://rachio.com/) (optional, requires account)
