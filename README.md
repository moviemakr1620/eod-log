# EOD Log: end of day crew log

A small self-hosted web app that replaces the daily "Reply to this email with your hours" thread.
Crew log each job day from their phone (project, who worked, everyone's own start and stop times, expenses with receipt photos, vehicle, media, gear, notes),
everything is stored in a local SQLite database on the NAS, and managers get **summary emails on the schedule you choose** (daily, weekdays or weekly; as many as you like, each with its own recipients) with hours per person and per job, and what to reimburse. No EODs in the period = no email.

Built for film shoots, AV installs and live events. Mobile first: big tap targets, the phone's own date and time pickers, a floating **+ New EOD** button, add-to-home-screen (PWA).

**Status:** v2: start/stop hours, multiple notification schedules, and the time-saving fix. Tested in Docker with a fake mail server and in emulated iPhone/Android browsers (see "Testing"). No real email has been sent by the developer.

| Week view | New EOD | Entry with receipt | Notifications | Summary email |
|---|---|---|---|---|
| ![week](preview/01-week.png) | ![new](preview/04-new-eod-filled.png) | ![detail](preview/05-entry-detail.png) | ![settings](preview/06-settings.png) | ![email](preview/07-summary-email.png) |

## What it does

- **+ New EOD** (floating button on phones): job / project, date, job type (Film shoot, AV install, Live event, Edit / DIT, Other).
- **Crew & hours, per person.** Each person gets their own **Start** and **Stop**, and that's what makes the hours. Meal breaks are off by default: tap **+ Add meal break** for anyone who took one.
  Site time works the same way: **+ Add site time** reveals **On site** and **Off site** for that person (shown as a secondary on-site hours figure; it never changes the hours). A **More** fold-out holds role, Edit/DIT hours, a note, and "hours, if not using start/stop" for someone who just knows their total.
  On phones and tablets the time fields use the native time picker. On desktop they are plain text fields: type `7`, `730`, `7:30p` or `19:30` (or pick from the 15-minute list) and it tidies to e.g. `7:30 PM` when you leave the field. A half-typed or unreadable time is outlined in red and the EOD will not save until it is fixed, so nothing is silently dropped.
  Hours are worked out live as you type. **Add crew** starts the new person with the first person's times, and **Copy times to everyone** syncs them.
- **The rest of the old email** sits in fold-away sections so the quick path stays short: client, location, crew chief, time zone; expenses and receipts; vehicle, miles and tolls; # media taken and used; equipment requested by the client and equipment taken, provided and used; issues and damage; notes.
- **Expenses**: one line per receipt with amount, category, who paid, and **Company card** or **Personal (reimburse)**. Each line takes photos (camera or library) or PDFs. Big phone photos are shrunk in the browser to about 2000 px JPEG before upload, so uploads are fast and the NAS stays small.
- **Remembers**: crew names, projects, clients, locations, vehicles and roles autocomplete from past entries. **Duplicate for another day** copies a job and its crew for multi-day jobs. Unsaved new entries are kept as a draft on the phone (photos excepted).
- **Week view**: a week navigator with a date picker, totals (EODs, crew hours, expenses, to reimburse), hours by person, and entry cards grouped by day.
- **List view**: search (job, client, location, crew, notes) and filters (job type, person, date range), as cards.
- **Entry page**: every time per person, receipts as thumbnails, plus Edit, Duplicate and Delete (admin).
- **Email notifications** (Settings, admin): add as many as you want. Each has a name, its own recipients, **how often** (every day, weekdays, or weekly on a chosen day), the send time and time zone, an on/off switch, and an option to attach receipts.
  Each email has totals, hours by person (with Edit/DIT and the amount to reimburse), jobs, every EOD with a link, and an expense list that flags missing receipts.
  **If there are no EODs in the period, nothing is sent**; it's logged as *skipped*. Each notification has **Preview** and **Send test**, and Settings shows a notification log.
- **CSV export** of hours (one row per person per day) and expenses, for payroll or spreadsheets.

### How hours are counted

- **Hours = Stop − Start − any meal breaks entered.** No meal entered = nothing deducted.
- Stop earlier than Start counts as past midnight (6pm to 2am = 8 h).
- On site / Off site are for the record only and **never change hours**. When On site and Off site are both filled in, the entry also shows **on-site hours**.
- If "hours, if not using times" is filled in, it wins.
- Edit/DIT hours are tracked separately and shown next to the hours, not added to them.

Want a different rule? It's one function: `public/hours.js` (shared by the browser and the server, with tests in `test/hours.test.js`).

## Sign-in and passwords

- **`APP_PASSWORD`** (required): one shared team password. Each person signs in once per phone (they can type their name so forms are pre-filled with it) and stays signed in for `SESSION_DAYS` (default 180).
- **`ADMIN_PASSWORD`** (optional, recommended): needed for **Settings**, **sending the summary**, and **deleting** entries. Anyone signs in with the team password; a manager can type the admin password at sign-in or when asked.
  If `ADMIN_PASSWORD` is empty, every signed-in person can do everything.
- Changing either password signs everyone out (sessions are signed with a key derived from them).
- Password tries are limited to 10 per 10 minutes per IP. The cookie is HttpOnly, SameSite=Lax, and Secure when the site is reached over https.
- Receipts are only served to signed-in users.
- Real passwords go in `.env` on the NAS or in Portainer's environment variables, **never in git** (`.env` is git-ignored).

## Run it with Docker Compose (on the NAS)

Needs Docker with the Compose plugin (Synology Container Manager, QNAP Container Station, TrueNAS, Unraid or plain Docker all work) and git on the NAS. Everything runs in **one container** (Node 22 + SQLite, non-root user `node`, uid 1000).

```bash
# first time only: clone (the repo is private, so git needs credentials; see "Git access on the NAS" below)
git clone https://github.com/moviemakr1620/eod-log.git eod-log
cd eod-log
cp .env.example .env        # then edit: APP_PASSWORD, ADMIN_PASSWORD, PUBLIC_URL, SMTP_*
docker compose build
docker compose up -d
docker compose logs -f      # should say: listening on :8080

# every later update: ALWAYS pull first, then rebuild
git pull
docker compose build
docker compose up -d
```

**Always run `git pull` before `docker compose build`**, otherwise you rebuild the old code. Your `.env` and the data volume are not in git, so a pull never touches them.

Then open **`http://<nas-ip>:7240`** on your phone and sign in. To put it on the home screen: Safari > Share > **Add to Home Screen**, or Chrome > ⋮ > **Add to Home screen** / **Install app**.

### Compose contract

- Service and container: **`eod-log`**, image `eod-log:latest`, `restart: unless-stopped`, healthcheck on `GET /healthz`.
- **Port:** `ports: "${EOD_PORT:-7240}:8080"`. The container listens on 8080; the NAS publishes it on **7240** (change `EOD_PORT` in `.env`).
- **Data:** named volume **`eod-data`** (real name `eod-log_eod-data`) mounted at `/data`. It holds:
  - `/data/eod.sqlite` (the database, WAL mode)
  - `/data/uploads/` (receipt files)
  - `/data/.session-secret` (made on first start)
- Hardening: `read_only: true` (with `tmpfs` on `/tmp`), `cap_drop: ALL`, and `no-new-privileges`.
- **Bind mount instead of a volume** (e.g. a NAS share you back up): replace `eod-data:/data` with `/volume1/docker/eod-log:/data`, then run `sudo chown -R 1000:1000 /volume1/docker/eod-log` once. The container runs as uid 1000 and must be able to write there.

### Backups

Back up the volume or bind-mount folder. That covers the database and receipts. For a consistent copy while it is running:
```bash
docker exec eod-log node -e "require('better-sqlite3')('/data/eod.sqlite').backup('/data/backup.sqlite').then(()=>console.log('ok'))"
```
then copy `backup.sqlite` and `uploads/` off the NAS (Hyper Backup, rsync, etc.).

### Portainer

**Easiest: use the prebuilt image.** Every push to `main` makes GitHub Actions build the app and publish it as `ghcr.io/moviemakr1620/eod-log:latest` (amd64 and arm64, so Intel and ARM NAS both work). Nothing needs to be built on the NAS.
1. **Stacks > Add stack > Web editor**, name it `eod-log`, and paste **`docker-compose.portainer.yml`**.
2. Under **Environment variables**, add at least `APP_PASSWORD`, and ideally `ADMIN_PASSWORD`, `PUBLIC_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` and `MANAGER_EMAILS` (every variable is listed below).
3. **Deploy the stack.** The container should turn *healthy*.
4. To update later: open the stack, click **Update the stack**, and turn on **Re-pull image**.

The image package must be public for Portainer to pull it without a login (GitHub > your profile > Packages > `eod-log` > Package settings > Change visibility > Public). If you keep it private, add a registry in Portainer (**Registries > Add registry > Custom**, URL `ghcr.io`, your GitHub username, and a personal access token with only `read:packages`).

**Alternative: build from the repo.** **Stacks > Add stack > Repository**, URL `https://github.com/moviemakr1620/eod-log`, reference `refs/heads/main`, compose path `docker-compose.yml`. Portainer clones and builds it itself. Add the same environment variables.

Pick one way to run it: either `docker compose up -d` in the folder or the Portainer stack. They use the same container name.
*Easiest overall:* run `docker compose up -d` in the folder; Portainer still shows the container.

### Behind Nginx Proxy Manager + Cloudflare (optional)

Local access on port 7240 works without this. To reach it by name or from outside:
1. In **NPM > Proxy Hosts > Add Proxy Host**, set:
   - **Domain:** e.g. `eod.yourcompany.com`
   - **Scheme:** `http`
   - **Forward Hostname / IP:** `<nas-ip>`
   - **Port:** `7240`
   - **Websockets:** off
   - **Block Common Exploits:** on
   - **SSL tab:** Let's Encrypt or a Cloudflare Origin cert, with **Force SSL** on.
2. Raise NPM's upload limit for receipt photos. Under the **Advanced** tab, add `client_max_body_size 50m;`.
3. In Cloudflare, add DNS for `eod` as **Proxied** and set SSL/TLS to **Full (strict)**. Cloudflare's free plan allows 100 MB uploads, which is plenty.
4. Set `PUBLIC_URL=https://eod.yourcompany.com` so links in the email work, then run `docker compose up -d` (no rebuild needed; it's a runtime variable).

This puts a login page on the internet, protected only by the shared password. If the NAS is office-only, leave it on the LAN or VPN. Cloudflare Access (Zero Trust, free for small teams) is a good extra lock.

### Git access on the NAS

Because the repo is private, pick one:
- **Deploy key (read-only, best for a server).** Generate a key with `ssh-keygen -t ed25519 -f ~/.ssh/eod_log_deploy -N ""`.
  Add the `.pub` file on GitHub under the repo's **Settings > Deploy keys**, and leave "Allow write access" off. Then clone with:
  `GIT_SSH_COMMAND="ssh -i ~/.ssh/eod_log_deploy -o IdentitiesOnly=yes" git clone git@github.com:moviemakr1620/eod-log.git eod-log`.
  Inside the clone, run `git config core.sshCommand "ssh -i ~/.ssh/eod_log_deploy -o IdentitiesOnly=yes"` so later `git pull`s use the same key.
  (Each repo needs its own deploy key; GitHub won't reuse one key across repos.)
- **GitHub CLI:** `gh auth login`, then `gh repo clone moviemakr1620/eod-log eod-log`.
- **Personal access token:** a fine-grained token with read-only *Contents* access to this repo, used as the password when git asks. Never put it in a file in the repo.

## Email notifications setup

1. Set the SMTP variables (below) and restart the container (`docker compose up -d`, or *Update the stack* in Portainer).
   - **Gmail / Google Workspace:** `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<the account>`, `SMTP_PASS=<an App Password>` (needs 2-step verification; a normal password won't work), `SMTP_FROM="EOD Log <that address>"`.
   - **Microsoft 365:** `smtp.office365.com`, port 587. SMTP AUTH has to be enabled for that mailbox.
   - **The NAS's own mail relay:** use its host and port. If it has a self-signed certificate, set `SMTP_TLS_REJECT_UNAUTHORIZED=false`.
2. Open **Settings** (admin password) > **Email notifications** > **Add**, or edit the one that's there. Notifications are saved in the database, not in env vars.
3. Use **Preview**, then **Send test** (on the edit page you can send the test to just yourself).

**What each frequency covers**

| How often | "Covers" option | Each email covers |
|---|---|---|
| Every day | That day (send in the evening, e.g. 19:00) | the send day |
| Every day | The day before (send in the morning) | the previous day |
| Weekdays (Mon–Fri) | That day | the send day; Monday's also includes Sat and Sun |
| Weekdays (Mon–Fri) | The day before | the previous day; Monday's covers Fri–Sun |
| Once a week (pick the day) | n/a | the previous Monday–Sunday |

**How sending works**
- The app checks every 30 seconds. On a send day at or after the send time, it decides once for that notification and period: **no EODs = skipped** (nothing sent, logged), otherwise it sends.
- Each notification and period is recorded in the database *before* sending, so a restart or a second check can never send it twice.
- The decision is made at send time: an EOD added later for an already-handled period is not emailed automatically. Use **Send test** if you need it.
- Adding or saving a notification after today's send time doesn't fire right away. It starts with the next send.
- A failed send (e.g. a wrong SMTP password) is logged as *failed* and not retried automatically, so it can't spam anyone. Fix it, then use **Send test**.
- It only sends while the container is running. If the NAS is off at the send time, it sends when it comes back up later that same day.

**Upgrading from the first version:** the old single weekly summary (its manager emails, day, time and receipts setting) becomes the first notification, "Weekly summary". If it already went out this week, it isn't sent again. The `MANAGER_EMAILS` and `SUMMARY_*` variables are now only used once, to create that first notification on a brand-new install.

## Environment variables (every one)

| Variable | Default | What it does |
|---|---|---|
| `APP_PASSWORD` | *(none: nobody can sign in)* | Shared team password. **Required.** |
| `ADMIN_PASSWORD` | empty | Password for settings, sending the summary, and delete. Empty = everyone can. |
| `EOD_PORT` | `7240` | Host port (compose only). |
| `PUBLIC_URL` | `http://localhost:8080` | Address people use, for links in emails and CSVs. No trailing slash. |
| `APP_NAME` | `EOD Log` | Name in the header, emails and on the home screen. |
| `COMPANY_NAME` | `KPI` | Shown on the sign-in page. |
| `APP_TIMEZONE` | `America/New_York` | Default time zone for "today", new entries and timestamps. |
| `MAX_UPLOAD_MB` | `20` | Largest single receipt file. |
| `SMTP_HOST`, `SMTP_PORT` | empty, `587` | Mail server. Email features stay off until `SMTP_HOST` and `SMTP_FROM` are set. |
| `SMTP_SECURE` | auto (`true` on 465) | Implicit TLS. Leave empty for 587 (STARTTLS). |
| `SMTP_USER`, `SMTP_PASS` | empty | SMTP login. |
| `SMTP_FROM` | `SMTP_USER` | From address, e.g. `"EOD Log <eod@company.com>"`. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | `false` only for a relay with a self-signed cert. |
| `MANAGER_EMAILS` | empty | Fresh installs only: recipients for the first "Weekly summary" notification. After that, manage notifications in Settings. |
| `SUMMARY_ENABLED` | `true` | Fresh installs only: first notification on/off. |
| `SUMMARY_DAY` | `1` | Fresh installs only: its day, 0 = Sunday … 6 = Saturday. |
| `SUMMARY_TIME` | `08:00` | Fresh installs only: its send time (24-hour). |
| `SUMMARY_TIMEZONE` | `APP_TIMEZONE` | Fresh installs only: its time zone. |
| `SUMMARY_ATTACH_RECEIPTS` | `false` | Fresh installs only: attach receipts (capped at 15 MB per email). |
| `SESSION_DAYS` | `180` | How long a phone stays signed in. |
| `SESSION_SECRET` | auto (stored in `/data`) | Cookie signing secret. |
| `COOKIE_SECURE` | `auto` | `auto` = Secure cookie when reached over https. |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which proxies' `X-Forwarded-*` headers to trust (NPM on the LAN is covered). |
| `ALLOW_NO_PASSWORD` | `false` | `true` turns off sign-in entirely. Not recommended. |
| `PORT`, `DATA_DIR` | `8080`, `/data` | Inside the container; normally leave alone. |

## Develop without Docker

Node 22 or newer:
```bash
npm ci
npm run dev          # http://localhost:8080 with APP_PASSWORD=dev, data in ./data
npm test             # unit tests for the hours maths
```

## Testing

- `npm test`: unit tests for `public/hours.js` (start/stop, optional meals, overnight, travel times ignored, typed-in hours, time formats such as `07:30:00`, `7:30 PM`).
- `scripts/e2e.mjs`: about 40 end-to-end checks against a running server. It signs in, creates entries with several crew on separate hours and with receipts, then checks the week and list views, search and filters, editing, deleting receipts, admin-only actions, settings and CSV.
  With `MAILPIT=` set, it also sends the summary to a [Mailpit](https://github.com/axllent/mailpit) catcher and checks the email, including attached receipts.
  `BASE=http://127.0.0.1:7240 APP_PASSWORD=... ADMIN_PASSWORD=... MAILPIT=http://127.0.0.1:8025 node scripts/e2e.mjs`
- `scripts/screenshots.mjs`: phone-size (390×844) screenshots into `preview/`. It needs `puppeteer-core` installed outside the project and Chrome.
- `scripts/browser-test.mjs`: drives the real form in **WebKit (iPhone 13)** and **Chromium (Pixel 7)** with Playwright. It covers add, edit, several crew, overnight, meals, a crew row with no name, and times with seconds. The simplest way to run it:
  `docker run --rm --network host -v $PWD:/w -w /w mcr.microsoft.com/playwright:v1.65.1-noble bash -c "npm i --no-save playwright@1.65.1 && APP_PASSWORD=... node scripts/browser-test.mjs"`
- `scripts/notify-test.mjs`: scheduler check (about 3 minutes) with Mailpit. A daily notification with no EODs sends nothing and is logged as skipped; with an EOD, two notifications send to their own recipients. A container restart afterwards sends no duplicates (checked by hand).

## Project layout

| Path | What |
|---|---|
| `src/server.js` | Express routes: pages, uploads, auth, summary, CSV. |
| `src/store.js`, `src/db.js` | SQLite schema and queries (better-sqlite3). |
| `src/views.js` | Server-rendered HTML (escaped by default). |
| `src/summary.js`, `src/mailer.js` | Summary data, email HTML/text, SMTP, notification schedules and the scheduler. |
| `src/auth.js` | Shared-password sign-in, signed cookies, admin elevation. |
| `public/` | `app.css`, `form.js` (EOD form), `hours.js` (shared hours maths), icons and manifest. |
| `test/`, `scripts/` | Unit test, fixtures, end-to-end and screenshot scripts. |

## Known limits

- One shared team password, not individual accounts. Anyone with it can add or edit any EOD, and an entry's "Logged by" is just the name typed at sign-in.
- No offline mode. The phone needs a connection to save, but an unfinished new entry is kept as a draft on the phone.
- HEIC photos from some Android or desktop browsers are stored as-is and may not preview. iPhones normally convert to JPEG when uploading.
- Not tested on real iPhones or Android phones, only in desktop Chrome at phone size. Not tested against a real SMTP provider, only Mailpit.
