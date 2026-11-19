# BookMyShow Bookings Open Telegram Alert System

A TypeScript/Node.js scraper that monitors BookMyShow for when a new movie's bookings open and sends Telegram notifications.

## Overview

Get notified when new movie bookings open up.

The system:
- Checks BookMyShow for booking availability every few seconds, kept running by pm2
- Sends immediate Telegram notifications when bookings open
- Provides direct booking links in notifications
- Supports multiple movies and cities through a simple JSON configuration

## Prerequisites

- Node.js 20 or higher
- pnpm
- Telegram Bot Token and Chat ID (for sending notifications)

## Setup

1. Clone the repository:
```bash
git clone https://github.com/thegeorgenikhil/bms-alerts
cd bms-alerts
```

2. Install dependencies:
```bash
pnpm install
```

3. Install the browser for Puppeteer:
```bash
pnpm browser:install
```

4. Build the project:
```bash
pnpm build
```

5. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your Telegram bot token and chat ID
```

6. Configure movies in `config.json` (see [Configuration](#configuration))

7. Install [pm2](https://pm2.keymetrics.io/) and deploy:
```bash
npm install -g pm2
./deploy.sh
```

`deploy.sh` installs dependencies, builds, and starts the watcher under pm2 as `bms-alerts` (or restarts it if it is already running). Run it again any time to redeploy.

To bring the watcher back after a reboot, run `pm2 startup` once and follow the command it prints.

## Configuration

### Movie Configuration (config.json)

Movies are configured in `config.json`. Each movie entry contains:

```json
{
    "name": "Movie Name",
    "slug_name": "movie-name-slug",
    "code": "ET00XXXXX",
    "city": "city-name",
    "date": "YYYYMMDD",
    "language": "english",
    "found": false,
    "theatres": {}
}
```

### How to Add New Movies

1. Visit the movie's BookMyShow page. The URL will look like:

```
https://in.bookmyshow.com/movies/[city]/[slug_name]/[code]
```

2. Extract the following from the URL:

For example:
```
https://in.bookmyshow.com/movies/kochi/prathichaya/ET00491497

- city: kochi
- slug_name: prathichaya
- code: ET00491497
```

3. Add the `date` (YYYYMMDD format) for the show date you want to track.

4. Add the `language` in lowercase, as BookMyShow spells it in the URL (`english`, `hindi`, `malayalam`, ...).

### Formats (2D, 3D, IMAX, 4DX, ...)

A movie code on its own only lists one format — e.g. the plain URL for an "English - 2D" code shows nothing when only IMAX or Infinity Vision shows are open. When `language` is set, the checker opens

```
https://in.bookmyshow.com/movies/[city]/[slug_name]/buytickets/[code]/[date]?etCodes=*&language=[language]
```

which lists every format of that language, so one entry covers all of them and any code of the movie works. Each format gets its own Telegram message, with the format in brackets after the movie name:

```
🎬 New Show Added!

🎥 Movie: Ramayana (HINDI IMAX 3D)
📅 Date: 17-11-2026
🏟️ Theatre: Cinepolis: Centre Square, Kochi
🕐 Shows: 4
⏰ 11:30 AM IMAX, 03:35 PM IMAX, 07:40 PM IMAX, 11:45 PM IMAX
```

To track more than one language, add one entry per language. If `language` is omitted, only the default format of that `code` is checked and the message has no format after the movie name.

## Usage

```bash
./deploy.sh              # deploy or redeploy
pm2 status bms-alerts    # is it running?
pm2 logs bms-alerts      # process output and crashes
pm2 restart bms-alerts   # restart without rebuilding
pm2 stop bms-alerts      # stop watching
```

Activity (new shows, errors, heartbeats) is logged to `bms.log`. Editing `config.json` needs no restart.

## Watch mode

pm2 runs `node dist/index.js --watch`:

- One browser tab stays open on BookMyShow. Each check fetches the booking page's HTML from inside that tab and reads the showtimes BookMyShow server-renders into it, instead of rendering the page. All movies are checked in parallel; a full cycle takes well under a second.
- Checks repeat every `POLL_INTERVAL_SECONDS` (default `5`, set it in `.env`, then run `./deploy.sh` or `pm2 restart bms-alerts --update-env`).
- `config.json` is re-read every cycle, so you can add or remove movies without restarting.
- `bms.log` only gets a line when something changes, plus a heartbeat every 10 minutes.
- If checks keep failing (blocked, network down), it backs off, reopens the browser, and sends one Telegram warning after a few minutes of failures.

`pnpm start` runs a single check and exits.

To preview without sending anything, run `DRY_RUN=1 pnpm start`: notifications are printed to the terminal and `config.json` is left untouched.
