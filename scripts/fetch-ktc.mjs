// Scrapes KeepTradeCut dynasty + redraft values and writes data/ktc.json.
// Run by .github/workflows/ktc.yml. Requires Node 18+ (global fetch).
// Exits non-zero (leaving the existing file untouched) if the dynasty pull fails.
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGES = {
  dynasty: 'https://keeptradecut.com/dynasty-rankings?page=0&filters=QB|WR|RB|TE|RDP&format=2',
  redraft: 'https://keeptradecut.com/fantasy-rankings?page=0&filters=QB|WR|RB|TE&format=2'
};

// Parse a balanced JSON array starting at html[start] === '['.
function parseArrayAt(html, start) {
  let depth = 0, inStr = null, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// Find the player array: first the classic `var playersArray = [...]`, then any
// array literal whose first object has a playerName key.
function extractPlayersArray(html) {
  const idx = html.indexOf('playersArray');
  if (idx >= 0) {
    const a = parseArrayAt(html, html.indexOf('[', idx));
    if (Array.isArray(a) && a.length >= 50) return a;
  }
  const re = /\[\s*\{\s*"playerName"/g;
  let m;
  while ((m = re.exec(html))) {
    const a = parseArrayAt(html, m.index);
    if (Array.isArray(a) && a.length >= 50) return a;
  }
  return null;
}

function diagnose(kind, status, html) {
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
  const markers = ['playersArray', 'playerName', 'superflexValues', 'oneQBValues', 'onePlayer',
    '__NEXT_DATA__', 'Just a moment', 'cf-chl', 'challenge-platform', 'Attention Required'];
  console.log(`[${kind}] status=${status} bytes=${html.length} title=${JSON.stringify(title)}`);
  for (const k of markers) {
    const i = html.indexOf(k);
    console.log(`  ${k}: ${i < 0 ? '-' : 'at ' + i + ' :: ' + JSON.stringify(html.slice(Math.max(0, i - 80), i + 160))}`);
  }
}

const slimVals = v => v && v.value ? { value: v.value, overallTrend: v.overallTrend ?? null } : null;

async function pull(kind) {
  const res = await fetch(PAGES[kind], {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }
  });
  if (!res.ok) throw new Error(`${kind}: HTTP ${res.status}`);
  const html = await res.text();
  const arr = extractPlayersArray(html);
  if (!Array.isArray(arr) || arr.length < 50) {
    diagnose(kind, res.status, html);
    throw new Error(`${kind}: playersArray not found`);
  }
  return arr.map(p => ({
    playerName: p.playerName,
    position: p.position,
    oneQBValues: slimVals(p.oneQBValues),
    superflexValues: slimVals(p.superflexValues)
  })).filter(p => p.playerName && (p.oneQBValues || p.superflexValues));
}

const dynasty = await pull('dynasty'); // let this throw — no point writing without it
let redraft = [];
try { redraft = await pull('redraft'); }
catch (err) {
  console.warn('Redraft pull failed, keeping previous redraft data:', err.message);
  try { redraft = JSON.parse(await readFile('data/ktc.json', 'utf8')).redraft || []; } catch {}
}

await mkdir('data', { recursive: true });
await writeFile('data/ktc.json', JSON.stringify({ updated: new Date().toISOString(), dynasty, redraft }));
console.log(`Wrote ${dynasty.length} dynasty / ${redraft.length} redraft rows`);
