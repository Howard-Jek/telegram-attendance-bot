# Telegram attendance check-in

Group members check in by tapping a button in their Telegram group. A small Telegram Mini App
reads the phone's GPS and records the check-in in a Google Sheet, with:

- server time;
- the member's verified Telegram identity;
- their location;
- their rank and full name, and group.

An admin opens a check-in session from the app. The place where the admin is standing becomes
the check-in point, and members must be within 150 m of it (admins can change this, and how long
check-in stays open, in the app).

There is no server to run. The backend is a Google Apps Script web app attached to the Sheet,
and the Mini App is one static page on GitHub Pages.

## How it works

```
Telegram group ──/checkin──▶ Apps Script webhook ──▶ posts one "📍 Check in" button
      │                                                     │
      │ tap the button                                      ▼
      ▼                                           Mini App (GitHub Pages)
 Mini App opens ──── signed Telegram identity + GPS ───▶ Apps Script web app ──▶ Google Sheet
                                                          │
                                                          └──▶ Telegram Bot API (membership, messages)
```

- **Identity.** It comes only from Telegram's signed `initData`, which the server verifies with
  the bot token. Names and IDs sent by the phone are never trusted.
- **Time.** All times are server time (`Asia/Singapore`), never the phone's clock.
- **Replies.** They reach the Mini App through a hidden frame instead of Apps Script's usual
  redirect, which can take 10–30 s or lose the reply when Google is slow. See `frameReply_` in
  `apps-script/Main.gs`.
- **Design notes.** The design and the reasoning behind each decision are in
  [docs/HANDOFF.md](docs/HANDOFF.md).

## Using it

**Members**

1. Type `/checkin` in the group, or tap the latest 📍 Check in button.
2. Wait for the stamp that shows "You're on the list" and the time.
3. The first time, type your rank and full name (e.g. "CPL Tan Wei Ming") and tap your group.
   It's remembered. Tap the pill under the stamp to change either.

**Admins** are the group's Telegram admins, plus anyone listed in `ADMIN_IDS`.

1. Stand at the venue and open the app, the same way members do.
2. Tap **Start check-in**. Your current location becomes the check-in point for this session.
3. The bot posts "📍 Check-in is open until HH:mm" in the group, with the button.
4. If you started in the wrong place, open the app at the venue. When it says you're too far,
   tap **Move check-in point here**.
5. When the session ends, the bot edits its message into the result, for example
   "Check-in closed at 11:02 · 23 checked in", followed by a line of counts per group.
   This happens within 5 minutes of closing.

**Settings.** Admins can change three settings in the app: **Change settings** on the start
screen, or **Check-in settings** after checking in.

- **How long check-in stays open**, 1–720 minutes. This applies from the next session.
- **How close members must be**, 10–5000 m. This applies straight away, including to a
  session that's already open.
- **Location accuracy needed**, 10–500 m. This also applies straight away.

These are the Config tab's `SESSION_MINUTES`, `RADIUS_M` and `MAX_ACCURACY_M`, so you can also
edit them there.

**The group chat stays tidy.**

- The bot deletes each `/checkin` message. For this it needs the *Delete messages* admin
  right.
- It keeps a single Check in button at the bottom of the chat.
- It posts at most one button every 20 seconds.

**Rules**

- Only one session can be open at a time, and it can't be ended early.
- Each person is recorded once per session.
- A check-in needs a precise enough GPS fix, within 150 m of the check-in point.
- Only members of the connected group can check in.
- Members who are too far away see a rounded distance ("about 200 m", "more than 1 km"), never
  the exact figure. Exact distances would let someone work out where an admin started a
  session.

## The Google Sheet

| Tab | What's in it | Who writes it |
|---|---|---|
| **Config** | Settings (see below) | You. The bot fills in `GROUP_CHAT_ID`. |
| **Sessions** | One row per session: who started it, times, check-in point, number checked in (updated every 5 minutes, final at close) | The bot |
| **Log** | One row per check-in: time, Telegram name, location, distance, rank and full name (`full_name`), group | The bot |
| **Rejected** | Check-in attempts that were refused while a session was open, and why | The bot |
| **Groups** | Your groups, one per row under the `group` header. Leave it empty to skip the group question. | You |
| **Members** | Each member's saved rank and full name, and group | The bot. You can correct names and groups here. |

**Safe to do**

- Rename the spreadsheet file, or move it to another folder. The bot finds it by its ID.
- Sort or filter the rows.
- Add your own columns to the right of the last column.
- Edit Config, Groups and Members.

**Breaks things**

- Renaming or deleting any of these tabs.
- Inserting, deleting or reordering columns inside them.

  When the bot finds a changed layout it stops and says so; it never writes rows into the
  wrong columns.

- Making a copy of the Sheet. The copy is a different file with its own copy of the script,
  and the bot keeps using the original.

**Hand edits take a little while to show**, because the bot keeps short-lived copies to stay
fast:

- Config and Groups: up to a minute.
- A member's name or group: up to 10 minutes.
- Sessions: up to 5 minutes.
- A check-in row you delete by hand still counts as checked in until that session ends.

