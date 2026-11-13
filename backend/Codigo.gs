// =====================================================================
// Tiques Z → ARCA · LABORATORIO (Estudio Celeste Vila)
// Backend Google Apps Script · v0.1 · 2026-11
//
// Separado del dashboard productivo: planilla, script, carpeta de fotos y
// Tablero propios. No toca nada del dashboard de Celeste.
//
// Propiedades del script (Configuración del proyecto → Propiedades):
//   NUEVA_CLAVE        (temporal) contraseña inicial → ejecutar establecerClave()
//   ANTHROPIC_API_KEY  clave de la API de Claude (lectura de fotos)
//   CLAUDE_MODEL       opcional; por defecto claude-sonnet-5-5
//   TABLERO_ID         ID de la planilla "Tablero IVA Ventas (LAB)"
//   CARPETA_RAIZ_ID    ID de la carpeta "Tiques Z (LAB)" en Drive
//   RETENCION_DIAS     opcional; días que se guardan las fotos de períodos Verificados (90)
// La planilla de datos es la que contiene este script (script vinculado).
// =====================================================================

const VERSION = '0.1.0';
const ERROR_GENERICO = 'Ocurrió un error inesperado.';
const NO_AUTORIZADO = 'No autorizado';
const SESION_SEG = 8 * 60 * 60;
const MAX_FALLOS_LOGIN = 10;
const VENTANA_FALLOS_SEG = 15 * 60;
const MAX_LLAMADAS_MIN = 120;
const MAX_FOTO_BYTES = 6 * 1024 * 1024;   // base64 ya reducido en el navegador
const MAX_BODY = 9 * 1024 * 1024;
const ESTADOS = ['Borrador', 'Controlado', 'Importado', 'Verificado'];
const ALICUOTAS = { '21': { tasa: '0.21', codigo: '0005' }, '10.5': { tasa: '0.105', codigo: '0004' } };
const ORDEN_ALICUOTAS = ['21', '10.5']; // orden de las líneas en el archivo de alícuotas (como octubre)

const HOJAS = {
  Clientes: ['alias', 'nombre', 'pv', 'alicuotas', 'numeracion', 'tipo_cbte', 'dias_sin_actividad', 'carpeta_id', 'activo'],
  Periodos: ['clave', 'cliente', 'periodo', 'estado', 'avisos_aceptados', 'aprobado_en', 'importado_en',
             'total_vista_previa', 'diferencia', 'verificado_en', 'hash_txt', 'actualizado_en'],
  Z: ['id', 'cliente', 'periodo', 'pv', 'z', 'fecha', 'desde', 'hasta', 'cant', 'gravado', 'iva21', 'iva105',
      'no_gravado', 'exento', 'total', 'neto21', 'neto105', 'origen', 'dudosos', 'confirmado', 'foto_id', 'obs', 'actualizado_en'],
  Auditoria: ['fecha', 'accion', 'cliente', 'periodo', 'detalle']
};

// =====================================================================
// CONFIGURACIÓN INICIAL (ejecutar a mano desde el editor)
// =====================================================================
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HOJAS).forEach(n => {
    let sh = ss.getSheetByName(n);
    if (!sh) sh = ss.insertSheet(n);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HOJAS[n]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, HOJAS[n].length).setFontWeight('bold');
    }
    sh.getRange('A:Z').setNumberFormat('@'); // todo como texto: los importes viajan como "1234.56"
  });
  console.log('Hojas listas. Cargá los clientes en la hoja Clientes.');
}

function establecerClave() {
  const props = PropertiesService.getScriptProperties();
  const nueva = props.getProperty('NUEVA_CLAVE');
  if (!nueva || nueva.length < 12) throw new Error('Cargá NUEVA_CLAVE (mínimo 12 caracteres) en Propiedades del script.');
  const sal = Utilities.getUuid();
  props.setProperties({ CLAVE_SAL: sal, CLAVE_HASH: hash_(sal + ':' + nueva) });
  props.deleteProperty('NUEVA_CLAVE');
  CacheService.getScriptCache().remove('fallos');
  console.log('Clave configurada; NUEVA_CLAVE eliminada.');
}

// Borra (a la papelera) fotos de períodos Verificados hace más de RETENCION_DIAS.
// Programar con un activador diario si Celeste lo aprueba.
function purgarFotos() {
  const dias = Number(PropertiesService.getScriptProperties().getProperty('RETENCION_DIAS') || 90);
  const limite = Date.now() - dias * 86400000;
  const per = leer_('Periodos').filter(p => p.estado === 'Verificado' && p.verificado_en && Date.parse(p.verificado_en) < limite);
  const claves = new Set(per.map(p => p.clave));
  let n = 0;
  leer_('Z').forEach(r => {
    if (r.foto_id && claves.has(r.cliente + '|' + r.periodo)) {
      try { DriveApp.getFileById(r.foto_id).setTrashed(true); n++; } catch (e) { /* ya borrada */ }
    }
  });
  console.log('Fotos enviadas a la papelera: ' + n);
}

// =====================================================================
// ENTRADA HTTP
// Todo por POST con cuerpo JSON (Content-Type text/plain, sin preflight).
// =====================================================================
function doGet() {
  return json_({ ok: true, servicio: 'tiquesz-lab', version: VERSION });
}

