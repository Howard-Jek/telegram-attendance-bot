# Telegram Attendance Bot: Build Handoff

The owner's original brief, kept for reference. Implementation decisions made along the way are listed at the end.

## Goal
Group members check in by tapping a button in a Telegram group. Each check-in records **server time, Telegram identity, and real device GPS** to a Google Sheet. Admins open a check-in **session** that lasts 60 minutes. Each person can be recorded only once per session. **Only one session can exist at a time, and no admin can start a second session while one is active.**

Keep it minimal. There is no always-on server, no framework, and no build step.

## Decisions already made (please don't reopen these)
| Decision | Why |
|---|---|
| Backend = Google Apps Script web app bound to the Sheet | No server to maintain; writes to the Sheet natively |
| Frontend = one static `index.html` Telegram Mini App on GitHub Pages | Reads device GPS directly with no map, so users can't drag a pin |
| Entry = direct-link Mini App (`t.me/<bot>/<app>`) in a URL button | Inline `web_app` buttons are private-chat only; direct links work in groups |
| No `/checkin` command and no webhook | Apps Script returns 302 redirects to Telegram webhooks, so updates pile up and retry. Sessions start from the Mini App instead, and the bot only makes outbound calls |
| Identity = verified Telegram `initData`, never client-sent names | Names can't be forged |
| All time rules use Apps Script server time (`Asia/Singapore`) | Phone clocks can't stretch the window |
| No "end session early" in v1 | Guarantees nobody can close and reopen within the hour |

## Architecture
```
Group message [📍 Check in] (URL button → t.me/<bot>/<app>)
        │
        ▼
Mini App (GitHub Pages, index.html)
  - Telegram.WebApp.initData (signed identity)
  - GPS via Telegram LocationManager, falling back to navigator.geolocation (high accuracy)
        │  POST text/plain JSON (avoids CORS preflight)
        ▼
Apps Script web app doPost  ──►  Google Sheet (Config / Sessions / Log / Rejected)
        │
        └──►  Telegram Bot API (outbound only: getChatMember, sendMessage, editMessageText)
```

## Repo layout
```
apps-script/
  appsscript.json      # timeZone "Asia/Singapore", V8 runtime, webapp config
  Main.gs              # doPost router + JSON responses
  Auth.gs              # initData parsing + HMAC verification
  Sessions.gs          # start session, active-session lookup, close job
  Checkin.gs           # check-in validation + writes
  Telegram.gs          # Bot API helpers (UrlFetchApp)
  Config.gs            # reads Config tab once per request
  Setup.gs             # one-off helpers: findGroupChatId, postEntryMessage, installTriggers, selfTest
web/
  index.html           # Mini App, with inline CSS/JS
tools/
  sign-initdata.js     # Node: generates a validly signed fake initData for selfTest
README.md              # owner setup + deploy steps
```
Use `clasp` to push and deploy Apps Script from the CLI. Always redeploy to the **existing** deployment ID (`clasp deploy -i <id>`) so the /exec URL never changes.

## Sheet schema
**Config** (key | value). The owner fills these in; code reads them once per request.
`SITE_LAT`, `SITE_LNG`, `RADIUS_M` (default 150), `MAX_ACCURACY_M` (default 100), `SESSION_MINUTES` (60), `INITDATA_MAX_AGE_MIN` (15), `ADMIN_IDS` (comma-separated Telegram user IDs), `GROUP_CHAT_ID`, `MINI_APP_LINK`.
`BOT_TOKEN` lives in **Script Properties only**. It is never stored in the Sheet and never logged.

**Sessions**: `session_id | started_by_id | started_by_name | opens_at | closes_at | announcement_message_id | status (open/closed) | checkin_count`
Session ID format: `S-yyyyMMdd-HHmm`.

**Log** (accepted check-ins only, one row per person per session):
`timestamp | session_id | user_id | first_name | last_name | username | latitude | longitude | accuracy_m | distance_m | dedupe_key`
`dedupe_key` = `<session_id>:<user_id>`. Look it up with TextFinder (matchEntireCell).

**Rejected**: `timestamp | session_id | user_id | name | username | reason | latitude | longitude | accuracy_m | distance_m`
Log `NOT_MEMBER`, `UNSUPPORTED_PLATFORM`, `LOW_ACCURACY`, and `OUT_OF_RANGE` here. **Never** log duplicates, no-session attempts, or auth failures.

