// Dev-only helper: drive headless Chromium over CDP. Usage: node _cdp.mjs script.mjs
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import fs from 'node:fs';
const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required', '--mute-audio', `--user-data-dir=/tmp/claude-0/cdp-${port}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = l.find((t) => t.type === 'page'); if (target) break; } catch {} await sleep(250); }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map(); export const logs = [];
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ' ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('LOG ' + m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url || '')); });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
const page = {
  sleep,
  async size(w, h, mobile = false) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }); },
  async goto(url, wait = 1200) { await send('Page.navigate', { url }); await sleep(wait); },
  async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result.result.value; },
  async shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(name, Buffer.from(r.result.data, 'base64')); },
  async click(sel) { return page.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel.split('>>')[0])})]${sel.includes('>>') ? `.filter(e=>e.textContent.includes(${JSON.stringify(sel.split('>>')[1])}))` : ''}[0]; if(!e) return false; e.click(); return true;})()`); },
  async type(sel, text) { return page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.focus(); e.value=${JSON.stringify(text)}; e.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`); },
  async mouse(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
  logs,
};
try { await (await import(process.argv[2])).default(page); } catch (e) { console.log('SCRIPT ERROR', e.message); }
if (logs.length) console.log('--- browser log ---\n' + [...new Set(logs)].join('\n'));
ws.close(); chrome.kill(); process.exit(0);