function doPost(e) {
  try {
    const body = (e && e.postData && e.postData.contents) || '';
    if (!body || body.length > MAX_BODY) return json_({ error: ERROR_GENERICO });
    let req;
    try { req = JSON.parse(body); } catch (x) { return json_({ error: ERROR_GENERICO }); }
    if (!req || typeof req !== 'object' || typeof req.accion !== 'string') return json_({ error: ERROR_GENERICO });

    if (req.accion === 'login') return json_(login_(req.clave));

    if (!sesionValida_(req.token)) return json_({ error: NO_AUTORIZADO });
    if (!dentroDelLimite_(req.token)) return json_({ error: 'Demasiadas solicitudes. Esperá un minuto.' });

    const fn = ACCIONES[req.accion];
    if (!fn) return json_({ error: ERROR_GENERICO });
    const datos = req.datos && typeof req.datos === 'object' ? req.datos : {};

    const escritura = ESCRITURAS.indexOf(req.accion) !== -1;
    const lock = LockService.getScriptLock();
    if (escritura) lock.waitLock(20000);
    try {
      return json_(fn(datos));
    } finally {
      if (escritura) lock.releaseLock();
    }
  } catch (err) {
    if (err && err.esValidacion) return json_({ error: err.message });
    console.error(err && err.stack || err);
    return json_({ error: ERROR_GENERICO });
  }
}

const ESCRITURAS = ['subirFoto', 'guardarZ', 'borrarZ', 'aprobar', 'marcarImportado', 'registrarVistaPrevia', 'reabrir', 'guardarCliente'];

const ACCIONES = {
  bandeja: d => bandeja_(periodo_(d.periodo)),
  periodo: d => vistaPeriodo_(cliente_(d.cliente), periodo_(d.periodo)),
  foto: d => foto_(id_(d.id)),
  subirFoto: d => subirFoto_(d),
  guardarZ: d => guardarZ_(d),
  borrarZ: d => borrarZ_(d),
  aprobar: d => aprobar_(cliente_(d.cliente), periodo_(d.periodo), d.aceptoAvisos === true),
  marcarImportado: d => cambiarEstado_(cliente_(d.cliente), periodo_(d.periodo), 'Importado'),
  registrarVistaPrevia: d => registrarVistaPrevia_(cliente_(d.cliente), periodo_(d.periodo), d.total),
  reabrir: d => reabrir_(cliente_(d.cliente), periodo_(d.periodo), d.motivo),
  descargar: d => descargar_(cliente_(d.cliente), periodo_(d.periodo), d.tipo),
  guardarCliente: d => guardarCliente_(d)
};

// =====================================================================
// SESIÓN Y LÍMITES
// =====================================================================
function login_(clave) {
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('fallos') || 0);
  if (fallos >= MAX_FALLOS_LOGIN) return { error: 'Demasiados intentos. Probá en 15 minutos.' };
  const p = PropertiesService.getScriptProperties();
  const h = p.getProperty('CLAVE_HASH'), sal = p.getProperty('CLAVE_SAL');
  const ok = !!h && !!sal && typeof clave === 'string' && clave.length > 0 && clave.length <= 200 &&
    igual_(hash_(sal + ':' + clave), h);
  if (!ok) {
    cache.put('fallos', String(fallos + 1), VENTANA_FALLOS_SEG);
    return { error: 'Clave incorrecta.' };
  }
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('tok:' + hash_(token), '1', SESION_SEG);
  auditar_('login', '', '', '');
  return { token: token, expiraEnSeg: SESION_SEG };
}

function sesionValida_(token) {
  if (typeof token !== 'string' || !/^[0-9a-f-]{72}$/.test(token)) return false;
  return CacheService.getScriptCache().get('tok:' + hash_(token)) === '1';
}

function dentroDelLimite_(token) {
  const cache = CacheService.getScriptCache();
  const k = 'rl:' + hash_(token).slice(0, 16) + ':' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), 120);
  return n <= MAX_LLAMADAS_MIN;
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function igual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// =====================================================================
// VALIDADORES
// =====================================================================
function err_(msg) { const e = new Error(msg); e.esValidacion = true; return e; }
function id_(v) { const s = String(v == null ? '' : v); if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) throw err_('Identificador inválido.'); return s; }
function periodo_(v) {
  const s = String(v == null ? '' : v);
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(s)) throw err_('Período inválido (AAAAMM).');
  return s;
}
function cliente_(v) {
  const s = String(v == null ? '' : v).toUpperCase();
  if (!/^[A-Z0-9_-]{2,30}$/.test(s)) throw err_('Cliente inválido.');
  if (!clientes_()[s]) throw err_('Cliente no configurado.');
  return s;
}
function fecha_(v) { const s = String(v == null ? '' : v); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw err_('Fecha inválida (AAAA-MM-DD).'); return s; }
function entero_(v, campo, min, max) {
  if (v === '' || v == null) return '';
  const s = String(v).trim();
  if (!/^\d{1,12}$/.test(s)) throw err_(campo + ': número entero inválido.');
  const n = Number(s); if (n < min || n > max) throw err_(campo + ': fuera de rango.');
  return String(n);
}
// Importe → string con 2 decimales exactos ("1234.56"); acepta "1.234,56", "1234,56", "1234.56" o número.
function importe_(v, campo) {
  if (v === '' || v == null) return '';
  let s = String(v).trim().replace(/\$/g, '').replace(/\s/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(s)) throw err_(campo + ': importe inválido.');
  return c2s_(s2c_(s));
}
function texto_(v, max) {
  if (v == null) return '';
  const s = String(v);
  if (s.length > max) throw err_('Texto demasiado largo.');
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// --- aritmética en centavos (enteros) ---
function s2c_(s) { // "1234.5" → 123450
  if (s === '' || s == null) return 0;
  const m = String(s).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw err_('Importe inválido.');
  return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(((m[3] || '') + '00').slice(0, 2)));
}
function c2s_(c) { const neg = c < 0; c = Math.abs(c); return (neg ? '-' : '') + Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2); }
// redondeo mitad hacia arriba de a/b con enteros (a,b > 0)
function divRedondeo_(a, b) { return Math.floor((2 * a + b) / (2 * b)); }
// centavos × tasa ("0.21") → centavos redondeados
function porTasa_(cent, tasa) { const t = tasaFrac_(tasa); return divRedondeo_(cent * t.num, t.den); }
// centavos ÷ tasa
function entreTasa_(cent, tasa) { const t = tasaFrac_(tasa); return divRedondeo_(cent * t.den, t.num); }
function tasaFrac_(tasa) { const d = (tasa.split('.')[1] || '').length; return { num: Number(tasa.replace('.', '')), den: Math.pow(10, d) }; }

