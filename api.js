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
  // Also accept multi-account links: /spreadsheets/u/7/d/<id>/...
  const m = String(url || '').match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : '';
}

function sheetFail(e) {
  const msg = (e && e.message) || '';
  if (/403|permission|forbidden|does not have permission/i.test(msg)) {
    return { error: 'Tài khoản Google của Xuka chưa có quyền xem file này' };
  }
  return { error: msg || 'Không đọc được file' };
}

function vnDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const d = new Date();
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
  }
  return Number(m[3]) + '/' + Number(m[2]) + '/' + m[1];
}

function sheetTitle(file) {
  return String((file && file.sheet) || 'Công nợ').replace(/'/g, "''");
}

async function sheetValuesGet(id, range) {
  const token = await googleToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/' + encodeURIComponent(range) + '?valueRenderOption=UNFORMATTED_VALUE';
  return httpsRequest(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token } });
}

async function sheetValuesUpdate(id, range, values) {
  const token = await googleToken();
  const body = JSON.stringify({ values: values });
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED';
  return httpsRequest(url, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
}

async function readCheckerSheet(file) {
  const id = sheetIdOf(file && file.url);
  if (!id) return { error: 'Link file không phải Google Sheet' };
  const data = await sheetValuesGet(id, "'" + sheetTitle(file) + "'!A:F");
  return parseCongNo((data && data.values) || []);
}

async function appendCheckerPayment(file, payment) {
  const id = sheetIdOf(file && file.url);
  if (!id) return { error: 'Link file không phải Google Sheet' };
  const amount = Number(payment && payment.amount);
  if (!(amount > 0)) return { error: 'Không có số tiền thanh toán' };
  const title = sheetTitle(file);
  let existing;
  try {
    existing = await sheetValuesGet(id, "'" + title + "'!A:A");
  } catch (e) {
    return sheetFail(e);
  }
  const col = (existing && existing.values) || [];
  let last = 2;
  for (let i = 0; i < col.length; i++) {
    if (col[i] && String(col[i][0] == null ? '' : col[i][0]).trim() !== '') last = i + 1;
  }
  const row = Math.max(last + 1, 3);
  try {
    await sheetValuesUpdate(id, "'" + title + "'!A" + row + ':D' + row, [[
      vnDate(payment.date), 'Thanh toán', '', amount
    ]]);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/403|permission|forbidden/i.test(msg)) {
      return { error: 'Tài khoản Google của Xuka chưa có quyền sửa file này' };
    }
    return { error: msg || 'Không ghi được file' };
  }
  return { row };
}

const THU_CHI_ID = '1bVQLczc-vYsjc0ngWG2cx8raLDkFjf7CyaNkiXSVRgA';
const THU_CHI_GID = 452194327;

function colLetter(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normHead(s) {
  return String(s || '').trim().toLowerCase();
}

function sheetSerial(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y, mo, d;
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    const now = new Date();
    y = now.getFullYear();
    mo = now.getMonth() + 1;
    d = now.getDate();
  }
  return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

async function sheetProps(id) {
  const token = await googleToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id + '?fields=' + encodeURIComponent('sheets.properties');
  return httpsRequest(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token } });
}

async function lastUsedRow(title, col) {
  const existing = await sheetValuesGet(THU_CHI_ID, "'" + title + "'!" + col + ':' + col);
  const vals = (existing && existing.values) || [];
  let last = 1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] && String(vals[i][0] == null ? '' : vals[i][0]).trim() !== '') last = i + 1;
  }
  return last;
}

