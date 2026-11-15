// Shared lists: a named list of titles that its owner can share with other
// users, read-only or editable. What a viewer may not see (library
// permissions, kids mode) is left out of the list for them.
import { db, now, HttpError } from './db.js';
import { requireUser } from './auth.js';
import { card } from './catalog.js';
import { scopeFor, visibleTitles, requireTitle } from './access.js';

/** The list plus what this user may do with it; 404 when it is not theirs and not shared with them. */
function accessTo(listId, user) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(listId));
  if (!list) throw new HttpError(404, 'Lijst niet gevonden.');
  if (list.owner_id === user.id) return { list, owner: true, edit: true };
  const share = db.prepare('SELECT can_edit FROM list_shares WHERE list_id = ? AND user_id = ?').get(list.id, user.id);
  if (!share) throw new HttpError(404, 'Lijst niet gevonden.');
  return { list, owner: false, edit: !!share.can_edit };
}
const cleanName = (v) => { const n = String(v || '').trim().slice(0, 60); if (!n) throw new HttpError(400, 'Geef de lijst een naam.'); return n; };

function summary(list, user, vis) {
  const items = db.prepare('SELECT t.id, t.poster FROM list_items i JOIN titles t ON t.id = i.title_id WHERE i.list_id = ? ORDER BY i.ord, i.added_at').all(list.id).filter((t) => !vis || vis.has(t.id));
  const owner = db.prepare('SELECT name, avatar FROM users WHERE id = ?').get(list.owner_id);
  const mine = list.owner_id === user.id;
  return {
    id: list.id, name: list.name, count: items.length, mine, owner: owner ? owner.name : '',
    canEdit: mine || !!db.prepare('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ? AND can_edit = 1').get(list.id, user.id),
    shared: db.prepare('SELECT COUNT(*) c FROM list_shares WHERE list_id = ?').get(list.id).c,
    posters: items.slice(0, 4).map((t) => card({ ...db.prepare('SELECT * FROM titles WHERE id = ?').get(t.id) }).poster).filter(Boolean),
  };
}

export default async function routes(app) {
  app.get('/api/lists', { preHandler: requireUser }, async (req) => {
    const vis = visibleTitles(scopeFor(req.user));
    const rows = db.prepare(`SELECT * FROM lists WHERE owner_id = ? OR id IN (SELECT list_id FROM list_shares WHERE user_id = ?) ORDER BY name COLLATE NOCASE`).all(req.user.id, req.user.id);
    const titleId = Number(req.query.title) || 0;
    return { lists: rows.map((l) => ({ ...summary(l, req.user, vis), ...(titleId && { has: !!db.prepare('SELECT 1 FROM list_items WHERE list_id = ? AND title_id = ?').get(l.id, titleId) }) })) };
  });

  app.post('/api/lists', { preHandler: requireUser }, async (req) => {
    if (db.prepare('SELECT COUNT(*) c FROM lists WHERE owner_id = ?').get(req.user.id).c >= 100) throw new HttpError(400, 'Je hebt het maximum van 100 lijsten bereikt.');
    return { id: Number(db.prepare('INSERT INTO lists (owner_id, name, created_at) VALUES (?,?,?)').run(req.user.id, cleanName(req.body?.name), now()).lastInsertRowid) };
  });

  app.get('/api/lists/:id', { preHandler: requireUser }, async (req) => {
    const a = accessTo(req.params.id, req.user);
    const vis = visibleTitles(scopeFor(req.user));
    const items = db.prepare('SELECT t.*, i.added_by FROM list_items i JOIN titles t ON t.id = i.title_id WHERE i.list_id = ? ORDER BY i.ord, i.added_at').all(a.list.id).filter((t) => !vis || vis.has(t.id));
    const names = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    return {
      ...summary(a.list, req.user, vis), items: items.map((t) => ({ ...card(t), addedBy: names.get(t.added_by) || '' })),
      // Who it is shared with is the owner's business only.
      shares: a.owner ? db.prepare('SELECT u.id, u.name, u.avatar, s.can_edit FROM list_shares s JOIN users u ON u.id = s.user_id WHERE s.list_id = ? ORDER BY u.name').all(a.list.id).map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, edit: !!s.can_edit })) : undefined,
    };
  });

  app.put('/api/lists/:id', { preHandler: requireUser }, async (req) => {
    const a = accessTo(req.params.id, req.user);
    if (!a.owner) throw new HttpError(403, 'Alleen de eigenaar kan de lijst hernoemen.');
    db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(cleanName(req.body?.name), a.list.id);
    return { ok: true };
  });

  app.delete('/api/lists/:id', { preHandler: requireUser }, async (req) => {
    const a = accessTo(req.params.id, req.user);
    // Someone it was shared with removes it from their own overview; the owner deletes it.
    if (a.owner) db.prepare('DELETE FROM lists WHERE id = ?').run(a.list.id);
    else db.prepare('DELETE FROM list_shares WHERE list_id = ? AND user_id = ?').run(a.list.id, req.user.id);
    return { ok: true };
  });

  app.put('/api/lists/:id/items/:titleId', { preHandler: requireUser }, async (req) => {
    const a = accessTo(req.params.id, req.user);
    if (!a.edit) throw new HttpError(403, 'Je kunt deze lijst alleen bekijken.');
    const titleId = Number(req.params.titleId);
    requireTitle(req.user, titleId);
    if (db.prepare('SELECT COUNT(*) c FROM list_items WHERE list_id = ?').get(a.list.id).c >= 1000) throw new HttpError(400, 'Deze lijst zit vol.');
    const ord = db.prepare('SELECT COALESCE(MAX(ord), 0) + 1 n FROM list_items WHERE list_id = ?').get(a.list.id).n;
    db.prepare('INSERT OR IGNORE INTO list_items (list_id, title_id, added_by, added_at, ord) VALUES (?,?,?,?,?)').run(a.list.id, titleId, req.user.id, now(), ord);
    return { ok: true };
  });
  app.delete('/api/lists/:id/items/:titleId', { preHandler: requireUser }, async (req) => {
    const a = accessTo(req.params.id, req.user);
    if (!a.edit) throw new HttpError(403, 'Je kunt deze lijst alleen bekijken.');
    db.prepare('DELETE FROM list_items WHERE list_id = ? AND title_id = ?').run(a.list.id, Number(req.params.titleId));
    return { ok: true };
  });

  // Replaces who the list is shared with: [{ id, edit }]
  app.put('/api/lists/:id/shares', { preHandler: requireUser }, async (req) => {
    const a = accessTo(req.params.id, req.user);
    if (!a.owner) throw new HttpError(403, 'Alleen de eigenaar kan de lijst delen.');
    const users = Array.isArray(req.body?.users) ? req.body.users : [];
    db.transaction(() => {
      db.prepare('DELETE FROM list_shares WHERE list_id = ?').run(a.list.id);
      for (const u of users.slice(0, 200)) {
        const id = Number(u?.id);
        if (id === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) continue;
        db.prepare('INSERT OR REPLACE INTO list_shares (list_id, user_id, can_edit) VALUES (?,?,?)').run(a.list.id, id, u.edit ? 1 : 0);
      }
    })();
    return { ok: true };
  });

  // Names to pick from when sharing. Only what is needed to recognise someone.
  app.get('/api/users/directory', { preHandler: requireUser }, async (req) => ({
    users: db.prepare('SELECT id, name, avatar FROM users WHERE id != ? ORDER BY name COLLATE NOCASE').all(req.user.id),
  }));
}