// =====================================================================
// LECTURA DE DATOS
// =====================================================================
function hoja_(n) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(n); }
function leer_(n) {
  const v = hoja_(n).getDataRange().getValues();
  const h = v[0];
  return v.slice(1).map((r, i) => { const o = { _fila: i + 2 }; h.forEach((k, j) => o[k] = r[j] === undefined ? '' : String(r[j])); return o; });
}
function escribirFila_(n, obj, fila) {
  const cols = HOJAS[n];
  const valores = [cols.map(c => obj[c] === undefined ? '' : obj[c])];
  const sh = hoja_(n);
  if (fila) sh.getRange(fila, 1, 1, cols.length).setValues(valores);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, cols.length).setValues(valores);
}
function auditar_(accion, cliente, periodo, detalle) {
  try { escribirFila_('Auditoria', { fecha: new Date().toISOString(), accion: accion, cliente: cliente, periodo: periodo, detalle: String(detalle).slice(0, 500) }); }
  catch (e) { console.error('auditoría', e); }
}

let CLIENTES_CACHE_ = null;
function clientes_() {
  if (CLIENTES_CACHE_) return CLIENTES_CACHE_;
  const m = {};
  leer_('Clientes').forEach(c => {
    if (String(c.activo).toUpperCase() === 'NO') return;
    const alias = String(c.alias).toUpperCase().trim();
    if (!alias) return;
    m[alias] = {
      alias: alias, nombre: c.nombre, pv: Number(c.pv),
      alicuotas: String(c.alicuotas || '21').split(/[;,|]/).map(x => x.trim()).filter(x => ALICUOTAS[x]),
      numeracion: String(c.numeracion || 'tique').toLowerCase() === 'z' ? 'z' : 'tique',
      tipo: Number(c.tipo_cbte || 83),
      diasSinActividad: String(c.dias_sin_actividad || '').toLowerCase(),
      carpeta: c.carpeta_id, _fila: c._fila
    };
  });
  CLIENTES_CACHE_ = m;
  return m;
}

function periodoReg_(cliente, periodo) {
  const p = leer_('Periodos').filter(x => x.clave === cliente + '|' + periodo)[0];
  return p || { clave: cliente + '|' + periodo, cliente: cliente, periodo: periodo, estado: 'Borrador' };
}
function guardarPeriodo_(p) { p.actualizado_en = new Date().toISOString(); escribirFila_('Periodos', p, p._fila); }
function filasZ_(cliente, periodo) {
  return leer_('Z').filter(r => r.cliente === cliente && r.periodo === periodo)
    .sort((a, b) => Number(a.z) - Number(b.z) || String(a.fecha).localeCompare(String(b.fecha)));
}

// =====================================================================
// REGLAS DE CÁLCULO (procedimiento IVA_01, verificadas con octubre 2026)
// Entrada: lo que imprime el Z. Salida: neto por alícuota.
// =====================================================================
function calcularNetos_(r, cli) {
  const g = s2c_(r.gravado), i21 = s2c_(r.iva21), i105 = s2c_(r.iva105);
  const ng = s2c_(r.no_gravado), ex = s2c_(r.exento), tot = s2c_(r.total);
  const tiene21 = cli.alicuotas.indexOf('21') !== -1, tiene105 = cli.alicuotas.indexOf('10.5') !== -1;
  let gravado = r.gravado === '' ? null : g;
  // Sin "gravado" impreso: gravado = total − IVA − exento − no gravado.
  if (gravado === null && r.total !== '' && (r.iva21 !== '' || r.iva105 !== '')) gravado = tot - i21 - i105 - ex - ng;
  // Solo el bruto (sin IVA impreso) y una alícuota: neto = redondeo(base / (1 + tasa)).
  if (gravado === null && r.total !== '' && r.iva21 === '' && r.iva105 === '') {
    const base = tot - ex - ng, ali = tiene105 && !tiene21 ? '10.5' : '21';
    const t = tasaFrac_(ALICUOTAS[ali].tasa);
    const neto = divRedondeo_(base * t.den, t.den + t.num);
    return ali === '21' ? { neto21: neto, iva21: base - neto, neto105: 0, iva105: 0, calculadoDesdeBruto: true }
                        : { neto21: 0, iva21: 0, neto105: neto, iva105: base - neto, calculadoDesdeBruto: true };
  }
  if (gravado === null) return null;
  if (i105 > 0 && i21 > 0) {            // dos alícuotas: 10,5 % desde su IVA, 21 % por diferencia
    const n105 = entreTasa_(i105, ALICUOTAS['10.5'].tasa);
    return { neto21: gravado - n105, iva21: i21, neto105: n105, iva105: i105 };
  }
  if (i105 > 0) return { neto21: 0, iva21: 0, neto105: gravado, iva105: i105 };
  return { neto21: gravado, iva21: i21, neto105: 0, iva105: 0 };
}

