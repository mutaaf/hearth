// Demo mode for mutaafaziz.com/hearth/demo/: a pretend house of TVs that
// lives in the browser. The real app (app.js) runs unchanged; it just talks
// to this instead of the Hearth server. Never loaded by the home server.
(function () {
  var LG_APPS = [
    ['netflix', 'Netflix'], ['youtube.leanback.v4', 'YouTube'], ['youtube.leanback.ytv.v1', 'YouTube TV'], ['amazon', 'Prime Video'],
    ['com.disney.disneyplus-prod', 'Disney+'], ['hulu', 'Hulu'], ['spotify-beehive', 'Spotify'],
    ['com.webos.app.livetv', 'Live TV'], ['com.webos.app.browser', 'Web Browser'],
  ];
  var SAMSUNG_APPS = [
    ['3201907018807', 'Netflix'], ['111299001912', 'YouTube'], ['3201707014489', 'YouTube TV'], ['3201910019365', 'Prime Video'],
    ['3201901017640', 'Disney+'], ['3201601007625', 'Hulu'], ['3201606009684', 'Spotify'],
  ];
  var LG_CAPS = { volumeLevel: true, inputs: true, toast: true, appIcons: false, pointer: true, keyboard: true };
  var SAMSUNG_CAPS = { volumeLevel: false, inputs: false, toast: false, appIcons: false, pointer: true, keyboard: true };
  var ROKU_CAPS = { volumeLevel: false, inputs: false, toast: false, appIcons: false, pointer: false, keyboard: true };
  var GTV_CAPS = { volumeLevel: true, inputs: false, toast: false, appIcons: false, remote: false, pointer: false, keyboard: false };
  var ROKU_APPS = [['12', 'Netflix'], ['837', 'YouTube'], ['195316', 'YouTube TV'], ['291097', 'Disney+'], ['2285', 'Hulu'], ['13', 'Prime Video'], ['22297', 'Spotify']];
  var GTV_APPS = [['233637DE', 'YouTube'], ['32EAB1DF', 'YouTube TV'], ['17608BC8', 'Prime Video'], ['C3DE6BC2', 'Disney+'], ['CC32E753', 'Spotify'], ['9AC194DC', 'Plex']];
  // Apple TV: bundle ids, as the Companion app list reports them.
  var ATV_CAPS = { volumeLevel: false, inputs: false, toast: false, appIcons: false, pointer: false, keyboard: true };
  var ATV_APPS = [
    ['com.netflix.Netflix', 'Netflix'], ['com.google.ios.youtube', 'YouTube'], ['com.google.ios.youtubeunplugged', 'YouTube TV'],
    ['com.apple.TVWatchList', 'TV'], ['com.disney.disneyplus', 'Disney+'], ['com.apple.TVMusic', 'Music'], ['com.apple.Arcade', 'Arcade'],
  ];
  // A slice of src/catalog.js for the launcher (key, title, mark, colour, and
  // which pretend id it is on each brand). No-Cast apps have no androidtv id;
  // the pretend Apple TV has only a few apps installed.
  var CATALOG = [
    ['youtube', 'YouTube', '▶', '#e62117', { lg: 'youtube.leanback.v4', samsung: '111299001912', roku: '837', androidtv: '233637DE', appletv: 'com.google.ios.youtube', appletv: 'com.netflix.Netflix' }],
    ['youtubetv', 'YouTube TV', 'TV', '#cc0000', { lg: 'youtube.leanback.ytv.v1', samsung: '3201707014489', roku: '195316', androidtv: '32EAB1DF', appletv: 'com.google.ios.youtubeunplugged' }],
    ['netflix', 'Netflix', 'N', '#e50914', { lg: 'netflix', samsung: '3201907018807', roku: '12', androidtv: 'CA5E8412' }],
    ['primevideo', 'Prime Video', 'prime', '#00a8e1', { lg: 'amazon', samsung: '3201910019365', roku: '13', androidtv: '17608BC8' }],
    ['disneyplus', 'Disney+', 'D+', '#113ccf', { lg: 'com.disney.disneyplus-prod', samsung: '3201901017640', roku: '291097', androidtv: 'C3DE6BC2', appletv: 'com.disney.disneyplus' }],
    ['max', 'Max', 'max', '#002be7', { lg: 'com.wbd.stream', samsung: '3202301029760', roku: '61322' }],
    ['hulu', 'Hulu', 'hulu', '#1ce783', { lg: 'hulu', samsung: '3201601007625', roku: '2285' }],
    ['appletv', 'Apple TV', 'tv', '#1d1d1f', { lg: 'com.apple.appletv', samsung: '3201807016597', roku: '551012', appletv: 'com.apple.TVWatchList' }],
    ['peacock', 'Peacock', 'P', '#000000', { lg: 'com.peacock.tv', samsung: '3202006020991', roku: '593099' }],
    ['paramountplus', 'Paramount+', 'P+', '#0064ff', { lg: 'com.cbs-all-access.webapp.prod', samsung: '3201710014981', roku: '31440', androidtv: '0BBDC217' }],
    ['espn', 'ESPN', 'E', '#dd0000', { lg: 'com.espn.espnplus-prod', samsung: '3201708014618', roku: '34376' }],
    ['spotify', 'Spotify', 'S', '#1db954', { lg: 'spotify-beehive', samsung: '3201606009684', roku: '22297', androidtv: 'CC32E753' }],
    ['plex', 'Plex', 'plex', '#e5a00d', { lg: 'cdp-30', samsung: '3201512006963', roku: '13535', androidtv: '9AC194DC' }],
    ['tubi', 'Tubi', 'T', '#7408ff', { lg: 'com.tubitv.ott.tubi', samsung: '3201504001965', roku: '41468' }],
    ['plutotv', 'Pluto TV', 'P', '#fff200', { lg: 'com.plutotv.app', samsung: '3201808016802', roku: '74519' }],
    ['sling', 'Sling TV', 'S', '#2c8fff', { lg: 'com.movenetworks.app.sling-tv-sling-production', samsung: '3201707014448', roku: '46041' }],
    ['fubo', 'Fubo', 'f', '#fa4616', { lg: 'com.fubotv.app', samsung: '3201903017953', roku: '43465' }],
    ['twitch', 'Twitch', 'tw', '#9146ff', { lg: 'tv.twitch.tv.starshot.lg', samsung: '3202203026841', androidtv: 'B3DCF968' }],
    ['crunchyroll', 'Crunchyroll', 'cr', '#f47521', { lg: 'com.crunchyroll.webapp', samsung: '3202302030097', roku: '2595' }],
    ['youtubekids', 'YouTube Kids', 'K', '#ff4e45', { lg: 'youtube.leanback.kids.v4', samsung: '3201611010983', androidtv: '0354A290' }],
  ];
  function catalogEntry(ref) {
    var r = String(ref || '').toLowerCase();
    return CATALOG.filter(function (c) { return c[0] === r || c[1].toLowerCase() === r; })[0];
  }
  // What a TV would answer for one catalog app: { installed, appId, reason }.
  function catalogOn(t, c) {
    var id = c[4][t.brand];
    if (!id) return t.brand === 'androidtv' ? { installed: false, reason: 'unsupported' } : { installed: false, reason: 'not-installed' };
    var hit = appsOf(t).filter(function (a) { return a[0] === id; })[0];
    return hit ? { installed: true, appId: id } : { installed: false, reason: 'not-installed' };
  }
  function launchOn(t, ref, wake) {
    var out = { id: t.id, name: t.name };
    if (!t.paired) return Object.assign(out, { ok: false, reason: 'unpaired', error: 'Not connected yet' });
    var woke = false;
    if (!t.state.online || t.state.power !== 'on') {
      if (!wake) return Object.assign(out, { ok: false, reason: 'off', error: 'It’s off' });
      change(t, { online: true, power: 'on', volume: t.brand === 'lg' ? 15 : t.state.volume, muted: t.brand === 'lg' ? false : t.state.muted });
      woke = true;
    }
    var c = catalogEntry(ref);
    var title = c ? c[1] : ref;
    var s = c ? catalogOn(t, c) : { installed: false, reason: 'not-installed' };
    if (!s.installed) {
      return Object.assign(out, { ok: false, reason: s.reason, error: s.reason === 'unsupported' ? title + ' can’t be opened on a Google TV without its own remote (no Cast app)' : title + ' isn’t installed on this TV' });
    }
    change(t, { app: s.appId, appTitle: title });
    return Object.assign(out, { ok: true, appId: s.appId, title: title }, woke ? { woke: true } : {});
  }
  var CAPS = { lg: null, samsung: null, roku: null, androidtv: null, appletv: null };

  function tv(id, brand, name, room, model, ip, paired, state) {
    return {
      id: id, brand: brand, name: name, room: room, model: model, ip: ip, paired: paired, canWake: true,
      capabilities: { lg: LG_CAPS, samsung: SAMSUNG_CAPS, roku: ROKU_CAPS, androidtv: GTV_CAPS, appletv: ATV_CAPS }[brand],
      since: Date.now() - Math.round(Math.random() * 3 * 3600e3),
      state: Object.assign({ online: false, power: 'off', volume: null, muted: null, app: null }, state),
    };
  }

  var tvs = [
    tv('demo-living', 'lg', 'Living Room', 'Downstairs', 'OLED65C1PUB', '192.168.1.40', true,
      { online: true, power: 'on', volume: 18, muted: false, app: 'netflix', media: { state: 'playing', position: null, duration: null, live: false, at: Date.now(), source: 'lg' } }),
    tv('demo-upstairs', 'androidtv', 'Upstairs TV', 'Upstairs', 'TCL 65A300W', '192.168.1.48', true,
      { online: true, power: 'on', volume: 53, muted: false, app: null }),
    tv('demo-kids', 'samsung', 'Kids’ Room', 'Upstairs', 'UN43TU7000', '192.168.1.41', true,
      { online: true, power: 'on', app: null }),
    tv('demo-media', 'appletv', 'Media Room', 'Downstairs', '4K (2nd gen)', '192.168.1.71', true,
      { online: true, power: 'on', app: 'com.netflix.Netflix', appTitle: 'Netflix', nowPlaying: 'The Long Weekend: Episode One', playing: 'playing',
        media: { state: 'playing', position: 1234000, duration: 2940000, live: false, at: Date.now(), source: 'appletv' } }),
    tv('demo-basement', 'roku', 'Basement', 'Downstairs', 'Streaming Stick 3840R', '192.168.1.53', true,
      { online: true, power: 'standby', app: null }),
    tv('demo-gameroom', 'lg', 'Game Room', 'Basement', 'OLED55C2PUA', '192.168.1.44', true,
      { online: true, power: 'on', volume: 32, muted: false, app: 'com.webos.app.hdmi2', inputLabel: 'PlayStation 5' }),
    tv('demo-bedroom', 'lg', 'Bedroom', 'Upstairs', '55UP7000PUA', '192.168.1.42', true,
      { online: true, power: 'on', volume: 12, muted: false, app: 'com.webos.app.browser', appTitle: 'Web Browser' }),
  ];
  var discoverable = [
    { id: 'demo-office', brand: 'samsung', name: 'Office TV', model: 'QN50Q60A', ip: '192.168.1.43', macs: [] },
    { id: 'demo-game', brand: 'appletv', name: 'Game Room', model: '4K', ip: '192.168.1.63', macs: [] },
  ];
  // The phone app can't drive Apple TVs yet: its demo leaves them out.
  if (window.HearthHost && window.HearthHost.native) {
    tvs = tvs.filter(function (t) { return t.brand !== 'appletv'; });
    discoverable = discoverable.filter(function (t) { return t.brand !== 'appletv'; });
  }

  var listeners = {};
  function emit(event, data) {
    (listeners[event] || []).forEach(function (fn) { fn({ data: JSON.stringify(data) }); });
  }
  function find(id) {
    var t = tvs.filter(function (x) { return x.id === id; })[0];
    if (!t) throw new Error('TV not found');
    return t;
  }
  function change(t, patch) {
    Object.assign(t.state, patch);
    emit('tv', t);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // A stand-in for src/devices.js so the demo's guide sheet has something real-looking.
  function demoGuide(brand, model) {
    var G = {
      lg: ['LG OLED (webOS)', 'allow-or-pin', 'Pick “Show a number” and type it in, or press Allow with the TV’s remote.', [['Turn on via Wi-Fi', 'Settings → General → Devices → TV Management → Turn on via Wi-Fi']]],
      samsung: ['Samsung smart TV (Tizen)', 'allow', 'Press Allow on the TV when it asks. Once.', [['Power On with Mobile', 'Settings → General → Network → Expert Settings → Power On with Mobile']]],
      roku: ['Roku', 'none', 'Nothing to press: Rokus let Hearth in by themselves.', [['Fast TV start', 'Settings → System → Power → Fast TV start']]],
      androidtv: ['Google TV', 'code', 'The TV shows a code once; type it into Hearth.', [['Stay connected', 'Settings → System → Power & energy → Network standby: On']]],
      appletv: ['Apple TV 4K', 'pin', 'Type the 4 numbers on the TV, twice.', [['Allow Access', 'Settings → AirPlay and HomeKit → Allow Access → Anyone on the Same Network']]],
    }[brand] || ['Smart TV', 'allow', 'Press Allow on the TV when it asks.', []];
    return {
      brand: brand, model: model, known: true, family: G[0], year: null, os: null,
      connect: { how: G[1], summary: G[2], before: [], onTv: null },
      keepReachable: G[3].map(function (k) { return { title: k[0], path: k[1] }; }),
      troubleshoot: [{ when: 'refused', fix: 'Pressed Deny by mistake? Remove Hearth from the TV’s list of connected devices, then connect again.' }, { when: 'not-found', fix: 'Make sure the TV and the phone are on the same Wi-Fi, not a guest network.' }],
      quirks: [],
    };
  }
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function needsOn(t) {
    if (!t.state.online || t.state.power !== 'on') throw new Error('TV is off or not reachable');
  }
  // Like Hub.wakeFor: a press on a sleeping TV wakes it first.
  function wakeFor(t) {
    if (t.paired && t.brand !== 'androidtv' && (!t.state.online || t.state.power !== 'on')) {
      change(t, { online: true, power: 'on', app: t.brand === 'lg' ? 'com.webos.app.home' : null });
    }
    needsOn(t);
  }

  function key(t, name) {
    wakeFor(t);
    if (t.brand === 'androidtv' && ['volup', 'voldown', 'mute', 'home', 'back'].indexOf(name) < 0) {
      throw new Error('Google TVs only allow volume, mute and apps without pairing. Arrow keys need Google’s one-time code.');
    }
    var s = t.state;
    if (name === 'volup' || name === 'voldown') {
      if (s.volume == null) return;
      change(t, { volume: Math.max(0, Math.min(100, s.volume + (name === 'volup' ? 1 : -1))), muted: false });
    } else if (name === 'mute' && t.brand === 'appletv') {
      throw new Error('Muting (the Apple TV passes volume to the TV, and has no network mute) isn’t supported on this TV');
    } else if (name === 'mute') {
      if (s.muted != null) change(t, { muted: !s.muted });
    } else if ((name === 'play' || name === 'pause') && s.media) {
      // Pretend players keep their place: freeze or resume the clock.
      var m = s.media;
      var pos = m.position == null ? null : m.position + (m.state === 'playing' ? Date.now() - m.at : 0);
      var next = name === 'play' ? 'playing' : 'paused';
      change(t, { playing: t.brand === 'appletv' ? next : s.playing, media: Object.assign({}, m, { state: next, position: pos, at: Date.now() }) });
    } else if ((name === 'rewind' || name === 'forward') && s.media && s.media.position != null) {
      var mm = s.media;
      var now = mm.position + (mm.state === 'playing' ? Date.now() - mm.at : 0) + (name === 'forward' ? 10000 : -10000);
      change(t, { media: Object.assign({}, mm, { position: Math.max(0, Math.min(mm.duration || now, now)), at: Date.now() }) });
    } else if (name === 'home' && t.brand === 'appletv') {
      change(t, { app: null, appTitle: null, nowPlaying: null, playing: null, media: null });
    } else if (name === 'home' && t.brand === 'lg') {
      change(t, { app: 'com.webos.app.home', media: null });
    } else if (name === 'source' && t.brand !== 'samsung') {
      throw new Error('The "source" button isn\'t supported on this TV');
    }
  }

  // ── Bulk select + scenes, in memory ──
  function appsOf(t) {
    return { lg: LG_APPS, samsung: SAMSUNG_APPS, roku: ROKU_APPS, androidtv: GTV_APPS, appletv: ATV_APPS }[t.brand];
  }
  function act(t, action, args) {
    args = args || {};
    if (action === 'power') {
      if (args.on !== false) change(t, { online: true, power: 'on', app: t.brand === 'lg' ? 'com.webos.app.home' : null });
      else change(t, { online: t.brand === 'samsung', power: t.brand === 'samsung' ? 'standby' : 'off', app: null, appTitle: null });
      return;
    }
    if (action === 'room') {
      if (args.name) t.name = String(args.name).trim() || t.name;
      if (args.room !== undefined) t.room = String(args.room).trim();
      emit('tv', t);
      return;
    }
    if (action === 'forget') {
      tvs = tvs.filter(function (x) { return x !== t; });
      emit('removed', { id: t.id });
      return;
    }
    if (!(action === 'launch' && args.wake)) needsOn(t);
    if (action === 'volume') {
      var level = args.level != null ? args.level : (t.state.volume || 15) + (args.delta || 0);
      change(t, { volume: Math.max(0, Math.min(100, level)), muted: false });
    } else if (action === 'mute') {
      change(t, { muted: args.on !== false });
    } else if (action === 'launch') {
      if (args.app || catalogEntry(args.title)) {
        var r = launchOn(t, args.app || args.title, args.wake);
        if (!r.ok) throw new Error(r.error);
        return;
      }
      var hit = appsOf(t).filter(function (a) { return a[1].toLowerCase() === String(args.title || '').toLowerCase() || a[0] === args.id; })[0];
      if (!hit) throw new Error((args.title || 'That app') + ' isn’t installed on this TV');
      change(t, { app: hit[0], appTitle: hit[1] });
    } else if (action === 'say') {
      if (t.brand !== 'lg') throw new Error('On-screen messages isn’t supported on this TV');
    } else if (action === 'key') {
      key(t, args.key);
    }
  }
  var scenes = [
    { id: 'everything-off', name: 'Everything off', emoji: '🌙', steps: [{ target: 'all', action: 'power', args: { on: false } }], schedule: null },
    { id: 'movie-night', name: 'Movie night', emoji: '🍿', steps: [
      { target: ['demo-living'], action: 'power', args: { on: true } },
      { target: ['demo-living'], action: 'volume', args: { level: 20 } },
      { target: ['demo-living'], action: 'launch', args: { title: 'Netflix' } }], schedule: null },
    { id: 'school-night', name: 'School night', emoji: '📚', steps: [{ target: 'all', action: 'power', args: { on: false } }], schedule: { days: [0, 1, 2, 3, 4], time: '21:00', enabled: true } },
  ];
  function nextRunOf(sc) {
    var s = sc.schedule;
    if (!s || !s.enabled || !s.days.length) return null;
    var hm = s.time.split(':');
    var now = new Date();
    for (var i = 0; i <= 7; i++) {
      var d = new Date(now);
      d.setDate(now.getDate() + i);
      d.setHours(+hm[0], +hm[1], 0, 0);
      if (s.days.indexOf(d.getDay()) >= 0 && d > now) return d.toISOString();
    }
    return null;
  }
  function sceneView(sc) { return Object.assign({}, sc, { nextRun: nextRunOf(sc) }); }
  function scenesChanged() { emit('scenes', scenes.map(sceneView)); }
  function runScene(sc) {
    var total = sc.steps.length;
    var allOk = true;
    emit('scene', { id: sc.id, name: sc.name, step: 0, total: total, done: false });
    sc.steps.forEach(function (st, i) {
      setTimeout(function () {
        var targets = st.target === 'all' ? tvs.filter(function (t) { return t.paired; }) : tvs.filter(function (t) { return st.target.indexOf(t.id) >= 0; });
        targets.forEach(function (t) {
          try { if (st.action !== 'wait') act(t, st.action, st.args); } catch (e) { allOk = false; }
        });
        emit('scene', { id: sc.id, name: sc.name, step: i + 1, total: total, done: false });
        if (i === total - 1) {
          sc.lastRun = new Date().toISOString();
          emit('scene', { id: sc.id, name: sc.name, step: total, total: total, done: true, ok: allOk });
        }
      }, 700 * (i + 1));
    });
    if (!total) emit('scene', { id: sc.id, name: sc.name, step: 0, total: 0, done: true, ok: true });
  }
  function findScene(id) {
    var sc = scenes.filter(function (x) { return x.id === id; })[0];
    if (!sc) throw new Error('Scene not found');
    return sc;
  }

  // ── doctor demo: the Basement Roku "moved" and heals; Upstairs needs its
  // full-remote code again; everyone else is fine. Steps stream like the real one.
  var movedOnce = false;
  function demoDoctor(t) {
    var steps = [];
    function step(name, label, status, detail, nerd) {
      var e = { id: t.id, step: name, label: label, status: status, detail: detail, nerd: nerd || null };
      var i = steps.findIndex(function (s) { return s.step === name; });
      if (i >= 0) steps[i] = e; else steps.push(e);
      emit('doctor', e);
    }
    var moved = t.id === 'demo-basement' && !movedOnce;
    var needsCode = t.id === 'demo-upstairs' && !(t.capabilities && t.capabilities.remote);
    var oldIp = t.ip;
    step('network', 'On the network?', 'running', 'Looking for it on your Wi-Fi…');
    return wait(700).then(function () {
      step('network', 'On the network?', moved ? 'warn' : 'ok', moved ? 'Not answering at ' + oldIp : 'Answering at ' + t.ip, { ip: oldIp, ports: [{ port: 8060, ok: !moved, ms: 6 }] });
      step('wake', 'Wake it up', moved ? 'running' : 'ok', moved ? 'Sending the wake-up signal…' : 'Not needed: it’s awake');
      return wait(moved ? 1500 : 300);
    }).then(function () {
      if (moved) step('wake', 'Wake it up', 'warn', 'It didn’t wake up at the old address.');
      step('find', 'Look for it again', moved ? 'running' : 'ok', moved ? 'Searching the whole network…' : 'Not needed: same address as before');
      if (moved) emit('looking', { on: true, tvs: [t.id] }); // the link (web/link.js)
      return wait(moved ? 2600 : 200);
    }).then(function () {
      if (moved) {
        movedOnce = true;
        t.ip = '192.168.1.61';
        step('find', 'Look for it again', 'ok', 'Found it at a new address: ' + t.ip, { from: oldIp, to: t.ip });
        emit('healed', { id: t.id, name: t.name, from: oldIp, to: t.ip, message: t.name + ' moved to ' + t.ip + ' — reconnected' });
        emit('looking', { on: false, tvs: [t.id], found: [t.id], missing: [] });
        emit('tv', t);
      }
      step('reconnect', 'Reconnect', 'running', 'Restarting Hearth’s connection…');
      return wait(600);
    }).then(function () {
      step('reconnect', 'Reconnect', 'ok', 'Reconnected');
      step('verify', 'Check it answers', 'running', 'Asking it a harmless question…');
      return wait(700);
    }).then(function () {
      step('verify', 'Check it answers', 'ok', t.model + ' answered in ' + (8 + Math.round(Math.random() * 30)) + ' ms', { auth: needsCode ? 'rejected' : 'ok' });
      if (needsCode) step('pair', 'Trust', 'warn', 'Unlock the full remote again: type the code shown on the TV.', { auth: 'rejected' });
      else step('pair', 'Trust', 'ok', 'It still trusts Hearth');
      var report = { id: t.id, name: t.name, brand: t.brand, ok: !needsCode, steps: steps, needsPairing: needsCode, how: needsCode ? 'googletv-code' : null, healed: moved ? { from: oldIp, to: t.ip } : null };
      report.summary = needsCode ? 'Unlock the full remote again: type the code shown on the TV.' : moved ? 'Fixed: it had moved to ' + t.ip + '.' : 'All good: connected and answering.';
      return report;
    });
  }

  var routes = [
    ['GET', /^\/catalog$/, function () {
      return CATALOG.map(function (c) {
        return { key: c[0], title: c[1], mark: c[2], color: c[3], brands: Object.keys(c[4]) };
      });
    }],
    ['GET', /^\/catalog\/status/, function () {
      var out = {};
      tvs.filter(function (t) { return t.paired; }).forEach(function (t) {
        var row = {};
        CATALOG.forEach(function (c) { row[c[0]] = catalogOn(t, c); });
        out[t.id] = row;
      });
      return out;
    }],
    ['POST', /^\/launch$/, function (_, body) {
      if (!body.app) throw new Error('Which app? e.g. { "app": "youtubetv" }');
      var targets = body.tvs === 'all' || body.tvs == null
        ? tvs.filter(function (t) { return t.paired; })
        : tvs.filter(function (t) { return (body.tvs || []).indexOf(t.id) >= 0; });
      if (!targets.length) throw new Error('Pick at least one TV');
      return wait(body.wake ? 900 : 350).then(function () {
        var results = targets.map(function (t) { return launchOn(t, body.app, body.wake); });
        var c = catalogEntry(body.app);
        return { app: c ? c[0] : null, title: c ? c[1] : body.app, ok: results.every(function (r) { return r.ok; }), results: results };
      });
    }],
    ['POST', /^\/bulk$/, function (_, body) {
      // ── doctor: "Fix connections" runs the pretend doctor on each TV
      if (body.action === 'doctor') {
        return Promise.all((body.ids || []).map(function (id) {
          var t = tvs.filter(function (x) { return x.id === id; })[0];
          if (!t) return { id: id, name: id, ok: false, error: 'Not found' };
          return demoDoctor(t).then(function (r) { return { id: id, name: t.name, ok: r.ok, error: r.ok ? undefined : r.summary }; });
        })).then(function (results) { return { results: results }; });
      }
      return {
        results: (body.ids || []).map(function (id) {
          var t = tvs.filter(function (x) { return x.id === id; })[0];
          if (!t) return { id: id, name: id, ok: false, error: 'Not found' };
          var name = t.name;
          try { act(t, body.action, body.args); return { id: id, name: name, ok: true }; }
          catch (e) { return { id: id, name: name, ok: false, error: e.message }; }
        }),
      };
    }],
    ['GET', /^\/scenes$/, function () { return scenes.map(sceneView); }],
    ['POST', /^\/scenes$/, function (_, body) {
      var sc = { id: 'scene-' + Date.now().toString(36), name: body.name || 'Scene', emoji: body.emoji || '✨', steps: body.steps || [], schedule: body.schedule || null };
      scenes.push(sc);
      scenesChanged();
      return sceneView(sc);
    }],
    ['PATCH', /^\/scenes\/([\w-]+)$/, function (m, body) {
      var sc = findScene(m[1]);
      ['name', 'emoji', 'steps', 'schedule'].forEach(function (k) { if (body[k] !== undefined) sc[k] = body[k]; });
      scenesChanged();
      return sceneView(sc);
    }],
    ['DELETE', /^\/scenes\/([\w-]+)$/, function (m) {
      var sc = findScene(m[1]);
      scenes = scenes.filter(function (x) { return x !== sc; });
      scenesChanged();
      return { ok: true };
    }],
    ['POST', /^\/scenes\/([\w-]+)\/run$/, function (m) { runScene(findScene(m[1])); return { ok: true, started: true }; }],
    ['GET', /^\/tvs$/, function () { return tvs; }],
    // ── connection guide + support queue: canned, nothing is sent from the demo ──
    ['POST', /^\/guide$/, function (_, body) {
      var t = body && body.tvId ? find(body.tvId) : null;
      var brand = (t && t.brand) || (body && body.device && body.device.brand) || 'lg';
      return wait(500).then(function () { return { guide: demoGuide(brand, (t && t.model) || (body && body.device && body.device.model) || ''), ai: null }; });
    }],
    // ── the wake coach (src/wake-plan.js, canned): Wi-Fi for the TVs, a box for the rest ──
    ['GET', /^\/tvs\/([\w-]+)\/wake-plan$/, function (m) {
      var t = find(m[1]);
      var boxes = tvs.filter(function (b) { return b.id !== t.id && (b.brand === 'roku' || b.brand === 'appletv'); })
        .map(function (b) { return { id: b.id, name: b.name, brand: b.brand, room: b.room }; });
      var isBox = t.brand === 'roku' || t.brand === 'appletv';
      var lg = t.brand === 'lg';
      var net = t.brand === 'androidtv'
        ? { possible: false, why: 'Google TVs only turn on from their own remote or Google Home, not from other apps.' }
        : { possible: true, auto: lg || isBox, why: lg ? 'Hearth already switched on its “Turn on via Wi-Fi” setting.' : isBox ? 'It wakes over the network by itself.' : 'One setting on the TV lets your phone wake it.',
            steps: lg || isBox ? [] : [{ title: 'Power On with Mobile', path: 'Settings → General → Network → Expert Settings → Power On with Mobile: On' }, { title: 'IP Remote', path: 'Settings → General → Network → Expert Settings → IP Remote: Enable (if your TV has it)' }] };
      var cec = { samsung: ['Anynet+ (HDMI-CEC)', 'Settings → General → External Device Manager → Anynet+ (HDMI-CEC): On'], lg: ['SIMPLINK (HDMI-CEC)', 'Settings → General → Devices → HDMI Settings → SIMPLINK (HDMI-CEC): On'] }[t.brand] || ['HDMI-CEC', 'Settings → Channels & Inputs → HDMI-CEC: On'];
      var box = isBox ? { possible: false, why: 'This is the box itself.' } : {
        possible: boxes.length > 0, why: 'A box plugged into the TV turns it on when the box wakes.', boxes: boxes,
        tvStep: { title: cec[0], path: cec[1] }, via: t.wakeVia || null, note: 'Waking through a box switches the TV to that box’s input.',
        boxSteps: { roku: [{ title: '1-touch play', path: 'On the Roku: Settings → System → Control other devices (CEC) → 1-touch play: On' }, { title: 'Wall power', path: 'Plug the Roku’s power into a wall socket, not the TV’s USB port, so it’s awake when the TV is off.' }],
          appletv: [{ title: 'Control TVs', path: 'On the Apple TV: Settings → Remotes and Devices → Control TVs and Receivers: On' }] } };
      var way = t.wakeVia ? 'box' : net.possible ? 'network' : box.possible ? 'box' : 'remote';
      var via = t.wakeVia && boxes.filter(function (b) { return b.id === t.wakeVia; })[0];
      return wait(700).then(function () {
        return { id: t.id, name: t.name, family: { lg: 'LG', samsung: 'Samsung', roku: 'Roku', androidtv: 'Google TV', appletv: 'Apple TV' }[t.brand], model: t.model, way: way,
          headline: way === 'network' ? (net.auto ? t.name + ' is ready to wake from your phone' : t.name + ' can wake from your phone') : way === 'box' ? t.name + ' can turn on through a box' : t.name + ' only turns on with its own remote',
          why: way === 'network' ? net.why : way === 'box' ? box.why : net.why, network: net, box: box,
          summary: via ? 'Through ' + via.name : way === 'network' ? (net.auto ? 'From your phone' : 'From your phone, after Power On with Mobile') : way === 'box' ? 'Needs a box: tap to set up' : 'Its own remote only' };
      });
    }],
    ['POST', /^\/tvs\/([\w-]+)\/wake-test$/, function (m) {
      var t = find(m[1]);
      t.state = Object.assign({}, t.state, { online: false, power: 'off' });
      emit('tv', t);
      return wait(3200).then(function () {
        t.state = Object.assign({}, t.state, { online: true, power: 'on' });
        emit('tv', t);
        return { ok: true, ms: 3200 };
      });
    }],
    ['POST', /^\/support$/, function () { return wait(700).then(function () { return { id: 'demo' + Math.random().toString(36).slice(2, 8) }; }); }],
    ['GET', /^\/support\/([a-z0-9]+)$/, function (m) { return { id: m[1], status: 'new', resolution: null }; }],
    ['GET', /^\/info$/, function () { return { name: 'hearth', friendlyUrl: null }; }],
    ['POST', /^\/scan$/, function () {
      return wait(2400).then(function () {
        return tvs.map(function (t) { return { id: t.id, brand: t.brand, name: t.name, model: t.model, ip: t.ip, macs: [], added: true }; })
          .concat(discoverable.map(function (d) { return Object.assign({ added: false }, d); }));
      });
    }],
    ['POST', /^\/tvs$/, function (_, body) {
      var d = discoverable.filter(function (x) { return x.ip === body.ip; })[0];
      if (!d) throw new Error('No LG or Samsung TV answered at that address. Is it switched on?');
      discoverable = discoverable.filter(function (x) { return x !== d; });
      var t = tv(d.id, d.brand, d.name, '', d.model, d.ip, false, {});
      tvs.push(t);
      emit('tv', t);
      emit('nearby', discoverable);
      return t;
    }],
    // ── doctor demo: Google TV code unlock (the "TV" shows 1A2B3C) ──
    ['POST', /^\/tvs\/([\w-]+)\/pair$/, function (m, body) {
      var t = find(m[1]);
      if (body && body.mode === 'code') return wait(900).then(function () { return Object.assign({}, t, { needsCode: true }); });
      if (body && body.code !== undefined) {
        return wait(600).then(function () {
          if (String(body.code).toUpperCase() !== '1A2B3C') throw new Error('That code doesn’t match the TV. (Demo code: 1A2B3C)');
          t.capabilities = Object.assign({}, t.capabilities, { remote: true });
          emit('tv', t);
          return t;
        });
      }
      // Apple TV: a code for the remote, then one for "what's playing".
      // Any 4 digits will do in the demo.
      if (t.brand === 'appletv' && !(body && body.pin)) {
        t.pinStep = 1;
        return wait(1200).then(function () { return Object.assign(copy(t), { needsPin: true, step: 1, steps: 2 }); });
      }
      if (t.brand === 'appletv' && t.pinStep === 1) {
        t.pinStep = 2;
        t.paired = true;
        change(t, { online: true, power: 'on' });
        return wait(900).then(function () { return Object.assign(copy(t), { needsPin: true, step: 2, steps: 2 }); });
      }
      return wait(2600).then(function () {
        t.paired = true;
        change(t, { online: true, power: 'on' });
        return t;
      });
    }],
    ['POST', /^\/tvs\/([\w-]+)\/unpair$/, function (m) {
      var t = find(m[1]);
      t.paired = false;
      emit('tv', t);
      return t;
    }],
    ['POST', /^\/tvs\/([\w-]+)\/doctor$/, function (m) { return demoDoctor(find(m[1])); }],
    ['POST', /^\/doctor$/, function () {
      return Promise.all(tvs.map(demoDoctor)).then(function (reports) { return { reports: reports }; });
    }],
    ['PATCH', /^\/tvs\/([\w-]+)$/, function (m, body) {
      var t = find(m[1]);
      if (body.name && body.name.trim()) t.name = body.name.trim();
      if (body.room != null) t.room = String(body.room).trim();
      if (body.wakeVia !== undefined) t.wakeVia = body.wakeVia || null;
      emit('tv', t);
      return t;
    }],
    ['DELETE', /^\/tvs\/([\w-]+)$/, function (m) {
      var t = find(m[1]);
      tvs = tvs.filter(function (x) { return x !== t; });
      discoverable.push({ id: t.id, brand: t.brand, name: t.name, model: t.model, ip: t.ip, macs: [] });
      emit('removed', { id: t.id });
      emit('nearby', discoverable);
      return { ok: true };
    }],
    ['POST', /^\/tvs\/([\w-]+)\/key$/, function (m, body) { key(find(m[1]), body.key); return { ok: true }; }],
    ['POST', /^\/tvs\/([\w-]+)\/volume$/, function (m, body) {
      var t = find(m[1]);
      if (!t.capabilities.volumeLevel) throw new Error('Setting the volume level isn’t supported on this TV');
      change(t, { volume: Math.max(0, Math.min(100, Math.round(Number(body.level) || 0))), muted: false });
      return { ok: true };
    }],
    ['POST', /^\/tvs\/([\w-]+)\/power$/, function (m, body) {
      var t = find(m[1]);
      if (body.on) {
        return wait(1400).then(function () {
          change(t, { online: true, power: 'on', volume: t.brand === 'lg' ? 15 : null, muted: t.brand === 'lg' ? false : null, app: t.brand === 'lg' ? 'com.webos.app.home' : null });
          return { ok: true };
        });
      }
      change(t, { online: t.brand === 'samsung', power: t.brand === 'samsung' ? 'standby' : 'off', app: null });
      return { ok: true };
    }],
    ['GET', /^\/tvs\/([\w-]+)\/apps$/, function (m) {
      var t = find(m[1]);
      needsOn(t);
      return ({ lg: LG_APPS, samsung: SAMSUNG_APPS, roku: ROKU_APPS, androidtv: GTV_APPS, appletv: ATV_APPS }[t.brand]).map(function (a) { return { id: a[0], title: a[1], icon: null }; });
    }],
    ['POST', /^\/tvs\/([\w-]+)\/launch$/, function (m, body) {
      var t = find(m[1]);
      wakeFor(t);
      var list = { lg: LG_APPS, samsung: SAMSUNG_APPS, roku: ROKU_APPS, androidtv: GTV_APPS, appletv: ATV_APPS }[t.brand];
      var hit = list.filter(function (a) { return a[0] === body.id; })[0];
      if (t.brand !== 'samsung') change(t, { app: body.id, appTitle: hit ? hit[1] : null });
      return { ok: true };
    }],
    ['GET', /^\/tvs\/([\w-]+)\/inputs$/, function () {
      return [
        { id: 'HDMI_1', label: 'Apple TV', connected: true },
        { id: 'HDMI_2', label: 'PlayStation 5', connected: true },
        { id: 'HDMI_3', label: 'HDMI 3', connected: false },
      ];
    }],
    ['POST', /^\/tvs\/([\w-]+)\/input$/, function (m, body) {
      var t = find(m[1]);
      wakeFor(t);
      var labels = { HDMI_1: 'Apple TV', HDMI_2: 'PlayStation 5', HDMI_3: 'HDMI 3' };
      change(t, { app: 'com.webos.app.hdmi' + String(body.id).replace(/\D/g, ''), appTitle: null, inputLabel: labels[body.id] || null });
      return { ok: true };
    }],
    ['POST', /^\/tvs\/([\w-]+)\/toast$/, function (m) {
      var t = find(m[1]);
      if (t.brand !== 'lg') throw new Error('On-screen messages isn\'t supported on this TV');
      needsOn(t);
      return { ok: true };
    }],
    ['POST', /^\/tvs\/([\w-]+)\/pointer$/, function (m) {
      var t = find(m[1]);
      needsOn(t);
      if (!t.capabilities.pointer) throw new Error('A pointer isn\'t supported on this TV');
      return { ok: true };
    }],
    ['POST', /^\/tvs\/([\w-]+)\/text$/, function (m, body) {
      var t = find(m[1]);
      needsOn(t);
      if (!t.capabilities.keyboard) throw new Error('Typing isn\'t supported on this TV');
      if (body.backspace && t.brand === 'samsung') throw new Error('Deleting text on this Samsung isn\'t supported (type it again from the start)');
      return { ok: true };
    }],
    ['POST', /^\/refresh$/, function () { return { refreshed: tvs.length }; }],
    // ── energy: pretend watts, a fortnight of pretend viewing, a pretend bill ──
    ['GET', /^\/energy$/, function () { return energyReport(); }],
    ['PUT', /^\/energy\/price$/, function (m, body) {
      var p = Number(body.pricePerKwh);
      if (!(p >= 0.01 && p <= 2)) throw new Error('Price per kWh should be between 0.01 and 2 (e.g. 0.17 for 17¢)');
      energy.price = { pricePerKwh: p, currency: energy.price.currency, source: 'manual' };
      return energyReport();
    }],
    ['DELETE', /^\/energy\/bill$/, function () { energy.price = { pricePerKwh: 0.17, currency: 'USD', source: 'default' }; energy.bill = null; return energyReport(); }],
    ['PATCH', /^\/energy\/tvs\/([\w-]+)$/, function (m, body) {
      energy.watts[m[1]] = body.onW == null && body.standbyW == null ? undefined : { onW: body.onW, standbyW: body.standbyW };
      return energyReport();
    }],
    ['POST', /^\/energy\/bill$/, function () {
      return new Promise(function (resolve) {
        setTimeout(function () {
          energy.bill = { currency: 'USD', pricePerKwh: 0.1447, priceSource: 'bill', total: 142.37, kwh: 918, days: 30, start: '2026-09-01', end: '2026-09-30', energyRate: 0.0921, fixed: 9.5, confidence: 'high', note: 'Demo: a pretend bill. At home, Hearth reads yours.', via: 'gemma-4-26b-a4b-it', at: Date.now() };
          energy.price = { pricePerKwh: 0.1447, currency: 'USD', source: 'bill' };
          resolve(energyReport());
        }, 1800);
      });
    }],
    ['POST', /^\/all\/power$/, function () {
      var paired = tvs.filter(function (t) { return t.paired; });
      paired.forEach(function (t) {
        change(t, { online: t.brand === 'samsung', power: t.brand === 'samsung' ? 'standby' : 'off', app: null });
      });
      return { ok: true, results: paired.map(function (t) { return { id: t.id, name: t.name, ok: true }; }) };
    }],
    // ── health: pretend report cards, diagnostics and AI notes ──
    ['GET', /^\/report$/, function () {
      return tvs.map(function (t) {
        var h = fakeHealth(t);
        return { id: t.id, name: t.name, brand: t.brand, model: t.model, score: h.rating.overall, grade: h.rating.grade, verdict: h.ai ? h.ai.insight.verdict_for_everyone : h.rating.verdict, worst: worstOf(h.rating), online: t.state.online, diagnosedAt: Date.now() };
      });
    }],
    ['GET', /^\/tvs\/([\w-]+)\/health$/, function (m) { return fakeHealth(find(m[1])); }],
    ['GET', /^\/tvs\/([\w-]+)\/diagnostics$/, function (m) { return wait(900).then(function () { return fakeHealth(find(m[1]), true); }); }],
    ['POST', /^\/tvs\/([\w-]+)\/insights$/, function (m) {
      var t = find(m[1]);
      return wait(1600).then(function () { insightsDone[t.id] = true; return fakeHealth(t, true); });
    }],
    ['POST', /^\/ai\/models$/, function (_, body) {
      var lists = { anthropic: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], openai: ['gpt-5-mini', 'gpt-5-nano'], xai: ['grok-4-fast'], gemini: ['gemini-2.5-flash-lite'] };
      var models = lists[body.provider] || lists.openai;
      return wait(500).then(function () { return { provider: body.provider, label: body.provider, models: models, suggested: body.provider === 'anthropic' ? 'claude-opus-5-5' : models[0] }; });
    }],
  ];

  // ── health (demo) ──
  var insightsDone = {};
  var PROFILES = {
    lg: { score: 88, sub: [93, 97, 84, 79, 92, 100], year: 2021, os: 'webOS TV 6.0', ver: '03.30.67', p50: 48, p95: 190, signal: -58, ports: [[3000, 'SSAP ws'], [3001, 'SSAP wss'], [1407, 'UPnP basic'], [7000, 'AirPlay']] },
    androidtv: { score: 71, sub: [90, 96, 80, 82, 35, 50], year: 2023, os: 'Google TV', ver: '3.72.446070', p50: 31, p95: 120, signal: null, ports: [[8008, 'Cast HTTP'], [8009, 'Cast TLS'], [6466, 'ATV remote'], [8443, 'Cast setup']] },
    samsung: { score: 64, sub: [74, 88, 70, 44, 70, 63], year: 2020, os: 'Tizen', ver: null, p50: 140, p95: 620, signal: null, ports: [[8001, 'Remote ws'], [8002, 'Remote wss'], [9197, 'DMR']] },
    roku: { score: 79, sub: [86, 94, 74, 88, 55, 75], year: null, os: 'Roku OS', ver: '15.3.4', p50: 62, p95: 240, signal: null, ports: [[8060, 'ECP'], [7000, 'AirPlay']] },
    appletv: { score: 91, sub: [95, 98, 90, 92, 88, 85], year: 2021, os: 'tvOS', ver: '26.1', p50: 38, p95: 140, signal: null, ports: [[7000, 'AirPlay'], [49153, 'Companion']] },
  };
  var LABELS = ['responsiveness', 'reliability', 'connection', 'software', 'wake', 'coverage'];
  function grade(s) { return s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F'; }
  function worstOf(r) { var f = r.findings.filter(function (x) { return x.severity === 'high' || x.severity === 'medium'; })[0]; return f ? f.title : null; }
  function seeded(n) { var x = Math.sin(n) * 10000; return x - Math.floor(x); }
  function fakeHealth(t, withDiag) {
    var p = PROFILES[t.brand] || PROFILES.roku;
    var now = Date.now();
    var lat = [];
    for (var i = 0; i < 90; i++) lat.push(Math.round(p.p50 * (0.6 + seeded(i + t.id.length) * 0.9) + (i % 17 === 0 ? p.p95 : 0)));
    var findings = [];
    if (t.brand === 'androidtv') findings.push({ severity: 'medium', title: 'Can’t be turned on from your phone', detail: 'Hearth has no way to wake it from sleep.', fix: 'Google TVs only turn on from their own remote or Google Home.' }, { severity: 'low', title: 'Arrow keys need Google’s code', detail: 'Without pairing, Hearth controls volume, mute and apps.', fix: 'Use the Google TV remote for menus.' });
    if (t.brand === 'samsung') findings.push({ severity: 'medium', title: 'Slow to respond', detail: '1 in 20 presses takes over 620 ms.', fix: 'Move the router closer, use 5 GHz Wi-Fi or plug in a network cable.' }, { severity: 'low', title: 'Volume is often 60 or higher', detail: '34% of the time.', fix: 'A soundbar or Night/Clear Voice mode can help without cranking it.' });
    if (t.brand === 'roku') findings.push({ severity: 'medium', title: 'Can’t be turned on from your phone', detail: 'This stick turns off with the TV.', fix: 'Plug the stick into a wall socket (not the TV’s USB port) so it stays awake when the TV sleeps.' });
    if (t.brand === 'lg') findings.push({ severity: 'good', title: 'Healthy', detail: 'Fast, reliable and fully under control.', fix: null });
    findings.push({ severity: 'tip', title: 'Stop the TV watching what you watch', detail: 'Most smart TVs track viewing for ads (ACR).', fix: 'Turn off viewing information / ACR in the TV’s privacy settings.' });
    var sub = {};
    LABELS.forEach(function (k, i) { sub[k] = { score: p.sub[i], evidence: [k === 'responsiveness' ? 'Median ' + p.p50 + ' ms, p95 ' + p.p95 + ' ms over 90 commands' : k === 'wake' && p.sub[i] < 50 ? 'Can’t be woken over the network' : 'Measured by Hearth over the last day'] }; });
    sub.coverage.list = { 'Arrow keys & OK': t.brand !== 'androidtv', 'Turn off': t.brand !== 'androidtv', 'Turn on': t.brand === 'lg' || t.brand === 'samsung', 'Exact volume': t.brand === 'lg' || t.brand === 'androidtv', 'Launch apps': true, 'Switch inputs': t.brand !== 'androidtv' && t.brand !== 'roku', 'Message on screen': t.brand === 'lg', 'See what’s on': t.brand !== 'samsung' };
    var ai = insightsDone[t.id] ? {
      insight: {
        headline: { lg: 'A well-kept 2021 LG', androidtv: 'Solid TV, limited remote', samsung: 'Older set, still capable', roku: 'Reliable little stick' }[t.brand],
        verdict_for_everyone: { lg: 'This TV is quick and dependable. Turning off viewing tracking is the only thing worth doing.', androidtv: 'Volume and apps work great from your phone. Use the TV’s own remote for menus and power.', samsung: 'It works, but it’s a bit slow over Wi-Fi. A network cable would make it snappier.', roku: 'Fast and reliable. Power it from the wall so your phone can wake it.' }[t.brand],
        top_actions: [{ action: 'Turn off viewing tracking (ACR)', why: 'Fewer ads, less background work, a little faster.' }],
        nerd_notes: ['p50 ' + p.p50 + ' ms / p95 ' + p.p95 + ' ms on the control channel', 'Control protocol answers well within one frame of TV UI latency'],
        model_profile: { year: p.year || 2023, platform: p.os, panel_or_device_notes: 'Demo data.', known_issues: [], privacy_settings_to_change: ['Viewing information / ACR off'], firmware_advice: 'Keep automatic updates on.' },
        ai_grade_adjustment: { points: 0, reason: '' },
      },
      provider: 'edge', providerLabel: 'Hearth Cloud', vendor: 'Gemma 4 on Cloudflare', model: '@cf/google/gemma-4-26b-a4b-it', colo: 'DFW', ms: 1460, inTokens: 1180, outTokens: 310, neurons: 38.5, costUsd: null, billedTo: 'Hearth (free allowance)', cached: false,
    } : null;
    var online = [{ t: now - 20 * 3600e3, v: true }, { t: now - 14 * 3600e3, v: false }, { t: now - 6 * 3600e3, v: true }];
    return {
      tv: t,
      rating: { overall: p.score, base: p.score, grade: grade(p.score), year: p.year ? { year: p.year, source: 'model code' } : null, sub: sub, findings: findings, verdict: findings[0].severity === 'good' ? 'In great shape.' : findings[0].title + '.', aiAdjustment: null },
      telemetry: {
        since: now - 7 * 864e5,
        commands: { count: 96, ok: 94, successPct: 97.9, p50: p.p50, p95: p.p95, p99: Math.round(p.p95 * 1.4), max: Math.round(p.p95 * 1.8), samples: 90, latencies: lat,
          byAction: { 'key:right': { count: 31, ok: 31, p50: p.p50 }, 'key:down': { count: 22, ok: 22, p50: p.p50 + 4 }, 'key:volup': { count: 14, ok: 14, p50: p.p50 - 3 }, launch: { count: 6, ok: 6, p50: p.p50 * 3 }, powerOn: { count: 3, ok: 2, p50: 900 } },
          errors: [{ message: 'TV is off or not reachable', count: 2 }],
          recent: lat.slice(-12).map(function (ms, i) { return { t: now - i * 41000, a: ['key:right', 'key:ok', 'key:volup'][i % 3], ok: true, ms: ms }; }) },
        availability: { h24: 0.71, d7: 0.66, onH24: 0.38 },
        connections: { downs24h: 2, unexpectedDrops24h: t.brand === 'samsung' ? 1 : 0, sessions: 9, avgSessionMs: 3.2 * 3600e3, timeline: [] },
        onlineTimeline: online,
        wake: { attempts: t.brand === 'androidtv' ? 0 : 4, ok: t.brand === 'roku' ? 2 : 4, successPct: t.brand === 'roku' ? 50 : t.brand === 'androidtv' ? null : 100, avgMs: 5200, recent: [] },
        screenTime: [{ app: 'Netflix', ms: 4.2 * 3600e3 }, { app: 'YouTube', ms: 2.6 * 3600e3 }, { app: 'Disney+', ms: 1.1 * 3600e3 }],
        volume: { samples: 40, avg: t.brand === 'samsung' ? 52 : 24, max: t.brand === 'samsung' ? 78 : 41, highPct: t.brand === 'samsung' ? 34 : 0, mutedPct: 8 },
        sightings: { count: 120, via: t.brand === 'androidtv' ? { mdns: 120 } : { ssdp: 120 } },
      },
      diagnostics: withDiag || insightsDone[t.id] ? {
        at: now, tookMs: 210,
        identity: { brand: t.brand, name: t.name, model: t.model, serial: 'DEMO-0000', ip: t.ip, macs: ['aa:bb:cc:00:00:01'], arpMac: 'aa:bb:cc:00:00:01' },
        software: { os: p.os, version: p.ver, build: p.ver ? p.ver.split('.').pop() : null, updateAvailable: t.brand === 'androidtv' ? false : null },
        network: { type: 'wifi', signalDbm: p.signal, noiseDbm: null, snrDb: null, protocol: { lg: 'SSAP (WebSocket)', samsung: 'Tizen remote channel (WebSocket)', roku: 'ECP (HTTP)', androidtv: 'Cast v2 (TLS + protobuf)' }[t.brand], rtt: { samples: 5, ok: 5, lossPct: 0, min: 8.2, avg: 19.6, max: 44.1, jitter: 9.8 }, openPorts: p.ports.map(function (x) { return { port: x[0], service: x[1] }; }), wolBroadcast: '192.168.1.255' },
        signals: { 'Power mode': 'PowerOn', 'Uptime (h)': 31.4, 'Apps installed': 18, 'Developer mode': 'false' },
        capabilities: t.capabilities, raw: { demo: true },
      } : null,
      ai: ai,
      aiPayload: { v: 1, brand: t.brand, model: t.model, year: p.year, platform: { os: p.os, version: p.ver }, scores: { overall: p.score, grade: grade(p.score) }, stats: { commands: 96, successPct: 97.9, p50Ms: p.p50, p95Ms: p.p95 } },
    };
  }

  // ── energy (demo) ──
  var energy = { price: { pricePerKwh: 0.17, currency: 'USD', source: 'default' }, bill: null, watts: {} };
  var DEMO_WATTS = { lg: [88, 0.5, '65″ · OLED · 2022'], samsung: [71, 0.5, '55″ · LED · 2021'], roku: [3, 1.5, 'streaming stick'], androidtv: [64, 1.5, '50″ · LED · 2022'], appletv: [3, 0.3, 'Apple TV box'] };
  function energyReport() {
    var price = energy.price.pricePerKwh;
    var r2 = function (x) { return Math.round(x * 100) / 100; };
    var rows = tvs.filter(function (t) { return t.paired; }).map(function (t, k) {
      var w = DEMO_WATTS[t.brand] || [70, 0.5, 'unknown size · LED'];
      var mine = energy.watts[t.id];
      var onW = mine && mine.onW != null ? mine.onW : w[0];
      var sbW = mine && mine.standbyW != null ? mine.standbyW : w[1];
      var daily = [];
      var onSum = 0;
      for (var i = 13; i >= 0; i--) {
        var d = new Date(Date.now() - i * 86400000);
        var onH = Math.round((2 + 3 * Math.abs(Math.sin((i + 1) * (k + 2) * 1.7)) + (d.getDay() % 6 === 0 ? 2.5 : 0)) * 10) / 10;
        onSum += onH;
        var kwh = (onH * onW + (24 - onH) * sbW) / 1000;
        daily.push({ day: d.toISOString().slice(0, 10), onH: onH, kwh: Math.round(kwh * 1000) / 1000, cost: r2(kwh * price) });
      }
      var onHDay = onSum / 14;
      var kwhDay = (onHDay * onW + (24 - onHDay) * sbW) / 1000;
      return { id: t.id, name: t.name, brand: t.brand, model: t.model, watts: { on: onW, standby: sbW, basis: w[2], yours: !!mine, estimate: { on: w[0], standby: w[1] } }, trackedH: 336, onHPerDay: Math.round(onHDay * 10) / 10, kwhPerDay: Math.round(kwhDay * 1000) / 1000, perMonth: r2(kwhDay * 30.44 * price), perYear: r2(kwhDay * 365 * price), standbyPerYear: r2(((24 - onHDay) * sbW / 1000) * 365 * price), daily: daily };
    });
    var sum = function (k) { return r2(rows.reduce(function (a, r) { return a + r[k]; }, 0)); };
    var kwhMonth = rows.reduce(function (a, r) { return a + r.kwhPerDay * 30.44; }, 0);
    return { price: energy.price, bill: energy.bill, tvs: rows, house: { perMonth: sum('perMonth'), perYear: sum('perYear'), standbyPerYear: sum('standbyPerYear'), kwhPerMonth: Math.round(kwhMonth * 10) / 10, shareOfBill: energy.bill ? Math.round((kwhMonth / energy.bill.kwh) * 1000) / 10 : null, trackedH: 336 }, at: Date.now() };
  }

  window.HearthDemo = {
    emit: emit, // for checking event-driven UI by hand (console)
    api: function (method, path, body) {
      for (var i = 0; i < routes.length; i++) {
        var m = path.match(routes[i][1]);
        if (m && routes[i][0] === method) {
          try {
            return Promise.resolve(routes[i][2](m, body || {})).then(copy);
          } catch (err) {
            return Promise.reject(err);
          }
        }
      }
      return Promise.reject(new Error('Not available in the demo'));
    },
    events: function () {
      setTimeout(function () { emit('hello', tvs); }, 0);
      // Like the real hub, "notice" the Office TV on the network a moment later.
      setTimeout(function () { emit('nearby', discoverable); }, 2500);
      return {
        addEventListener: function (event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
      };
    },
  };

  // A slim banner so nobody mistakes the demo for their own house
  // (hidden when the landing page embeds the demo in a phone frame).
  document.addEventListener('DOMContentLoaded', function () {
    if (/[?&]embed=1/.test(location.search)) return;
    document.documentElement.style.setProperty('--demo-bar', '28px');
    var bar = document.createElement('a');
    bar.className = 'demo-bar mono';
    // In the phone app the demo is a page beside the real one (demo.html).
    var app = window.HearthHost && window.HearthHost.native;
    bar.href = app ? 'index.html' : '../';
    bar.innerHTML = app ? '<span>Demo · pretend TVs</span><b>Back to my house →</b>' : '<span>Demo · pretend TVs</span><b>Get Hearth for your house →</b>';
    document.body.prepend(bar);
  });
})();
