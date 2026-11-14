// Fase 2: two-factor sign-in, audit log, fail2ban log lines, library permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mkUser, mkFile, call } from './helpers.js';

const { db, settings, now } = await import('../src/db.js');
const { default: authRoutes, userFromToken } = await import('../src/auth.js');
const { default: catalogRoutes } = await import('../src/catalog.js');
const { default: streamRoutes } = await import('../src/stream.js');
const { default: subtitleRoutes } = await import('../src/subtitles.js');
const { default: watchRoutes } = await import('../src/watch.js');
const { codeAt, stepOf, verifyCode, base32Encode, base32Decode } = await import('../src/totp.js');
const { audit, purgeAudit, queryAudit, logAuthFailure } = await import('../src/audit.js');
const { scopeFor, fileSql } = await import('../src/access.js');

const app = await makeApp(authRoutes, catalogRoutes, streamRoutes, subtitleRoutes, watchRoutes);
test.after(() => app.close());
const admin = mkUser('admin');
const login = (body, ip = '10.0.0.1') => app.inject({ method: 'POST', url: '/api/auth/login', payload: body, remoteAddress: ip });

test('TOTP matches the RFC 6238 test vectors and refuses reuse', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(codeAt(secret, stepOf(59_000)), '287082');
  assert.equal(codeAt(secret, stepOf(1111111109_000)), '081804');
  assert.equal(codeAt(secret, stepOf(1234567890_000)), '005924');
  const t = 1234567890_000, step = stepOf(t);
  assert.equal(verifyCode(secret, '005924', { now: t }), step);
  assert.equal(verifyCode(secret, '005 924', { now: t + 30_000 }), step, 'one step of drift is fine');
  assert.equal(verifyCode(secret, '005924', { now: t + 90_000 }), null);
  assert.equal(verifyCode(secret, '005924', { now: t, after: step }), null, 'a used code is refused');
  assert.equal(verifyCode(secret, 'abcdef', { now: t }), null);
});

test('two-factor sign-in: setup, sign-in with code, recovery code, no secrets in responses', async () => {
  const u = mkUser('user', 'Tessa');
  const setup = (await call(app, u, 'POST', '/api/auth/2fa/setup')).json();
  assert.match(setup.url, /^otpauth:\/\/totp\/Kinoko:Tessa\?secret=[A-Z2-7]+&/);
  assert.equal((await call(app, u, 'POST', '/api/auth/2fa/enable', { code: '000000' })).statusCode, 400);
  const step = stepOf();
  const on = (await call(app, u, 'POST', '/api/auth/2fa/enable', { code: codeAt(setup.secret, step) })).json();
  assert.equal(on.recoveryCodes.length, 10);
  const stored = db.prepare('SELECT recovery_codes, totp_secret FROM users WHERE id = ?').get(u.id);
  assert.ok(!stored.recovery_codes.includes(on.recoveryCodes[0]), 'recovery codes are stored hashed');

  // Password alone: no token, just the request for a code.
  const first = await login({ name: 'Tessa', password: 'geheim123' });
  assert.deepEqual(first.json(), { totpRequired: true });
  assert.equal((await login({ name: 'Tessa', password: 'geheim123', code: '123456' })).statusCode, 401);
  // The code used to enable cannot sign in; the next one can, once.
  assert.equal((await login({ name: 'Tessa', password: 'geheim123', code: codeAt(setup.secret, step) })).statusCode, 401);
  const next = codeAt(setup.secret, step + 1);
  const ok = await login({ name: 'Tessa', password: 'geheim123', code: next });
  assert.equal(ok.statusCode, 200); assert.ok(ok.json().token); assert.equal(ok.json().user.twoFactor, true);
  assert.equal((await login({ name: 'Tessa', password: 'geheim123', code: next })).statusCode, 401, 'replay');
  // A recovery code works exactly once.
  assert.equal((await login({ name: 'Tessa', password: 'geheim123', code: on.recoveryCodes[3] }, '10.0.0.2')).statusCode, 200);
  assert.equal((await login({ name: 'Tessa', password: 'geheim123', code: on.recoveryCodes[3] }, '10.0.0.2')).statusCode, 401);

  for (const r of [await call(app, u, 'GET', '/api/auth/me'), await call(app, admin, 'GET', '/api/admin/users'), ok]) {
    assert.ok(!r.body.includes(stored.totp_secret), 'the secret leaked');
    assert.ok(!r.body.includes('recovery'), 'recovery codes leaked');
  }
  // Turning it off needs password and a code; an admin can reset it.
  assert.equal((await call(app, u, 'POST', '/api/auth/2fa/disable', { password: 'geheim123', code: '111111' })).statusCode, 403);
  assert.equal((await call(app, u, 'PUT', `/api/admin/users/${u.id}`, { reset2fa: true })).statusCode, 403);
  assert.equal((await call(app, admin, 'PUT', `/api/admin/users/${u.id}`, { reset2fa: true })).statusCode, 200);
  assert.ok((await login({ name: 'Tessa', password: 'geheim123' }, '10.0.0.3')).json().token);
});