// =====================================================================
// CONTROLES
// =====================================================================
function controlar_(cliente, periodo, filas) {
  const cli = clientes_()[cliente];
  const errores = [], avisos = [], porFila = {};
  const add = (lista, id, msg) => { lista.push({ id: id, msg: msg }); (porFila[id] = porFila[id] || []).push(msg); };
  const anio = Number(periodo.slice(0, 4)), mes = Number(periodo.slice(4));
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const vistosZ = {};
  let antZ = null, antT = null;

  filas.forEach(r => {
    const id = r.id;
    ['z', 'fecha', 'total'].forEach(c => { if (r[c] === '') add(errores, id, 'Falta ' + c + '.'); });
    if (r.fecha && r.fecha.slice(0, 7) !== periodo.slice(0, 4) + '-' + periodo.slice(4)) add(errores, id, 'Fecha fuera del período.');
    if (Number(r.pv) !== cli.pv) add(errores, id, 'Punto de venta ' + r.pv + ' distinto del configurado (' + cli.pv + ').');
    if (vistosZ[r.z]) add(errores, id, 'Z repetido: ' + r.z + '.'); vistosZ[r.z] = true;
    if (r.confirmado !== 'SI') add(errores, id, 'Sin confirmar.');
    const tot = s2c_(r.total);
    if (tot > 0) {
      if (cli.numeracion === 'tique') {
        if (r.desde === '' || r.hasta === '') add(errores, id, 'Faltan los tiques desde/hasta.');
        else if (Number(r.desde) > Number(r.hasta)) add(errores, id, 'Tique desde mayor que hasta.');
        else if (r.cant !== '' && Number(r.hasta) - Number(r.desde) + 1 !== Number(r.cant)) add(avisos, id, 'La cantidad de tiques no coincide con desde–hasta.');
      }
      const n = calcularNetos_(r, cli);
      if (!n) add(errores, id, 'No se pueden calcular los netos: falta gravado o IVA.');
      else {
        const suma = n.neto21 + n.iva21 + n.neto105 + n.iva105 + s2c_(r.exento) + s2c_(r.no_gravado);
        if (Math.abs(suma - tot) > 1) add(errores, id, 'Neto + IVA + exento ≠ total (dif. ' + c2s_(suma - tot) + ').');
        if (n.iva21 > 0 && cli.alicuotas.indexOf('21') === -1) add(errores, id, 'Alícuota 21 % no configurada para el cliente.');
        if (n.iva105 > 0 && cli.alicuotas.indexOf('10.5') === -1) add(errores, id, 'Alícuota 10,5 % no configurada para el cliente.');
        const d21 = n.neto21 ? porTasa_(n.neto21, '0.21') - n.iva21 : 0;
        if (d21) add(avisos, id, 'IVA 21 % calculado vs impreso: ' + c2s_(d21) + ' (se usa el impreso).');
        if (n.calculadoDesdeBruto) add(avisos, id, 'Neto e IVA calculados desde el total (el Z no imprime el IVA).');
      }
    }
    if (r.dudosos) add(avisos, id, 'Lectura dudosa: ' + r.dudosos + '. Mirá la foto.');
    if (r.obs) add(avisos, id, 'Observación: ' + String(r.obs).replace(/^'/, ''));
    // Numeración de Z: contra el Z anterior (incluidos los Z en cero).
    if (antZ && r.z !== '' && antZ.z !== '' && Number(r.z) !== Number(antZ.z) + 1 && Number(r.z) !== Number(antZ.z)) {
      add(avisos, id, 'Salto de numeración de Z (' + antZ.z + ' → ' + r.z + ').');
    }
    // Numeración de tiques: contra el último Z con ventas.
    if (antT && cli.numeracion === 'tique' && tot > 0 && antT.hasta !== '' && r.desde !== '') {
      if (Number(r.desde) <= Number(antT.hasta)) add(errores, id, 'Tiques superpuestos con el Z ' + antT.z + '.');
      else if (Number(r.desde) !== Number(antT.hasta) + 1) add(avisos, id, 'Salto de tiques (' + antT.hasta + ' → ' + r.desde + ').');
    }
    antZ = r;
    if (tot > 0) antT = r;
  });

  // días sin Z
  const conZ = {}; filas.forEach(r => conZ[r.fecha] = true);
  const sinZ = [];
  for (let d = 1; d <= ultimoDia; d++) {
    const f = periodo.slice(0, 4) + '-' + periodo.slice(4) + '-' + ('0' + d).slice(-2);
    const dow = new Date(Date.UTC(anio, mes - 1, d)).getUTCDay();
    if (!conZ[f] && !(cli.diasSinActividad.indexOf('dom') !== -1 && dow === 0)) sinZ.push(f);
  }
  if (sinZ.length) avisos.push({ id: '', msg: 'Días sin Z: ' + sinZ.map(f => f.slice(8) + '/' + f.slice(5, 7)).join(', ') + '.' });
  if (!filas.length) errores.push({ id: '', msg: 'No hay Z cargados.' });
  return { errores: errores, avisos: avisos, porFila: porFila, diasSinZ: sinZ };
}

function totales_(cliente, filas) {
  const cli = clientes_()[cliente];
  const t = { cantidad: 0, neto105: 0, iva105: 0, neto21: 0, iva21: 0, exentoNoGravado: 0, total: 0 };
  filas.forEach(r => {
    const tot = s2c_(r.total); if (tot <= 0) return;
    const n = calcularNetos_(r, cli); if (!n) return;
    t.cantidad++; t.neto105 += n.neto105; t.iva105 += n.iva105; t.neto21 += n.neto21; t.iva21 += n.iva21;
    t.exentoNoGravado += s2c_(r.exento) + s2c_(r.no_gravado); t.total += tot;
  });
  return t;
}

// =====================================================================
// ACCIONES
// =====================================================================
function bandeja_(periodo) {
  const cs = clientes_();
  const zs = leer_('Z').filter(r => r.periodo === periodo);
  const ps = leer_('Periodos').filter(p => p.periodo === periodo);
  return {
    periodo: periodo,
    clientes: Object.keys(cs).sort().map(a => {
      const f = zs.filter(r => r.cliente === a);
      const p = ps.filter(x => x.cliente === a)[0];
      const t = totales_(a, f);
      return { alias: a, nombre: cs[a].nombre, pv: cs[a].pv, z: f.length,
               sinConfirmar: f.filter(r => r.confirmado !== 'SI').length,
               total: c2s_(t.total), estado: p ? p.estado : (f.length ? 'Borrador' : 'Sin fotos') };
    })
  };
}

function vistaPeriodo_(cliente, periodo) {
  const filas = filasZ_(cliente, periodo);
  const cli = clientes_()[cliente];
  const ctrl = controlar_(cliente, periodo, filas);
  const t = totales_(cliente, filas);
  const p = periodoReg_(cliente, periodo);
  return {
    cliente: { alias: cli.alias, nombre: cli.nombre, pv: cli.pv, alicuotas: cli.alicuotas, numeracion: cli.numeracion },
    periodo: periodo, estado: p.estado, totalVistaPrevia: p.total_vista_previa || '', diferencia: p.diferencia || '',
    filas: filas.map(r => {
      const n = s2c_(r.total) > 0 ? calcularNetos_(r, cli) : null;
      const o = {}; HOJAS.Z.forEach(k => o[k] = r[k]);
      o.neto21 = n ? c2s_(n.neto21) : ''; o.neto105 = n ? c2s_(n.neto105) : '';
      o.alertas = ctrl.porFila[r.id] || [];
      return o;
    }),
    controles: { errores: ctrl.errores, avisos: ctrl.avisos, diasSinZ: ctrl.diasSinZ },
    totales: Object.keys(t).reduce((o, k) => { o[k] = k === 'cantidad' ? t[k] : c2s_(t[k]); return o; }, {})
  };
}

function editable_(cliente, periodo) {
  const e = periodoReg_(cliente, periodo).estado;
  if (e !== 'Borrador') throw err_('El período está ' + e + '. Para cambiarlo hay que reabrirlo.');
}

function foto_(id) {
  const r = leer_('Z').filter(x => x.id === id)[0];
  if (!r || !r.foto_id) throw err_('Sin foto.');
  const f = DriveApp.getFileById(r.foto_id);
  return { mime: f.getMimeType(), base64: Utilities.base64Encode(f.getBlob().getBytes()) };
}

function subirFoto_(d) {
  const cliente = cliente_(d.cliente), periodo = periodo_(d.periodo);
  editable_(cliente, periodo);
  if (typeof d.base64 !== 'string' || d.base64.length > MAX_FOTO_BYTES * 1.4 || !/^[A-Za-z0-9+/=]+$/.test(d.base64)) throw err_('Foto inválida o demasiado grande.');
  const mime = d.mime === 'image/png' ? 'image/png' : 'image/jpeg';
  const bytes = Utilities.base64Decode(d.base64);
  // Verifica la firma del archivo (JPEG FFD8 / PNG 89504E47).
  const esJpg = (bytes[0] & 0xff) === 0xff && (bytes[1] & 0xff) === 0xd8;
  const esPng = (bytes[0] & 0xff) === 0x89 && bytes[1] === 0x50;
  if (!(esJpg || esPng)) throw err_('El archivo no es una imagen JPG o PNG.');

  const carpeta = carpetaPeriodo_(cliente, periodo);
  const nombre = cliente + '_' + periodo + '_' + Utilities.formatDate(new Date(), 'GMT-3', 'yyyyMMdd_HHmmss') + '_' + Math.floor(Math.random() * 1e4) + (esPng ? '.png' : '.jpg');
  const archivo = carpeta.createFile(Utilities.newBlob(bytes, mime, nombre));

  let lectura = null, error = null;
  try { lectura = leerConIA_(d.base64, mime); } catch (e) { error = 'No se pudo leer la foto automáticamente: cargala a mano.'; console.error(e); }

  const fila = { id: 'z' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), cliente: cliente, periodo: periodo,
                 pv: String(clientes_()[cliente].pv), origen: lectura ? 'ia' : 'manual', confirmado: 'NO', foto_id: archivo.getId(),
                 actualizado_en: new Date().toISOString() };
  if (lectura) Object.assign(fila, lectura);
  // Si ya existe ese Z en el período, no se duplica: se avisa.
  const existente = lectura && lectura.z ? filasZ_(cliente, periodo).filter(r => r.z === lectura.z)[0] : null;
  if (existente) fila.obs = texto_('Posible duplicado del Z ' + lectura.z + ' (ya cargado).', 200);
  escribirFila_('Z', fila);
  auditar_('subirFoto', cliente, periodo, (lectura ? 'leída Z ' + (lectura.z || '?') : 'sin lectura') + ' · ' + nombre);
  return { fila: fila, aviso: error };
}

function carpetaPeriodo_(cliente, periodo) {
  const cli = clientes_()[cliente];
  let base;
  if (cli.carpeta) base = DriveApp.getFolderById(cli.carpeta);
  else {
    const raiz = DriveApp.getFolderById(prop_('CARPETA_RAIZ_ID'));
    const it = raiz.getFoldersByName(cliente);
    base = it.hasNext() ? it.next() : raiz.createFolder(cliente);
  }
  const it2 = base.getFoldersByName(periodo);
  return it2.hasNext() ? it2.next() : base.createFolder(periodo);
}

function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Falta la propiedad ' + k);
  return v;
}

