// Viewing time per user, title and day. Feeds the yearly overview (Wrapped).
import { db } from './db.js';

/** Adds watched seconds to today's row. Called from the progress endpoint. */
export function logWatch(userId, titleId, episodeId, seconds, at = new Date()) {
  if (!(seconds > 0)) return;
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  db.prepare(`INSERT INTO watch_log (user_id, title_id, episode_id, day, seconds) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, title_id, episode_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`).run(userId, titleId, episodeId || 0, day, seconds);
}

