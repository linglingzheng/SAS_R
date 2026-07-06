#!/usr/bin/env node
/*
 * BC Parks Day-Use Pass helper (Joffre Lakes / Pipi7íyekw and other parks)
 * ------------------------------------------------------------------------
 * Runs a real browser ON YOUR COMPUTER. Three modes:
 *
 *   node reserve.js               → go now: fill the form for your date/slot
 *   node reserve.js --wait        → sit idle, start at the 7:00 AM release
 *   node reserve.js --monitor     → keep checking availability (default 60 min),
 *                                    alarm + auto-fill the moment a pass opens up
 *
 * Extra flags:
 *   --minutes 90     how long --monitor keeps trying (default 60)
 *   --every 25       seconds between checks in --monitor (default 25, min 10)
 *   --config x.json  use a different config file
 *
 * It never solves CAPTCHAs or skips the virtual waiting room for you — you
 * handle those; the script handles the timing, watching, and typing.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Real site by default. Overridable via BCPARKS_URL for local testing/mocks.
const REGISTRATION_URL = process.env.BCPARKS_URL || 'https://reserve.bcparks.ca/dayuse/registration';

// ---------- cli / config ---------------------------------------------------

function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? (process.argv[i + 1] ?? true) : def;
}
const OPTS = {
  wait: process.argv.includes('--wait'),
  monitor: process.argv.includes('--monitor'),
  minutes: Number(flag('--minutes', 60)),
  every: Math.max(10, Number(flag('--every', 25))),
};

function loadConfig() {
  const file = flag('--config', path.join(__dirname, 'config.json'));
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

// ---------- small utilities ------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
const pause = (msg) => ask(`\n⏸  ${msg}\n   → Press ENTER when done to continue... `);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('en-CA', { hour12: false })}] ${m}`);
function alarm(times = 6) { for (let i = 0; i < times; i++) process.stdout.write('\x07'); } // terminal bell

function msUntilRelease(releaseTime, timezone) {
  const [hh, mm] = releaseTime.split(':').map(Number);
  const parkNow = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const target = new Date(parkNow);
  target.setHours(hh, mm, 0, 0);
  return target.getTime() - parkNow.getTime();
}

// ---------- resilient element helpers --------------------------------------

async function tryClickText(page, texts, { timeout = 2500 } = {}) {
  for (const t of texts) {
    const loc = page.getByRole('button', { name: t, exact: false }).or(page.getByText(t, { exact: false }));
    try { await loc.first().click({ timeout }); log(`Clicked: "${t}"`); return true; } catch (_) {}
  }
  return false;
}
async function tryFillLabel(page, labels, value, { timeout = 2500 } = {}) {
  for (const l of labels) {
    try { await page.getByLabel(l, { exact: false }).first().fill(value, { timeout }); log(`Filled "${l}" = ${value}`); return true; } catch (_) {}
    try { await page.getByPlaceholder(l, { exact: false }).first().fill(value, { timeout }); log(`Filled (placeholder) "${l}" = ${value}`); return true; } catch (_) {}
  }
  return false;
}

// ---------- availability check (best-effort, DOM-agnostic) -----------------
// Returns { available: bool, reason: string }. We look for the target date
// being selectable and the absence of "sold out"/"unavailable" language.
async function checkAvailability(page, cfg) {
  try {
    await page.goto(REGISTRATION_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    return { available: false, reason: `page load failed: ${e.message.split('\n')[0]}` };
  }
  await page.waitForTimeout(2500);

  // Dismiss cookie banners so they don't hide content.
  await tryClickText(page, ['Accept', 'Accept all cookies', 'Got it'], { timeout: 2500 }).catch(() => {});

  const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();

  // If the whole site is in a virtual waiting room, say so — that's not "no pass".
  if (/waiting room|you are in line|estimated wait|queue/i.test(bodyText)) {
    return { available: null, reason: 'virtual waiting room — wait it out in the browser' };
  }

  // Select the park (fuzzy) so the calendar renders.
  await tryClickText(page, [cfg.park, 'Joffre', 'Pipi7íyekw'], { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const dayNum = String(Number(cfg.visitDate.split('-')[2]));
  // Is the target day cell present and NOT disabled?
  let cellEnabled = null;
  try {
    const cell = page.getByRole('button', { name: new RegExp(`^\\s*${dayNum}\\s*$`) })
      .or(page.locator(`[aria-label*="${cfg.visitDate}"]`)).first();
    if (await cell.count()) {
      const disabled = await cell.getAttribute('disabled');
      const ariaDis = await cell.getAttribute('aria-disabled');
      const cls = (await cell.getAttribute('class')) || '';
      cellEnabled = !(disabled !== null || ariaDis === 'true' || /disabled|unavailable|sold/i.test(cls));
    }
  } catch (_) {}

  const soldOut = /sold out|no passes|not available|fully booked|no availability/i.test(bodyText);

  if (cellEnabled === true) return { available: true, reason: `date ${cfg.visitDate} looks selectable` };
  if (cellEnabled === false) return { available: false, reason: `date ${cfg.visitDate} is disabled/greyed out` };
  if (soldOut) return { available: false, reason: 'page shows sold-out/unavailable text' };
  // Couldn't tell for sure — surface it so the human can glance at the browser.
  return { available: null, reason: 'could not read availability automatically — check the browser' };
}

// ---------- the form-fill flow ---------------------------------------------

async function fillForm(page, cfg) {
  await tryClickText(page, ['Accept', 'I accept', 'Accept all cookies', 'Got it'], { timeout: 1500 });
  log('If a "waiting room"/queue is showing, DO NOT touch anything — it forwards you automatically.');

  // Park
  let ok = await tryClickText(page, [cfg.park, 'Joffre', 'Pipi7íyekw']);
  if (!ok) {
    try {
      const sel = page.getByLabel(/park/i).first();
      await sel.selectOption({ label: cfg.park }).catch(async () => { await sel.click(); await tryClickText(page, [cfg.park, 'Joffre']); });
      ok = true;
    } catch (_) {}
  }
  if (!ok) await pause(`Please click the park "${cfg.park}" in the browser.`);
  await page.waitForTimeout(1000);
  await tryClickText(page, ['Next', 'Continue', 'Confirm']);

  // Date
  const dayNum = String(Number(cfg.visitDate.split('-')[2]));
  let dateOk = false;
  try {
    const cell = page.getByRole('button', { name: new RegExp(`^\\s*${dayNum}\\s*$`) })
      .or(page.locator(`[aria-label*="${cfg.visitDate}"]`)).first();
    await cell.click({ timeout: 5000 });
    log(`Picked date ${cfg.visitDate}`); dateOk = true;
  } catch (_) {}
  if (!dateOk) await pause(`Please pick the date ${cfg.visitDate} in the calendar.`);
  await page.waitForTimeout(800);

  // Time slot
  if (cfg.timeSlot) {
    const words = cfg.timeSlot.toUpperCase() === 'AM' ? ['AM', 'Morning', 'A.M.']
      : cfg.timeSlot.toUpperCase() === 'PM' ? ['PM', 'Afternoon', 'P.M.'] : [cfg.timeSlot];
    const slotOk = await tryClickText(page, words, { timeout: 4000 });
    if (!slotOk) log(`(No obvious ${cfg.timeSlot} slot — park may not use time slots. Continuing.)`);
  }

  // Number of passes
  const n = String(cfg.passCount || 1);
  let qtyOk = false;
  try {
    const qty = page.getByLabel(/number|passes|quantity|people|party/i).first();
    await qty.selectOption(n).catch(async () => { await qty.fill(n); });
    log(`Set passes = ${n}`); qtyOk = true;
  } catch (_) {}
  if (!qtyOk) {
    const plus = page.getByRole('button', { name: /^\+$|add|increase/i }).first();
    try { for (let i = 1; i < cfg.passCount; i++) await plus.click({ timeout: 1500 }); log(`Stepped passes up to ${n}`); qtyOk = true; } catch (_) {}
  }
  if (!qtyOk) await pause(`Please set the number of passes to ${n}.`);
  await tryClickText(page, ['Next', 'Continue', 'Reserve', 'Get pass', 'Add to cart']);
  await page.waitForTimeout(1200);

  // Personal details
  log('Filling in your contact details...');
  await tryFillLabel(page, ['First name', 'Given name', 'First'], cfg.contact.firstName);
  await tryFillLabel(page, ['Last name', 'Surname', 'Family name', 'Last'], cfg.contact.lastName);
  await tryFillLabel(page, ['Email', 'E-mail'], cfg.contact.email);
  await tryFillLabel(page, ['Confirm email', 'Re-enter email', 'Verify email'], cfg.contact.email);
  if (cfg.contact.phone) await tryFillLabel(page, ['Phone', 'Telephone', 'Mobile'], cfg.contact.phone);
  if (cfg.vehiclePlate) await tryFillLabel(page, ['Plate', 'Licence plate', 'License plate', 'Vehicle'], cfg.vehiclePlate);
  try { await page.getByRole('checkbox').first().check({ timeout: 2000 }); log('Checked the terms/agreement box.'); } catch (_) {}

  // Review + submit
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('  ✅ The form should now be filled in. LOOK at the browser and');
  console.log('  check every field (date, slot, # passes, name/email spelling).');
  console.log('────────────────────────────────────────────────────────────');
  if (cfg.autoSubmit) {
    log('autoSubmit is ON — submitting now.');
    const done = await tryClickText(page, ['Complete registration', 'Confirm', 'Submit', 'Finish', 'Reserve now']);
    if (!done) await pause('Could not find the submit button — please click it yourself.');
  } else {
    await pause('Review looks good? I will NOT auto-submit. Click Submit yourself in the browser, then press ENTER.');
  }
  log('Done. Leave the browser open until you see the confirmation & check your email.');
}

// ---------- release-wait mode ----------------------------------------------

async function spinUntilRelease(page, cfg) {
  await page.goto(REGISTRATION_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  let remaining = msUntilRelease(cfg.releaseTime || '07:00', cfg.timezone || 'America/Vancouver');
  while (remaining > 0) {
    process.stdout.write(`\r  ⏳ ${Math.ceil(remaining / 1000)}s until ${cfg.releaseTime} release — reloading...   `);
    await sleep(Math.min(remaining, 5000));
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    remaining = msUntilRelease(cfg.releaseTime || '07:00', cfg.timezone || 'America/Vancouver');
  }
  console.log('\n  🚀 Release time! Go go go.');
  alarm();
}

// ---------- monitor mode ---------------------------------------------------

async function monitorLoop(page, cfg) {
  const deadline = Date.now() + OPTS.minutes * 60 * 1000;
  let n = 0;
  console.log(`\n  👀 Monitoring ${cfg.park} for ${cfg.visitDate} (${cfg.timeSlot || 'any slot'})`);
  console.log(`  Checking every ${OPTS.every}s for up to ${OPTS.minutes} min. Ctrl-C to stop.\n`);
  while (Date.now() < deadline) {
    n++;
    const res = await checkAvailability(page, cfg);
    const left = Math.round((deadline - Date.now()) / 60000);
    if (res.available === true) {
      alarm(10);
      console.log('\n════════════════════════════════════════════════════════════');
      console.log(`  🎉 A PASS LOOKS AVAILABLE for ${cfg.visitDate}! (${res.reason})`);
      console.log('  Grabbing it now — filling in your details...');
      console.log('════════════════════════════════════════════════════════════\n');
      await fillForm(page, cfg);
      return true;
    }
    log(`check #${n}: ${res.available === false ? 'no pass' : 'unclear'} — ${res.reason}  (${left} min left)`);
    if (Date.now() >= deadline) break;
    await sleep(OPTS.every * 1000);
  }
  console.log('\n  ⏱  Monitor window ended without finding a confirmed opening.');
  console.log('     Cancellations can appear anytime — try again, or run with --minutes 120.');
  return false;
}

// ---------- main -----------------------------------------------------------

async function run() {
  const cfg = loadConfig();
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  BC Parks Day-Use Pass helper');
  console.log(`  Park:   ${cfg.park}${cfg.trail ? ' / ' + cfg.trail : ''}`);
  console.log(`  Date:   ${cfg.visitDate}   Slot: ${cfg.timeSlot || '(any)'}   Passes: ${cfg.passCount}`);
  console.log(`  Name:   ${cfg.contact.firstName} ${cfg.contact.lastName}   <${cfg.contact.email}>`);
  console.log('  Passes are free; up to 4/transaction; each person 13+ needs one.');
  console.log('════════════════════════════════════════════════════════════');

  const launchOpts = { headless: !!cfg.headless, args: ['--start-maximized'] };
  if (process.env.PW_EXECUTABLE) launchOpts.executablePath = process.env.PW_EXECUTABLE; // test override only
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  try {
    if (OPTS.monitor) {
      await monitorLoop(page, cfg);
    } else {
      if (OPTS.wait) { await spinUntilRelease(page, cfg); }
      else { await page.goto(REGISTRATION_URL, { waitUntil: 'domcontentloaded' }); }
      log('Page loaded.');
      await page.waitForTimeout(1200);
      await fillForm(page, cfg);
    }
  } catch (e) {
    console.error('\n✖ Error:', e.message.split('\n')[0]);
    console.error('  The browser is left open so you can finish manually.');
  }

  await ask('\nPress ENTER to close the browser and exit... ');
  await browser.close();
  rl.close();
}

run();