const PROMPT_LECTURA = [
  'La imagen es un "Informe diario de cierre" (Z) de un controlador fiscal argentino.',
  'Devolvé SOLO un objeto JSON, sin texto antes ni después, con estas claves:',
  'fecha (AAAA-MM-DD, la fecha de la jornada), pv (entero), z (número del informe Z, entero),',
  'tique_desde (primer comprobante, entero o null), tique_hasta (último comprobante, entero o null), cantidad (comprobantes generados o null),',
  'gravado (importe gravado o null), iva21 (IVA 21% o null), iva105 (IVA 10,5% o null), no_gravado, exento,',
  'total (importe total de comprobantes fiscales), otros_tipos (true si el Z informa tique factura A/B, notas de crédito o devoluciones),',
  'dudosos (lista de claves que no se leen con seguridad).',
  'Importes con punto decimal y 2 decimales, sin separador de miles (ej. 1234.56). Si un dato no está impreso, null.',
  'Si el Z informa "ultimo tique" y "cantidad" pero no el primero, dejá tique_desde en null.',
  'No inventes valores: si no se lee, null y agregalo a dudosos.'
].join('\n');

function leerConIA_(base64, mime) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return null;
  const modelo = PropertiesService.getScriptProperties().getProperty('CLAUDE_MODEL') || 'claude-sonnet-5-5';
  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: modelo, max_tokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: PROMPT_LECTURA }] }]
    })
  });
  if (resp.getResponseCode() !== 200) throw new Error('API ' + resp.getResponseCode());
  const out = JSON.parse(resp.getContentText());
  const txt = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return normalizarLectura_(txt);
}

