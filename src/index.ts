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
  found: boolean;
  theatres: Record<string, string[]>;
}

interface ScrapedTheatre {
  name: string;
  timings: string[];
}

interface TelegramKeyboard {
  inline_keyboard: { text: string; url: string }[][];
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

  if (!TELEGRAM_BOT_TOKEN) {
    log("error", "TELEGRAM_BOT_TOKEN environment variable not set");
    process.exit(1);
  }
  if (!TELEGRAM_CHAT_ID) {
    log("error", "TELEGRAM_CHAT_ID environment variable not set");
    process.exit(1);
  }

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

      const bookingURL = `https://in.bookmyshow.com/movies/${movie.city}/${movie.slug_name}/buytickets/${movie.code}/${movie.date}`;

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

      if (actualSelectedDate && actualSelectedDate !== movie.date) {
        log("info", "Shows not yet available for requested date", {
          movie: movie.name,
          requestedDate: movie.date,
          actualDate: actualSelectedDate,
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
      const theatreElements = await theatreContainer.$$(".sc-e8nk8f-3");

      const scrapedTheatres: ScrapedTheatre[] = [];
      for (const theatreEl of theatreElements) {
        const theatreNameDiv = await theatreEl.$(".sc-1h5m8q1-2");
        const theatreName = theatreNameDiv
          ? await theatreNameDiv.evaluate((el) => el.textContent || "")
          : "";

        const showSlots = await theatreEl.$$(".sc-1la7659-0");
        const timings: string[] = [];
        for (const slot of showSlots) {
          const timeEl = await slot.$(".sc-1vhizuf-2");
          const tagEl = await slot.$(".sc-1vhizuf-3");
          const time = timeEl ? await timeEl.evaluate((el) => el.textContent || "") : "";
          const tag = tagEl ? await tagEl.evaluate((el) => el.textContent || "") : "";
          if (time.trim()) {
            timings.push(tag.trim() ? `${time.trim()} ${tag.trim()}` : time.trim());
          }
        }

        scrapedTheatres.push({ name: theatreName.trim(), timings });
      }

      const showDate = movie.date;
      const formattedDate = `${showDate.slice(6, 8)}-${showDate.slice(4, 6)}-${showDate.slice(0, 4)}`;
      const bookingKeyboard: TelegramKeyboard = {
        inline_keyboard: [[{ text: "🎟️ Book on BookMyShow", url: bookingURL }]],
      };

      for (const theatre of scrapedTheatres) {
        if (!theatre.name) continue;

        const existingTimings = movie.theatres[theatre.name];
        const isNewTheatre = existingTimings === undefined;

        if (isNewTheatre) {
          // New theatre — notify with all timings
          movie.theatres[theatre.name] = theatre.timings;

          const notificationMsg = `🎬 *New Show Added!*\n\n🎥 Movie: *${movie.name}*\n📅 Date: *${formattedDate}*\n🏟️ Theatre: *${theatre.name}*\n🕐 Shows: *${theatre.timings.length}*\n⏰ *${theatre.timings.join(", ")}*`;

          try {
            await sendTelegramNotification(TELEGRAM_CHAT_ID, notificationMsg, "Markdown", bookingKeyboard);
          } catch (err) {
            log("error", "Error sending Telegram notification", {
              movie: movie.name, theatre: theatre.name, ...describeError(err),
            });
          }

          log("info", "Found new theatre", {
            movie: movie.name, date: formattedDate, theatre: theatre.name,
            timings: theatre.timings, url: bookingURL,
          });
        } else {
          // Existing theatre — check for new timings
          const newTimings = theatre.timings.filter((t) => !existingTimings.includes(t));
          if (newTimings.length > 0) {
            movie.theatres[theatre.name] = [...existingTimings, ...newTimings];

            const notificationMsg = `🎬 *New Timing Added!*\n\n🎥 Movie: *${movie.name}*\n📅 Date: *${formattedDate}*\n🏟️ Theatre: *${theatre.name}*\n⏰ New: *${newTimings.join(", ")}*`;

            try {
              await sendTelegramNotification(TELEGRAM_CHAT_ID, notificationMsg, "Markdown", bookingKeyboard);
            } catch (err) {
              log("error", "Error sending Telegram notification", {
                movie: movie.name, theatre: theatre.name, ...describeError(err),
              });
            }

            log("info", "Found new timings", {
              movie: movie.name, date: formattedDate, theatre: theatre.name,
              newTimings, url: bookingURL,
            });
          }
        }
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

  saveMovies(moviesList);

  const duration = (Date.now() - startTime) / 1000;
  log("info", "cron completed", { duration_in_seconds: duration });
}

main().catch((err) => {
  log("error", "Unhandled error", { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
