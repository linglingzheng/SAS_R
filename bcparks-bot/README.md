# BC Parks Day-Use Pass Helper 🏔️

A small script that opens the real BC Parks day-use site in a browser **on your
own computer**, waits for the 7:00 AM release, and fills in the registration
form for you (park, date, AM/PM slot, number of passes, your name/email/phone).

It keeps **you** in control of the parts a bot shouldn't do alone: the virtual
waiting-room queue, any CAPTCHA, and the final "Submit". Think of it as a fast,
accurate typist that never oversleeps — not a fully automatic scalping bot.

Target park: **Pipi7íyekw / Joffre Lakes** (works for other day-use parks too).

---

## The one rule that matters most: timing ⏰

Passes are released at **7:00 AM Pacific, exactly 2 days before** your visit,
and **max 4 passes per transaction**. They can sell out fast. So:

| You want to visit | Passes release at | Run the script |
|---|---|---|
| Thu **Jul 9** | Tue Jul 7, 7:00 AM | Tue Jul 7, ~6:55 AM |
| Fri **Jul 10** | Wed Jul 8, 7:00 AM | Wed Jul 8, ~6:55 AM |

(Jul 7 and Jul 8 visit dates already released on Jul 5 and Jul 6 — check the
site for any leftover spots, but the timed run won't help for those.)

You book **one visit date per run**. To grab both Jul 9 and Jul 10, run it once
each morning with the matching `visitDate` in `config.json`.

---

## Setup (do this once, the day before)

You need [Node.js](https://nodejs.org) 18+ installed. Then in a terminal:

```bash
cd bcparks-bot
npm install            # installs Playwright + a browser (~1–2 min)
cp config.example.json config.json
```

Open `config.json` and fill in your details:

```jsonc
{
  "park": "Joffre Lakes",
  "visitDate": "2026-07-09",   // the day you want to hike (YYYY-MM-DD)
  "timeSlot": "AM",            // "AM", "PM", or "" if the park has no slots
  "passCount": 2,              // 1–4; one per person aged 13+
  "contact": {
    "firstName": "Jane",
    "lastName": "Doe",
    "email": "jane@example.com",
    "phone": "6045551234"
  },
  "vehiclePlate": "",          // only if the form asks for it
  "releaseTime": "07:00",
  "timezone": "America/Vancouver",
  "headless": false,           // keep false so you can watch & help
  "autoSubmit": false          // false = you click the final Submit (safer)
}
```

`config.json` is git-ignored, so your personal info is never committed.

---

## Running it — three modes

**1. Wait for the 7 AM release** (best for a brand-new date dropping):
```bash
npm run wait
```
Opens the browser, warms the page, counts down, reloads until 7:00:00, then
drives the form the moment passes go live.

**2. Monitor for availability / cancellations** (best for a date that's already
sold out — spots reappear when people cancel):
```bash
node reserve.js --monitor              # checks every 25s for 60 min
node reserve.js --monitor --minutes 120 --every 20
```
It keeps re-checking your date politely, prints the status each time, and the
moment a pass opens it **sounds an alarm** and automatically fills in your
details. Sample output:
```
[06:59:55] check #1: no pass — date 2026-07-09 is disabled/greyed out  (60 min left)
[07:00:20] 🎉 A PASS LOOKS AVAILABLE for 2026-07-09! Grabbing it now...
[07:00:22] Filled "First name" = Jane
[07:00:22] Filled "Email" = jane@example.com
```
Keep the interval at 20s+ so you stay a polite, human-like visitor and don't
get rate-limited/blocked.

**3. Go now** (test the flow, or grab leftover passes right away):
```bash
npm start
```

### How the personal-information entry works

Once a pass is secured, BC Parks asks for very little — it's a free pass, so
**there's no payment and no account/login required**. The registration screen
typically asks for:

| Field | Comes from `config.json` | Notes |
|---|---|---|
| First name | `contact.firstName` | the pass holder |
| Last name | `contact.lastName` | |
| Email | `contact.email` | your pass/QR code is emailed here — use a real one |
| Confirm email | `contact.email` | filled with the same value if asked |
| Phone | `contact.phone` | sometimes optional |
| Number of passes | `passCount` | 1–4; one per person aged 13+ |
| Vehicle plate | `vehiclePlate` | only some parks/flows ask; leave "" if unsure |
| Agree to terms | (auto-checked) | the script ticks the checkbox |

The script types all of these for you. If BC Parks has renamed a field and the
script can't find it, it **pauses and asks you to fill that one box**, then you
press Enter and it carries on — so a layout change never leaves you stuck.

### What you'll see

1. A real Chrome window opens on the BC Parks site.
2. If there's a **virtual waiting room / queue**, let it sit — it forwards you
   automatically. Don't close it.
3. The script clicks through: park → date → time slot → number of passes →
   your contact details.
4. If the site's layout has shifted and it can't find a field, it **pauses**
   and asks you to click that one thing, then press **Enter** to continue.
5. It stops before the final Submit so you can eyeball everything. Click
   **Submit / Complete registration** yourself (or set `autoSubmit: true`).
6. Wait for the on-screen confirmation and the email. Save/screenshot your pass.

---

## Tips for actually getting a pass

- Have `config.json` ready and `npm install` done **the night before**.
- Start `npm run wait` by ~6:55 AM so the browser is warm.
- Good, wired internet helps more than anything.
- If it sells out, spots sometimes reappear from cancellations — re-run later.

## Good to know

- Day-use passes are **free**. Passes are **not required for kids 12 and under**
  when with a pass-holding adult, so don't count them in `passCount`.
- **2026 Joffre closures:** the park is closed **Jun 20–27** and **Sep 8–30**
  for First Nations cultural practices and conservation. Your July dates are open.
- If you have an overnight camping reservation, you don't need a day-use pass.
- This talks only to the official site (`reserve.bcparks.ca`), stores nothing
  remotely, and doesn't defeat CAPTCHAs or queues. Use it for your own personal
  bookings and be considerate — it's a shared public resource. Automated access
  may be subject to BC Parks' terms of use; you're responsible for how you use it.
```