// Convierte la respuesta de la IA en una fila validada. Nada de lo que devuelve se usa sin validar.
function normalizarLectura_(txt) {
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Respuesta sin JSON');
  const j = JSON.parse(m[0]);
  const dud = Array.isArray(j.dudosos) ? j.dudosos.filter(x => typeof x === 'string').map(x => x.replace(/[^a-z0-9_]/gi, '')).slice(0, 12) : [];
  const safe = (fn, campo) => { try { return fn(); } catch (e) { dud.push(campo); return ''; } };
  const r = {
    fecha: safe(() => j.fecha ? fecha_(j.fecha) : '', 'fecha'),
    z: safe(() => entero_(j.z, 'z', 1, 99999999), 'z'),
    desde: safe(() => entero_(j.tique_desde, 'desde', 0, 99999999999), 'tique_desde'),
    hasta: safe(() => entero_(j.tique_hasta, 'hasta', 0, 99999999999), 'tique_hasta'),
    cant: safe(() => entero_(j.cantidad, 'cantidad', 0, 999999), 'cantidad'),
    gravado: safe(() => importe_(j.gravado, 'gravado'), 'gravado'),
    iva21: safe(() => importe_(j.iva21, 'iva21'), 'iva21'),
    iva105: safe(() => importe_(j.iva105, 'iva105'), 'iva105'),
    no_gravado: safe(() => importe_(j.no_gravado, 'no_gravado'), 'no_gravado'),
    exento: safe(() => importe_(j.exento, 'exento'), 'exento'),
    total: safe(() => importe_(j.total, 'total'), 'total')
  };
  if (r.desde === '' && r.hasta !== '' && r.cant !== '') r.desde = String(Number(r.hasta) - Number(r.cant) + 1);
  if (j.otros_tipos === true) r.obs = 'El Z informa tique factura A/B o notas de crédito: revisar.';
  r.dudosos = Array.from(new Set(dud)).join(', ');
  return r;
}

function guardarZ_(d) {
  const cliente = cliente_(d.cliente), periodo = periodo_(d.periodo);
  editable_(cliente, periodo);
  const f = d.fila && typeof d.fila === 'object' ? d.fila : {};
  const existentes = filasZ_(cliente, periodo);
  let reg = f.id ? existentes.filter(r => r.id === id_(f.id))[0] : null;
  if (f.id && !reg) throw err_('No existe esa fila.');
  const nueva = {
    id: reg ? reg.id : 'z' + Utilities.getUuid().replace(/-/g, '').slice(0, 16),
    cliente: cliente, periodo: periodo,
    pv: entero_(f.pv === undefined ? clientes_()[cliente].pv : f.pv, 'P.V.', 1, 99999),
    z: entero_(f.z, 'Nº Z', 1, 99999999), fecha: f.fecha ? fecha_(f.fecha) : '',
    desde: entero_(f.desde, 'Tique desde', 0, 99999999999), hasta: entero_(f.hasta, 'Tique hasta', 0, 99999999999),
    cant: entero_(f.cant, 'Cantidad', 0, 999999),
    gravado: importe_(f.gravado, 'Gravado'), iva21: importe_(f.iva21, 'IVA 21 %'), iva105: importe_(f.iva105, 'IVA 10,5 %'),
    no_gravado: importe_(f.no_gravado, 'No gravado'), exento: importe_(f.exento, 'Exento'), total: importe_(f.total, 'Total'),
    origen: reg ? (reg.origen === 'ia' ? 'ia+editado' : reg.origen) : 'manual',
    dudosos: f.confirmado === true ? '' : (reg ? reg.dudosos : ''),
    confirmado: f.confirmado === true ? 'SI' : 'NO',
    foto_id: reg ? reg.foto_id : '', obs: texto_(f.obs || '', 300),
    actualizado_en: new Date().toISOString()
  };
  if (nueva.desde === '' && nueva.hasta !== '' && nueva.cant !== '') nueva.desde = String(Number(nueva.hasta) - Number(nueva.cant) + 1);
  escribirFila_('Z', nueva, reg ? reg._fila : null);
  auditar_(reg ? 'editarZ' : 'altaZ', cliente, periodo, 'Z ' + nueva.z + (nueva.confirmado === 'SI' ? ' confirmado' : ''));
  return { ok: true, id: nueva.id };
}

function borrarZ_(d) {
  const cliente = cliente_(d.cliente), periodo = periodo_(d.periodo);
  editable_(cliente, periodo);
  const reg = filasZ_(cliente, periodo).filter(r => r.id === id_(d.id))[0];
  if (!reg) throw err_('No existe esa fila.');
  hoja_('Z').deleteRow(reg._fila);
  auditar_('borrarZ', cliente, periodo, 'Z ' + reg.z);
  return { ok: true };
}

