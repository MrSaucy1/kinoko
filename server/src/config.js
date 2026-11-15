// Runtime configuration. Everything is overridable through environment
// variables so the same code runs in an LXC, a VM or a dev checkout.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export const config = {
  port: Number(process.env.KINOKO_PORT || 8096),
  host: process.env.KINOKO_HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.KINOKO_DATA || path.join(root, 'data')),
  webDir: path.resolve(process.env.KINOKO_WEB || path.join(root, 'web')),
  ffmpeg: process.env.KINOKO_FFMPEG || 'ffmpeg',
  ffprobe: process.env.KINOKO_FFPROBE || 'ffprobe',
  ytdlp: process.env.KINOKO_YTDLP || 'yt-dlp',
  helper: process.env.KINOKO_HELPER || '/usr/local/bin/kinoko-helper',
  version: JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version,
};

for (const d of ['', 'images', 'transcode', 'subs', 'fingerprints', 'backups', 'trickplay', 'music', 'recordings', 'archive']) {
  fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
}

export const dataPath = (...p) => path.join(config.dataDir, ...p);