Write timestamps as `Date` objects so Sheets formats them in SGT.

## Backend API
Single endpoint: `POST <apps-script-exec-url>`, body `{ action, initData, platform, location? }`, where location is `{ lat, lng, accuracy }`.
Response: `{ ok: bool, code: string, message: string (user-facing), data?: object }`.

| action | Purpose |
|---|---|
| `status` | Called on Mini App open. Returns `{ isAdmin, activeSession: {sessionId, closesAt, startedByName} \| null, myCheckin: {at} \| null }` |
| `startSession` | Admin opens a session |
| `checkin` | Member checks in |

Codes: `CHECKED_IN, ALREADY_CHECKED_IN, NO_ACTIVE_SESSION, SESSION_STARTED, SESSION_ACTIVE, NOT_ADMIN, NOT_MEMBER, OUT_OF_RANGE, LOW_ACCURACY, UNSUPPORTED_PLATFORM, AUTH_FAILED, AUTH_EXPIRED, BUSY`.

## Business rules

### startSession (in this order)
1. Verify initData → `AUTH_FAILED`. Check auth_date age ≤ `INITDATA_MAX_AGE_MIN` → `AUTH_EXPIRED`.
2. User ID in `ADMIN_IDS` → otherwise `NOT_ADMIN`.
3. Acquire `LockService.getScriptLock()` (waitLock 10s, else `BUSY`).
4. If **any** session has `closes_at > now` → `SESSION_ACTIVE`, with `closesAt` and `startedByName`. Write nothing. This applies to every admin, including the one who started it.
5. Create the Sessions row (`opens_at = now`, `closes_at = now + SESSION_MINUTES`). Release the lock.
6. Outside the lock: `sendMessage` to the group ("📍 Check-in open until HH:mm", with the check-in URL button) and store `message_id`. If sending fails, the session stays valid; return a warning in `message`.

Two admins tapping Start at the same moment must produce exactly one session. The lock plus step 4 guarantees this.

### checkin (in this order)
1. Verify initData → `AUTH_FAILED` / `AUTH_EXPIRED`.
2. `platform` must be `android` or `ios` → otherwise `UNSUPPORTED_PLATFORM`. This is client-reported, so it's a UX guard, not a security control.
3. `getChatMember(GROUP_CHAT_ID, user_id)`. Status must be creator, administrator, member, or restricted with `is_member=true` → otherwise `NOT_MEMBER`. Do this before the lock because it's a network call.
4. Acquire the script lock (as above).
5. The active session is the one where `opens_at ≤ now < closes_at` → otherwise `NO_ACTIVE_SESSION`.
6. `dedupe_key` already in Log → `ALREADY_CHECKED_IN`, returning the original time. **Write nothing.**
7. `accuracy > MAX_ACCURACY_M` → `LOW_ACCURACY` (write to Rejected).
8. Haversine distance to the site `> RADIUS_M` → `OUT_OF_RANGE` (write to Rejected).
9. Append to Log, increment `checkin_count`, release the lock → `CHECKED_IN`.

Users rejected at steps 7–8 may retry. Only an accepted check-in counts toward dedupe.

### Close job
Install a time-driven trigger that runs every 5 minutes. It finds `status=open AND closes_at ≤ now`, sets `status=closed`, and edits the announcement to "Check-in closed at HH:mm, N checked in" with the button removed. This is cosmetic only; enforcement is always `closes_at` vs. server time.

## initData verification (easy to get wrong)
Follow https://core.telegram.org/bots/webapps (validating data received via the Mini App) and verify against the current docs:
1. Parse the raw `initData` query string **manually**, since Apps Script has no `URLSearchParams`. Split on `&` and `=`, then `decodeURIComponent` each value.
2. `data_check_string` = every field **except `hash`**, sorted by key, formatted as `key=value` and joined with `\n`. Fields like `signature` **are included**.
3. `secret_key = HMAC_SHA256(key="WebAppData", message=BOT_TOKEN)`.
4. `computed = hex(HMAC_SHA256(key=secret_key, message=data_check_string))`. Use the `Byte[]` overload of `Utilities.computeHmacSha256Signature` for this step.
5. Apps Script bytes are **signed** (-128..127). Hex-encode with `(b & 0xff).toString(16).padStart(2, '0')`.
6. Compare to `hash`, then check `auth_date` freshness. Take the user from the parsed `user` JSON only.

