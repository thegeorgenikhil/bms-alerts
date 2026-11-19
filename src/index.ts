import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

// CONFIG_FILE overrides the config path (handy for trying a test config).
const CONFIG_FILE = process.env.CONFIG_FILE ?? path.join(ROOT_DIR, "config.json");
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
  // Full label used in messages and as the stored key, e.g. "06:50 AM (ENG) PXL".
  timing: string;
  // Bare show time, e.g. "06:50 AM".
  time: string;
  // Seat selection page of this show (the booking page when unknown).
  url: string;
  soldOut: boolean;
}

interface ScrapedTheatre {
  name: string;
  shows: ScrapedShow[];
}

type CheckResult =
  | { status: "open"; theatres: ScrapedTheatre[] }
  // Shows haven't opened for the requested date (BMS fell back to
  // `actualDate`, or lists no shows at all when it is null).
  | { status: "not-open"; actualDate: string | null }
  | { status: "error"; error: string; blocked?: boolean };

interface FetchedPage {
  status: number;
  url: string;
  body: string;
  error: string;
  ms: number;
}

interface TelegramKeyboard {
  inline_keyboard: { text: string; url: string }[][];
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// DRY_RUN=1 prints notifications to stdout instead of sending them and
// leaves config.json untouched.
const DRY_RUN = process.env.DRY_RUN === "1";
// --watch (or WATCH=1) keeps one browser open and re-checks every
// POLL_INTERVAL_SECONDS instead of exiting after a single check.
const WATCH = process.argv.includes("--watch") || process.env.WATCH === "1";
// VERBOSE=1 echoes every log line to the terminal and adds per-check
// debug lines (terminal only, so bms.log doesn't fill up).
const VERBOSE = process.env.VERBOSE === "1";
const POLL_INTERVAL_MS = Math.max(1, Number(process.env.POLL_INTERVAL_SECONDS) || 5) * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_BACKOFF_MS = 60000;
const HEARTBEAT_MS = 10 * 60 * 1000;
// In watch mode, alert on Telegram once checks have been failing this long.
const FAILURE_ALERT_MS = 3 * 60 * 1000;

const BMS_ORIGIN = "https://in.bookmyshow.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function showKey(show: ScrapedShow) {
  return show.format ? `${show.format} | ${show.timing}` : show.timing;
}

// Groups shows by format, preserving page order.
function groupByFormat(shows: ScrapedShow[]) {
  const byFormat = new Map<string, ScrapedShow[]>();
  for (const show of shows) {
    const group = byFormat.get(show.format) ?? [];
    group.push(show);
    byFormat.set(show.format, group);
  }
  return byFormat;
}

const SHOW_BUTTONS_PER_ROW = 3;
// Telegram allows 100 buttons per message; leave room for the last row.
const MAX_SHOW_BUTTONS = 96;

// One button per show, opening that show's seat selection, followed by a
// button for the movie's booking page.
function showKeyboard(shows: ScrapedShow[], bookingURL: string): TelegramKeyboard {
  const rows: TelegramKeyboard["inline_keyboard"] = [];
  for (const [i, show] of shows.slice(0, MAX_SHOW_BUTTONS).entries()) {
    if (i % SHOW_BUTTONS_PER_ROW === 0) rows.push([]);
    rows[rows.length - 1].push({
      text: show.soldOut ? `${show.time} (sold out)` : show.time,
      url: show.url,
    });
  }
  rows.push([{ text: "🎟️ All shows on BookMyShow", url: bookingURL }]);
  return { inline_keyboard: rows };
}

function log(level: string, message: string, fields?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const fieldsStr = fields ? " " + JSON.stringify(fields) : "";
  const line = `${timestamp} [${level}] ${message}${fieldsStr}\n`;
  if (VERBOSE) process.stdout.write(line);
  if (level !== "debug") fs.appendFileSync(LOG_FILE, line);
}

