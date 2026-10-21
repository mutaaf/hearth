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
  var LG_CAPS = { volumeLevel: true, inputs: true, toast: true, appIcons: false };
  var SAMSUNG_CAPS = { volumeLevel: false, inputs: false, toast: false, appIcons: false };
  var ROKU_CAPS = { volumeLevel: false, inputs: false, toast: false, appIcons: false };
  var GTV_CAPS = { volumeLevel: true, inputs: false, toast: false, appIcons: false, remote: false };
  var ROKU_APPS = [['12', 'Netflix'], ['837', 'YouTube'], ['195316', 'YouTube TV'], ['291097', 'Disney+'], ['2285', 'Hulu'], ['13', 'Prime Video'], ['22297', 'Spotify']];
  var GTV_APPS = [['233637DE', 'YouTube'], ['32EAB1DF', 'YouTube TV'], ['17608BC8', 'Prime Video'], ['C3DE6BC2', 'Disney+'], ['CC32E753', 'Spotify'], ['9AC194DC', 'Plex']];
  // A slice of src/catalog.js for the launcher (key, title, mark, colour, and
  // which pretend id it is on each brand). No-Cast apps have no androidtv id.
  var CATALOG = [
    ['youtube', 'YouTube', '▶', '#e62117', { lg: 'youtube.leanback.v4', samsung: '111299001912', roku: '837', androidtv: '233637DE' }],
    ['youtubetv', 'YouTube TV', 'TV', '#cc0000', { lg: 'youtube.leanback.ytv.v1', samsung: '3201707014489', roku: '195316', androidtv: '32EAB1DF' }],
    ['netflix', 'Netflix', 'N', '#e50914', { lg: 'netflix', samsung: '3201907018807', roku: '12', androidtv: 'CA5E8412' }],
    ['primevideo', 'Prime Video', 'prime', '#00a8e1', { lg: 'amazon', samsung: '3201910019365', roku: '13', androidtv: '17608BC8' }],
    ['disneyplus', 'Disney+', 'D+', '#113ccf', { lg: 'com.disney.disneyplus-prod', samsung: '3201901017640', roku: '291097', androidtv: 'C3DE6BC2' }],
    ['max', 'Max', 'max', '#002be7', { lg: 'com.wbd.stream', samsung: '3202301029760', roku: '61322' }],
    ['hulu', 'Hulu', 'hulu', '#1ce783', { lg: 'hulu', samsung: '3201601007625', roku: '2285' }],
    ['appletv', 'Apple TV', 'tv', '#1d1d1f', { lg: 'com.apple.appletv', samsung: '3201807016597', roku: '551012' }],
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
  var CAPS = { lg: null, samsung: null, roku: null, androidtv: null };

  function tv(id, brand, name, room, model, ip, paired, state) {
    return {
      id: id, brand: brand, name: name, room: room, model: model, ip: ip, paired: paired, canWake: true,
      capabilities: { lg: LG_CAPS, samsung: SAMSUNG_CAPS, roku: ROKU_CAPS, androidtv: GTV_CAPS }[brand],
      since: Date.now() - Math.round(Math.random() * 3 * 3600e3),
      state: Object.assign({ online: false, power: 'off', volume: null, muted: null, app: null }, state),
    };
  }

  var tvs = [
    tv('demo-living', 'lg', 'Living Room', 'Downstairs', 'OLED65C1PUB', '192.168.1.40', true,
      { online: true, power: 'on', volume: 18, muted: false, app: 'netflix' }),
    tv('demo-upstairs', 'androidtv', 'Upstairs TV', 'Upstairs', 'TCL 65A300W', '192.168.1.48', true,
      { online: true, power: 'on', volume: 53, muted: false, app: null }),
    tv('demo-kids', 'samsung', 'Kids’ Room', 'Upstairs', 'UN43TU7000', '192.168.1.41', true,
      { online: true, power: 'on', app: null }),
    tv('demo-basement', 'roku', 'Basement', 'Downstairs', 'Streaming Stick 3840R', '192.168.1.53', true,
      { online: true, power: 'standby', app: null }),
    tv('demo-bedroom', 'lg', 'Bedroom', 'Upstairs', '55UP7000PUA', '192.168.1.42', true,
      { online: false, power: 'off' }),
  ];
  var discoverable = [
    { id: 'demo-office', brand: 'samsung', name: 'Office TV', model: 'QN50Q60A', ip: '192.168.1.43', macs: [] },
  ];

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
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function needsOn(t) {
    if (!t.state.online || t.state.power !== 'on') throw new Error('TV is off or not reachable');
  }

  function key(t, name) {
    needsOn(t);
    if (t.brand === 'androidtv' && ['volup', 'voldown', 'mute', 'home', 'back'].indexOf(name) < 0) {
      throw new Error('Google TVs only allow volume, mute and apps without pairing. Arrow keys need Google’s one-time code.');
    }
    var s = t.state;
    if (name === 'volup' || name === 'voldown') {
      if (s.volume == null) return;
      change(t, { volume: Math.max(0, Math.min(100, s.volume + (name === 'volup' ? 1 : -1))), muted: false });
    } else if (name === 'mute') {
      if (s.muted != null) change(t, { muted: !s.muted });
    } else if (name === 'home' && t.brand === 'lg') {
      change(t, { app: 'com.webos.app.home' });
    } else if (name === 'source' && t.brand !== 'samsung') {
      throw new Error('The "source" button isn\'t supported on this TV');
    }
  }

  // ── Bulk select + scenes, in memory ──
  function appsOf(t) {
    return { lg: LG_APPS, samsung: SAMSUNG_APPS, roku: ROKU_APPS, androidtv: GTV_APPS }[t.brand];
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
    ['POST', /^\/tvs\/([\w-]+)\/pair$/, function (m) {
      var t = find(m[1]);
      return wait(2600).then(function () {
        t.paired = true;
        change(t, { online: true, power: 'on' });
        return t;
      });
    }],
    ['PATCH', /^\/tvs\/([\w-]+)$/, function (m, body) {
      var t = find(m[1]);
      if (body.name && body.name.trim()) t.name = body.name.trim();
      if (body.room != null) t.room = String(body.room).trim();
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
      return ({ lg: LG_APPS, samsung: SAMSUNG_APPS, roku: ROKU_APPS, androidtv: GTV_APPS }[t.brand]).map(function (a) { return { id: a[0], title: a[1], icon: null }; });
    }],
    ['POST', /^\/tvs\/([\w-]+)\/launch$/, function (m, body) {
      var t = find(m[1]);
      needsOn(t);
      var list = { lg: LG_APPS, samsung: SAMSUNG_APPS, roku: ROKU_APPS, androidtv: GTV_APPS }[t.brand];
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
      needsOn(t);
      change(t, { app: 'com.webos.app.hdmi' + String(body.id).replace(/\D/g, '') });
      return { ok: true };
    }],
    ['POST', /^\/tvs\/([\w-]+)\/toast$/, function (m) {
      var t = find(m[1]);
      if (t.brand !== 'lg') throw new Error('On-screen messages isn\'t supported on this TV');
      needsOn(t);
      return { ok: true };
    }],
    ['POST', /^\/all\/power$/, function () {
      var paired = tvs.filter(function (t) { return t.paired; });
      paired.forEach(function (t) {
        change(t, { online: t.brand === 'samsung', power: t.brand === 'samsung' ? 'standby' : 'off', app: null });
      });
      return { ok: true, results: paired.map(function (t) { return { id: t.id, name: t.name, ok: true }; }) };
    }],
  ];

  window.HearthDemo = {
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
    bar.href = '../';
    bar.innerHTML = '<span>Demo · pretend TVs</span><b>Get Hearth for your house →</b>';
    document.body.prepend(bar);
  });
})();