`tools/sign-initdata.js` (Node `crypto`) produces a signed sample with a fake token. `selfTest()` in Setup.gs must accept it, and must reject tampered or stale variants, **before** any real Telegram testing.

## Mini App behaviour (web/index.html)
- Load `https://telegram.org/js/telegram-web-app.js`, call `ready()` and `expand()`, and follow Telegram theme params for colours.
- On open: call `status`, then render one of these states:
  - **Desktop/web client** → "Open this on your phone to check in." Stop.
  - **No session, member** → "No check-in open right now."
  - **No session, admin** → [Start check-in (60 min)] behind `showConfirm`. After starting, show session info plus a manual [Check in] button. Admins are not auto-checked in.
  - **Active session, already checked in** → "✅ Checked in at HH:mm. Session closes HH:mm."
  - **Active session, not checked in** → **auto-attempt check-in immediately**, so the group tap is the only tap after first-run permission. On failure, show the reason and [Try again].
  - **Admin during an active session** → the member view plus "Open until HH:mm, started by X". No Start button.
- Location: `Telegram.WebApp.LocationManager.init()` then `getLocation()`. If access is denied, show [Open settings] using `LocationManager.openSettings()`. Fall back to `navigator.geolocation.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })` when LocationManager is unavailable. Confirm the exact API names against the current Mini Apps docs.
- Never display or send a map or any manual location input.
- The Apps Script /exec URL is a constant in the page. It isn't a secret; security rests on initData verification.

## Setup helpers (Setup.gs)
- `findGroupChatId()`: calls `getUpdates` (no webhook is set) and logs chat IDs. The owner first sends `/start@<bot>` in the group.
- `postEntryMessage()`: posts the permanent "📍 Check in" message with the URL button. The owner pins it manually.
- `installTriggers()`: idempotent. Installs the 5-minute close job without creating duplicates.
- `selfTest()`: runs the initData tests above plus the haversine sanity checks.

## Build phases (stop after each for my review)
1. **Backend core**: Config, Auth (plus `sign-initdata.js` and `selfTest`), Sessions, Checkin, doPost router. `selfTest` passes.
2. **Mini App**: `index.html` with every state above.
3. **Telegram glue**: announcements, close job, setup helpers.
4. **README**: owner setup and deploy guide, including clasp and GitHub Pages.

## Acceptance tests
1. Admin starts a session → Sessions row appears and the group gets an announcement with a button.
2. Any admin tries to start during an active session → `SESSION_ACTIVE` with close time and starter, and no new row. Two simultaneous starts → exactly one session.
3. On-site member during a session → exactly one Log row, SGT server timestamp, all fields filled.
4. Same member again, including two rapid taps → no new row; the app shows the original time.
5. After `closes_at` → `NO_ACTIVE_SESSION`; Start becomes available again.
6. Off-site or poor accuracy → rejected, Rejected row written, retry allowed.
7. Telegram Desktop or Web → blocked with the "open on phone" message.
8. Non-member opens a forwarded link → `NOT_MEMBER`.
9. Tampered initData → `AUTH_FAILED`. initData older than 15 min → `AUTH_EXPIRED`.
10. Announcement shows closed with the count within about 5 min of close.
11. Location permission denied → clear message plus a working [Open settings].

## Out of scope for v1
`/checkin` command or webhook, check-out, ending sessions early, multiple venues, dashboards or reports, mock-GPS detection.

## Owner steps (things only I can do)
1. @BotFather: create the bot and save the token. Add the bot to the group.
2. Create the Google Sheet and the Apps Script project. Enable the Apps Script API (script.google.com/home/usersettings) for clasp, then run `clasp login`.
3. Put `BOT_TOKEN` in Script Properties. Deploy the web app as **Execute as: Me, Access: Anyone**.
4. Enable GitHub Pages for `web/`. Run BotFather `/newapp` with the Pages URL to get `MINI_APP_LINK`.
5. Fill in Config (venue coordinates, radius, admin IDs), run `findGroupChatId`, `installTriggers`, and `postEntryMessage`, then pin the message.