async function appendThuChi(payment) {
  const amount = Number(payment && payment.amount);
  if (!amount) return { error: 'Không có số tiền thanh toán' };
  if (!payment || !payment.content || !payment.field || !payment.category) {
    return { error: 'Thiếu nội dung Thu Chi' };
  }
  let title = '';
  try {
    const meta = await sheetProps(THU_CHI_ID);
    const sheets = (meta && meta.sheets) || [];
    const hit = sheets.map(function (s) { return s.properties; }).find(function (s) { return s && s.sheetId === THU_CHI_GID; });
    if (!hit) return { error: 'Không thấy tab Thu Chi trong file' };
    title = String(hit.title || '').replace(/'/g, "''");
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/403|permission|forbidden/i.test(msg)) {
      return { error: 'Tài khoản Google của Xuka chưa có quyền sửa file Thu Chi' };
    }
    return { error: msg || 'Không ghi được file Thu Chi' };
  }
  let header = [];
  try {
    const res = await sheetValuesGet(THU_CHI_ID, "'" + title + "'!1:1");
    header = (res && res.values && res.values[0]) || [];
  } catch (e) {
    return { error: (e && e.message) || 'Không đọc được file Thu Chi' };
  }
  const want = {
    month: 'tháng ht',
    date: 'ngày tt',
    field: 'ngành nghề',
    cat: 'danh mục thu chi',
    content: 'nội dung',
    chi: 'chi',
    pttt: 'pttt',
    note: 'ghi chú'
  };
  const line = header.map(normHead);
  const idx = {};
  for (const key of Object.keys(want)) {
    idx[key] = line.findIndex(function (c) { return c === want[key]; });
    if (idx[key] < 0) return { error: 'Không thấy cột ' + want[key] + ' trên file Thu Chi' };
  }
  let row = 2;
  try {
    const lastDate = await lastUsedRow(title, colLetter(idx.date));
    const lastContent = await lastUsedRow(title, colLetter(idx.content));
    row = Math.max(lastDate, lastContent, 1) + 1;
  } catch (e) {
    return { error: (e && e.message) || 'Không ghi được file Thu Chi' };
  }
  const min = Math.min(idx.month, idx.date, idx.field, idx.cat, idx.content, idx.chi, idx.pttt, idx.note);
  const max = Math.max(idx.month, idx.date, idx.field, idx.cat, idx.content, idx.chi, idx.pttt, idx.note);
  const values = new Array(max - min + 1).fill('');
  const note = /^https?:\/\//i.test(payment.note) ? String(payment.note) : '';
  values[idx.month - min] = Number(payment.month) || (new Date().getMonth() + 1);
  values[idx.date - min] = sheetSerial(payment.date);
  values[idx.field - min] = String(payment.field);
  values[idx.cat - min] = String(payment.category);
  values[idx.content - min] = String(payment.content);
  values[idx.chi - min] = amount;
  values[idx.pttt - min] = String(payment.pttt || '');
  values[idx.note - min] = note;
  try {
    await sheetValuesUpdate(THU_CHI_ID, "'" + title + "'!" + colLetter(min) + row + ':' + colLetter(max) + row, [values]);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/403|permission|forbidden/i.test(msg)) {
      return { error: 'Tài khoản Google của Xuka chưa có quyền sửa file Thu Chi' };
    }
    return { error: msg || 'Không ghi được file Thu Chi' };
  }
  return { row };
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

function geminiApiKey() {
  const fromEnv = String(process.env.XUKA_GEMINI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(DATA_DIR, 'gemini-api-key.txt');
    if (fs.existsSync(file)) return String(fs.readFileSync(file, 'utf8') || '').trim();
  } catch (e) {}
  return '';
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
  const key = geminiApiKey();
  if (!key) return { error: 'Chưa có XUKA_GEMINI_API_KEY trên server' };
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

function hashId(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stampSeed(row) {
  const copy = {};
  Object.keys(row).sort().forEach((k) => {
    if (k !== 'id' && k !== '_id') copy[k] = row[k];
  });
  return JSON.stringify(copy);
}

function stampList(list, readId, writeId, prefix) {
  if (!Array.isArray(list)) return;
  const seen = {};
  list.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    let id = readId(row);
    if (!id) {
      id = prefix + hashId(stampSeed(row) + '#' + i);
      writeId(row, id);
    }
    let n = 2;
    while (seen[id]) {
      id = prefix + hashId(stampSeed(row) + '#' + i + '#' + n);
      writeId(row, id);
      n++;
    }
    seen[id] = 1;
  });
}

function stampMain(main) {
  if (!main || typeof main !== 'object') return main;
  stampList(main.sup, (r) => r.id || r.idCK || '', (r, id) => { r.id = id; }, 'sp');
  stampList(main.kh, (r) => r._id || '', (r, id) => { r._id = id; }, 'kh');
  stampList(main.ck, (r) => r._id || '', (r, id) => { r._id = id; }, 'ck');
  stampList(main.muaGc, (r) => r.id || '', (r, id) => { r.id = id; }, 'gc');
  return main;
}

function userKey(u) {
  return String((u && (u.user || u.email)) || '').trim().toLowerCase();
}

function applyList(list, patch, keyFn) {
  let rows = Array.isArray(list) ? list.slice() : [];
  const del = {};
  (patch && patch.delete || []).forEach((id) => { if (id) del[id] = 1; });
  if (Object.keys(del).length) {
    rows = rows.filter((row) => {
      const id = keyFn(row);
      return !id || !del[id];
    });
  }
  (patch && patch.upsert || []).forEach((row) => {
    const id = keyFn(row);
    if (!id) { rows.unshift(row); return; }
    let idx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (keyFn(rows[i]) === id) { idx = i; break; }
    }
    if (idx >= 0) rows[idx] = row;
    else rows.unshift(row);
  });
  return rows;
}

function applyMap(obj, patch) {
  const out = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.assign({}, obj) : {};
  (patch && patch.delete || []).forEach((k) => { delete out[k]; });
  const up = (patch && patch.upsert) || {};
  Object.keys(up).forEach((k) => { out[k] = up[k]; });
  return out;
}

