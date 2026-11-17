import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const CONFIG_FILE = path.join(ROOT_DIR, "config.json");
const LOG_FILE = path.join(ROOT_DIR, "bms.log");

interface MovieDetails {
  name: string;
  slug_name: string;
  code: string;
  city: string;
  date: string;
  // Lowercase language as BMS spells it in the URL (e.g. "english", "hindi").
  // When set, every format (2D, 3D, IMAX, 4DX, ...) of that language is
  // checked. When omitted, only the default format of `code` is checked.
  language?: string;
  found: boolean;
  // theatre name -> known shows, each stored as "<format> | <timing>"
  // (or just "<timing>" when the format is unknown).
  theatres: Record<string, string[]>;
}

interface ScrapedShow {
  format: string;
  timing: string;
}

interface ScrapedTheatre {
  name: string;
  shows: ScrapedShow[];
}

interface TelegramKeyboard {
  inline_keyboard: { text: string; url: string }[][];
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// DRY_RUN=1 prints notifications to stdout instead of sending them and
// leaves config.json untouched.
const DRY_RUN = process.env.DRY_RUN === "1";

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function showKey(show: ScrapedShow) {
  return show.format ? `${show.format} | ${show.timing}` : show.timing;
}

// Groups shows by format, preserving page order.
function groupByFormat(shows: ScrapedShow[]) {
  const byFormat = new Map<string, string[]>();
  for (const show of shows) {
    const timings = byFormat.get(show.format) ?? [];
    timings.push(show.timing);
    byFormat.set(show.format, timings);
  }
  return byFormat;
}

function log(level: string, message: string, fields?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const fieldsStr = fields ? " " + JSON.stringify(fields) : "";
  const line = `${timestamp} [${level}] ${message}${fieldsStr}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function loadMovies(): MovieDetails[] {
  const data = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(data);
}

function saveMovies(movies: MovieDetails[]) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(movies, null, 4) + "\n");
}

function describeError(err: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = { error: String(err) };
  if (err instanceof Error && err.stack) {
    details.stack = err.stack;
  }
  const causes: string[] = [];
  let current: unknown = err;
  while (current instanceof Error && current.cause !== undefined) {
    const cause = current.cause;
    if (cause instanceof Error) {
      const code = (cause as NodeJS.ErrnoException).code;
      causes.push(code ? `${code}: ${cause.message}` : String(cause));
    } else {
      causes.push(String(cause));
    }
    current = cause;
  }
  if (causes.length > 0) {
    details.causes = causes;
  }
  return details;
}

const TELEGRAM_MAX_ATTEMPTS = 3;
const TELEGRAM_RETRY_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramNotificationOnce(
  chatId: string,
  message: string,
  parseMode: string,
  keyboard: TelegramKeyboard
) {
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: parseMode,
    reply_markup: keyboard,
  };

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = (await response.json()) as {
    ok: boolean;
    description?: string;
    error_code?: number;
  };
  if (!result.ok) {
    throw new Error(
      `Telegram API error (HTTP ${response.status}, code ${result.error_code}): ${result.description}`
    );
  }
}

async function sendTelegramNotification(
  chatId: string,
  message: string,
  parseMode: string,
  keyboard: TelegramKeyboard
) {
  if (DRY_RUN) {
    console.log(`--- DRY RUN notification ---\n${message}\n${keyboard.inline_keyboard[0][0].url}\n`);
    return;
  }
  for (let attempt = 1; attempt <= TELEGRAM_MAX_ATTEMPTS; attempt++) {
    try {
      await sendTelegramNotificationOnce(chatId, message, parseMode, keyboard);
      return;
    } catch (err) {
      if (attempt === TELEGRAM_MAX_ATTEMPTS) throw err;
      log("warn", "Telegram send failed, retrying", {
        attempt,
        maxAttempts: TELEGRAM_MAX_ATTEMPTS,
        ...describeError(err),
      });
      await sleep(TELEGRAM_RETRY_DELAY_MS * attempt);
    }
  }
}

async function main() {
  const startTime = Date.now();

  if (!TELEGRAM_BOT_TOKEN && !DRY_RUN) {
    log("error", "TELEGRAM_BOT_TOKEN environment variable not set");
    process.exit(1);
  }
  if (!TELEGRAM_CHAT_ID && !DRY_RUN) {
    log("error", "TELEGRAM_CHAT_ID environment variable not set");
    process.exit(1);
  }

  const chatId = TELEGRAM_CHAT_ID ?? "";
  const moviesList = loadMovies();

  for (const movie of moviesList) {
    if (movie.found) continue;

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      );

      // Without etCodes=*, BMS only lists the default format of this event
      // code (e.g. just "English - 2D") and hides IMAX/3D/4DX/etc.
      // etCodes=* only works together with a language.
      const allFormatsQuery = movie.language
        ? `?etCodes=*&language=${encodeURIComponent(movie.language.toLowerCase())}`
        : "";
      const bookingURL = `https://in.bookmyshow.com/movies/${movie.city}/${movie.slug_name}/buytickets/${movie.code}/${movie.date}${allFormatsQuery}`;

      await page.goto(bookingURL, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});

      // Verify the actually selected date matches the requested date.
      // BMS silently defaults to the nearest available date if shows
      // haven't opened for the requested date.
      const actualSelectedDate = await page.evaluate(() => {
        const els = document.querySelectorAll<HTMLElement>("[id]");
        for (const el of els) {
          if (/^\d{8}$/.test(el.id)) {
            const bg = window.getComputedStyle(el).backgroundColor;
            if (bg === "rgb(235, 78, 98)") return el.id; // #EB4E62
          }
        }
        return null;
      });