## Known limits (accepted)
- GPS comes from the device. Mock-GPS apps and a technical user capturing their own initData on Desktop and POSTing made-up coordinates are accepted for v1.
- Apps Script concurrency: fine for a few dozen simultaneous check-ins. On `BUSY`, the Mini App retries once after 2s.
- The close-job timing is approximate (about 5 min), but enforcement is exact.

## Implementation decisions (Phase 1–2)
- Extra response codes: `OK` (status), `BAD_REQUEST` (malformed body / unknown action / missing location), `SERVER_ERROR` (exceptions, owner misconfiguration).
- ok=true for OK, SESSION_STARTED, CHECKED_IN, ALREADY_CHECKED_IN; false otherwise.
- NOT_MEMBER / UNSUPPORTED_PLATFORM are decided before the session lookup; they are written to Rejected only if a session is currently open (read without the lock), so no-session attempts are never logged.
- Added setupSheets() (creates tabs/headers, seeds Config, sets spreadsheet TZ, plain-text Config values).
- Added tests/ (Node emulator of Apps Script + node:test) and package.json (dev-only, no deps).
- Step 6 of startSession (group announcement) is deferred to Phase 3 per the phase plan.
- Requests open the Sheet by SPREADSHEET_ID (stored by setupSheets), because getActiveSpreadsheet() is unavailable in web-app executions; the manifest therefore asks for the full `spreadsheets` scope.
- Fail closed (SERVER_ERROR naming the tab) if the Sessions/Log header row or a session's dates were edited into something unreadable.
- Security scan fixes: pre-lock Rejected rows are written once per person, session and reason; getChatMember results are cached (MEMBER 5 min, NOT_MEMBER 1 min); status shows startedByName only to admins.
- Formula-like names (= + - @ …) are stored with a visible leading apostrophe so CSV exports stay inert.
- status also returns sessionMinutes (for the "Start check-in (N min)" label).
- Mini App colours come from Telegram theme params. In JS, their lightness (OKLCH) is adjusted until they reach WCAG AA against the live theme, which keeps the theme's hue.
- One automatic retry after 2 s on BUSY or an unreadable response, such as Apps Script's HTML overload page.
- **Location order.** LocationManager comes first on every platform, as the spec says, because it needs no extra prompt after the first run.
  - **Android stale fixes.** Telegram for Android answers with the phone's cached last-known fix, of any age (DrKLO/Telegram BotLocation.requestObject). So when an Android fix from LocationManager is rejected as OUT_OF_RANGE or LOW_ACCURACY, the page gets one fresh fix from the WebView's geolocation (enableHighAccuracy, maximumAge 0) and submits again.
    - The fresh fix costs a Telegram "allow location" prompt, because Telegram clears WebView location grants on every open, which is why it isn't the default.
    - Side effect: the stale attempt leaves a Rejected row just before the successful Log row.
  - **iOS silent answer.** iOS sends nothing when Telegram lacks the phone's location permission. Once the bot has asked before, the page tries browser geolocation after 10 s, which fails fast in that case. A late Telegram answer still wins within a 5 s grace period.
  - **Browser fallback.** Browser geolocation is also used when LocationManager is unavailable (clients before Bot API 8.0) or reports no accuracy.
- **Location switched off.** A null LocationManager answer with access already granted means the phone's Location is off. The page shows "turn on Location" without Open settings, which would do nothing in that case.
- **Coming back from settings.** After Open settings, Try again becomes the primary button. Android also retries automatically when it reports the permission change. iOS reports nothing, so an `activated` event is only a best-effort retry.
- Failure screens during a check-in carry a "NOT CHECKED IN" label and a red ✕ ring that mirrors the stamp, so a failure never reads as success.
- A network failure during a check-in is shown as "Not confirmed" with a neutral mark, because the server may have recorded it.
- A very coarse accuracy (over 1 km) gets advice to turn on Precise Location.
- If telegram-web-app.js fails to load inside Telegram, the page offers Reload instead of the "open from Telegram" copy.
- A double tap on Start opens at most one confirmation.
- Focus follows the screen for keyboard and screen-reader users, and a status line speaks one sentence per change.
- After 8 s of loading, the page shows "Still working".
- Type is set in rem: iPhones follow the user's Text Size setting, and the stamp grows with the text.
- The action button is sticky, so it stays reachable when large text makes a screen taller than the phone.

