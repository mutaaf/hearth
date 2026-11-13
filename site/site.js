// mutaafaziz.com/hearth. The aurora sky is sticky behind the hero and the
// setup story; whichever section is in view decides the shape (scroll, not
// hover, so it works on phones). The demo phone loads only when near.
(function () {
  var LABELS = { 'hearth-house': 'the house', 'hearth-tv': 'every TV', 'hearth-remote': 'one remote', 'hearth-flame': 'hearth' };
  var canvas = document.getElementById('field');
  var label = document.getElementById('shapeLabel');
  var field = null;

  if (window.AuroraField && window.HearthShapes) {
    window.HearthShapes.register(window.AuroraField);
    try {
      field = window.AuroraField.create(canvas, {
        shapes: window.HearthShapes.names,
        rotation: ['hearth-house', 'hearth-tv', 'hearth-remote', 'hearth-flame'],
        initial: 'hearth-house',
        palette: 'ember',
        cycle: 5200,
        depth: 2.6,
        stage: document.getElementById('stage'),
        // Filled shapes spread points thin; more of them reads brighter.
        count: function (w) { return w > 760 ? 8000 : 3600; },
        // The sky sits under the page copy; let taps reach the links.
        interactive: false,
        onShape: function (name) { if (LABELS[name]) label.textContent = LABELS[name]; },
      });
    } catch (e) {
      field = null;
    }
  }

  // Scroll story: the step crossing the middle of the screen owns the shape.
  var steps = [].slice.call(document.querySelectorAll('.step'));
  var hero = document.querySelector('.hero');
  var current = null;
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        if (e.target === hero) {
          steps.forEach(function (s) { s.classList.remove('active'); });
          current = null; // the hero cycles through every shape again
          return;
        }
        steps.forEach(function (s) { s.classList.toggle('active', s === e.target); });
        var name = e.target.dataset.shape;
        if (field && name !== current) {
          current = name;
          field.setShape(name, { pin: 60000 });
        }
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(function (s) { io.observe(s); });
    io.observe(hero);
  } else {
    steps.forEach(function (s) { s.classList.add('active'); });
  }

  // Nav turns into a frosted pill once you leave the top.
  var nav = document.getElementById('nav');
  var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 24); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Demo phone: load the iframe only when it's about to be seen, and only on
  // screens wide enough to show it (phones get a full-screen link instead).
  var phone = document.getElementById('phone');
  var frame = document.getElementById('demoFrame');
  var skin = 'aurora';
  var wantsFrame = function () { return window.matchMedia('(min-width: 861px)').matches; };
  function load() {
    var src = frame.dataset.src + '&skin=' + skin;
    if (frame.getAttribute('src') === src) return;
    phone.classList.remove('loaded');
    frame.classList.remove('ready');
    frame.src = src;
  }
  frame.addEventListener('load', function () {
    if (!frame.getAttribute('src')) return;
    phone.classList.add('loaded');
    frame.classList.add('ready');
  });
  if ('IntersectionObserver' in window) {
    var near = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; }) && wantsFrame()) {
        load();
        near.disconnect();
      }
    }, { rootMargin: '400px 0px' });
    near.observe(phone);
  } else if (wantsFrame()) load();

  document.querySelectorAll('.skin').forEach(function (btn) {
    btn.addEventListener('click', function () {
      skin = btn.dataset.skin;
      document.querySelectorAll('.skin').forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      if (wantsFrame()) load();
      else window.location.href = 'demo/?skin=' + skin;
    });
  });

  // Box Office (anonymous website analytics): which "Try it" link opens the demo.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href^="demo/"]');
    if (!a) return;
    var bo = window.boxoffice = window.boxoffice || { q: [], track: function () { this.q.push([].slice.call(arguments)); } };
    bo.track('demo_open', { skin: /skin=8bit/.test(a.getAttribute('href')) ? '8bit' : 'default' });
  });
  // …and which "Join the beta" link people tap.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href*="testflight.apple.com"]');
    if (!a) return;
    var bo = window.boxoffice = window.boxoffice || { q: [], track: function () { this.q.push([].slice.call(arguments)); } };
    bo.track('beta_open', { from: a.dataset.beta || 'other' });
  });

  // iPhone Duo: the device opens as the track scrolls past. --p is the hinge
  // (0 shut, 1 flat), --q the whole track (for the rail). Offsets are measured
  // on resize, so a frame only reads scrollY. Reduced motion: two stills.
  var track = document.getElementById('duoTrack');
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (track && !still) {
    var section = track.closest('.duo');
    var stage = track.querySelector('.duo-stage');
    var dev = track.querySelector('.duo-dev');
    section.classList.add('fold');
    var top = 0, span = 1, raf = 0, last = -1;
    var ease = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
    var measure = function () {
      var r = track.getBoundingClientRect();
      top = r.top + window.scrollY;
      span = Math.max(1, r.height - window.innerHeight);
      frame();
    };
    var frame = function () {
      raf = 0;
      var q = Math.min(1, Math.max(0, (window.scrollY - top) / span));
      if (Math.abs(q - last) < 0.0005) return;
      last = q;
      // Hold shut for the first third, open through the middle, hold open after.
      var p = ease(Math.min(1, Math.max(0, (q - 0.3) / 0.4)));
      dev.style.setProperty('--p', p.toFixed(4));
      stage.style.setProperty('--q', q.toFixed(4));
      stage.classList.toggle('is-open', p > 0.55);
      stage.classList.toggle('is-closed', p < 0.08 && q > 0.02);
    };
    window.addEventListener('scroll', function () { if (!raf) raf = requestAnimationFrame(frame); }, { passive: true });
    window.addEventListener('resize', measure);
    window.addEventListener('load', measure);
    measure();
  }

})();
