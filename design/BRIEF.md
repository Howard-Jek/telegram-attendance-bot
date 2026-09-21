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
