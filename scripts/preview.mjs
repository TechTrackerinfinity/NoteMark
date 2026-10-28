import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => { try { const name = new URL(req.url, 'http://localhost').pathname; const path = resolve(root, '.' + (name === '/' ? '/index.html' : name)); if (!path.startsWith(root + '/') && !path.startsWith(root + '\\')) throw new Error(); const bytes = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes); } catch { res.writeHead(404); res.end(); } });
server.listen(Number(process.env.PORT || 5173), '127.0.0.1', () => console.log('NoteMark preview: http://localhost:' + server.address().port));
