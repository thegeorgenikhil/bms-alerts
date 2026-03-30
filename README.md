# BookMyShow Bookings Open Telegram Alert System

A TypeScript/Node.js scraper that monitors BookMyShow for when a new movie's bookings open and sends Telegram notifications.

## Overview

Get notified when new movie bookings open up.

The system:
- Periodically checks BookMyShow for booking availability using cron
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

7. Set up a cron job:
```bash
crontab -e
```

Add one of the following lines depending on your desired frequency:

```bash
# Every 1 minute
* * * * * cd /path/to/bms-alerts && /bin/bash run.sh >> /path/to/bms-alerts/bms-cron-error.log 2>&1

# Every 2 minutes
*/2 * * * * cd /path/to/bms-alerts && /bin/bash run.sh >> /path/to/bms-alerts/bms-cron-error.log 2>&1

# Every 5 minutes
*/5 * * * * cd /path/to/bms-alerts && /bin/bash run.sh >> /path/to/bms-alerts/bms-cron-error.log 2>&1

# Every 10 minutes
*/10 * * * * cd /path/to/bms-alerts && /bin/bash run.sh >> /path/to/bms-alerts/bms-cron-error.log 2>&1

# Every 15 minutes
*/15 * * * * cd /path/to/bms-alerts && /bin/bash run.sh >> /path/to/bms-alerts/bms-cron-error.log 2>&1

# Every 30 minutes
*/30 * * * * cd /path/to/bms-alerts && /bin/bash run.sh >> /path/to/bms-alerts/bms-cron-error.log 2>&1

# Every hour
0 * * * * cd /path/to/bms-alerts && /bin/bash run.sh >> /path/to/bms-alerts/bms-cron-error.log 2>&1
```

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

### IMAX Movies

For IMAX versions of a movie, append `-imax-2d` to the `slug_name`. The movie code remains the same — only the slug changes.

For example, for *Project Hail Mary* in Kochi:
- Normal: `slug_name: "project-hail-mary"`
- IMAX 2D: `slug_name: "project-hail-mary-imax-2d"`

```
# Normal
https://in.bookmyshow.com/movies/kochi/project-hail-mary/ET00481564

# IMAX 2D
https://in.bookmyshow.com/movies/kochi/project-hail-mary-imax-2d/ET00481564
```

To track both versions, add two separate entries in `config.json` with the same `code` but different `slug_name` values.

## Usage

1. Configure your movies in `config.json`
2. Make sure your `.env` file is properly configured
3. Run the script:
```bash
pnpm start
# or
./run.sh
```

The script will:
- Monitor each movie in the configuration
- Send Telegram notifications when bookings open
- Update the theatre list in `config.json`
- Log all activities to `bms.log`
