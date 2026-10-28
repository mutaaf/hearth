// Hearth's shapes for aurora-field (github.com/mutaaf/aurora-field). Shared
// by the app's scan screen and the landing page. Plain script, no modules,
// so it works next to aurora-field.min.js anywhere.
(function () {
  var PATHS = {
    // A house whose windows are three glowing screens.
    'hearth-house': {
      paths: [
        'M10 48 L50 12 L90 48 V92 H10 Z',
        'M20 56 H44 V72 H20 Z',
        'M56 56 H80 V72 H56 Z',
        'M40 78 H60 V92 H40 Z',
      ],
      tone: [0, 1, 1, 1],
    },
    // Signal: three Wi-Fi arcs and a dot (the link, while Hearth looks for a TV).
    'hearth-signal': {
      paths: [
        'M7.57 37.57 C18.83 26.32 34.09 20.00 50.00 20.00 C65.91 20.00 81.17 26.32 92.43 37.57 L86.77 43.23 C77.02 33.48 63.79 28.00 50.00 28.00 C36.21 28.00 22.98 33.48 13.23 43.23 Z',
        'M20.30 50.30 C28.18 42.42 38.86 38.00 50.00 38.00 C61.14 38.00 71.82 42.42 79.70 50.30 L74.04 55.96 C67.67 49.58 59.02 46.00 50.00 46.00 C40.98 46.00 32.33 49.58 25.96 55.96 Z',
        'M33.03 63.03 C37.53 58.53 43.63 56.00 50.00 56.00 C56.37 56.00 62.47 58.53 66.97 63.03 L61.31 68.69 C58.31 65.69 54.24 64.00 50.00 64.00 C45.76 64.00 41.69 65.69 38.69 68.69 Z',
        'M44 80 C44 76.69 46.69 74 50 74 C53.31 74 56 76.69 56 80 C56 83.31 53.31 86 50 86 C46.69 86 44 83.31 44 80 Z',
      ],
      tone: [0, 0, 1, 1],
    },
    // A TV on its stand, with a play mark on the screen.
    'hearth-tv': {
      paths: [
        'M6 16 H94 V74 H6 Z',
        'M12 22 H88 V68 H12 Z',
        'M43 39 L60 45 L43 51 Z',
        'M45 74 L40 86 H60 L55 74 Z',
      ],
      tone: [0, 0, 1, 0],
    },
    // The remote: body, D-pad ring, OK, two rockers.
    'hearth-remote': {
      paths: [
        'M38 4 H62 Q72 4 72 14 V88 Q72 98 62 98 H38 Q28 98 28 88 V14 Q28 4 38 4 Z',
        'M36 32 C36 24.3 42.3 18 50 18 C57.7 18 64 24.3 64 32 C64 39.7 57.7 46 50 46 C42.3 46 36 39.7 36 32 Z',
        'M44 32 C44 28.7 46.7 26 50 26 C53.3 26 56 28.7 56 32 C56 35.3 53.3 38 50 38 C46.7 38 44 35.3 44 32 Z',
        'M36 58 H46 V86 H36 Z',
        'M54 58 H64 V86 H54 Z',
      ],
      tone: [0, 0, 1, 0, 0],
    },
    // The hearth itself.
    'hearth-flame': {
      paths: [
        'M50 4 C58 22 78 34 76 60 C74 84 60 96 50 96 C40 96 26 86 24 62 C22 44 36 34 38 18 C44 28 46 34 50 40 C53 28 51 16 50 4 Z',
        'M50 54 C57 62 62 70 60 80 C58 90 42 90 40 80 C38 71 45 64 50 54 Z',
      ],
      tone: [0, 1],
    },
  };

  var done = false;
  window.HearthShapes = {
    names: Object.keys(PATHS),
    register: function (AF) {
      if (done || !AF) return;
      done = true;
      Object.keys(PATHS).forEach(function (name) {
        AF.register(name, AF.fromSVG(PATHS[name].paths, { tone: PATHS[name].tone }));
      });
    },
  };
})();
