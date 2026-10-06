const http = require('http');
const fs = require('fs');
const path = require('path');

// Data lives OUTSIDE the platform bot folder (which the platform wipes on
// every reload). Override the location with XUKA_DATA_DIR if needed.
const DATA_DIR = process.env.XUKA_DATA_DIR || '/home/vmadmin/xuka-data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}
const DATA_FILE = path.join(DATA_DIR, 'xuka_data.json');
const PORT = 3456;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url !== '/api/data') { res.writeHead(404); res.end(); return; }

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
