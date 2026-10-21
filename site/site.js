// The hero: aurora-field particles assemble into Hearth's story (house →
// TV → remote → flame). Hovering a step card pins that shape.
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
        // Filled shapes spread points thin; more of them reads brighter.
        count: function (w) { return w > 760 ? 8000 : 3600; },
        stage: document.getElementById('stage'),
        onShape: function (name) {
          if (LABELS[name]) label.textContent = LABELS[name];
          document.querySelectorAll('.steps article').forEach(function (a) { a.classList.toggle('active', a.dataset.shape === name); });
        },
      });
    } catch (e) {
      field = null;
    }
  }

  document.querySelectorAll('.steps article').forEach(function (card) {
    card.addEventListener('mouseenter', function () { if (field) field.setShape(card.dataset.shape, { pin: true }); });
    card.addEventListener('click', function () {
      if (!field) return;
      field.setShape(card.dataset.shape, { pin: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  var copy = document.getElementById('copy');
  copy.addEventListener('click', function () {
    var text = 'git clone https://github.com/mutaaf/hearth\ncd hearth && npm run up';
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
      function () { copy.textContent = 'copied ✓'; setTimeout(function () { copy.textContent = 'copy'; }, 1600); },
      function () { copy.textContent = 'select + copy'; },
    );
  });
})();
