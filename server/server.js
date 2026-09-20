const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { handleApi } = require('./api');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(__dirname, '..', 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

function serveStatic(req, res, pathname) {
  // Owner-uploaded photos/videos live under data/uploads (persistent storage),
  // not public/ — so one storage volume mounted at data/ covers the database
  // AND all uploaded media on any host that only supports a single volume.
  const isUpload = pathname.startsWith('/uploads/');
  const rootDir = isUpload ? DATA_DIR : PUBLIC_DIR;
  let filePath = path.join(rootDir, decodeURIComponent(pathname));

  // Directory traversal guard
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (pathname === '/' || pathname === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      // Try adding .html for pretty URLs (e.g. /login -> /login.html)
      const withHtml = filePath + '.html';
      fs.stat(withHtml, (err2, stats2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          return res.end('<h1>404</h1><p>Page not found.</p><a href="/">Go home</a>');
        }
        streamFile(res, withHtml);
      });
      return;
    }
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    streamFile(res, filePath);
  });
}

function streamFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = new URLSearchParams(parsed.query);

  // CORS (useful if you later split frontend/backend across origins)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Basic security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname, query);
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`\n  SpaBook platform running at http://localhost:${PORT}\n`);
  console.log('  Demo logins:');
  console.log('   Admin:   admin@spabook.demo / admin123');
  console.log('   Owner:   owner1@spabook.demo / owner123');
  console.log('   Customer: customer@spabook.demo / customer123\n');
});
