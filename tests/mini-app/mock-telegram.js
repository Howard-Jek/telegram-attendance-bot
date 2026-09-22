/* Stands in for telegram-web-app.js and the Apps Script backend, driven by ?scenario=
 * (see scenarios.js). It copies the real SDK's rules where the page depends on them:
 * showConfirm throws while a popup is open; LocationManager.init does not call back when already
 * inited; getLocation/openSettings throw or no-op exactly as the SDK does; below Bot API 8.0 the
 * LocationManager methods only warn. Records what the page did in window.__mini for run.html. */
(function () {
  var params = new URLSearchParams(location.search);
  var name = params.get('scenario') || 'member-auto-checkin';
  var sc = window.SCENARIOS[name];
  if (!sc) throw new Error('Unknown scenario: ' + name);
  var theme = window.THEMES[params.get('theme') || 'light'];
  var log = (window.__mini = { scenario: name, calls: [], confirmed: [], openedSettings: 0, closed: 0, nativeConfirms: 0, openedLinks: [], timeline: [], vias: [] });
  var t0 = Date.now();
  function mark(what) { log.timeline.push({ what: what, t: Date.now() - t0 }); } // function declarations are hoisted
  // The page must never fall back to the browser's own confirm() inside Telegram.
  window.confirm = function () { log.nativeConfirms++; return true; };

  // ---------- backend ----------
  var queues = {};
  Object.keys(sc.api || {}).forEach(function (k) { queues[k] = sc.api[k].slice(); });
  window.fetch = function (url, opts) {
    var body = JSON.parse(opts.body);
    log.calls.push(body);
    log.vias.push('fetch');
    mark('sent:' + body.action);
    var q = queues[body.action] || [];
    var next = q.length > 1 ? q.shift() : q[0];
    if (!next) return Promise.reject(new TypeError('no mock response for ' + body.action));
    if (next.pending) return new Promise(function () {});
    if (next.network) return Promise.reject(new TypeError('Failed to fetch'));
    var text = next.html ? '<!DOCTYPE html><html><body>Too many simultaneous invocations</body></html>' : JSON.stringify(next);
    return new Promise(function (resolve) {
      setTimeout(function () { mark('answered:' + body.action); resolve(new Response(text, { status: 200 })); }, sc.apiDelay || 60);
    });
  };

  // The frame transport: a form posted into a hidden frame, answered by postMessage.
  HTMLFormElement.prototype.submit = function () {
    var url = new URL(this.action);
    if (url.searchParams.get('transport') !== 'frame') throw new Error('unexpected form submit');
    var rid = url.searchParams.get('rid');
    var body = JSON.parse(this.querySelector('input[name=payload]').value);
    log.calls.push(body);
    log.vias.push('frame');
    mark('sent:' + body.action + ':frame');
    var q = queues[body.action] || [];
    var next = q.length > 1 ? q.shift() : q[0];
    if (!next || next.pending) return; // no answer yet: the frame stays loading
    if (next.network || next.html) {
      // The frame loads an error page, with no message.
      var frame = document.querySelector('iframe[name="' + this.target + '"]');
      setTimeout(function () { frame.srcdoc = '<p>error</p>'; }, 30);
      return;
    }
    setTimeout(function () {
      mark('answered:' + body.action);
      window.postMessage({ attendanceReply: true, rid: rid, res: next }, location.origin);
    }, sc.frameDelay || sc.apiDelay || 60);
  };

  // ---------- the WebView's own geolocation ----------
  var loc = sc.location || {};
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: function (ok, err, opts) {
        mark('browser-location');
        var delay = loc.browserDelay || 40;
        // Like a real browser, give up with TIMEOUT (3) after opts.timeout.
        if (opts && opts.timeout && delay > opts.timeout) {
          return setTimeout(function () { err({ code: 3 }); }, opts.timeout);
        }
        setTimeout(function () {
          if (loc.browser) ok({ coords: loc.browser });
          else err({ code: loc.browserError || 2 });
        }, delay);
      },
    },
  });

  if (sc.sdk === false) return;

  // ---------- Telegram.WebApp ----------
  var root = document.documentElement;
  Object.keys(theme).forEach(function (k) {
    root.style.setProperty('--tg-theme-' + k.split('_').join('-'), theme[k]);
  });

  var platform = sc.platform || 'android';
  var version = sc.version || '8.0';
  function atLeast(v) {
    var a = version.split('.').map(Number);
    var b = String(v).split('.').map(Number);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return true;
  }
  var handlers = {};
  function fire(ev) { (handlers[ev] || []).forEach(function (h) { h.call(window.Telegram.WebApp); }); }

  // loc.lm: a fix, null (the user refused this bot's location), or 'silent' (iOS when Telegram
  // itself lacks the phone's permission: no answer at all). loc.deviceOff: access granted but the
  // phone has Location switched off, so the answer is null.
  var granted = loc.lm !== null;
  // loc.preGranted: this bot was allowed location on an earlier visit.
  var inited = false;
  var available = true;
  var lm = {
    get isInited() { return inited; },
    get isLocationAvailable() { return inited && available; },
    isAccessRequested: !!loc.asked || !!loc.preGranted, // loc.asked: this bot has asked for location before
    isAccessGranted: !!loc.preGranted,
    init: function (cb) {
      if (!atLeast('8.0')) { console.warn('[Telegram.WebApp] LocationManager is not supported in version ' + version); return lm; }
      if (inited) return lm; // the real SDK does not call back again
      setTimeout(function () { inited = true; fire('locationManagerUpdated'); if (cb) cb(); }, 20);
      return lm;
    },
    getLocation: function (cb) {
      if (!atLeast('8.0')) { console.warn('[Telegram.WebApp] LocationManager is not supported'); return lm; }
      if (!inited) throw new Error('WebAppLocationManagerNotInited');
      if (!available) throw new Error('WebAppLocationManagerLocationNotAvailable');
      mark('location-requested');
      if (loc.lm === 'silent') return lm;
      setTimeout(function () {
        lm.isAccessRequested = true;
        lm.isAccessGranted = granted;
        fire('locationManagerUpdated');
        cb(granted && !loc.deviceOff ? loc.lm : null);
      }, loc.lmDelay || 40);
      return lm;
    },
    openSettings: function () {
      if (!inited) throw new Error('WebAppLocationManagerNotInited');
      if (!available) throw new Error('WebAppLocationManagerLocationNotAvailable');
      if (!lm.isAccessRequested) throw new Error('WebAppLocationManagerLocationAccessNotRequested');
      if (lm.isAccessGranted) { console.warn('[Telegram.WebApp] Location access already granted, no need to go to settings'); return lm; }
      log.openedSettings++;
      if (loc.grantOnSettings) {
        granted = true;
        loc.lm = { latitude: 1.28345, longitude: 103.86071, horizontal_accuracy: 10 };
        // Android reports the change; iOS reports nothing (the page must rely on Try again).
        if (platform === 'android') {
          setTimeout(function () { lm.isAccessGranted = true; fire('locationManagerUpdated'); }, 150);
        }
      }
      return lm;
    },
  };

  var popupOpen = false;
  window.Telegram = {
    WebApp: {
      initData: sc.initData !== undefined ? sc.initData : 'user=%7B%22id%22%3A42%7D&auth_date=1790000000&hash=mock',
      initDataUnsafe: { user: sc.tgUser || { id: 42, first_name: 'Cy', last_name: 'Member' }, start_param: sc.startParam },
      platform: platform,
      version: version,
      colorScheme: params.get('theme') === 'dark' ? 'dark' : 'light',
      themeParams: theme,
      isVersionAtLeast: atLeast,
      ready: function () {},
      expand: function () {},
      close: function () { log.closed++; },
      onEvent: function (ev, h) { (handlers[ev] = handlers[ev] || []).push(h); },
      showConfirm: function (message, cb) {
        if (!atLeast('6.2')) throw new Error('WebAppMethodUnsupported');
        if (popupOpen) throw new Error('WebAppPopupOpened');
        if (!message || message.length > 256) throw new Error('WebAppPopupParamInvalid');
        popupOpen = true;
        log.confirmed.push(message);
        setTimeout(function () { popupOpen = false; cb(!!sc.confirm); }, 120);
      },
      HapticFeedback: { notificationOccurred: function () {} },
      openTelegramLink: function (url) { log.openedLinks.push(url); },
      LocationManager: lm,
    },
  };
})();
