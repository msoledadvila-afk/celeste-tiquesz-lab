// Servidor local SOLO para pruebas: sirve el frontend y simula el Apps Script con el harness.
// node tests/e2e_server.js 8765
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { crearEntorno } = require('./harness');
const env = crearEntorno();
env.clave('clave-de-prueba-larga');
env.props.ANTHROPIC_API_KEY = 'sk-prueba';
env.setIA('{"fecha":"2026-11-02","pv":4,"z":2290,"tique_desde":null,"tique_hasta":700,"cantidad":5,"gravado":null,"iva21":"21000.00","iva105":null,"no_gravado":"0.00","exento":"0.00","total":"121000.00","otros_tipos":false,"dudosos":["iva21"]}');
const raiz = path.join(__dirname, '..');
const tipos = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const out = env.ctx.doPost({ postData: { contents: b } });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  let f = req.url.split('?')[0]; if (f === '/') f = '/index.html';
  if (f === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("window.TIQUESZ_CONFIG={API_URL:'/api'};"); }
  const p = path.join(raiz, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  if (!p.startsWith(raiz) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(p);
  if (f === '/index.html') body = Buffer.from(body.toString().replace('connect-src https://script.google.com https://script.googleusercontent.com', "connect-src 'self'"));
  res.writeHead(200, { 'Content-Type': tipos[path.extname(p)] || 'application/octet-stream' }); res.end(body);
}).listen(Number(process.argv[2] || 8765));
