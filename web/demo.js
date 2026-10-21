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

  var routes = [
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