test('the sign-in throttle also covers the code step', async () => {
  const u = mkUser('user', 'Throttle');
  const setup = (await call(app, u, 'POST', '/api/auth/2fa/setup')).json();
  await call(app, u, 'POST', '/api/auth/2fa/enable', { code: codeAt(setup.secret, stepOf()) });
  let last;
  for (let i = 0; i < 9; i++) last = await login({ name: 'Throttle', password: 'geheim123', code: '000001' }, '10.9.9.9');
  assert.equal(last.statusCode, 429);
  // Even the right code is refused while throttled.
  assert.equal((await login({ name: 'Throttle', password: 'geheim123', code: codeAt(setup.secret, stepOf() + 1) }, '10.9.9.9')).statusCode, 429);
});

test('2FA can be made mandatory for admins', async () => {
  const other = mkUser('admin', 'TweedeBeheerder');
  settings.set('require_2fa_admins', true);
  try {
    const r = await call(app, other, 'GET', '/api/admin/users');
    assert.equal(r.statusCode, 403); assert.match(r.json().error, /tweestapsverificatie/);
    assert.equal((await call(app, other, 'GET', '/api/auth/me')).json().user.mustSetup2fa, true);
    const setup = (await call(app, other, 'POST', '/api/auth/2fa/setup')).json();
    await call(app, other, 'POST', '/api/auth/2fa/enable', { code: codeAt(setup.secret, stepOf()) });
    const again = userFromToken(other.token);
    assert.equal(again.totp_enabled, 1);
    assert.equal((await call(app, other, 'GET', '/api/admin/users')).statusCode, 200);
    assert.equal((await call(app, other, 'POST', '/api/auth/2fa/disable', { password: 'geheim123', code: codeAt(setup.secret, stepOf() + 1) })).statusCode, 403);
  } finally { settings.set('require_2fa_admins', false); }
});

test('audit log: sign-ins and user changes are recorded, filterable, admin only, no secrets', async () => {
  await login({ name: 'bestaat-niet', password: 'supergeheim-wachtwoord' }, '10.1.1.1');
  const id = (await call(app, admin, 'POST', '/api/admin/users', { name: 'Tijdelijk', password: 'geheim123' })).json().id;
  await call(app, admin, 'DELETE', `/api/admin/users/${id}`);
  const all = await call(app, admin, 'GET', '/api/admin/audit?limit=200');
  const actions = all.json().entries.map((e) => e.action);
  for (const a of ['login.fail', 'login.ok', 'user.create', 'user.delete', '2fa.enable', '2fa.reset']) assert.ok(actions.includes(a), a);
  assert.ok(!all.body.includes('supergeheim-wachtwoord') && !all.body.includes('geheim123'));
  const fails = (await call(app, admin, 'GET', '/api/admin/audit?action=login.fail&q=10.1.1.1')).json().entries;
  assert.ok(fails.length >= 1 && fails.every((e) => e.action === 'login.fail' && e.ip === '10.1.1.1'));
  assert.equal((await call(app, mkUser(), 'GET', '/api/admin/audit')).statusCode, 403);
  assert.equal((await call(app, null, 'GET', '/api/admin/audit')).statusCode, 401);

  // Retention: entries older than the configured days disappear.
  audit('login.ok', { detail: 'oud' });
  db.prepare("UPDATE audit_log SET at = ? WHERE detail = 'oud'").run(now() - 100 * 86400);
  assert.equal((await call(app, admin, 'PUT', '/api/admin/audit', { days: 30 })).statusCode, 200);
  assert.ok(purgeAudit() >= 1);
  assert.equal(queryAudit({ q: 'oud' }).filter((e) => e.detail === 'oud').length, 0);
  // Line breaks cannot be smuggled into an entry.
  audit('login.fail', { ip: '1.2.3.4', detail: 'a\nb\r\nc' });
  assert.equal(queryAudit({ q: '1.2.3.4' })[0].detail, 'a b c');
});