### Config

| Key | Default | Meaning |
|---|---|---|
| `GROUP_CHAT_ID` | *(blank)* | The connected Telegram group. The bot fills it in. Clear it to move the bot to another group. |
| `MINI_APP_LINK` | *(blank)* | The Mini App's direct link from BotFather, e.g. `https://t.me/YourBot/checkin` |
| `RADIUS_M` | 150 | How close to the check-in point members must be, in metres. Admins can change it in the app. |
| `MAX_ACCURACY_M` | 100 | The roughest GPS fix accepted, in metres. This also applies to the admin who sets the point. Admins can change it in the app. |
| `SESSION_MINUTES` | 60 | How long a session stays open. Admins can change it in the app. |
| `INITDATA_MAX_AGE_MIN` | 15 | How long an opened Mini App stays valid before members must reopen it |
| `ADMIN_IDS` | *(blank)* | Optional. Comma-separated Telegram user IDs that may start sessions without being group admins. |

`BOT_TOKEN` is **never** kept in the Sheet. It lives only in the script's Script Properties.

## Setting it up from scratch

You need:

- a Google account;
- Telegram on your phone;
- Node.js 20 or later, for the `clasp` command-line tool;
- a GitHub account, for hosting the Mini App.

### 1. Create the bot

In Telegram, message [@BotFather](https://t.me/BotFather):

1. Send `/newbot` and keep the token it gives you. Treat it like a password.
2. Leave *Allow groups* on (it's the default).

### 2. Create the Sheet and the script

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

Turn on the Apps Script API at <https://script.google.com/home/usersettings>. Then, from a copy
of this repository:

```bash
clasp create-script --type sheets --title "Attendance" --rootDir apps-script
```

`create-script` replaces `apps-script/appsscript.json` with a blank one, so restore ours:

```bash
git checkout apps-script/appsscript.json
```

```bash
clasp push -f
```

This creates a new Google Sheet with the script attached. Its IDs are in `.clasp.json`, which
is git-ignored.

### 3. Store the bot token

1. Open the script with `clasp open-script`.
2. Go to **Project Settings → Script Properties**.
3. Add `BOT_TOKEN` with the token from BotFather.

### 4. Deploy the web app

```bash
clasp create-deployment --description "attendance"
```

Note the deployment ID it prints. Your web app URL is:

```
https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
```

Put that URL in two places:

- `API_URL` in `web/index.html`;
- a Script Property named `WEBAPP_URL`, or the `WEBAPP_URL_` constant in
  `apps-script/Config.gs`.

Also add your GitHub Pages origin, for example `https://yourname.github.io`, to
`FRAME_ORIGINS_` in `apps-script/Main.gs`. Replies are only handed to pages on that list.

Push again, and update the same deployment so the URL stays the same:

```bash
clasp push -f
```

```bash
clasp update-deployment <DEPLOYMENT_ID> --description "attendance"
```

### 5. Publish the Mini App

1. Push the repository to GitHub.
2. In **Settings → Pages**, set **Source: GitHub Actions**.

The workflow in `.github/workflows/pages.yml` publishes only the `web/` folder, and does so
whenever `web/` changes. Your Mini App is then at `https://yourname.github.io/<repo>/`.

### 6. Register the Mini App with BotFather

1. Send `/newapp` to BotFather and pick your bot.
2. Give the Pages URL as the web app URL. `design/botfather-cover.png` is a ready-made
   640×360 cover image.
3. Choose a short name.
4. BotFather replies with a link like `https://t.me/YourBot/checkin`. Put it in **Config →
   MINI_APP_LINK**.

### 7. Run `setup()`

1. In the script editor, pick `setup` in the function menu and press **Run**.
2. Approve the permissions Google asks for.

`setup()` does the following, and it is safe to run again at any time:

- creates the tabs and columns;
- connects the bot's webhook;
- adds `/checkin` to the bot's command menu;
- installs the 5-minute close job;
- prints what's left to do.

### 8. Connect your group

The execution log of `setup()` shows a **one-time connect link**.

1. Open it on your phone and pick your group.
2. Telegram adds the bot as an admin, and the bot connects itself and says so in the group.

Alternatively, put your own Telegram user ID in `ADMIN_IDS` and add the bot to the group as an
admin yourself. Only you can connect a group this way. A stranger who adds the bot to their
own group is refused.

Then list your groups in the **Groups** tab, and you're ready.

## Updating

After changing the backend code:

```bash
clasp push -f
```

```bash
clasp update-deployment <DEPLOYMENT_ID> --description "what changed"
```

Always update the **existing** deployment, so the web app URL (and the Mini App's `API_URL`)
never changes. After an update that adds tabs, columns or permissions, run `setup()` once;
until you do, the app says so. Mini App changes go live when they're pushed to `main`, and
phones may keep the old page for up to 10 minutes.

To move the bot to another group:

1. Clear `GROUP_CHAT_ID` in Config.
2. Run `setup()`.
3. Use the new connect link it prints.

If Telegram upgrades your group to a supergroup, the group's ID changes. The bot follows the
change automatically.

## Security and privacy

- **Share the Sheet as *Viewer* only.** Anyone who can edit the Sheet can open its script and
  read `BOT_TOKEN`.
- **Identity** comes only from Telegram-signed data, verified on every request. Check-ins also
  confirm group membership with Telegram.
- **The webhook** is protected by a random secret in its URL, generated by `setup()`. Apps
  Script can't read Telegram's secret header, so the secret has to travel in the URL.
- **Everything typed by members** is stored as plain text, so it can never run as a
  spreadsheet formula.
- **What is stored:**
  - The Log stores each check-in's location.
  - The Rejected tab stores locations only for refusals caused by the location itself (too far
    away, or too rough).
  - People outside the group, or on desktop Telegram, are recorded without a location.
- **Admins** get exact distances, and the Sheet keeps them; members only see rounded ones.
- **Settings from the app** are limited to session length, distance and accuracy, within fixed
  ranges. Only admins can change them. The group, `ADMIN_IDS` and the Mini App link can only be
  changed in the Sheet. Each change is logged with the admin's Telegram ID (Apps Script →
  Executions).

## Troubleshooting

| You see | What to do |
|---|---|
| "Check-in isn't connected to a group yet" | Connect the group (step 8). |
| "The bot was updated. The owner needs to run setup()" | Run `setup()` in the script editor. |
| "Check-in is not set up yet (Config: …)" | Fix the named Config value. |
| `/checkin` does nothing | Make sure the bot is still an admin of the group, and run `setup()` to reconnect the webhook. If `MINI_APP_LINK` is missing, the bot says so in the group. |
| The `/checkin` messages aren't deleted | Give the bot the *Delete messages* admin right. |
| "Members only" for a real member | The bot must be a group admin to check membership. Someone who just joined can try again a minute later. |
| "Check-in isn't ready yet" | The session has no check-in point. An admin taps **Set check-in point here**. |
| "Location isn't precise enough", or "approximate location" | Turn on Precise Location for Telegram, and move outdoors or near a window. |
| The first open after a quiet spell takes a few seconds | Apps Script starting up. Later opens are quicker. |

## Development

The backend has offline tests that run on a small Apps Script emulator, with no Google account
needed:

```bash
npm test
```

The Mini App has a browser test harness that swaps Telegram and the backend for scripted mocks.
Serve the repository root:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open these pages:

- `http://127.0.0.1:8765/tests/mini-app/run.html` runs every scenario in
  `tests/mini-app/scenarios.js` against the real `web/index.html`.
- `…/gallery.html` shows the main screens side by side. Add `?theme=dark` or `?theme=washed`
  for other themes.
- `…/audit.html` runs a layout audit on every screen. It needs a local copy of the ui-craft
  `ui_audit.js` at `.audit/ui_audit.js`, which is git-ignored.
- `…/transport-race.html?url=<exec URL>` compares the two ways of getting replies from a live
  deployment.

`tools/sign-initdata.js` produces validly signed test `initData` with a fake token. In the
script editor, `selfTest()` checks the signature code against it.

### Layout

```
apps-script/       the backend (pushed with clasp)
  Main.gs            request entry point, reply transports
  Auth.gs            Telegram initData verification, admin check
  Sessions.gs        status, start, move the check-in point
  Checkin.gs         check-in rules and writes
  Profile.gs         groups, ranks and full names
  Settings.gs        check-in settings admins change in the app
  Group.gs           the group's Check in button and the close job
  Webhook.gs         Telegram updates: /checkin, connecting the group, supergroup upgrades
  Telegram.gs        Bot API calls
  Cache.gs           short-lived copies of Sheet data
  Config.gs          Sheet layout and the Config tab
  Setup.gs           setup() and selfTest()
web/index.html     the Mini App (one file, no build step)
tests/             backend tests, emulator, Mini App harness
tools/             test initData signer
docs/HANDOFF.md    the original brief and every design decision since
design/            design brief and the BotFather cover image
```

## Known limits

- **Faked location.** GPS comes from the phone, so a mock-location app can fake it.
- **Big crowds.** Check-ins are written to the Sheet one at a time, at about 1–2 a second.
  - 140 people arriving over a few minutes check in at normal speed.
  - 140 people tapping at the same moment all get in within about 1½–2 minutes: half within
    about a minute, the last within about 100–120 s. People near the back of the queue see "Lots
    of people are checking in right now" while the app keeps retrying for them, for up to 2½
    minutes.
  - Saving names and groups has its own queue, so it never slows down check-ins.
  - Opening the app doesn't queue: 140 simultaneous opens were measured at 1.6 s median.
  - Calling one group at a time keeps everyone's wait short. Tapping the bot's button is
    lighter than everyone typing `/checkin`.
- **Apps Script quotas.** Apps Script allows 20,000 Telegram calls a day, which is plenty.
- **Phones only.** Check-in needs the Telegram app on Android or iPhone. Desktop and web
  Telegram show "open this on your phone".
- **Result timing.** The closing message appears within 5 minutes of the session ending.
  Enforcement is exact, though: nobody can check in after the closing time.
