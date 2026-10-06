const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Data lives OUTSIDE the platform bot folder (which the platform wipes on
// every reload). Override the location with XUKA_DATA_DIR if needed.
const DATA_DIR = process.env.XUKA_DATA_DIR || '/home/vmadmin/xuka-data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}
const DATA_FILE = path.join(DATA_DIR, 'xuka_data.json');
const PORT = Number(process.env.PORT) || 3456;

function googleCredPath() {
  const fromEnv = process.env.XUKA_GOOGLE_CREDENTIALS || '';
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.join(DATA_DIR, 'google-credentials.json');
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else {
          const msg = (data && (data.error_description || (data.error && data.error.message) || data.error)) || raw || ('HTTP ' + res.statusCode);
          const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let tokenCache = { token: '', exp: 0 };
async function googleToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp > now + 60) return tokenCache.token;
  const file = googleCredPath();
  if (!fs.existsSync(file)) throw new Error('Chưa có file khóa Google trên server');
  const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(creds.private_key);
  const assertion = header + '.' + claim + '.' + b64url(sig);
  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion);
  const json = await httpsRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }
  }, form);
  if (!json || !json.access_token) throw new Error('Không lấy được token Google');
  tokenCache = { token: json.access_token, exp: now + (Number(json.expires_in) || 3600) };
  return tokenCache.token;
}

function moneyCell(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return isFinite(n) ? n : null;
}

function parseCongNo(rows) {
  let header = -1, colI = -1, colIII = -1;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const line = (rows[r] || []).map(c => String(c || '').trim().toLowerCase());
    const i = line.findIndex(c => c === 'công nợ');
    const j = line.findIndex(c => c === 'còn lại');
    if (i >= 0 && j >= 0) { header = r; colI = i; colIII = j; break; }
  }
  if (header < 0) return { error: 'Không thấy cột Công nợ và Còn lại' };
  let I = null, III = null;
  if (header > 0) {
    const above = rows[header - 1] || [];
    I = moneyCell(above[colI]);
    III = moneyCell(above[colIII]);
  }
  if (I == null) {
    let sum = 0;
    for (let r = header + 1; r < rows.length; r++) {
      const n = moneyCell((rows[r] || [])[colI]);
      if (n) sum += n;
    }
    I = sum;
  }
  if (III == null) {
    for (let r = rows.length - 1; r > header; r--) {
      const n = moneyCell((rows[r] || [])[colIII]);
      if (n != null) { III = n; break; }
    }
  }
  return { I, III };
}

function sheetIdOf(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : '';
}

function sheetFail(e) {
  const msg = (e && e.message) || '';
  if (/403|permission|forbidden|does not have permission/i.test(msg)) {
    return { error: 'Tài khoản Google của Xuka chưa có quyền xem file này' };
  }
  return { error: msg || 'Không đọc được file' };
}

async function readCheckerSheet(file) {
  const id = sheetIdOf(file && file.url);
  if (!id) return { error: 'Link file không phải Google Sheet' };
  const title = String((file && file.sheet) || 'Công nợ').replace(/'/g, "''");
  const range = "'" + title + "'!A:F";
  const token = await googleToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/' + encodeURIComponent(range) + '?valueRenderOption=UNFORMATTED_VALUE';
  const data = await httpsRequest(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token } });
  return parseCongNo((data && data.values) || []);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('too big'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const route = String(req.url || '').split('?')[0];
  if (route === '/api/checker-sheets' && req.method === 'POST') {
    readBody(req, 1e6).then(async (body) => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
      const files = payload && payload.files && typeof payload.files === 'object' ? payload.files : {};
      const rows = {};
      const names = Object.keys(files).filter(n => files[n] && files[n].url);
      for (const name of names) {
        try { rows[name] = await readCheckerSheet(files[name]); }
        catch (e) { rows[name] = sheetFail(e); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows }));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"invalid"}');
    });
    return;
  }
  if (req.url !== '/api/data' && route !== '/api/data') { res.writeHead(404); res.end(); return; }

  if (req.method === 'GET') {
    try {
      const raw = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : 'null';
      const parsed = JSON.parse(raw);
      // Normalize: if stored as raw xuka_cn_v1 object (old format), wrap it
      let result = parsed;
      if (parsed && parsed.sup !== undefined && parsed.xuka_cn_v1 === undefined) {
        result = { xuka_cn_v1: parsed };
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('null'); }

  } else if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 20e6) req.destroy(); });
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        if (!d || typeof d !== 'object') throw new Error();
        // Merge over existing top-level keys instead of blind overwrite: a client
        // that hasn't synced xuka_users/xuka_mapping/xuka_debt_reset locally yet
        // would otherwise silently wipe them (and resurrect old data) on save.
        let existing = {};
        if (fs.existsSync(DATA_FILE)) {
          try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch(e) { existing = {}; }
          fs.copyFileSync(DATA_FILE, DATA_FILE + '.prev');
        }
        const merged = Object.assign({}, existing, d);
        // Keep last-known-good copy, then write atomically (tmp + rename) so a
        // crash mid-write can't corrupt xuka_data.json.
        const tmpFile = DATA_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(merged), 'utf8');
        fs.renameSync(tmpFile, DATA_FILE);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end('{"ok":true}');
      } catch(e) { res.writeHead(400); res.end('{"error":"invalid"}'); }
    });
  } else {
    res.writeHead(405); res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log('xuka-api listening on port ' + PORT + ', data at ' + DATA_FILE));