      // BMS also rewrites the URL to the date it fell back to.
      const urlDate = page.url().match(/\/(\d{8})(?:[?#]|$)/)?.[1] ?? null;
      const actualDate =
        actualSelectedDate && actualSelectedDate !== movie.date
          ? actualSelectedDate
          : urlDate && urlDate !== movie.date
            ? urlDate
            : null;

      if (actualDate) {
        log("info", "Shows not yet available for requested date", {
          movie: movie.name,
          requestedDate: movie.date,
          actualDate,
        });
        continue;
      }

      const theatreContainer = await page.$(
        ".ReactVirtualized__Grid__innerScrollContainer"
      );
      if (!theatreContainer) {
        log("error", "Error finding theatre container", { movie: movie.name });
        continue;
      }

      // Only use the stable styled-components prefix classes (sc-*); the
      // hashed companion classes (e.g. "kJBeM") change between BMS builds.
      //
      // Each theatre card holds one group (.sc-y0qrj4-1) per format, with an
      // optional heading (.sc-y0qrj4-2, e.g. "Hindi IMAX 3D") that BMS only
      // renders in the all-formats view.
      //
      // The browser callback returns raw text only and declares no named
      // helpers: tsx/esbuild wraps those in a `__name` call that doesn't
      // exist inside the page.
      const rawTheatres = await theatreContainer.$$eval(".sc-e8nk8f-3", (theatreEls) =>
        theatreEls.map((theatreEl) => ({
          // First match is the theatre name; format headings reuse the class.
          name: theatreEl.querySelector(".sc-1h5m8q1-2")?.textContent || "",
          slots: [...theatreEl.querySelectorAll(".sc-1la7659-0")].map((slot) => {
            const timeEl = slot.querySelector(".sc-1vhizuf-2");
            return {
              format:
                slot.closest(".sc-y0qrj4-1")?.querySelector(".sc-y0qrj4-2")?.textContent || "",
              // The time element also nests the subtitle badge (e.g. "ENG"),
              // so read only its own text nodes for the time.
              time: [...(timeEl?.childNodes ?? [])]
                .filter((n) => n.nodeType === Node.TEXT_NODE)
                .map((n) => n.textContent)
                .join(" "),
              subtitle: timeEl?.querySelector(".sc-1vhizuf-4")?.textContent || "",
              tag: slot.querySelector(".sc-1vhizuf-3")?.textContent || "",
            };
          }),
        }))
      );

      const scrapedTheatres: ScrapedTheatre[] = rawTheatres.map((theatre) => ({
        name: cleanText(theatre.name),
        shows: theatre.slots
          .filter((slot) => cleanText(slot.time))
          .map((slot) => {
            const subtitle = cleanText(slot.subtitle);
            return {
              format: cleanText(slot.format).toUpperCase(),
              timing: [cleanText(slot.time), subtitle && `(${subtitle})`, cleanText(slot.tag)]
                .filter(Boolean)
                .join(" "),
            };
          }),
      }));

      const showDate = movie.date;
      const formattedDate = `${showDate.slice(6, 8)}-${showDate.slice(4, 6)}-${showDate.slice(0, 4)}`;
      const bookingKeyboard: TelegramKeyboard = {
        inline_keyboard: [[{ text: "🎟️ Book on BookMyShow", url: bookingURL }]],
      };

      for (const theatre of scrapedTheatres) {
        if (!theatre.name) continue;

        const existingShows = movie.theatres[theatre.name];
        const isNewTheatre = existingShows === undefined;
        const newShows = isNewTheatre
          ? theatre.shows
          : theatre.shows.filter((show) => !existingShows.includes(showKey(show)));

        if (!isNewTheatre && newShows.length === 0) continue;

        movie.theatres[theatre.name] = [
          ...(existingShows ?? []),
          ...newShows.map(showKey),
        ];

        // One message per format, with the format in brackets after the
        // movie name, e.g. "Ramayana (HINDI IMAX 3D)".
        for (const [format, timings] of groupByFormat(newShows)) {
          const movieTitle = format ? `${movie.name} (${format})` : movie.name;
          const header = `🎥 Movie: *${movieTitle}*\n📅 Date: *${formattedDate}*\n🏟️ Theatre: *${theatre.name}*`;
          const notificationMsg = isNewTheatre
            ? `🎬 *New Show Added!*\n\n${header}\n🕐 Shows: *${timings.length}*\n⏰ *${timings.join(", ")}*`
            : `🎬 *New Timing Added!*\n\n${header}\n⏰ New: *${timings.join(", ")}*`;

          try {
            await sendTelegramNotification(chatId, notificationMsg, "Markdown", bookingKeyboard);
          } catch (err) {
            log("error", "Error sending Telegram notification", {
              movie: movie.name, theatre: theatre.name, format, ...describeError(err),
            });
          }
        }

        log("info", isNewTheatre ? "Found new theatre" : "Found new timings", {
          movie: movie.name, date: formattedDate, theatre: theatre.name,
          shows: newShows.map(showKey), url: bookingURL,
        });
      }
    } catch (err) {
      log("error", "Error processing movie", {
        movie: movie.name,
        error: String(err),
      });
    } finally {
      await browser.close();
    }
  }

  if (!DRY_RUN) saveMovies(moviesList);

  const duration = (Date.now() - startTime) / 1000;
  log("info", "cron completed", { duration_in_seconds: duration });
}

main().catch((err) => {
  log("error", "Unhandled error", { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
