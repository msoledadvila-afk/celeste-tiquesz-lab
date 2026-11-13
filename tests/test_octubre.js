// Prueba de aceptación: con los Z reales de un período de referencia, el laboratorio
// tiene que reproducir byte a byte los TXT y el Resumen de cierre de referencia.
// Los datos reales NO están en el repo: se pasan por variable de entorno.
//   OCT_FIXTURE=/ruta/fixture.json  OCT_REF=/ruta/carpeta_con_txt  node tests/test_octubre.js
'use strict';
const fs = require('fs');
const path = require('path');
const { crearEntorno } = require('./harness');

const FIX = process.env.OCT_FIXTURE, REF = process.env.OCT_REF;
if (!FIX || !REF || !fs.existsSync(FIX)) { console.log('SKIP: faltan OCT_FIXTURE / OCT_REF (datos reales fuera del repo).'); process.exit(0); }
const datos = JSON.parse(fs.readFileSync(FIX, 'utf8'));
let fallas = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fallas++; };
const sumar = (a, b) => (Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100;

const env = crearEntorno();
env.clave('clave-de-prueba-larga');
const token = env.post({ accion: 'login', clave: 'clave-de-prueba-larga' }).token;
const P = (accion, d) => env.post({ accion, token, datos: d });

const casos = datos.casos; // configuración y filas de cada cliente: fuera del repo
const PER = datos.periodo;

for (const [cli, cfg] of Object.entries(casos)) {
  ok(P('guardarCliente', { alias: cli, nombre: cli, pv: cfg.pv, alicuotas: cfg.alicuotas, numeracion: 'tique', diasSinActividad: cfg.dias }).ok, cli + ': cliente configurado');
  // Se carga lo que IMPRIME el Z (gravado total, IVA por alícuota, exento, total), no los netos.
  for (const r of cfg.filas) {
    const res = P('guardarZ', { cliente: cli, periodo: PER, fila: {
      z: r.z, fecha: r.fecha, pv: r.pv, desde: r.desde, hasta: r.hasta, cant: r.cant,
      gravado: sumar(r.n21, r.n105).toFixed(2), iva21: r.i21, iva105: Number(r.i105) ? r.i105 : '',
      exento: r.exento, no_gravado: '0', total: r.total, confirmado: true } });
    if (!res.ok) { ok(false, cli + ' Z ' + r.z + ': ' + res.error); }
  }
  const v = P('periodo', { cliente: cli, periodo: PER });
  ok(v.totales.total === cfg.total, cli + ': total ' + v.totales.total + ' = ' + cfg.total);
  ok(v.controles.errores.length === 0, cli + ': sin errores (' + JSON.stringify(v.controles.errores.slice(0, 3)) + ')');
  // Netos derivados = netos de la tabla de control de referencia.
  const malos = v.filas.filter((f, i) => f.neto21 !== cfg.filas[i].n21 || f.neto105 !== cfg.filas[i].n105);
  ok(malos.length === 0, cli + ': netos por alícuota iguales a la referencia en las ' + v.filas.length + ' filas');

  const res = P('descargar', { cliente: cli, periodo: PER, tipo: 'resumen' });
  const refRes = fs.readFileSync(path.join(REF, cfg.ref, cli + '_' + PER + '_RESUMEN_CIERRE.csv'), 'latin1');
  ok(res.contenido === refRes, cli + ': Resumen de cierre (Borrador) idéntico byte a byte');
  if (res.contenido !== refRes) console.log(JSON.stringify(res.contenido), '\n', JSON.stringify(refRes));

  ok(!!P('descargar', { cliente: cli, periodo: PER, tipo: 'cbte' }).error, cli + ': .txt bloqueado antes de aprobar');
  ok(!!P('aprobar', { cliente: cli, periodo: PER }).error || v.controles.avisos.length === 0, cli + ': aprobar exige aceptar los avisos');
  const ap = P('aprobar', { cliente: cli, periodo: PER, aceptoAvisos: true });
  ok(ap.ok && ap.estado === 'Controlado', cli + ': aprobado → Controlado ' + (ap.error || ''));

  for (const tipo of ['cbte', 'alicuotas']) {
    const d = P('descargar', { cliente: cli, periodo: PER, tipo });
    const nombre = cfg.base + (tipo === 'cbte' ? '_VENTAS_CBTE.txt' : '_VENTAS_ALICUOTAS.txt');
    const ref = fs.readFileSync(path.join(REF, cfg.ref, nombre));
    const gen = Buffer.from(d.contenido, 'latin1');
    ok(d.nombre === nombre, cli + ': nombre de archivo ' + d.nombre);
    ok(gen.equals(ref), cli + ': ' + nombre + ' idéntico byte a byte (' + gen.length + '/' + ref.length + ' bytes)');
  }
  ok(!!P('guardarZ', { cliente: cli, periodo: PER, fila: { z: 1, fecha: '2026-10-01', total: '1', confirmado: true } }).error, cli + ': no se puede editar un período Controlado');
}

// Tablero: filas A y TOTAL por cliente, estado Controlado.
const nombres = Object.keys(casos);
const carga = env.tablero.Carga.filas.filter(r => nombres.includes(r[0]));
ok(carga.length === nombres.length * 2, 'Tablero: filas A + TOTAL por cliente');
ok(carga.every(r => r[12] === 'Controlado' && String(r[1]) === PER), 'Tablero: estado Controlado y período numérico');
nombres.forEach(c => ok(carga.find(r => r[0] === c && r[2] === 'TOTAL')[9] === Number(casos[c].total), 'Tablero: total ' + c));
ok(carga.every(r => r[13] === '=formula'), 'Tablero: columnas N y O (fórmulas) intactas');

// Ciclo de estados con el primer cliente: Importado → vista previa con diferencia → igual → Verificado → reabrir.
const C = nombres[0], T = casos[C].total;
const Q = d => Object.assign({ cliente: C, periodo: PER }, d || {});
ok(P('marcarImportado', Q()).estado === 'Importado', 'Estado Importado');
const vpMal = P('registrarVistaPrevia', Q({ total: (Number(T) + 0.01).toFixed(2) }));
ok(vpMal.estado === 'Importado' && vpMal.diferencia === '0.01', 'Vista previa con diferencia: sigue Importado');
ok(P('registrarVistaPrevia', Q({ total: T.replace('.', ',') })).estado === 'Verificado', 'Vista previa igual: Verificado');
const filaT = env.tablero.Carga.filas.find(r => r[0] === C && r[2] === 'TOTAL');
ok(filaT[12] === 'Verificado' && filaT[10] === Number(T) && filaT[11] === 0, 'Tablero actualizado: Verificado, vista previa y diferencia 0');
ok(P('descargar', Q({ tipo: 'resumen' })).contenido.includes(';0,00;Verificado'), 'Resumen refleja vista previa y Verificado');
ok(!!P('reabrir', Q({ motivo: '' })).error, 'Reabrir exige motivo');
ok(P('reabrir', Q({ motivo: 'Prueba de reapertura' })).estado === 'Borrador', 'Reabrir → Borrador');
ok(env.tablero.Carga.filas.filter(r => r[0] === C).length === 2, 'Reabrir no duplica filas en el Tablero');

console.log(fallas ? '\n' + fallas + ' FALLA(S)' : '\nTODO OK');
process.exit(fallas ? 1 : 0);
