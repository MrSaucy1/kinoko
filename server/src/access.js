// Who may see what. A user is either unrestricted, or limited to a set of
// libraries (and, separately, to content from linked servers). Every place
// that lists or opens a title, file or extra goes through here.
import { db, HttpError } from './db.js';

/** The viewing scope of a user row. Admins are never restricted. */
export function scopeFor(user) {
  if (!user || user.role === 'admin' || user.all_libraries !== 0) return { all: true, libs: null, peers: true };
  const libs = new Set(db.prepare('SELECT library_id FROM library_access WHERE user_id = ?').all(user.id).map((r) => r.library_id));
  return { all: false, libs, peers: user.allow_peers !== 0 };
}

export const canSeeFile = (scope, f) => scope.all || (f.peer_id ? scope.peers : scope.libs.has(f.library_id));

/** SQL condition on a files row (alias `a`) for this scope. Only integers are inlined. */
export function fileSql(scope, a = 'f') {
  if (scope.all) return '1';
  const ids = [...scope.libs].filter(Number.isInteger).join(',');
  const local = ids ? `(${a}.peer_id IS NULL AND ${a}.library_id IN (${ids}))` : '0';
  return scope.peers ? `(${local} OR ${a}.peer_id IS NOT NULL)` : local;
}

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