## Changes requested by the owner (September 2026)
The owner reopened two of the decisions above. This section overrides the table and the sections it contradicts.

- **`/checkin` and a webhook (reopens "No `/checkin` command and no webhook").**
  - The webhook shares `doPost` with the Mini App. It is told apart by `?hook=<WEBHOOK_SECRET>`.
  - Apps Script can't read request headers, so Telegram's `secret_token` header can't be checked. The secret travels in the URL instead; `setup()` generates it and stores it in Script Properties.
  - The redirect problem that motivated "no webhook" is avoided by answering with **HtmlService** output. Apps Script serves that with a plain 200, while ContentService output is served through a 302. This was verified against a real deployment on 2026-09-21: 200, no redirect. Updates are also de-duplicated by `update_id` (CacheService, 6 h).
  - `/checkin` in the connected group deletes the command (if the bot may delete messages) and posts one "📍 Check in" URL button at the bottom of the chat. It replaces the previous button, so only one exists. Posts are at least 20 s apart, which keeps the bot under Telegram's group limit of about 20 messages a minute.
  - `/start` or `/checkin` in a private chat replies with the same button.
  - Because the bot is an admin, Telegram delivers every group message. The script drops anything that isn't a command before opening the Sheet.
  - A bot can't open a Mini App directly from a group command, so `/checkin` → button → app is the shortest path.
- **The group connects itself.** While `GROUP_CHAT_ID` is blank, the first group the bot joins (`my_chat_member`) is written into Config under the script lock, and the bot says so in that group.
  - Once a group is connected, the bot tells any other group it's added to and leaves.
  - To move the bot to another group, clear the cell first.
  - Supergroup upgrades are followed automatically, from any of four signals:
    - the old group's `migrate_to_chat_id` notice;
    - the new group's `migrate_from_chat_id` notice;
    - a `getChatMember` error that carries `migrate_to_chat_id`;
    - the bot "joining" the new supergroup, confirmed by `getChat` on the old id.
- **Admins are the group's Telegram admins** (creator or administrator), via `getChatMember`.
  - The answer is cached for 5 minutes, and a `chat_member` update clears it at once.
  - `ADMIN_IDS` is now optional and adds extra people.
  - `status` now makes one Bot API call per person per 5 minutes; check-in reuses the cached answer.
- **Each session is centred on the admin who starts it (replaces `SITE_LAT`/`SITE_LNG`).**
  - `startSession` requires the admin's GPS fix, which must be as precise as a check-in (`MAX_ACCURACY_M`). It is stored on the Sessions row (`site_lat`, `site_lng`, `site_accuracy_m`).
  - On Android the Mini App takes a fresh browser fix for the point, because Telegram's can be stale.
  - `moveSite` lets the admin who started the check-in move the point to where they stand (since 2026-09-22, only that admin). The Mini App offers it to them when they're told they're too far away, and then checks them in with the same fix.
  - Sessions created before this change have no point and answer `NO_SITE`.
- **Groups and full names.**
  - The owner lists groups on the **Groups** tab.
  - After checking in, a member taps their group. The first time, they also type their rank and full name (asked for by the owner; stored in the `full_name` column). It is not prefilled from Telegram, because display names are often nicknames and never carry a rank.
  - `saveProfile` stores both on the **Members** tab (one row per person, editable by admins) and on that person's Log row.
  - Later check-ins copy them onto the Log row automatically.
  - Only group members can save a profile, and the group must be on the Groups tab.
- **Close job.** `closeExpiredSessions` runs every 5 minutes (installed by `setup()`). It marks ended sessions closed and recounts from the Log. It turns the live button into "Check-in closed at 11:02 · 23 checked in" with a line of per-group counts.
  - Sessions that ended over an hour earlier close without a post.
  - Errors are logged, never thrown, so a failing trigger doesn't email the owner every 5 minutes.
- **Privacy.** NOT_MEMBER and UNSUPPORTED_PLATFORM rows in Rejected no longer store a location.
- **One setup step.** `setup()` replaces `setupSheets`/`findGroupChatId`/`installTriggers`/`postEntryMessage`. It:
  - appends new columns and tabs without moving data;
  - sets the webhook and the `/checkin` command menu;
  - installs exactly one close job;
  - logs what's left to do.
  
  It needs the added `script.scriptapp` scope, for the trigger.
