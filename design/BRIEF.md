# Design brief: attendance check-in Mini App (web/index.html)

- **Subject.** A group member standing at the venue taps "📍 Check in" in the Telegram group. The Mini App opens, reads their GPS, and records them. The page does one job, on a phone, in a few seconds, usually in a doorway with people behind them.
- **Audience.** Group members, most of them on Android or iPhone Telegram, plus a few admins who open a 60-minute session. Mixed ages and tech comfort. Many will see the page for three seconds at a time, once a week.
- **Emotional target.** *Certainty.* "Done — I'm on the list at 10:32." The result state must be readable at arm's length: an unmistakable yes or no, the time, and what to do next.
- **Stack.** One static HTML file with inline CSS and JS, no framework and no build step, served from GitHub Pages. It loads `telegram-web-app.js` and POSTs text/plain JSON to the Apps Script /exec URL.
- **Constraints.**
  - Colours come from Telegram's theme params (`--tg-theme-*`), so the app looks like part of the user's Telegram in light, dark and custom themes.
  - Every token has a fallback, so the page also renders in a plain browser.
  - Font: the system UI stack (SF Pro on iOS, Roboto on Android). This is deliberate, even though the skill's font rules discourage it: a Mini App should read as native Telegram, and a web font costs load time on venue Wi-Fi. Personality comes from type scale and the numerals instead.
  - Designed for 360–430px phones first. Desktop and Web clients only ever see the "open on your phone" state.
  - No map and no manual location input, ever.
  - One primary action per state, in the thumb zone. Focus, disabled and pressed states are designed.
  - `prefers-reduced-motion` is respected.
- **Signature move.** The check-in *stamp*: the confirmed time set large in tabular numerals inside a ring in the accent colour, which presses in once (scale plus fade) when a check-in lands.
  - The "no" mirrors it. Every failed check-in shows a NOT CHECKED IN label in the stamp's type treatment, in the danger colour, over a tinted disc with an ✕.
  - Every state uses the same centred mark-title-line composition, so the eye always knows where the answer is.
- **Accessibility.** AA contrast against whatever theme the user has. Telegram's own hint colour is below 4.5:1 on some themes, so muted text is corrected in JS until it passes. Status changes are announced through an `aria-live` region.
- **September 2026 additions** (same system, no new visual language):
  - *Admins start where they stand.* Start reads the admin's GPS and makes that spot the check-in point, so the confirm says so ("within 150 m of where you’re standing"). If the point is wrong, an admin who lands on "too far" gets **Move check-in point here** as the primary action, which also checks them in.
  - *Group and full name, once.* After the stamp lands, a member with no saved group sees "Which group are you in?" as a set of large buttons under a compact stamp; the first time, an empty "Rank and full name" field (placeholder "e.g. CPL Tan Wei Ming") sits above them. One tap on a group saves both. Afterwards the checked-in screen shows a tappable pill ("Bravo · CPL Cy Tan · Change").
  - A failure to save the group never reads as a failed check-in: it shows inline, and the stamp stays.
  - *Check-in settings (admins).* A form screen in the same system: a small mark, the title, one line, then three labelled number fields with their unit beside them ("How long a check-in stays open" minutes; "How close members must be to the check-in point" m; "Location must be accurate to within" m). Save and Cancel sit in the sticky action bar; whenever content runs on beneath it (any screen), the content fades out just above the bar. Errors show under each field, and a couldn't-save notice sits above the fields so the sticky bar never hides it. After saving, the next screen says once exactly what changed ("Saved. Members can now check in within 300 m."), and with a check-in open, that it still closes at its time. Telegram's back arrow closes the form, and is hidden while a save is in flight; a slow save (a crowd holding the queue) says so on screen and gives up after 30 s. On phones under 700px tall, measured when the form opens, the mark is dropped so the fields fit.