function applyStrings(list, patch) {
  const del = {};
  (patch && patch.delete || []).forEach((s) => { del[String(s)] = 1; });
  const out = (Array.isArray(list) ? list : []).filter((s) => !del[String(s)]);
  (patch && patch.upsert || []).forEach((s) => {
    if (out.map(String).indexOf(String(s)) < 0) out.push(s);
  });
  return out;
}

function applyXukaPatch(store, body) {
  if (!store.xuka_cn_v1 || typeof store.xuka_cn_v1 !== 'object') store.xuka_cn_v1 = {};
  const main = store.xuka_cn_v1;
  const patch = body.xuka_patch || {};
  stampMain(main);
  const lists = [
    ['sup', (r) => String((r && (r.id || r.idCK)) || '')],
    ['kh', (r) => String((r && r._id) || '')],
    ['ck', (r) => String((r && r._id) || '')],
    ['muaGc', (r) => String((r && r.id) || '')],
    ['partners', (r) => String((r && r.type) || '') + '\n' + String((r && r.name) || '')],
    ['khChars', (r) => String((r && r.name) || '')]
  ];
  lists.forEach(([key, keyFn]) => {
    if (patch[key]) main[key] = applyList(main[key], patch[key], keyFn);
  });
  ['checkerBook', 'checkerOver'].forEach((key) => {
    if (patch[key]) main[key] = applyMap(main[key], patch[key]);
  });
  if (patch.companyBanks) main.companyBanks = applyStrings(main.companyBanks, patch.companyBanks);
  if (patch.charOptions) {
    if (!main.charOptions || typeof main.charOptions !== 'object') main.charOptions = {};
    Object.keys(patch.charOptions).forEach((k) => {
      main.charOptions[k] = applyStrings(main.charOptions[k], patch.charOptions[k]);
    });
  }
  if (patch.ctr != null) main.ctr = Math.max(Number(main.ctr) || 1, Number(patch.ctr) || 1);
  if (patch.lastChotPhien != null) main.lastChotPhien = Math.max(Number(main.lastChotPhien) || 0, Number(patch.lastChotPhien) || 0);
  if (patch.checkerPctSet) main.checkerPct = patch.checkerPct;
  if (patch.checkerFiles) {
    const existing = main.checkerFiles || {};
    const linked = Object.keys(existing).filter((k) => existing[k] && existing[k].url);
    const dels = patch.checkerFiles.delete || [];
    const ups = patch.checkerFiles.upsert || {};
    const wipingAll = linked.length > 1 && !Object.keys(ups).length && linked.every((k) => dels.indexOf(k) >= 0);
    if (wipingAll) delete patch.checkerFiles;
    else main.checkerFiles = applyMap(existing, patch.checkerFiles);
  }
  if (body.xuka_users_patch) store.xuka_users = applyList(store.xuka_users, body.xuka_users_patch, userKey);
  if (body.xuka_mapping_patch) store.xuka_mapping = applyMap(store.xuka_mapping, body.xuka_mapping_patch);
  return store;
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
  if (route === '/api/checker-payment' && req.method === 'POST') {
    readBody(req, 1e6).then(async (body) => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
      const result = await appendCheckerPayment(payload.file, payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"invalid"}');
    });
    return;
  }
  if (route === '/api/read-bill' && req.method === 'POST') {
    readBody(req, 4e6).then(async (body) => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
      try {
        const result = await readBillImage(payload.image);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e && e.message) || 'Không đọc được bill' }));
      }
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"invalid"}');
    });
    return;
  }
  if (route === '/api/thu-chi' && req.method === 'POST') {
    readBody(req, 1e6).then(async (body) => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
      const result = await appendThuChi(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
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
        // xuka_patch merges each record, so two people can save different rows.
        let existing = {};
        if (fs.existsSync(DATA_FILE)) {
          try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch(e) { existing = {}; }
          fs.copyFileSync(DATA_FILE, DATA_FILE + '.prev');
        }
        if (!existing || typeof existing !== 'object') existing = {};
        if (existing.sup !== undefined && existing.xuka_cn_v1 === undefined) existing = { xuka_cn_v1: existing };
        if (!d.xuka_patch && d.xuka_cn_v1 && existing.xuka_cn_v1) {
          ['checkerFiles', 'muaGc', 'checkerBook', 'checkerPct', 'checkerOver', 'companyBanks'].forEach((k) => {
            if (!Object.prototype.hasOwnProperty.call(d.xuka_cn_v1, k) && existing.xuka_cn_v1[k] != null) {
              d.xuka_cn_v1[k] = existing.xuka_cn_v1[k];
            }
          });
        }
        const merged = d.xuka_patch ? applyXukaPatch(existing, d) : Object.assign({}, existing, d);
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