- **Security scan (2026-09-21, two LOW findings, both fixed):**
  - *Connecting needs the owner.* A group connects only when:
    - someone listed in `ADMIN_IDS` adds the bot, or
    - the group is picked through the one-time connect link `setup()` prints (`t.me/<bot>?startgroup=<code>&admin=delete_messages`).

    Otherwise anyone who knew the bot's @username could claim it while `GROUP_CHAT_ID` is blank.
  - *Members get coarse distances.* An out-of-range member hears the distance rounded up to 50 m, or "more than 1 km". After 10 such answers per session they hear only "not within".
    - This stops a member from trilaterating the check-in point, which is where an admin stood (maybe at home).
    - Admins get exact figures, and the Rejected tab keeps them.
- **Speed (2026-09-22).** Measured on the live deployment, each request cost:
  - about 0.75 s of Apps Script start-up;
  - about 0.6 s to open the Sheet and read Config;
  - about 0.1–0.2 s for each further Sheet call;
  - about 0.35 s for Google's redirect.

  Opening the app therefore took two such requests with a GPS fix between them. Changes:
  - *Copies of Sheet data (`Cache.gs`).*
    - Config and Groups are copied for 60 s, and a member's saved profile for 10 minutes.
    - There is a copy of the not-yet-ended sessions, and a per-session copy of who has checked in.
    - The last two are written only under the script lock, so a slow reader can't restore an older copy.
    - Starting a session and the session a check-in is recorded against always come from the Sheet, under the lock.
    - A warm status call no longer opens the Sheet, and a check-in skips the Log search when the copy can answer. If the check-in copy is lost early, negative answers come from the Log again.
    - *Trade-off:* hand edits in the Sheet show up once a copy refreshes. Config and Groups take up to a minute. Sessions take until the next close-job run, which refreshes the copy every 5 minutes. A Log row deleted by hand still counts as checked in until that session ends.
  - *GPS during status.* If the bot already has location access, the Mini App starts the fix while status loads. It asks nothing new, so first-time visitors are never prompted when no session is open.
  - *Admin's fresh fix.* On Android the fresh fix for the check-in point waits at most 8 s, then falls back to Telegram's fix.
  - *Adversarial review of the speed-up (2026-09-22).* 10 findings survived verification; all are fixed, with regression tests:
    - **Only the Log may say "not yet".** The copy of who has checked in answers repeats only. A first check-in is still confirmed in the Log before its row is written.
    - **Copies are updated after the write is flushed.** Before this, an error just after writing the row could lead to a second row on retry. That was reproduced in the emulator, then fixed.
    - **The Config copy is versioned,** so a slow reader can't put back an old `GROUP_CHAT_ID`.
    - **The early GPS fix is narrower.** It runs only when the member came from the bot's button for an open session (that button's link carries `startapp=open`) and the bot already has location access. An early failure is shown once, not retried.
    - **The admin's 8 s fresh-fix cap now starts after permission is granted.** It used to include the prompt. When the phone's last known position is used, the admin is told.
- **Replies through a frame (2026-09-22).** The slowness was in how Apps Script returns replies, not in our code.
  - *Evidence:* temporary per-step timings from a real phone. The backend answered in 0.2–2.2 s, but replies reached the phone after 8–27 s or were lost (timeout, 404).
  - *Cause:* ContentService replies come back through a redirect to Google's reply cache (`script.googleusercontent.com/macros/echo`). From here it took 0.3–17 s, in waves, and it drops replies not collected within about 25 s.
  - *Fix:* the Mini App sends each request as a form into a hidden frame (`?transport=frame`). `frameReply_` answers with an HtmlService page, which Apps Script serves directly with no redirect. That page hands the JSON to the Mini App with `postMessage`, sent only to allowed origins, with the JSON escaped for `<script>`.
  - *Backups:* a normal copy follows at 5 s and another frame copy at 12 s, or at once if a copy fails. The first reply wins, with a 25 s cap. Every action tolerates repeats: a check-in answers "already", a start answers "already open, by you" (`startedByMe`), and profile saves and moves are idempotent.
  - *Offline:* a frame that loads without a reply counts as failed, so being offline still fails fast.
  - *Measured* against the live deployment during a slow spell: normal replies took 5.7–17 s, one was lost and one failed; frame replies took 1.6–2.6 s every time. On the owner's phone, the full start-then-check-in took 6 s, down from over a minute.
  - The diagnostics were removed afterwards. The old Perf tab can be deleted.
