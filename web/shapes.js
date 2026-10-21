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