function aprobar_(cliente, periodo, aceptoAvisos) {
  editable_(cliente, periodo);
  const filas = filasZ_(cliente, periodo);
  const ctrl = controlar_(cliente, periodo, filas);
  if (ctrl.errores.length) throw err_('Hay ' + ctrl.errores.length + ' error(es) sin resolver. No se puede aprobar.');
  if (ctrl.avisos.length && !aceptoAvisos) throw err_('Hay avisos: revisalos y marcá que los aceptás.');
  const arch = generarArchivos_(cliente, periodo, filas);
  const p = periodoReg_(cliente, periodo);
  p.estado = 'Controlado'; p.aprobado_en = new Date().toISOString();
  p.avisos_aceptados = texto_(ctrl.avisos.map(a => a.msg).join(' | '), 4000);
  p.hash_txt = hash_(arch.cbte + '#' + arch.alicuotas).slice(0, 16);
  guardarPeriodo_(p);
  actualizarTablero_(cliente, periodo);
  auditar_('aprobar', cliente, periodo, 'Total ' + arch.total + ' · ' + arch.lineas + ' líneas · avisos: ' + ctrl.avisos.length);
  return { ok: true, estado: 'Controlado' };
}

function cambiarEstado_(cliente, periodo, estado) {
  const p = periodoReg_(cliente, periodo);
  if (estado === 'Importado' && p.estado !== 'Controlado') throw err_('Solo se marca Importado un período Controlado.');
  p.estado = estado; p.importado_en = new Date().toISOString();
  guardarPeriodo_(p); actualizarTablero_(cliente, periodo);
  auditar_('estado', cliente, periodo, estado);
  return { ok: true, estado: estado };
}

function registrarVistaPrevia_(cliente, periodo, total) {
  const p = periodoReg_(cliente, periodo);
  if (['Importado', 'Verificado'].indexOf(p.estado) === -1) throw err_('Primero marcá el período como Importado.');
  const tVP = importe_(total, 'Total vista previa ARCA');
  if (tVP === '') throw err_('Ingresá el total de la vista previa.');
  const t = totales_(cliente, filasZ_(cliente, periodo));
  const dif = s2c_(tVP) - t.total;
  p.total_vista_previa = tVP; p.diferencia = c2s_(dif);
  p.estado = dif === 0 ? 'Verificado' : 'Importado';
  if (dif === 0) p.verificado_en = new Date().toISOString();
  guardarPeriodo_(p); actualizarTablero_(cliente, periodo);
  auditar_('vistaPrevia', cliente, periodo, 'ARCA ' + tVP + ' · dif ' + p.diferencia);
  return { ok: true, estado: p.estado, diferencia: p.diferencia };
}