function debug(message: string, fields?: Record<string, unknown>) {
  if (VERBOSE) log("debug", message, fields);
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
    const buttons = keyboard.inline_keyboard
      .map((row) => row.map((button) => `[${button.text}] ${button.url}`).join("\n"))
      .join("\n");
    console.log(`--- DRY RUN notification ---\n${message}\n${buttons}\n`);
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

function bookingPath(movie: MovieDetails) {
  // Without etCodes=*, BMS only lists the default format of this event
  // code (e.g. just "English - 2D") and hides IMAX/3D/4DX/etc.
  // etCodes=* only works together with a language.
  const allFormatsQuery = movie.language
    ? `?etCodes=*&language=${encodeURIComponent(movie.language.toLowerCase())}`
    : "";
  return `/movies/${movie.city}/${movie.slug_name}/buytickets/${movie.code}/${movie.date}${allFormatsQuery}`;
}

// One long-lived browser tab on the BMS origin. Showtimes are read by
// fetching the booking page's HTML from inside that tab (so the request
// carries the browser's own cookies and network stack) instead of
// rendering the page: BMS server-renders the showtime data into
// window.__INITIAL_STATE__, which makes a check ~200ms instead of ~4s.
//
// The JSON API the page calls client-side
// (/api/movies-data/v5/showtimes-by-event/primary-dynamic) is not used on
// purpose: it is edge-cached and was observed serving responses over a
// minute old, while the server-rendered HTML is generated per request.
class BmsSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async open(city: string) {
    await this.close();
    this.browser = await puppeteer.launch({
      headless: true,
      // Watch mode handles these itself so it can stop cleanly; puppeteer's
      // own handlers would exit the process mid-cycle.
      handleSIGINT: !WATCH,
      handleSIGTERM: !WATCH,
      handleSIGHUP: !WATCH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const page = await this.browser.newPage();
    await page.setUserAgent(USER_AGENT);
    // The tab only exists to give fetches a same-origin context.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const skip = ["image", "font", "media", "stylesheet"].includes(req.resourceType());
      (skip ? req.abort() : req.continue()).catch(() => {});
    });
    await page.goto(`${BMS_ORIGIN}/explore/movies-${city}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    this.page = page;
  }

  get isOpen() {
    return this.page !== null && !this.page.isClosed() && this.browser?.connected === true;
  }

  // Fetches all paths in parallel. The callback declares no named helpers:
  // tsx/esbuild wraps those in a `__name` call that doesn't exist inside
  // the page.
  async fetchAll(paths: string[]): Promise<FetchedPage[]> {
    if (!this.page) throw new Error("BMS session is not open");
    return this.page.evaluate(
      (paths, timeoutMs) =>
        Promise.all(
          paths.map(async (path) => {
            const started = performance.now();
            try {
              const res = await fetch(path, {
                cache: "no-store",
                headers: { accept: "text/html" },
                signal: AbortSignal.timeout(timeoutMs),
              });
              const body = await res.text();
              const ms = Math.round(performance.now() - started);
              return { status: res.status, url: res.url, body, error: "", ms };
            } catch (err) {
              const ms = Math.round(performance.now() - started);
              return { status: 0, url: "", body: "", error: String(err), ms };
            }
          })
        ),
      paths,
      FETCH_TIMEOUT_MS
    );
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    await browser?.close().catch(() => {});
  }
}

const STATE_MARKER = "window.__INITIAL_STATE__ = ";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function sectionFormat(section: Json): string {
  const parts: string[] = [];
  for (const line of section?.text ?? []) {
    for (const component of line?.components ?? []) {
      if (component?.text) parts.push(component.text);
    }
  }
  return cleanText(parts.join(" ")).toUpperCase();
}

function parseShowtimes(fetched: FetchedPage, movie: MovieDetails): CheckResult {
  if (fetched.error) return { status: "error", error: fetched.error };
  if (fetched.status !== 200) {
    return {
      status: "error",
      error: `HTTP ${fetched.status}`,
      blocked: fetched.status === 403 || fetched.status === 429,
    };
  }

  const start = fetched.body.indexOf(STATE_MARKER);
  const end = start === -1 ? -1 : fetched.body.indexOf("</script>", start);
  if (end === -1) return { status: "error", error: "Initial state not found in page" };

  let state: Json;
  try {
    const raw = fetched.body.slice(start + STATE_MARKER.length, end).trim().replace(/;$/, "");
    state = JSON.parse(raw);
  } catch (err) {
    return { status: "error", error: `Initial state is not valid JSON: ${String(err)}` };
  }

  const queries = state?.showtimesFunctionalApi?.queries ?? {};
  const queryKey = Object.keys(queries).find((key) => key.startsWith("fetchPrimaryDynamic"));
  const query = queryKey ? queries[queryKey] : undefined;
  if (!query) return { status: "error", error: "Showtimes query missing from initial state" };
  if (query.status !== "fulfilled") {
    return { status: "error", error: `Showtimes query ${query.status}` };
  }

  const data = query.data?.data ?? {};

  // BMS silently falls back to the nearest available date when shows
  // haven't opened for the requested one.
  const servedDate: string | null =
    data.additionalData?.dateCode ?? fetched.url.match(/\/(\d{8})(?:[?#]|$)/)?.[1] ?? null;
  if (servedDate && servedDate !== movie.date) {
    return { status: "not-open", actualDate: servedDate };
  }

  const theatres: ScrapedTheatre[] = [];
  for (const widget of data.showtimeWidgets ?? []) {
    if (widget?.type !== "groupList") continue;
    for (const group of widget.data ?? []) {
      for (const venue of group?.data ?? []) {
        if (venue?.type !== "venue-card") continue;
        const shows: ScrapedShow[] = [];
        const venueCode: string = venue.additionalData?.venueCode ?? "";
        for (const section of venue.showtimesSections ?? []) {
          const format = sectionFormat(section);
          // In the all-formats view each format is its own event code.
          const eventCode: string = section?.additionalData?.eventCode ?? movie.code;
          for (const show of section?.showtimes ?? []) {
            const time = cleanText(show?.title ?? "");
            if (!time) continue;
            // A show listed under another date doesn't count for this one.
            const showDate = show.additionalData?.showDateCode;
            if (showDate && showDate !== movie.date) continue;
            const subtitle = cleanText(show.subtitleAcronym ?? "");
            const tag = cleanText(show.screenAttr ?? "");
            const sessionId: string = show.additionalData?.sessionId ?? "";
            shows.push({
              format,
              timing: [time, subtitle && `(${subtitle})`, tag].filter(Boolean).join(" "),
              time,
              url:
                venueCode && sessionId
                  ? `${BMS_ORIGIN}/movies/${movie.city}/seat-layout/${eventCode}/${venueCode}/${sessionId}/${movie.date}`
                  : BMS_ORIGIN + bookingPath(movie),
              soldOut: show.additionalData?.availStatus === "0",
            });
          }
        }
        theatres.push({ name: cleanText(venue.additionalData?.venueName ?? ""), shows });
      }
    }
  }

  if (!theatres.some((theatre) => theatre.name && theatre.shows.length > 0)) {
    return { status: "not-open", actualDate: null };
  }
  return { status: "open", theatres };
}

// Sends alerts for shows not yet recorded on `movie` and records them.
// Returns true when `movie` changed.
async function notifyNewShows(movie: MovieDetails, theatres: ScrapedTheatre[], chatId: string) {
  const showDate = movie.date;
  const formattedDate = `${showDate.slice(6, 8)}-${showDate.slice(4, 6)}-${showDate.slice(0, 4)}`;
  const bookingURL = BMS_ORIGIN + bookingPath(movie);
  let changed = false;

  for (const theatre of theatres) {
    if (!theatre.name) continue;

    const existingShows = movie.theatres[theatre.name];
    const isNewTheatre = existingShows === undefined;
    const newShows = isNewTheatre
      ? theatre.shows
      : theatre.shows.filter((show) => !existingShows.includes(showKey(show)));

    if (newShows.length === 0) continue;

    movie.theatres[theatre.name] = [...(existingShows ?? []), ...newShows.map(showKey)];
    changed = true;

    // One message per format, with the format in brackets after the
    // movie name, e.g. "Ramayana (HINDI IMAX 3D)".
    for (const [format, shows] of groupByFormat(newShows)) {
      const timings = shows.map((show) => show.timing);
      const movieTitle = format ? `${movie.name} (${format})` : movie.name;
      const header = `🎥 Movie: *${movieTitle}*\n📅 Date: *${formattedDate}*\n🏟️ Theatre: *${theatre.name}*`;
      const notificationMsg = isNewTheatre
        ? `🎬 *New Show Added!*\n\n${header}\n🕐 Shows: *${timings.length}*\n⏰ *${timings.join(", ")}*`
        : `🎬 *New Timing Added!*\n\n${header}\n⏰ New: *${timings.join(", ")}*`;

      try {
        await sendTelegramNotification(
          chatId, notificationMsg, "Markdown", showKeyboard(shows, bookingURL)
        );
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

  return changed;
}

// Last logged outcome per target, so watch mode logs changes rather than
// the same "not yet available" line every few seconds.
const lastOutcome = new Map<string, string>();

function logOutcome(movie: MovieDetails, result: CheckResult) {
  const target = `${movie.code}|${movie.city}|${movie.date}|${movie.language ?? ""}`;
  const outcome = JSON.stringify(result.status === "open" ? { status: "open" } : result);
  if (lastOutcome.get(target) === outcome) return;
  lastOutcome.set(target, outcome);

  const fields = { movie: movie.name, city: movie.city, requestedDate: movie.date };
  if (result.status === "not-open") {
    log("info", "Shows not yet available for requested date", {
      ...fields, actualDate: result.actualDate,
    });
  } else if (result.status === "error") {
    log("error", "Error checking movie", { ...fields, error: result.error });
  }
}

interface CycleResult {
  checked: number;
  failed: number;
  blocked: boolean;
}

// Checks every pending movie once, all in parallel.
async function runCycle(session: BmsSession, chatId: string): Promise<CycleResult> {
  const moviesList = loadMovies();
  const pending = moviesList.filter((movie) => !movie.found);
  if (pending.length === 0) {
    debug("No pending movies in config");
    return { checked: 0, failed: 0, blocked: false };
  }

  const cycleStart = Date.now();
  if (!session.isOpen) {
    await session.open(pending[0].city);
    debug("Browser session opened", { ms: Date.now() - cycleStart });
  }

  const pages = await session.fetchAll(pending.map(bookingPath));
  const results = pages.map((page, i) => parseShowtimes(page, pending[i]));

  let changed = false;
  let failed = 0;
  let blocked = false;
  for (const [i, result] of results.entries()) {
    const movie = pending[i];
    logOutcome(movie, result);
    debug("Checked", {
      movie: movie.name, city: movie.city, date: movie.date,
      result: result.status,
      ...(result.status === "open" && {
        theatres: result.theatres.length,
        shows: result.theatres.reduce((n, theatre) => n + theatre.shows.length, 0),
      }),
      ...(result.status === "not-open" && { actualDate: result.actualDate }),
      ...(result.status === "error" && { error: result.error }),
      http: pages[i].status, kb: Math.round(pages[i].body.length / 1024), ms: pages[i].ms,
    });
    if (result.status === "error") {
      failed++;
      blocked ||= result.blocked === true;
    } else if (result.status === "open") {
      if (await notifyNewShows(movie, result.theatres, chatId)) changed = true;
    }
  }

  if (changed && !DRY_RUN) saveMovies(moviesList);
  debug("Cycle done", { checked: pending.length, failed, changed, ms: Date.now() - cycleStart });
  return { checked: pending.length, failed, blocked };
}

async function runOnce(chatId: string) {
  const startTime = Date.now();
  const session = new BmsSession();
  try {
    await runCycle(session, chatId);
  } catch (err) {
    log("error", "Error running check", describeError(err));
  } finally {
    await session.close();
  }
  log("info", "check completed", { duration_in_seconds: (Date.now() - startTime) / 1000 });
}

async function watch(chatId: string) {
  const session = new BmsSession();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log("info", "watch started", { poll_interval_seconds: POLL_INTERVAL_MS / 1000 });

  let consecutiveFailures = 0;
  let failingSince: number | null = null;
  let failureAlertSent = false;
  let cycles = 0;
  let cycleMsTotal = 0;
  let lastHeartbeat = Date.now();
  const stats = () => ({
    cycles, avg_cycle_ms: cycles ? Math.round(cycleMsTotal / cycles) : 0, consecutiveFailures,
  });

  while (!stopping) {
    const cycleStart = Date.now();
    let ok = false;
    try {
      const result = await runCycle(session, chatId);
      // A cycle is healthy unless every check failed.
      ok = result.checked === 0 || result.failed < result.checked;
      if (result.blocked) await session.close();
    } catch (err) {
      log("error", "Error running check", describeError(err));
      await session.close();
    }
    cycles++;
    cycleMsTotal += Date.now() - cycleStart;

    if (ok) {
      if (failureAlertSent) {
        await sendTelegramNotification(chatId, "✅ BMS watcher recovered.", "Markdown", {
          inline_keyboard: [],
        }).catch(() => {});
      }
      consecutiveFailures = 0;
      failingSince = null;
      failureAlertSent = false;
    } else {
      consecutiveFailures++;
      failingSince ??= cycleStart;
      // A fresh tab (and browser) is the fix for most failures.
      if (consecutiveFailures % 3 === 0) await session.close();
      if (!failureAlertSent && Date.now() - failingSince >= FAILURE_ALERT_MS) {
        failureAlertSent = true;
        await sendTelegramNotification(
          chatId,
          "⚠️ BMS watcher has been failing for a few minutes. Check bms.log.",
          "Markdown",
          { inline_keyboard: [] }
        ).catch(() => {});
      }
    }

    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      log("info", "watch heartbeat", stats());
      cycles = 0;
      cycleMsTotal = 0;
      lastHeartbeat = Date.now();
    }

    if (!ok) debug("Cycle failed, backing off", { consecutiveFailures });
    const backoff = ok ? 0 : Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 6));
    const wait = Math.max(POLL_INTERVAL_MS - (Date.now() - cycleStart), backoff);
    const waitUntil = Date.now() + wait;
    while (!stopping && Date.now() < waitUntil) await sleep(Math.min(250, waitUntil - Date.now()));
  }

  await session.close();
  log("info", "watch stopped", stats());
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN && !DRY_RUN) {
    log("error", "TELEGRAM_BOT_TOKEN environment variable not set");
    process.exit(1);
  }
  if (!TELEGRAM_CHAT_ID && !DRY_RUN) {
    log("error", "TELEGRAM_CHAT_ID environment variable not set");
    process.exit(1);
  }

  const chatId = TELEGRAM_CHAT_ID ?? "";
  if (WATCH) await watch(chatId);
  else await runOnce(chatId);
}

main().catch((err) => {
  log("error", "Unhandled error", { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
