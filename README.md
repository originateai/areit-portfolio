# AREIT Portfolio Tracker — Complete Setup Guide

**Time required:** 45–60 minutes  
**Everything done in the browser — no software to install**

---

## What this builds

- **8:00am email** every weekday — US overnight signal, bond market, today's ASX trades, REIT yield status
- **4:00pm email** if any REIT hits 8% yield — immediate buy alert
- **Live dashboard** — REIT yields, P&L, deployment tracker, school fees coverage
- **Paper trading engine** — ASX morning scan, trades logged automatically

---

## Files in this project

```
areit-portfolio/
├── netlify.toml                     ← Scheduler and build config
├── package.json                     ← Dependencies (Supabase + Resend)
├── .env.example                     ← All environment variables (reference)
├── .gitignore
├── public/
│   └── index.html                   ← Live dashboard (8 pages)
├── netlify/
│   └── functions/
│       ├── _shared.js               ← Shared utilities (email, fetch, constants)
│       ├── morning-scan.js          ← 8:00am AEST — briefing + trade selection
│       ├── fetch-prices.js          ← 4:00pm AEST — closing prices + mark trades
│       ├── yield-triggers.js        ← 4:05pm AEST — REIT alerts
│       └── env.js                   ← Serves Supabase keys to dashboard
└── supabase/
    └── schema.sql                   ← Database tables + seed data
```

---

## STEP 1 — Unzip the files

1. Find `areit-portfolio.zip` in your Downloads folder
2. Right-click it → **Extract All**
3. Extract to: `C:\Users\James\Documents\areit-portfolio`
4. Open that folder — you should see the files listed above

---

## STEP 2 — Create GitHub repository

1. Go to **github.com** and sign in
2. Click the **+** button (top right) → **New repository**
3. Repository name: `areit-portfolio`
4. Visibility: **Private**
5. **Do NOT tick** "Add a README file" — leave everything unchecked
6. Click **Create repository**

---

## STEP 3 — Upload files to GitHub

GitHub lets you upload files and folders via the browser.

### Upload root files

1. On your new repo page, click **uploading an existing file**
2. Open `C:\Users\James\Documents\areit-portfolio` in Windows Explorer
3. Select these files (hold Ctrl to select multiple):
   - `netlify.toml`
   - `package.json`
   - `.gitignore`
   - `.env.example`
4. Drag them into the GitHub upload area
5. Commit message: `initial setup`
6. Click **Commit changes**

### Upload public folder

1. Back in your repo, click **Add file** → **Upload files**
2. Open Windows Explorer, go into the `public` folder
3. Drag `index.html` into GitHub
4. In the file path at the top, you'll need to add the folder — click on the filename box and type `public/` before `index.html`
   - The path should show: `public/index.html`
5. Commit message: `add dashboard`
6. Click **Commit changes**

### Upload netlify/functions folder

1. Click **Add file** → **Upload files**
2. Open Windows Explorer, navigate to `netlify/functions/`
3. Select all 5 files:
   - `_shared.js`
   - `morning-scan.js`
   - `fetch-prices.js`
   - `yield-triggers.js`
   - `env.js`
4. Drag them all into GitHub
5. In the path box, type `netlify/functions/` before the first filename
   - Path should show: `netlify/functions/_shared.js` etc
6. Commit message: `add netlify functions`
7. Click **Commit changes**

### Upload supabase folder

1. Click **Add file** → **Upload files**
2. Open `supabase/` folder in Explorer
3. Drag `schema.sql` into GitHub
4. In path box, type `supabase/` before the filename
5. Commit message: `add supabase schema`
6. Click **Commit changes**

### Verify the structure

Your repo should now look like:
```
areit-portfolio/
├── netlify.toml
├── package.json
├── .gitignore
├── .env.example
├── public/index.html
├── netlify/functions/_shared.js
├── netlify/functions/morning-scan.js
├── netlify/functions/fetch-prices.js
├── netlify/functions/yield-triggers.js
├── netlify/functions/env.js
└── supabase/schema.sql
```

If anything is in the wrong place — click the file, then click the pencil (edit), change nothing, and in the filename box at the top drag the cursor to the beginning and type the correct path.

---

## STEP 4 — Create Supabase project

1. Go to **supabase.com** and sign in
2. Click **New project**
3. Fill in:
   - Name: `areit-portfolio`
   - Database password: create something strong and save it
   - Region: **Southeast Asia (Singapore)**
4. Click **Create new project**
5. Wait 2 minutes for it to spin up

### Run the database schema

1. In your new Supabase project, click **SQL Editor** in the left sidebar
2. Click **New query**
3. On your computer, find `supabase/schema.sql`
4. Right-click → **Open with** → **Notepad**
5. Press **Ctrl+A** then **Ctrl+C** to copy everything
6. In Supabase SQL Editor, click in the editor area and press **Ctrl+V** to paste
7. Click the green **Run** button (or press Ctrl+Enter)
8. You should see: `Success. No rows returned`

If you see an error — paste it here and I'll fix it.

### Copy your API keys

1. In Supabase, click **Settings** (gear icon, bottom left) → **API**
2. Open Notepad and copy these three values into it:

```
Project URL:    https://xxxxxxxx.supabase.co
anon public:    eyJhbGc... (long string)
service_role:   eyJhbGc... (different long string — keep secret)
```

---

## STEP 5 — Get Resend API key

You're keeping this project separate from AI Compli so you need a new key.

1. Go to **resend.com** and sign in
2. Click **API Keys** in the left sidebar
3. Click **Create API key**
4. Name: `areit-portfolio`
5. Permission: **Sending access**
6. Domain: **All domains** (for now)
7. Click **Add**
8. Copy the key (starts with `re_`) — paste into Notepad