- **Crowds of ~140 (2026-09-22).**
  - *Measured.* 140 simultaneous requests to the live deployment were all accepted: median 1.6 s, 90% within 2.7 s, slowest 5.2 s.
  - *The limit is the lock.* Check-ins still queue for the script lock, about 0.5–0.8 s each, so roughly 1–2 per second.
  - *Changes that shorten and smooth the queue:*
    - A repeat check-in (a second tap, or the app's backup copy) is answered from the check-in copy without taking the lock.
    - A check-in writes only its Log row. `checkin_count` is refreshed by the close job every 5 minutes, and finally at close.
    - The Mini App retries BUSY up to 4 times, after random 2–5 s waits, and shows "Lots of people are checking in right now".
    - Backup copies go out at 8 s and 15 s. After a failed copy, the next follows after a random ~1 s instead of at once, so copies don't pile onto a queue.
  - *Adversarial review of the crowd changes.* A discrete-event model of 140 simultaneous check-ins found four problems:
    - **Retries gave up too early.** Four BUSY retries cover about 75 s, but the queue takes about 100 s, so about 20% saw a failure screen. The app now retries BUSY for up to 150 s of elapsed time; in the model, 0–1% see a failure screen.
    - **Name and group saves shared the check-in lock.** At a first session this doubled the wait. `saveProfile` now uses the owner's user lock (`withProfileLock_`). The web app runs as its owner, so every request shares that one lock, but it is separate from the check-in lock. Check-ins only append rows, so a save can safely update today's Log row without the check-in lock.
    - **A final BUSY could be wrong.** One of the queued copies may have recorded the person. Before showing "Not checked in", the app now asks `status`, which doesn't queue.
    - **A timer race** could send an extra backup copy.

    Modelled result: half the crowd is in within about a minute, and the last person within about 100–120 s.
- **Settings in the app (2026-09-22).** The owner asked for the session length and radius to be set from the app, like the check-in point.
  - `saveSettings` (Settings.gs) sets `SESSION_MINUTES` (1–720), `RADIUS_M` (10–5000) and `MAX_ACCURACY_M` (10–500). The values must be whole numbers, and it saves all three or none.
  - Only admins can use it (`checkAdmin_`, as for starting a session). It writes the Config tab under the script lock and moves the Config copy on, so the change applies to the next request.
  - Distance and accuracy apply at once, including to an open session. The session length applies from the next session, because an open session's `closes_at` is already fixed.
  - The group, `ADMIN_IDS` and `MINI_APP_LINK` are deliberately not settable from the app.
  - `setConfigValues_` writes the last row of a key that appears twice, since `loadConfig_` reads the last one.
  - The Mini App shows **Check-in settings** to admins on the start screen, the checked-in screen, the ready screen, and the "too far" and "not precise enough" failures.
  - *Owner request (2026-09-22): a check-in belongs to the admin who started it.* While it is open, only its starter may save settings (`SETTINGS_LOCKED` otherwise) or move its point (`NOT_STARTER`). Both are checked under the script lock against the Sheet (`isStarter_` in Sessions.gs), so a form opened before another admin started is refused on save. Status tells admins `startedByMe`; the app hides the controls for other admins and names the starter. The start reply carries the distance and accuracy in effect, since another admin may have changed them just before. The owner can still edit the Sheet.
  - *Review (2026-09-22), four reviewers plus a verifier per finding.* No security issues. Fixed:
    - **Only changed values are sent.** The server treats a missing field as unchanged, so a screen opened before another admin's save can't undo it.
    - **Each save carries a `saveId`,** which the app's backup copies reuse. A copy that arrives after its save was applied, perhaps after a newer save, doesn't write again.
    - **Settings are reachable mid-session** from the failures where they matter.
    - **An unconfirmed save or a demotion reloads on Cancel.**
    - **Double taps and Telegram's back button are handled.** The app ignores taps on a screen's buttons in its first 350 ms, and the back arrow closes the form.
    - **Focus and screen-reader fixes:** the unit is read with each field, and focus starts at the title.
    - **The sticky bar gets a hairline** when content runs on beneath it.
    - **Clearer copy** for the accuracy field.
