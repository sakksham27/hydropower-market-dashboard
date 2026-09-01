# Hydropower Market Dashboard

**Live:** [hydropower-market-dashboard.onrender.com](https://hydropower-market-dashboard.onrender.com)

A live dashboard that overlays **river streamflow**, **wholesale electricity prices**, and **short-range flow forecasts** on one screen, so a hydropower operator or energy trader can see, at a glance, when water and price line up to make generation most valuable.

Built on three free, public, government data sources. No paid market-data subscriptions required, and the app itself runs on a $0 hosting stack (see [Deployment](#deployment)).


## Why this exists

Hydropower generation decisions depend on two independent signals that are normally checked in two different places:

- **How much water is available** (streamflow), which determines how much power *can* be generated.
- **What that power is worth right now** (wholesale price), which determines whether it's worth generating.

This dashboard pulls both into one view, adds a forward-looking flow forecast, and layers in threshold-based alerting so you don't have to keep a browser tab open all day to catch a change.

## Features

- **Multi-page layout**: a Home overview, a Flows page, and a Pricing page, all reachable from the same nav bar.
- **Live data panels** for three independent sources, each pinnable, comparable, and searchable by ID:
  - **USGS streamflow** (Flows page): real-time river discharge (cfs) at any USGS gauge.
  - **NOAA NWPS short-range forecast** (Flows page): National Water Model forecasted flow for a river reach.
  - **NYISO real-time LBMP** (Pricing page): live wholesale electricity price at any NY grid pricing node (PTID).
- **Saved sites**: bundle a gauge + PTID + reach under one name (e.g. "Niagara Falls Plant"); selecting it fills in whichever IDs are relevant to the page you're on.
- **Threshold alerts**: set "notify me when X is above/below Y" per site and data source.
  - A background poller re-checks every 5 minutes, even with no browser open.
  - Edge-triggered, so a stuck violation doesn't spam repeat notifications.
  - Optional email delivery via any SMTP provider (Gmail app password, SendGrid, Mailgun, etc.).
- **In-app notification center**: bell icon with unread count and history.
- **Chart tools**: zoomable range slider, auto-scale toggle, CSV/JSON/XML export per panel.
- **Multi-user accounts**: signup/login with hashed passwords; each user has their own saved sites, alerts, and contact settings.
- **Historical persistence**: every fetched reading is upserted into Postgres, so data accumulates over time instead of being lost between fetches.

## Tech stack

- **Backend:** Python, Flask
- **Database:** PostgreSQL (via `psycopg2`), hosted on [Neon](https://neon.tech) (serverless Postgres, free tier)
- **Frontend:** Vanilla JavaScript, [Chart.js](https://www.chartjs.org/)
- **Auth:** Flask sessions, `werkzeug` password hashing (PBKDF2-SHA256)
- **CSRF protection:** Flask-WTF, covering both native forms and the JSON API (via a `fetch()`-patching header injection in `script.js`)
- **Production server:** gunicorn (single worker; see [Deployment](#deployment) for why)
- **Hosting:** [Render](https://render.com) (free web service tier)
- **Email:** stdlib `smtplib` (generic SMTP, provider-agnostic)

## Project layout

```
app/
├── app.py               # Flask routes, external API fetch/clean logic, alert poller
├── db.py                 # Postgres schema + queries
├── requirements.txt
├── Procfile               # Production start command (gunicorn, single worker)
├── .python-version         # Pins the Python version used to build/run on Render
├── static/
│   ├── script.js            # Dashboard UI logic, charts, alerts, saved sites
│   ├── start.js
│   └── style.css
└── templates/
    ├── home.html             # Home overview (placeholder for now)
    ├── flows.html             # USGS streamflow + NOAA forecast panels
    ├── pricing.html            # NYISO price panel
    ├── _header.html             # Shared page header + nav bar (included on every page)
    ├── _modals.html              # Shared Manage Sites / Manage Alerts / chart-expand modals
    └── start.html                # Login / signup
```

## Data sources

| Source | What it provides | Docs |
|---|---|---|
| USGS Water Services | Real-time streamflow (discharge, cfs) | waterservices.usgs.gov |
| NYISO | Real-time locational-based marginal price (LBMP) | nyiso.com |
| NOAA NWPS | National Water Model short-range streamflow forecast | water.noaa.gov |

All three are free and require no API key.

## Setup (local development)

### Prerequisites

- Python 3.11 (matches what's pinned for production; 3.9+ also works locally)
- A Postgres database: either running locally, or a free instance from [Neon](https://neon.tech) (no card required)

### Install

```bash
cd app
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Configure environment

Create `app/.env`:

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=water_data
DB_USER=postgres
DB_PASSWORD=your_password
# "prefer" works for both local Postgres (no SSL) and a hosted provider
# like Neon that requires it - no per-environment config needed.
DB_SSLMODE=prefer
SECRET_KEY=some_random_secret_key

# Optional: set to "true" to enable Flask's debug mode (auto-reload,
# interactive debugger). Leave unset/false anywhere reachable over the
# network: the debugger allows arbitrary code execution.
FLASK_DEBUG=false

# Optional: leave blank to skip real email sends (logged instead)
SMTP_HOST=
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
```

The app creates its own tables on startup (`users`, `saved_sites`, `alert_thresholds`, `alert_notifications`, and one table per data source). No manual migrations needed.

### Run

```bash
cd app
python app.py
```

Visit `http://localhost:5050`.

## Deployment

The live site runs on a **$0 hosting stack**: [Render](https://render.com) for the app, [Neon](https://neon.tech) for the database. Both have genuinely free tiers (no time-limited trial, no card required for signup), chosen deliberately over the alternatives:

- **Not SQLite**: Render's free web service has an *ephemeral filesystem*; a local SQLite file would be wiped on every restart, redeploy, or the automatic spin-down after 15 minutes of inactivity.
- **Not Render's own Postgres add-on**: its free tier currently expires 30 days after creation. Neon's free tier has no such expiry.

### Deploying this app yourself

1. **Create a Neon project** at neon.tech and grab its connection details (host, database, user, password) from the dashboard.
2. **Create a Render Web Service**, connected to your fork of this repo:

   | Setting | Value |
   |---|---|
   | Root Directory | `app` |
   | Runtime | Python 3 |
   | Build Command | `pip install -r requirements.txt` |
   | Start Command | `gunicorn app:app --bind 0.0.0.0:$PORT --workers 1` |
   | Instance Type | Free |

3. **Set environment variables** on Render (same names as the local `.env` above): `SECRET_KEY`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_SSLMODE=require` (Neon requires SSL; locally we default to `prefer` since local Postgres doesn't need it).
4. Deploy. Render builds and gives you a public `*.onrender.com` URL.

**Gotcha we hit going through this ourselves:** Render defaults to the newest available Python (3.14 at time of writing), which broke `psycopg2-binary`'s compiled extension (no compatible wheel yet: `undefined symbol: _PyInterpreterState_Get`). Fixed by pinning the version via `app/.python-version` (`3.11.9`), worth setting from the start rather than hitting this on your first deploy.

**Why `--workers 1` is required, not optional:** the alert poller runs as a background thread inside the web process itself, started once at import time. More than one gunicorn worker means more than one poller, which means duplicate alert checks and duplicate emails.

### Known limitations of the free tier

- Render's free web service sleeps after 15 minutes with no traffic, so the first request after a quiet period is slow (~1 minute cold start).
- The alert poller only runs while the process is awake: it doesn't reliably fire on its own 5-minute schedule during quiet periods, only resuming when a visit wakes the app back up. An external scheduled pinger (hitting the site periodically) would fix this, but isn't set up yet.

## Usage

1. Sign up for an account.
2. Use the nav bar to go to **Flows** (USGS gauge + NOAA reach) or **Pricing** (NYISO PTID), enter an ID in a panel, and hit Submit.
3. Pin frequently used IDs, or save a combination of all three under one site name from the profile menu.
4. Open **Manage Alerts** from the profile menu to set thresholds and, optionally, email notifications.

## Security notes

- Passwords are hashed with PBKDF2-SHA256, never stored in plain text.
- All SQL is parameterized: no string-built queries from user input.
- Every route that reads or writes user-specific data requires login.
- CSRF protection (Flask-WTF) covers both native forms and the JSON API.
- Flask's debug mode (which exposes an interactive, code-executing debugger on error pages) is off by default and must be explicitly opted into via `FLASK_DEBUG=true`; never set that where the app is reachable over the network.

## Industry relevance

This is a lightweight version of the kind of market-integration dashboards used at small-to-mid hydroelectric facilities, built entirely from free public data instead of paid feeds:

- **Generation scheduling**: decide when to run turbines based on both water availability and market price in one view, instead of checking separate government portals.
- **Revenue optimization**: the price × flow overlay approximates what an energy trading desk does manually to spot high-value generation windows.
- **Forecast-informed planning**: the NOAA short-range forecast lets an operator anticipate flow changes before they happen.
- **Proactive monitoring**: threshold alerts remove the need for constant manual checking, useful for smaller operators without a 24/7 control room.

## License

MIT. See [LICENSE](LICENSE).