---

## STEP 6 — Get FRED API key (free)

FRED is the US Federal Reserve's free data service — gives us bond yields and macro data.

1. Go to: **fred.stlouisfed.org/docs/api/api_key.html**
2. Click **Request API Key**
3. Create a free account (email + password)
4. Your key arrives by email within a few minutes
5. Copy it into Notepad

---

## STEP 7 — Connect Netlify to GitHub

1. Go to **netlify.com** and sign in
2. Click **Add new site** → **Import an existing project**
3. Click **Deploy with GitHub**
4. If asked to authorise — click **Authorise Netlify**
5. Search for `areit-portfolio` and click it
6. Build settings — set these exactly:
   - Build command: **(leave completely blank)**
   - Publish directory: `public`
7. Click **Deploy site**
8. It deploys in ~30 seconds — you get a URL like `https://amazing-name-123.netlify.app`

---

## STEP 8 — Add environment variables to Netlify

This is the most important step. Go to:

**Netlify → your site → Site configuration → Environment variables → Add a variable**

Add each one:

| Variable name | Value | Where to get it |
|---|---|---|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | Supabase → Settings → API |
| `SUPABASE_ANON_KEY` | `eyJ...` (anon public) | Supabase → Settings → API |
| `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role) | Supabase → Settings → API |
| `RESEND_API_KEY` | `re_...` | Resend → API Keys |
| `ALERT_EMAIL` | `James.storey@outlook.com.au` | Your email |
| `FROM_EMAIL` | `onboarding@resend.dev` | Resend free sender |
| `FRED_API_KEY` | Your FRED key | Email from FRED |
| `MONTHLY_DEPLOY` | `12000` | Fixed |
| `SCHOOL_FEES` | `60000` | Fixed |
| `YIELD_TRIGGER` | `0.08` | Fixed |
| `VIX_TRIGGER` | `25` | Fixed |
| `IG_DEMO` | `true` | Fixed (Phase 2) |

After adding all 12 variables:
1. Click **Deploys** in left sidebar
2. Click **Trigger deploy** → **Deploy site**
3. Wait 30 seconds

---

## STEP 9 — Test everything

### Test the morning scan

1. Netlify → **Functions** tab (left sidebar)
2. You should see: `morning-scan`, `fetch-prices`, `yield-triggers`, `env`
3. Click `morning-scan`
4. Click **Test function**
5. Wait 15–20 seconds
6. You should see a green response:
   ```json
   { "signal": "LONG", "score": 5, "trades": 2, "triggered": 0 }
   ```
7. Check James.storey@outlook.com.au — email should arrive within 2 minutes
8. Check spam folder if nothing arrives

### Check Supabase

1. Supabase → **Table Editor** → `morning_signals`
   - Should have 1 row with today's date
2. `watchlist` — should have 28 stocks
3. `reit_holdings` — should have 6 rows (HDN, DXC, WPR, CQR, RGN, GSBG37)
4. `play_trades` — may have trades if signal was positive

### Test yield triggers

1. Netlify → Functions → `yield-triggers` → **Test function**
2. Check `alerts` table in Supabase

### View the dashboard

1. Netlify → **Site overview** → click the URL
2. Dashboard should load — REIT holdings page
3. Prices may show as dashes until 4pm when `fetch-prices` runs

---

## STEP 10 — Optional: rename your site

1. Netlify → **Site configuration** → **Site details**
2. Click **Change site name**
3. Type something like `areit-james` or `storey-portfolio`
4. Your URL becomes: `https://areit-james.netlify.app`

---

## What happens automatically every day

| Time (AEST) | What happens |
|---|---|
| **8:00am Mon–Fri** | Morning briefing email arrives at James.storey@outlook.com.au |
| **4:00pm Mon–Fri** | ASX closing prices fetched and saved |
| **4:00pm Mon–Fri** | Open paper trades closed at market price |
| **4:05pm Mon–Fri** | REIT yields checked — email if any hit 8% |

---

## Your daily routine

**8:00am** — Read the morning briefing email. 2 minutes.

**10:00am** — If trades were flagged, open the dashboard and note the positions.  
(Paper mode — nothing executes automatically yet)

**4:00pm alert** — If HDN, DXC or WPR hits 8% yield, you get an immediate email.  
Log into IG Markets → Share Trading → buy the flagged stock.

---

## Phase 2 — Coming next

Once the paper portfolio has 20+ closed trades:
- Switch from paper to live mode
- IG Markets API integration for automatic execution
- SMS alerts via Twilio
- KoyFin integration for visual confirmation

---

## Troubleshooting

**Functions tab shows no functions**
- Check `netlify.toml` is in the repo root (not in a subfolder)
- Trigger a new deploy

**Dashboard loads but shows nothing / loading forever**
- Press F12 → Console tab — paste any red errors here
- Check all 12 environment variables are set in Netlify
- Make sure you redeployed after adding variables

**Morning scan runs but no email**
- Check spam folder
- Check `FROM_EMAIL` is `onboarding@resend.dev`
- Check `RESEND_API_KEY` starts with `re_`
- Check Resend dashboard → Logs for any failures

**Schema.sql gives an error**
- Paste the exact error message here — I'll fix it

**Yahoo Finance returning no prices**
- Normal occasionally — Yahoo rate-limits requests
- Will retry the next scheduled run
- Can manually test `fetch-prices` function anytime

---

*Built for James Storey · 360 Capital Group · All alerts to James.storey@outlook.com.au*