test('failed sign-ins give one fixed, parseable log line', async () => {
  const lines = []; const orig = console.warn; console.warn = (l) => lines.push(String(l));
  try {
    await login({ name: 'x\nkinoko: auth failure ip=6.6.6.6 reason=password', password: 'fout' }, '203.0.113.7');
    logAuthFailure('2001:db8::1', 'totp'); logAuthFailure('1.2.3.4\nextra', 'password');
  } finally { console.warn = orig; }
  assert.deepEqual(lines, ['kinoko: auth failure ip=203.0.113.7 reason=password', 'kinoko: auth failure ip=2001:db8::1 reason=totp', 'kinoko: auth failure ip=1.2.3.4ea reason=password']);
  const filter = /^kinoko: auth failure ip=(\S+) reason=\S+$/;
  assert.ok(lines.every((l) => filter.test(l)));
});

test('library permissions: a restricted user reaches a hidden library through no route', async () => {
  const lib = (name) => Number(db.prepare('INSERT INTO libraries (name, type, paths, created_at) VALUES (?,?,?,?)').run(name, 'movies', '[]', 1).lastInsertRowid);
  const open = lib('Open'), closed = lib('Verborgen');
  const pub = mkFile({ title: 'Zichtbare Film', libraryId: open }), hid = mkFile({ title: 'Geheime Film', libraryId: closed }), hid2 = mkFile({ title: 'Geheime Film 2', libraryId: closed });
  const show = mkFile({ title: 'Geheime Serie', kind: 'show', libraryId: closed, episode: [1, 1] });
  const peerId = Number(db.prepare('INSERT INTO peers (name, url, created_at) VALUES (?,?,?)').run('Vriend', 'http://vriend.invalid', 1).lastInsertRowid);
  const remote = mkFile({ title: 'Film Van Vriend' });
  db.prepare('UPDATE files SET peer_id = ?, remote_id = 1, library_id = NULL WHERE id = ?').run(peerId, remote.fileId);
  const col = Number(db.prepare("INSERT INTO collections (name, source_key) VALUES ('Geheime collectie', 'k1')").run().lastInsertRowid);
  for (const t of [hid.titleId, hid2.titleId]) db.prepare('INSERT INTO collection_items (collection_id, title_id) VALUES (?,?)').run(col, t);
  const extra = Number(db.prepare("INSERT INTO extras (library_id, title_id, path, name, added_at) VALUES (?,?,?,?,1)").run(closed, hid.titleId, hid.path, 'Trailer').lastInsertRowid);
  db.prepare("UPDATE titles SET rating = 9, genres = '[\"Drama\"]', backdrop = 'x', overview = 'y'").run();

  const kid = mkUser('user', 'Beperkt'), free = mkUser('user', 'Vrij');
  assert.equal((await call(app, kid, 'PUT', `/api/admin/users/${kid.id}`, { allLibraries: true })).statusCode, 403, 'a user cannot change their own access');
  assert.equal((await call(app, admin, 'PUT', `/api/admin/users/${kid.id}`, { allLibraries: false, allowPeers: false, libraries: [open, 99999] })).statusCode, 200);
  const listed = (await call(app, admin, 'GET', '/api/admin/users')).json().users.find((x) => x.id === kid.id);
  assert.deepEqual([listed.allLibraries, listed.allowPeers, listed.libraries], [false, false, [open]]);
  assert.equal(fileSql(scopeFor(userFromToken(kid.token))), `(f.peer_id IS NULL AND f.library_id IN (${open}))`);

  const secret = /Geheime|Film Van Vriend/;
  const get = async (url) => { const r = await call(app, kid, 'GET', url); return r; };
  // Listings never mention hidden titles…
  for (const url of ['/api/home', '/api/home?kind=movie', '/api/browse', '/api/browse?q=geheime', '/api/browse?q=vriend', '/api/browse?genre=Drama', '/api/collections', '/api/watchnight', `/api/titles/${pub.titleId}`]) {
    const r = await get(url);
    assert.equal(r.statusCode, 200, url);
    assert.ok(!secret.test(r.body), `${url} lekt een verborgen titel`);
  }
  assert.ok((await get('/api/browse')).body.includes('Zichtbare Film'));
  // …and anything addressed directly answers as if it does not exist.
  const blocked = [
    ['GET', `/api/titles/${hid.titleId}`], ['GET', `/api/titles/${show.titleId}`], ['GET', `/api/titles/${remote.titleId}`], ['GET', `/api/collections/${col}`],
    ['PUT', `/api/mylist/${hid.titleId}`], ['PUT', `/api/titles/${show.titleId}/prefs`, { subLang: 'nl' }],
    ['POST', '/api/play', { fileId: hid.fileId }], ['POST', '/api/play', { fileId: remote.fileId }], ['POST', `/api/extras/${extra}/play`, {}],
    ['PUT', `/api/files/${hid.fileId}/sub-offset`, { offsetMs: 100 }], ['POST', '/api/progress', { titleId: hid.titleId, position: 100, duration: 1000 }],
    ['GET', `/api/files/${hid.fileId}/subtitles/search`], ['POST', `/api/files/${hid.fileId}/subtitles/download`, { url: 'http://x', lang: 'nl' }],
    ['POST', '/api/watch', { fileId: hid.fileId }],
  ];
  for (const [method, url, body] of blocked) {
    const r = await call(app, kid, method, url, body);
    assert.equal(r.statusCode, 404, `${method} ${url} gaf ${r.statusCode}`);
    assert.ok(!secret.test(r.body), `${method} ${url} lekt`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mylist WHERE user_id = ?').get(kid.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM progress WHERE user_id = ?').get(kid.id).c, 0);

  // Watch together: a room on hidden content does not let the restricted account in.
  const code = (await call(app, admin, 'POST', '/api/watch', { fileId: hid.fileId })).json().code;
  for (const [method, url] of [['GET', `/api/watch/${code}`], ['POST', `/api/watch/${code}/play`]]) {
    const r = await call(app, kid, method, url, method === 'POST' ? {} : undefined);
    assert.equal(r.statusCode, 403, url); assert.ok(!secret.test(r.body));
  }
  // What is allowed still works, and an unrestricted user is unaffected.
  assert.equal((await call(app, kid, 'POST', '/api/play', { fileId: pub.fileId })).statusCode, 200);
  assert.equal((await call(app, free, 'GET', `/api/titles/${hid.titleId}`)).statusCode, 200);
  assert.equal((await call(app, free, 'GET', `/api/collections/${col}`)).json().items.length, 2);
  // Linked-server content is a separate switch.
  await call(app, admin, 'PUT', `/api/admin/users/${kid.id}`, { allowPeers: true });
  assert.equal((await call(app, kid, 'GET', `/api/titles/${remote.titleId}`)).statusCode, 200);
  // Admins are never restricted, whatever the row says.
  db.prepare('UPDATE users SET all_libraries = 0 WHERE id = ?').run(admin.id);
  assert.equal((await call(app, admin, 'GET', `/api/titles/${hid.titleId}`)).statusCode, 200);
});
