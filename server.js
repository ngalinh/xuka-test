const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) return;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  });
}

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

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
          reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function billImagePart(image) {
  const raw = String(image || '').trim();
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (m) return { mimeType: m[1], data: m[2].replace(/\s/g, '') };
  const data = raw.replace(/\s/g, '');
  if (data.length > 80) return { mimeType: 'image/jpeg', data };
  return null;
}

function normalizeBillRead(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  let obj = null;
  try { obj = JSON.parse(cleaned); } catch (e) {
    const found = cleaned.match(/\{[\s\S]*\}/);
    if (found) { try { obj = JSON.parse(found[0]); } catch (e2) { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return { date: '', amount: 0 };
  let date = String(obj.date || '').trim();
  const iso = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dmy = date.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (iso) date = iso[1] + '-' + iso[2] + '-' + iso[3];
  else if (dmy) date = dmy[3] + '-' + String(dmy[2]).padStart(2, '0') + '-' + String(dmy[1]).padStart(2, '0');
  else date = '';
  let amount = obj.amount;
  if (typeof amount === 'string') amount = amount.replace(/[^\d]/g, '');
  amount = Math.round(Number(amount) || 0);
  if (!(amount > 0)) amount = 0;
  return { date, amount };
}

async function readBillImage(image) {
  const key = String(process.env.XUKA_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
  if (!key) return { error: 'Chưa điền XUKA_GEMINI_API_KEY trong .env của bot' };
  const img = billImagePart(image);
  if (!img || !img.data) return { error: 'Ảnh bill không đọc được' };
  const model = process.env.XUKA_GEMINI_MODEL || 'gemini-2.5-flash';
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: 'Đây là ảnh bill chuyển khoản ngân hàng Việt Nam. Chỉ trả về một JSON, không markdown: {"date":"YYYY-MM-DD","amount":0}. date là ngày giao dịch trên bill. amount là số tiền chuyển, số nguyên VND. Không lấy số dư tài khoản. Không thấy thì date là chuỗi rỗng và amount là 0.' },
        { inlineData: { mimeType: img.mimeType, data: img.data } }
      ]
    }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const json = await httpsRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
  const out = normalizeBillRead(text);
  if (!out.date && !out.amount) return { error: 'Không thấy ngày hoặc số tiền trên ảnh', date: '', amount: 0 };
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
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

function safeFile(urlPath) {
  const clean = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  const full = path.normalize(path.join(__dirname, rel));
  if (!full.startsWith(path.normalize(__dirname + path.sep)) && full !== path.normalize(__dirname)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  const route = String(req.url || '/').split('?')[0];
  if ((route === '/read-bill' || route === '/api/read-bill') && req.method === 'POST') {
    readBody(req, 4e6).then(async (body) => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
      try {
        sendJson(res, 200, await readBillImage(payload.image));
      } catch (e) {
        sendJson(res, 200, { error: (e && e.message) || 'Không đọc được bill' });
      }
    }).catch(() => sendJson(res, 400, { error: 'invalid' }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }
  const file = safeFile(route);
  if (!file) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
});

server.listen(PORT, () => console.log('xuka-test listening on ' + PORT));
