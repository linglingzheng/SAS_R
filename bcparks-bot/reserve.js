#!/usr/bin/env node
/*
 * BC Parks Day-Use Pass helper (Joffre Lakes / Pipi7íyekw and other parks)
 * ------------------------------------------------------------------------
 * This opens the REAL BC Parks site in a real browser on YOUR computer,
 * (optionally) waits for the 7:00 AM release, then walks through the form
 * filling in your details. It is "guided": whenever it isn't 100% sure it
 * found the right field (the site changes its layout from time to time), it
 * pauses and asks you to click that one thing, then continues.
 *
 * It never solves CAPTCHAs or bypasses the virtual waiting room for you —
 * you handle those, the script handles the tedious typing and the timing.
 *
 * Usage:
 *   node reserve.js                 # run now, using config.json
 *   node reserve.js --wait          # sit idle, then start at releaseTime
 *   node reserve.js --config other.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REGISTRATION_URL = 'https://reserve.bcparks.ca/dayuse/registration';

// ---------- small utilities ------------------------------------------------

function loadConfig() {
  const idx = process.argv.indexOf('--config');
  const file = idx !== -1 ? process.argv[idx + 1] : path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) {
    console.error(`\n✖ Config file not found: ${file}`);
    console.error('  Copy config.example.json to config.json and fill in your details.\n');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = cfg.contact || {};
  const missing = [];
  if (!cfg.park) missing.push('park');
  if (!cfg.visitDate) missing.push('visitDate');
  if (!c.firstName || c.firstName.includes('YOUR')) missing.push('contact.firstName');
  if (!c.lastName || c.lastName.includes('YOUR')) missing.push('contact.lastName');
  if (!c.email || c.email.includes('example.com')) missing.push('contact.email');
  if (missing.length) {
    console.error(`\n✖ Please fill these in config.json: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  return cfg;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}
async function pause(msg) {
  await ask(`\n⏸  ${msg}\n   → Press ENTER when done to continue... `);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const t = new Date().toLocaleTimeString('en-CA', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// Return "now" as a Date, and the release moment for today in the park's tz.
function msUntilRelease(releaseTime, timezone) {
  const [hh, mm] = releaseTime.split(':').map(Number);
  // What time is it right now in the park timezone?
  const now = new Date();
  const parkNowStr = now.toLocaleString('en-US', { timeZone: timezone });
  const parkNow = new Date(parkNowStr);
  const target = new Date(parkNow);
  target.setHours(hh, mm, 0, 0);
  // If we've already passed release time today, target is in the past → 0.
  const diff = target.getTime() - parkNow.getTime();
  return diff;
}

async function waitForRelease(cfg) {
  const diff = msUntilRelease(cfg.releaseTime || '07:00', cfg.timezone || 'America/Vancouver');
  if (diff <= 0) {
    log(`Release time ${cfg.releaseTime} has already passed today — starting now.`);
    return;
  }
  const mins = Math.round(diff / 60000);
  log(`Waiting for ${cfg.releaseTime} ${cfg.timezone} release (~${mins} min from now).`);
  log('Leave this window open. The browser opens ~90s before release so pages are warm.');
  // Sleep until 90s before release, then let the caller open the browser.
  const preWarm = Math.max(0, diff - 90 * 1000);
  await sleep(preWarm);
  log('Almost time — opening the browser to warm up.');
}

// ---------- resilient element helpers --------------------------------------
// The BC Parks site is a single-page app; exact ids change. We try several
// strategies and fall back to asking the human rather than guessing wrong.

async function tryClickText(page, texts, { timeout = 6000 } = {}) {
  for (const t of texts) {
    const loc = page.getByRole('button', { name: t, exact: false })
      .or(page.getByText(t, { exact: false }));
    try {
      await loc.first().click({ timeout });
      log(`Clicked: "${t}"`);
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

async function tryFillLabel(page, labels, value, { timeout = 4000 } = {}) {
  for (const l of labels) {
    try {
      const byLabel = page.getByLabel(l, { exact: false });
      await byLabel.first().fill(value, { timeout });
      log(`Filled "${l}" = ${value}`);
      return true;
    } catch (_) { /* try placeholder */ }
    try {
      const byPh = page.getByPlaceholder(l, { exact: false });
      await byPh.first().fill(value, { timeout });
      log(`Filled (placeholder) "${l}" = ${value}`);
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

// ---------- main flow ------------------------------------------------------

async function run() {
  const cfg = loadConfig();
  const wait = process.argv.includes('--wait');

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  BC Parks Day-Use Pass helper');
  console.log(`  Park:      ${cfg.park}${cfg.trail ? ' / ' + cfg.trail : ''}`);
  console.log(`  Date:      ${cfg.visitDate}   Slot: ${cfg.timeSlot || '(any)'}`);
  console.log(`  Passes:    ${cfg.passCount}`);
  console.log(`  Name:      ${cfg.contact.firstName} ${cfg.contact.lastName}`);
  console.log(`  Email:     ${cfg.contact.email}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  NOTE: passes are free; up to 4 per transaction; each person');
  console.log('  13+ needs one. Passes open at 7:00 AM Pacific, 2 days before');
  console.log('  the visit date, and can go fast. Keep an eye on the browser.');
  console.log('════════════════════════════════════════════════════════════\n');

  if (wait) await waitForRelease(cfg);

  const browser = await chromium.launch({
    headless: !!cfg.headless,          // default false → you can watch & help
    args: ['--start-maximized'],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // If we're waiting for release, spin on the landing page until it's time.
  if (wait) {
    let remaining = msUntilRelease(cfg.releaseTime || '07:00', cfg.timezone || 'America/Vancouver');
    await page.goto(REGISTRATION_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    while (remaining > 0) {
      const secs = Math.ceil(remaining / 1000);
      process.stdout.write(`\r  ⏳ ${secs}s until release — reloading page...      `);
      await sleep(Math.min(remaining, 5000));
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      remaining = msUntilRelease(cfg.releaseTime || '07:00', cfg.timezone || 'America/Vancouver');
    }
    console.log('\n  🚀 Release time! Go go go.');
  } else {
    await page.goto(REGISTRATION_URL, { waitUntil: 'domcontentloaded' });
  }

  log('Page loaded. If you see a virtual waiting room / queue, wait it out here.');
  await page.waitForTimeout(1500);

  // ---- Step 0: virtual waiting room / cookie banners --------------------
  await tryClickText(page, ['Accept', 'I accept', 'Accept all cookies', 'Got it']);
  log('If a "waiting room" or queue page is showing, DO NOT touch anything —');
  log('it will forward you automatically. Otherwise continue below.');

  // ---- Step 1: choose the park -----------------------------------------
  let ok = await tryClickText(page, [cfg.park, 'Joffre', 'Pipi7íyekw']);
  if (!ok) {
    // Some layouts use a dropdown.
    try {
      const sel = page.getByLabel(/park/i).first();
      await sel.selectOption({ label: cfg.park }).catch(async () => {
        await sel.click();
        await tryClickText(page, [cfg.park, 'Joffre']);
      });
      ok = true;
    } catch (_) { /* fall through */ }
  }
  if (!ok) await pause(`Please click the park "${cfg.park}" in the browser.`);
  await page.waitForTimeout(1000);
  await tryClickText(page, ['Next', 'Continue', 'Confirm']);

  // ---- Step 2: choose the date -----------------------------------------
  // Date is usually a calendar. Day number is the reliable target.
  const dayNum = String(Number(cfg.visitDate.split('-')[2])); // "09" -> "9"
  let dateOk = false;
  try {
    // Prefer a non-disabled calendar cell whose text is exactly the day.
    const cell = page.getByRole('button', { name: new RegExp(`^\\s*${dayNum}\\s*$`) })
      .or(page.locator(`[aria-label*="${cfg.visitDate}"]`))
      .first();
    await cell.click({ timeout: 5000 });
    log(`Picked date ${cfg.visitDate}`);
    dateOk = true;
  } catch (_) { /* fall through */ }
  if (!dateOk) await pause(`Please pick the date ${cfg.visitDate} in the calendar.`);
  await page.waitForTimeout(800);

  // ---- Step 3: time slot (AM / PM) if the park uses them ---------------
  if (cfg.timeSlot) {
    const slotWords = cfg.timeSlot.toUpperCase() === 'AM'
      ? ['AM', 'Morning', 'A.M.']
      : cfg.timeSlot.toUpperCase() === 'PM'
        ? ['PM', 'Afternoon', 'P.M.']
        : [cfg.timeSlot];
    const slotOk = await tryClickText(page, slotWords, { timeout: 4000 });
    if (!slotOk) log(`(No obvious ${cfg.timeSlot} slot — park may not use time slots. Continuing.)`);
  }

  // ---- Step 4: number of passes ----------------------------------------
  const n = String(cfg.passCount || 1);
  let qtyOk = false;
  try {
    const qty = page.getByLabel(/number|passes|quantity|people|party/i).first();
    await qty.selectOption(n).catch(async () => { await qty.fill(n); });
    log(`Set passes = ${n}`);
    qtyOk = true;
  } catch (_) { /* fall through */ }
  if (!qtyOk) {
    // Some UIs use a +/- stepper: click "+" (passCount-1) times.
    const plus = page.getByRole('button', { name: /^\+$|add|increase/i }).first();
    try {
      for (let i = 1; i < cfg.passCount; i++) { await plus.click({ timeout: 1500 }); }
      log(`Stepped passes up to ${n}`);
      qtyOk = true;
    } catch (_) { /* fall through */ }
  }
  if (!qtyOk) await pause(`Please set the number of passes to ${n}.`);

  await tryClickText(page, ['Next', 'Continue', 'Reserve', 'Get pass', 'Add to cart']);
  await page.waitForTimeout(1200);

  // ---- Step 5: personal details ----------------------------------------
  log('Filling in your contact details...');
  await tryFillLabel(page, ['First name', 'Given name', 'First'], cfg.contact.firstName);
  await tryFillLabel(page, ['Last name', 'Surname', 'Family name', 'Last'], cfg.contact.lastName);
  await tryFillLabel(page, ['Email', 'E-mail'], cfg.contact.email);
  // Some forms ask to confirm the email.
  await tryFillLabel(page, ['Confirm email', 'Re-enter email', 'Verify email'], cfg.contact.email);
  if (cfg.contact.phone) await tryFillLabel(page, ['Phone', 'Telephone', 'Mobile'], cfg.contact.phone);
  if (cfg.vehiclePlate) await tryFillLabel(page, ['Plate', 'Licence plate', 'License plate', 'Vehicle'], cfg.vehiclePlate);

  // Accept terms if present.
  try {
    const terms = page.getByRole('checkbox').first();
    await terms.check({ timeout: 2000 });
    log('Checked the terms/agreement box.');
  } catch (_) { /* none, or already checked */ }

  // ---- Step 6: review + submit -----------------------------------------
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('  ✅ The form should now be filled in.');
  console.log('  Please LOOK at the browser and check every field is correct');
  console.log('  (date, slot, number of passes, spelling of name/email).');
  console.log('────────────────────────────────────────────────────────────');

  if (cfg.autoSubmit) {
    log('autoSubmit is ON — submitting now.');
    const submitted = await tryClickText(page, ['Complete registration', 'Confirm', 'Submit', 'Finish', 'Reserve now']);
    if (!submitted) await pause('Could not find the submit button — please click it yourself.');
  } else {
    await pause('Review looks good? I will NOT auto-submit. Submit it yourself in the browser (recommended), then press ENTER.');
  }

  log('Done. Leave the browser open until you see the confirmation & check your email.');
  await ask('\nPress ENTER to close the browser and exit... ');
  await browser.close();
  rl.close();
}

run().catch((e) => {
  console.error('\n✖ Error:', e.message);
  console.error('  The browser is left open so you can finish manually if needed.');
});
