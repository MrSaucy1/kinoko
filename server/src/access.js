// Who may see what. A user can be limited to a set of libraries, to content
// from linked servers or not, and (kids mode) to a maximum age rating. Every
// place that lists or opens a title, file or extra goes through here.
import { db, HttpError } from './db.js';

/**
 * The viewing scope of a user row. Admins are never restricted.
 *   libs        Set of library ids, or null for every library
 *   peers       may see content from linked servers
 *   maxAge      highest age rating allowed, or null for no limit
 *   hideUnrated with a limit: titles without a rating are hidden too
 */
export function scopeFor(user) {
  const open = { all: true, libs: null, peers: true, maxAge: null, hideUnrated: false, kids: false };
  if (!user || user.role === 'admin') return open;
  const limitedLibs = user.all_libraries === 0;
  const maxAge = Number.isInteger(user.max_age) ? user.max_age : null;
  if (!limitedLibs && maxAge === null) return open;
  return {
    all: false,
    libs: limitedLibs ? new Set(db.prepare('SELECT library_id FROM library_access WHERE user_id = ?').all(user.id).map((r) => r.library_id)) : null,
    peers: limitedLibs ? user.allow_peers !== 0 : true,
    maxAge, hideUnrated: maxAge !== null && user.hide_unrated !== 0, kids: maxAge !== null,
  };
}

/** SQL condition on a titles row (alias `a`) for the age limit. */
export function ageSql(scope, a = 't') {
  if (scope.all || scope.maxAge === null) return '1';
  const max = Math.trunc(scope.maxAge);
  return scope.hideUnrated ? `(${a}.age IS NOT NULL AND ${a}.age <= ${max})` : `(${a}.age IS NULL OR ${a}.age <= ${max})`;
}

/** SQL condition on a files row (alias `a`): library, linked servers and the title's age. Only integers are inlined. */
export function fileSql(scope, a = 'f') {
  if (scope.all) return '1';
  let lib = '1';
  if (scope.libs) {
    const ids = [...scope.libs].filter(Number.isInteger).join(',');
    const local = ids ? `(${a}.peer_id IS NULL AND ${a}.library_id IN (${ids}))` : '0';
    lib = scope.peers ? `(${local} OR ${a}.peer_id IS NOT NULL)` : local;
  }
  if (scope.maxAge === null) return lib;
  return `(${lib} AND ${a}.title_id IN (SELECT ta.id FROM titles ta WHERE ${ageSql(scope, 'ta')}))`;
}

const libOk = (scope, row) => !scope.libs || (row.peer_id ? scope.peers : scope.libs.has(row.library_id));
function ageOk(scope, titleId) {
  if (scope.all || scope.maxAge === null) return true;
  return !!db.prepare(`SELECT 1 FROM titles t WHERE t.id = ? AND ${ageSql(scope)}`).get(titleId);
}

export const canSeeFile = (scope, f) => scope.all || (libOk(scope, f) && ageOk(scope, f.title_id));
/** Bonus material follows its library and its title. */
export const canSeeExtra = (scope, x) => scope.all || (libOk(scope, x) && ageOk(scope, x.title_id));

/** Ids of the titles this scope can see; null means "all of them". */
export function visibleTitles(scope) {
  if (scope.all) return null;
  return new Set(db.prepare(`SELECT DISTINCT f.title_id id FROM files f WHERE ${fileSql(scope)}`).all().map((r) => r.id));
}

// A hidden thing answers exactly like a missing thing, so its existence does not leak.
export function requireFile(user, fileId, message = 'Deze versie bestaat niet meer.') {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(fileId));
  if (!file || !canSeeFile(scopeFor(user), file)) throw new HttpError(404, message);
  return file;
}
export function canSeeTitle(scope, titleId) {
  if (scope.all) return !!db.prepare('SELECT 1 FROM titles WHERE id = ?').get(Number(titleId));
  return !!db.prepare(`SELECT 1 FROM files f WHERE f.title_id = ? AND ${fileSql(scope)} LIMIT 1`).get(Number(titleId));
}
export function requireTitle(user, titleId) {
  if (!canSeeTitle(scopeFor(user), titleId)) throw new HttpError(404, 'Titel niet gevonden.');
}

/**
 * SQL condition on a tracks row (alias `a`). Music follows the same library
 * and linked-server permissions as films. It has no age ratings, so an account
 * with an age limit gets everything except tracks tagged as explicit.
 */
export function trackSql(scope, a = 't') {
  if (scope.all) return '1';
  let lib = '1';
  if (scope.libs) {
    const ids = [...scope.libs].filter(Number.isInteger).join(',');
    const local = ids ? `(${a}.peer_id IS NULL AND ${a}.library_id IN (${ids}))` : '0';
    lib = scope.peers ? `(${local} OR ${a}.peer_id IS NOT NULL)` : local;
  }
  return scope.maxAge === null ? lib : `(${lib} AND ${a}.explicit = 0)`;
}
