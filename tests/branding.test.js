/* ============================================================
   The brand module: the block a property keeps in its settings, the write that
   guards it, and the palette engine that turns a logo into CSS variables. The
   engine is pure, so it is tested against synthetic pixels rather than a
   browser: the same input must always produce the same readable theme.
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApp(email) {
  const cache = {};
  const storage = {
    getItem: (k) => (k in cache ? cache[k] : null),
    setItem: (k, v) => { cache[k] = String(v); },
    removeItem: (k) => { delete cache[k]; }
  };
  const context = {
    window: {}, console: { warn() {}, log() {}, error() {} },
    localStorage: storage, sessionStorage: storage,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    parseInt, parseFloat, isNaN, setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => fn, clearTimeout: () => {}
  };
  for (const file of ['data.js', 'store.js', 'brand.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8');
    vm.runInNewContext(source, context, { filename: file });
  }
  const LHMS = context.window.LHMS;
  LHMS.signIn(email || 'ifeoma.okafor@aureliagrand.com', 'demo1234');
  return LHMS;
}

// Values come from inside the vm, so their prototypes differ from the test's.
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const HEX = /^#[0-9a-f]{6}$/i;

const SMALL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU8HkAAAAABJRU5ErkJggg==';

function pixels(layers) {
  const data = [];
  layers.forEach((l) => {
    for (let i = 0; i < l.n; i++) data.push(l.r, l.g, l.b, l.a === undefined ? 255 : l.a);
  });
  return data;
}

test('every property opens with a brand block, and the flagship keeps the group lock-up', () => {
  const LHMS = loadApp();
  const agm = LHMS.get.branding('agm');
  assert.equal(agm.brandName, 'Aurelia Grand');
  assert.equal(agm.tagline, 'Hotels & Residences');
  assert.equal(agm.logo, '');
  same(agm.images, []);
  assert.equal(agm.palette, null);
  assert.equal(agm.useColors, true, 'a logo that arrives later is allowed to dress the desk');
  assert.equal(LHMS.get.branding('ari').brandName, 'Aurelia Reserve Ikoyi');
  assert.equal(LHMS.get.branding('apa').tagline, 'Diplomatic calm, minutes from the capital');
});

test('a brand write names only what moved and signs the trail', () => {
  const LHMS = loadApp();
  const r = LHMS.actions.saveBranding('agm', {
    brandName: 'Marina House', tagline: 'On the lagoon', useColors: false
  });
  assert.equal(r.ok, true, r.error);
  same(r.changed, [
    'name Aurelia Grand → Marina House',
    'tagline "Hotels & Residences" → "On the lagoon"',
    'system colours returned to default'
  ]);

  const b = LHMS.get.branding('agm');
  assert.equal(b.brandName, 'Marina House');
  assert.equal(b.tagline, 'On the lagoon');
  assert.equal(b.useColors, false);
  assert.equal(b.updatedBy, 'Ifeoma Okafor');
  assert.ok(b.updatedAt, 'a moving write is stamped');

  const entry = LHMS.db.activity[0];
  assert.equal(entry.action, 'updated the hotel brand');
  assert.equal(entry.entity, 'hotel brand');
  assert.equal(entry.actor, 'Ifeoma Okafor');
  assert.ok(entry.detail.startsWith('Aurelia Grand Marina · name Aurelia Grand → Marina House'));

  // A save that moves nothing says so rather than naming a change.
  const at = b.updatedAt;
  const again = LHMS.actions.saveBranding('agm', {
    brandName: 'Marina House', tagline: 'On the lagoon', useColors: false
  });
  same(again.changed, []);
  assert.equal(LHMS.get.branding('agm').updatedAt, at, 'a no-op does not restamp the brand');
  assert.equal(LHMS.db.activity[0].detail, 'Aurelia Grand Marina · nothing moved');
});

test('logo, gallery and palette are stored as one block without touching the policies', () => {
  const LHMS = loadApp();
  const policies = JSON.stringify(LHMS.get.settings('agm'));

  let r = LHMS.actions.saveBranding('agm', { logo: SMALL, palette: ['#16283f', '#b18f52'] });
  assert.equal(r.ok, true, r.error);
  same(r.changed, ['logo added', 'logo palette applied']);

  r = LHMS.actions.saveBranding('agm', { images: [{ src: SMALL, name: 'Lobby' }, { src: SMALL, name: 'Pool' }] });
  assert.equal(r.ok, true, r.error);
  same(r.changed, ['images 0 → 2']);

  const b = LHMS.get.branding('agm');
  assert.equal(b.logo, SMALL);
  same(b.palette, ['#16283f', '#b18f52']);
  same(b.images.map((i) => i.name), ['Lobby', 'Pool']);

  // The rest of the settings block rides through untouched.
  const after = LHMS.get.settings('agm');
  assert.equal(after.depositPct, JSON.parse(policies).depositPct);
  assert.equal(after.finance.approvalAmount, JSON.parse(policies).finance.approvalAmount);

  // A caller cannot reach into the returned gallery and change the book.
  const copy = LHMS.get.branding('agm');
  copy.images.push({ src: SMALL, name: 'Mine' });
  assert.equal(LHMS.get.branding('agm').images.length, 2);

  r = LHMS.actions.saveBranding('agm', { logo: '', palette: null });
  assert.equal(r.ok, true);
  same(r.changed, ['logo removed', 'logo palette cleared']);
});

test('the write refuses what the uploader would not produce', () => {
  const LHMS = loadApp();
  const seven = Array.from({ length: 7 }, () => ({ src: SMALL, name: 'x' }));
  const five = Array.from({ length: 5 }, () => ({ src: 'data:image/png;base64,' + 'A'.repeat(800000), name: 'x' }));
  const cases = [
    [{}, 'Nothing to update.'],
    [{ motto: 'hello' }, 'does not carry motto'],
    [{ brandName: '   ' }, 'Give the hotel a name'],
    [{ brandName: 'A'.repeat(61) }, 'under 60'],
    [{ tagline: 'A'.repeat(91) }, 'under 90'],
    [{ logo: 'https://example.com/logo.png' }, 'PNG, JPEG, WebP or SVG'],
    [{ logo: 'data:image/png;base64,' + 'A'.repeat(700000) }, 'too large'],
    [{ images: seven }, 'Six images'],
    [{ images: [{ src: 'assets/img/hero.jpg', name: 'Hero' }] }, 'Each gallery image'],
    [{ images: [{ src: SMALL, name: 'A'.repeat(81) }] }, '80 characters'],
    [{ palette: ['#16283f', 'navy'] }, '#rrggbb'],
    [{ palette: ['#16283f', '#b18f52', '#d9c08d', '#3a5677', '#f7f0df', '#ffffff', '#000000', '#123456', '#654321'] }, 'one and eight'],
    [{ useColors: 'yes' }, 'on or off'],
    [{ images: five }, 'more image than this browser can keep']
  ];
  cases.forEach(([patch, message]) => {
    const r = LHMS.actions.saveBranding('agm', patch);
    assert.equal(r.ok, false, JSON.stringify(patch).slice(0, 60));
    assert.ok(r.error.indexOf(message) !== -1, r.error + ' should mention ' + message);
  });
  assert.equal(LHMS.get.branding('agm').logo, '', 'nothing from a refused write reached the book');
});

test('the palette takes the ink and a second voice out of a logo', () => {
  const LHMS = loadApp();
  const data = pixels([
    { n: 200, r: 250, g: 250, b: 250 },  // paper, ignored
    { n: 100, r: 20, g: 40, b: 70 },     // the logo's navy
    { n: 50, r: 200, g: 160, b: 70 },    // its gold
    { n: 50, r: 255, g: 0, b: 0, a: 0 }  // transparency, ignored
  ]);
  const p = LHMS.brand.paletteFromPixels(data);
  assert.equal(p.length, 5);
  p.forEach((c) => assert.match(c, HEX));

  const primary = LHMS.brand.toRgb(p[0]);
  assert.ok(primary[2] > primary[0], 'the dominant navy stays blue');
  assert.ok(LHMS.brand.luminance(p[0]) <= 0.12, 'the primary is dark enough for text');

  const accent = LHMS.brand.toRgb(p[1]);
  assert.ok(accent[0] > accent[2], 'the gold survives as the accent');
  assert.ok(LHMS.brand.contrast(p[1], '#ffffff') >= 3, 'and stays readable on white');

  // Transparency and paper alone cannot become a brand.
  same(LHMS.brand.paletteFromPixels(pixels([{ n: 50, r: 9, g: 9, b: 9, a: 0 }])), LHMS.brand.FALLBACK);
});

test('a monochrome logo keeps the house accent instead of inventing a hue', () => {
  const LHMS = loadApp();
  const p = LHMS.brand.paletteFromPixels(pixels([
    { n: 300, r: 120, g: 120, b: 120 },
    { n: 100, r: 255, g: 255, b: 255 }
  ]));
  const primary = LHMS.brand.toRgb(p[0]);
  assert.ok(Math.abs(primary[0] - primary[2]) < 6, 'the grey stays grey');
  const accent = LHMS.brand.toRgb(p[1]);
  assert.ok(accent[0] > accent[2], 'the accent is the house gold');
  assert.equal(p.length, 5);
});

test('a palette becomes one deterministic, readable theme', () => {
  const LHMS = loadApp();
  const theme = LHMS.brand.themeFromPalette(['#16283f', '#b18f52']);
  const keys = Object.keys(theme);

  // Every flat colour the desk paints with — ink, surfaces, rules, sidebar, text
  // on the shell — comes out of the logo, not only the two accents.
  const flat = [
    '--navy', '--navy-2', '--navy-3', '--navy-4', '--navy-deep', '--navy-deeper',
    '--gold', '--gold-2', '--gold-3', '--gold-soft', '--ink', '--ink-2',
    '--cream', '--bg', '--card', '--line', '--line-2', '--wash-1', '--wash-2',
    '--mark-1', '--mark-2', '--on-dark-muted', '--avatar-bg', '--avatar-ink'
  ];
  flat.forEach((k) => {
    assert.ok(keys.indexOf(k) !== -1, k + ' is set');
    assert.match(theme[k], HEX, k + ' is a flat colour');
  });

  const veils = [
    '--wash-1-0', '--wash-2-0', '--glow-brand', '--glow-accent',
    '--accent-veil', '--gold-line', '--gold-fade-1', '--gold-fade-2', '--gold-fade-3',
    '--veil-1', '--veil-2', '--veil-3', '--scrim', '--selection'
  ];
  veils.forEach((k) => {
    assert.ok(keys.indexOf(k) !== -1, k + ' is set');
    assert.match(theme[k], /^rgba\(\d{1,3},\d{1,3},\d{1,3},(0|0?\.\d+)\)$/, k + ' is a veil');
  });

  ['--shadow-sm', '--shadow', '--shadow-lg', '--shadow-btn'].forEach((k) => {
    assert.ok(keys.indexOf(k) !== -1, k + ' is set');
    assert.match(theme[k], /^0(px)? \d+px \d+px rgba\([\d.]+,?[\d.]*,?[\d.]*,[\d.]+\)$/, k + ' is a shadow');
  });

  // A theme that merely renames the house navy would pass every check above, so
  // the light is checked too: cards lift off the wash, the wash stays lighter
  // than its rules, and the shell sits under both.
  assert.ok(LHMS.brand.luminance(theme['--card']) > LHMS.brand.luminance(theme['--bg']), 'cards lift off the page wash');
  assert.ok(LHMS.brand.luminance(theme['--bg']) > LHMS.brand.luminance(theme['--line']), 'the page stays lighter than its rules');
  assert.ok(LHMS.brand.luminance(theme['--navy-deep']) < LHMS.brand.luminance(theme['--navy']), 'the shell is deeper than the ink');

  assert.equal(theme['--navy'], '#16283f', 'an already-dark primary is not crushed further');
  assert.ok(LHMS.brand.contrast(theme['--ink'], theme['--card']) >= 7, 'body ink on a card is AAA');
  assert.ok(LHMS.brand.contrast(theme['--gold'], '#ffffff') >= 3, 'gold labels survive on white');
  same(theme, LHMS.brand.themeFromPalette(['#16283f', '#b18f52']));
});

test('a logo in another hue re-tints the desk, not only its accents', () => {
  const LHMS = loadApp();
  const theme = LHMS.brand.themeFromPalette(['#14503a', '#b4552f']);
  const bg = LHMS.brand.toRgb(theme['--bg']);
  assert.ok(bg[1] > bg[0] && bg[1] > bg[2], 'the page wash carries the logo green: ' + theme['--bg']);
  assert.notEqual(theme['--card'], '#ffffff', 'the cards are tinted, not paper white');
  const accent = LHMS.brand.toRgb(theme['--gold']);
  assert.ok(accent[0] > accent[1] && accent[1] > accent[2], 'the accent is the logo terracotta: ' + theme['--gold']);
  assert.notEqual(theme['--navy'], LHMS.brand.themeFromPalette(LHMS.brand.FALLBACK)['--navy']);
});

test('applying a brand without a page is a no-op, not a crash', () => {
  const LHMS = loadApp();
  assert.doesNotThrow(() => LHMS.brand.apply(null));
  assert.doesNotThrow(() => LHMS.brand.apply({ palette: ['#16283f', '#b18f52'], useColors: true, logo: '' }));
  assert.doesNotThrow(() => LHMS.brand.apply({ palette: [], useColors: false, logo: SMALL }));
  assert.doesNotThrow(() => LHMS.brand.clear());
  assert.doesNotThrow(() => LHMS.brand.setFavicon(''));
});

test('charts ask for their colours when they draw, not when the file loads', () => {
  const LHMS = loadApp();
  // No document here, so the reader falls back to the house series rather than
  // throwing — and the call is a function, which is the point: a page that
  // aliased it to a variable at load time would keep the old palette for ever.
  const colours = LHMS.brand.chartColors();
  assert.equal(typeof LHMS.brand.chartColors, 'function');
  assert.equal(colours.length, 10);
  colours.forEach((c) => assert.match(c, HEX));
  same(colours, LHMS.brand.chartColors());
});
