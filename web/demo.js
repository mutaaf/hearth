// Demo mode for mutaafaziz.com/hearth/demo/: a pretend house of TVs that
// lives in the browser. The real app (app.js) runs unchanged; it just talks
// to this instead of the Hearth server. Never loaded by the home server.
(function () {
  var LG_APPS = [
    ['netflix', 'Netflix'], ['youtube.leanback.v4', 'YouTube'], ['amazon', 'Prime Video'],
    ['com.disney.disneyplus-prod', 'Disney+'], ['hulu', 'Hulu'], ['spotify-beehive', 'Spotify'],
    ['com.webos.app.livetv', 'Live TV'], ['com.webos.app.browser', 'Web Browser'],
  ];
  var SAMSUNG_APPS = [
    ['3201907018807', 'Netflix'], ['111299001912', 'YouTube'], ['3201910019365', 'Prime Video'],
    ['3201901017640', 'Disney+'], ['3201601007625', 'Hulu'], ['3201606009684', 'Spotify'],
  ];
  var LG_CAPS = { volumeLevel: true, inputs: true, toast: true, appIcons: false };
  var SAMSUNG_CAPS = { volumeLevel: false, inputs: false, toast: false, appIcons: false };
  var ROKU_CAPS = { volumeLevel: false, inputs: false, toast: false, appIcons: false };
  var GTV_CAPS = { volumeLevel: true, inputs: false, toast: false, appIcons: false, remote: false };
  var ROKU_APPS = [['12', 'Netflix'], ['837', 'YouTube'], ['291097', 'Disney+'], ['2285', 'Hulu'], ['13', 'Prime Video'], ['22297', 'Spotify']];
  var GTV_APPS = [['233637DE', 'YouTube'], ['CA5E8412', 'Netflix'], ['CC32E753', 'Spotify'], ['9AC194DC', 'Plex']];
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
    needsOn(t);
    if (action === 'volume') {
      var level = args.level != null ? args.level : (t.state.volume || 15) + (args.delta || 0);
      change(t, { volume: Math.max(0, Math.min(100, level)), muted: false });
    } else if (action === 'mute') {
      change(t, { muted: args.on !== false });
    } else if (action === 'launch') {
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
  };
  var LABELS = ['responsiveness', 'reliability', 'connection', 'software', 'wake', 'coverage'];
  function grade(s) { return s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F'; }
  function worstOf(r) { var f = r.findings.filter(function (x) { return x.severity === 'high' || x.severity === 'medium'; })[0]; return f ? f.title : null; }
  function seeded(n) { var x = Math.sin(n) * 10000; return x - Math.floor(x); }
  function fakeHealth(t, withDiag) {
    var p = PROFILES[t.brand];
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