function reabrir_(cliente, periodo, motivo) {
  const m = texto_(motivo || '', 300);
  if (m.replace(/'/g, '').trim().length < 5) throw err_('Escribí el motivo para reabrir.');
  const p = periodoReg_(cliente, periodo);
  const antes = p.estado;
  p.estado = 'Borrador'; p.total_vista_previa = ''; p.diferencia = '';
  guardarPeriodo_(p); actualizarTablero_(cliente, periodo);
  auditar_('reabrir', cliente, periodo, antes + ' → Borrador · ' + m);
  return { ok: true, estado: 'Borrador', aviso: antes !== 'Controlado' ? 'Si ya importaste en ARCA, al volver a importar elegí «Reemplazar».' : '' };
}

function guardarCliente_(d) {
  const alias = String(d.alias || '').toUpperCase();
  if (!/^[A-Z0-9_-]{2,30}$/.test(alias)) throw err_('Alias inválido.');
  const ali = String(d.alicuotas || '21').split(/[;,|]/).map(x => x.trim());
  if (!ali.length || ali.some(a => !ALICUOTAS[a])) throw err_('Alícuotas válidas: 21 y/o 10.5.');
  const reg = { alias: alias, nombre: texto_(d.nombre || '', 80), pv: entero_(d.pv, 'P.V.', 1, 99999),
    alicuotas: ali.join(','), numeracion: d.numeracion === 'z' ? 'z' : 'tique', tipo_cbte: '83',
    dias_sin_actividad: d.diasSinActividad === 'dom' ? 'dom' : '', carpeta_id: '', activo: 'SI' };
  if (reg.pv === '') throw err_('Falta el punto de venta.');
  const ex = leer_('Clientes').filter(c => String(c.alias).toUpperCase() === alias)[0];
  if (ex) reg.carpeta_id = ex.carpeta_id;
  escribirFila_('Clientes', reg, ex ? ex._fila : null);
  CLIENTES_CACHE_ = null;
  auditar_('cliente', alias, '', ex ? 'editado' : 'alta');
  return { ok: true };
}

// =====================================================================
// ARCHIVOS (RG 4597 · Libro IVA Digital · ventas)
// =====================================================================
function n_(v, largo) { const s = String(v); if (s.length > largo) throw err_('Valor demasiado largo para el campo.'); return ('0'.repeat(largo) + s).slice(-largo); }
function imp_(cent) { if (cent < 0) throw err_('Importe negativo en el archivo.'); return n_(cent, 15); }
function txt_(s, largo) { s = String(s); if (!/^[\x20-\x7e]*$/.test(s)) throw err_('Texto con caracteres no permitidos.'); return (s + ' '.repeat(largo)).slice(0, largo); }

function generarArchivos_(cliente, periodo, filas) {
  const cli = clientes_()[cliente];
  const cb = [], al = [];
  let total = 0, sumaAl = 0;
  filas.forEach(r => {
    const tot = s2c_(r.total); if (tot <= 0) return;   // Z en cero: no va al archivo
    const n = calcularNetos_(r, cli);
    const desde = cli.numeracion === 'z' ? r.z : r.desde, hasta = cli.numeracion === 'z' ? r.z : r.hasta;
    const lineasAl = [];
    ORDEN_ALICUOTAS.forEach(a => {
      const neto = a === '21' ? n.neto21 : n.neto105, iva = a === '21' ? n.iva21 : n.iva105;
      if (neto > 0 || iva > 0) lineasAl.push(n_(cli.tipo, 3) + n_(cli.pv, 5) + n_(desde, 20) + imp_(neto) + ALICUOTAS[a].codigo + imp_(iva));
    });
    if (!lineasAl.length) throw err_('El Z ' + r.z + ' no tiene alícuotas.');
    const lin = r.fecha.replace(/-/g, '') + n_(cli.tipo, 3) + n_(cli.pv, 5) + n_(desde, 20) + n_(hasta, 20) + '99' + '0'.repeat(20) +
      txt_('VENTA GLOBAL DIARIA', 30) + imp_(tot) + imp_(s2c_(r.no_gravado)) + imp_(0) + imp_(s2c_(r.exento)) +
      imp_(0) + imp_(0) + imp_(0) + imp_(0) + 'PES' + '0001000000' + String(lineasAl.length) + ' ' + imp_(0) + '00000000';
    if (lin.length !== 266) throw err_('Línea de comprobante con largo ' + lin.length + '.');
    lineasAl.forEach(l => { if (l.length !== 62) throw err_('Línea de alícuota con largo ' + l.length + '.'); });
    cb.push(lin); Array.prototype.push.apply(al, lineasAl);
    total += tot; sumaAl += n.neto21 + n.iva21 + n.neto105 + n.iva105 + s2c_(r.exento) + s2c_(r.no_gravado);
  });
  if (Math.abs(sumaAl - total) > cb.length) throw err_('Los archivos no cierran: comprobantes ≠ alícuotas.');
  return { cbte: cb.join('\r\n') + (cb.length ? '\r\n' : ''), alicuotas: al.join('\r\n') + (al.length ? '\r\n' : ''),
           lineas: cb.length, total: c2s_(total) };
}

function resumenCSV_(cliente, periodo) {
  const filas = filasZ_(cliente, periodo);
  const t = totales_(cliente, filas);
  const p = periodoReg_(cliente, periodo);
  const f = c => c2s_(c).replace('.', ',');
  const vp = p.total_vista_previa ? f(s2c_(p.total_vista_previa)) : '';
  const dif = p.diferencia !== '' && p.diferencia != null ? f(s2c_(p.diferencia)) : '';
  const fila = via => [cliente, periodo, via, t.cantidad, f(t.neto105), f(t.iva105), f(t.neto21), f(t.iva21), f(t.exentoNoGravado), f(t.total), vp, dif, p.estado].join(';');
  return ['Cliente;Periodo;Via;Cantidad comprobantes;Neto 10,5%;IVA 10,5%;Neto 21%;IVA 21%;Exento y no gravado;Total;Total vista previa ARCA;Diferencia;Estado',
          fila('A'), fila('TOTAL')].join('\r\n') + '\r\n';
}

function descargar_(cliente, periodo, tipo) {
  const cli = clientes_()[cliente];
  const base = cliente + '_PV' + n_(cli.pv, 4) + '_' + periodo;
  if (tipo === 'resumen') return { nombre: cliente + '_' + periodo + '_RESUMEN_CIERRE.csv', contenido: resumenCSV_(cliente, periodo) };
  const p = periodoReg_(cliente, periodo);
  if (p.estado === 'Borrador') throw err_('Los .txt se habilitan cuando el período está Controlado (aprobado).');
  const a = generarArchivos_(cliente, periodo, filasZ_(cliente, periodo));
  if (tipo === 'cbte') return { nombre: base + '_VENTAS_CBTE.txt', contenido: a.cbte };
  if (tipo === 'alicuotas') return { nombre: base + '_VENTAS_ALICUOTAS.txt', contenido: a.alicuotas };
  throw err_('Tipo de descarga inválido.');
}

// =====================================================================
// TABLERO IVA VENTAS (copia en Google Sheets del Excel de Celeste)
// Escribe solo las columnas A–M de la hoja «Carga», como indica el Tablero.
// =====================================================================
function actualizarTablero_(cliente, periodo) {
  const id = PropertiesService.getScriptProperties().getProperty('TABLERO_ID');
  if (!id) return;
  const sh = SpreadsheetApp.openById(id).getSheetByName('Carga');
  const t = totales_(cliente, filasZ_(cliente, periodo));
  const p = periodoReg_(cliente, periodo);
  const num = c => Number(c2s_(c));
  const vp = p.total_vista_previa ? Number(p.total_vista_previa) : '';
  const dif = p.diferencia !== '' && p.diferencia != null ? Number(p.diferencia) : '';
  const valores = via => [cliente, Number(periodo), via, t.cantidad, num(t.neto105), num(t.iva105), num(t.neto21), num(t.iva21),
                          num(t.exentoNoGravado), num(t.total), vp, dif, p.estado];
  const n = Math.max(sh.getLastRow(), 1);
  const datos = n > 1 ? sh.getRange(2, 1, n - 1, 3).getValues() : [];
  ['A', 'TOTAL'].forEach(via => {
    let fila = 0, libre = 0;
    for (let i = 0; i < datos.length; i++) {
      const [c, per, v] = datos[i];
      if (String(c).toUpperCase().trim() === cliente && String(per).trim() === periodo && String(v).toUpperCase().trim() === via) { fila = i + 2; break; }
      if (!libre && c === '' && per === '' && v === '') libre = i + 2;
    }
    const destino = fila || libre || n + 1;
    sh.getRange(destino, 1, 1, 13).setValues([valores(via)]);
    if (!fila) datos[destino - 2] = [cliente, periodo, via];
  });
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
