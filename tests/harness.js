// Entorno simulado de Google Apps Script para probar backend/Codigo.gs en Node.
// Uso: const env = crearEntorno(); env.post({accion:..., ...})
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function crearHoja(nombre) {
  const filas = [];
  return {
    nombre, filas,
    getName: () => nombre,
    getLastRow: () => filas.length,
    appendRow: r => filas.push(r.map(v => v === undefined ? '' : v)),
    setFrozenRows() {}, deleteRow: i => filas.splice(i - 1, 1),
    getDataRange() { return { getValues: () => filas.map(r => r.slice()) }; },
    getRange(a, b, c, d) {
      if (typeof a === 'string') return { setNumberFormat() { return this; }, setFontWeight() { return this; } };
      const fila = a, col = b, nf = c || 1, nc = d || 1;
      return {
        setValues(v) { for (let i = 0; i < nf; i++) { filas[fila - 1 + i] = filas[fila - 1 + i] || []; for (let j = 0; j < nc; j++) filas[fila - 1 + i][col - 1 + j] = v[i][j]; } },
        getValues() { const out = []; for (let i = 0; i < nf; i++) { const r = filas[fila - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => r[col - 1 + j] === undefined ? '' : r[col - 1 + j])); } return out; },
        setFontWeight() { return this; }, setNumberFormat() { return this; }
      };
    }
  };
}

function crearEntorno(opts = {}) {
  const hojas = {}, tablero = {};
  const props = {}, cache = {};
  const archivos = {};
  let iaRespuesta = opts.iaRespuesta || null;
  const ss = { getSheetByName: n => hojas[n] || null, insertSheet: n => (hojas[n] = crearHoja(n)) };
  tablero.Carga = crearHoja('Carga');
  tablero.Carga.appendRow(['Cliente', 'Periodo', 'Via', 'Cantidad comprobantes', 'Neto 10,5%', 'IVA 10,5%', 'Neto 21%', 'IVA 21%', 'Exento y no gravado', 'Total', 'Total vista previa ARCA', 'Diferencia', 'Estado', 'Clave (no tocar)', 'Repetido']);
  for (let i = 2; i <= 40; i++) tablero.Carga.appendRow(Array(13).fill('').concat(['=formula', '=formula']));
  const carpeta = nombre => ({
    nombre, getFoldersByName: () => ({ hasNext: () => false }), createFolder: n => carpeta(n),
    createFile: blob => { const id = 'f' + Object.keys(archivos).length; archivos[id] = blob; return { getId: () => id }; }
  });
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => { if (opts.verbose) console.error(...a); } },
    JSON, Math, Date, Number, String, Array, Object, Set, Error, RegExp, isNaN, parseInt,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ({ getSheetByName: n => tablero[n] }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperties: o => Object.assign(props, o), deleteProperty: k => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => JSON.parse(t) }) },
    DriveApp: { getFolderById: () => carpeta('raiz'), getFileById: id => ({ setTrashed() {}, getMimeType: () => 'image/jpeg', getBlob: () => ({ getBytes: () => archivos[id].bytes }) }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ content: [{ type: 'text', text: iaRespuesta }] }) }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      computeDigest: (a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      base64Decode: s => [...Buffer.from(s, 'base64')].map(b => (b > 127 ? b - 256 : b)),
      base64Encode: b => Buffer.from(b.map(x => x & 0xff)).toString('base64'),
      formatDate: () => '20261113_120000',
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Codigo.gs'), 'utf8'), ctx);
  ctx.setup();
  props.TABLERO_ID = 'tablero'; props.CARPETA_RAIZ_ID = 'raiz';
  const post = obj => { vm.runInContext('CLIENTES_CACHE_ = null', ctx); return ctx.doPost({ postData: { contents: JSON.stringify(obj) } }); };
  return {
    ctx, hojas, tablero, props, cache, archivos, post,
    setIA: t => { iaRespuesta = t; },
    clave(c) { props.NUEVA_CLAVE = c; ctx.establecerClave(); },
    resetCacheClientes() { vm.runInContext('CLIENTES_CACHE_ = null', ctx); }
  };
}

module.exports = { crearEntorno };
