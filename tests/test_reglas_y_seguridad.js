// Pruebas con datos inventados (se pueden versionar): reglas de control, lectura con IA y seguridad.
'use strict';
const { crearEntorno } = require('./harness');
let fallas = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fallas++; };

const env = crearEntorno();
env.clave('clave-de-prueba-larga');

// --- Sesión ---
ok(env.post({ accion: 'bandeja', datos: { periodo: '202611' } }).error === 'No autorizado', 'Sin token: No autorizado');
ok(env.post({ accion: 'bandeja', token: 'x'.repeat(72), datos: {} }).error === 'No autorizado', 'Token inventado: No autorizado');
ok(env.post({ accion: 'login', clave: 'mal' }).error === 'Clave incorrecta.', 'Clave incorrecta');
const token = env.post({ accion: 'login', clave: 'clave-de-prueba-larga' }).token;
ok(/^[0-9a-f-]{72}$/.test(token), 'Login devuelve token');
ok(!Object.values(env.cache).includes(token) && !Object.keys(env.cache).some(k => k.includes(token)), 'El token no se guarda en claro');
const P = (accion, d) => env.post({ accion, token, datos: d });
ok(P('borrarTodo', {}).error === 'Ocurrió un error inesperado.', 'Acción desconocida: error genérico');
ok(env.ctx.doPost({ postData: { contents: '{roto' } }).error === 'Ocurrió un error inesperado.', 'JSON roto: error genérico');

// --- Cliente de prueba: PV 9, solo 21 %, domingos sin actividad ---
ok(P('guardarCliente', { alias: 'PRUEBA', nombre: '=HYPERLINK("x")', pv: 9, alicuotas: '21', numeracion: 'tique', diasSinActividad: 'dom' }).ok, 'Alta de cliente');
ok(env.hojas.Clientes.filas[1][1].startsWith("'="), 'Nombre con fórmula: neutralizado');
ok(!!P('guardarCliente', { alias: 'X', pv: 1 }).error, 'Alias corto rechazado');
ok(!!P('guardarCliente', { alias: 'OTRO', pv: 1, alicuotas: '27' }).error, 'Alícuota no soportada rechazada');
ok(!!P('periodo', { cliente: 'NOEXISTE', periodo: '202611' }).error, 'Cliente inexistente rechazado');
ok(!!P('periodo', { cliente: 'PRUEBA', periodo: '202613' }).error, 'Período inválido rechazado');

const Z = f => P('guardarZ', { cliente: 'PRUEBA', periodo: '202611', fila: Object.assign({ pv: 9, confirmado: true }, f) });
// Z con IVA impreso (formato septiembre: bruto e IVA, sin gravado)
ok(Z({ z: 100, fecha: '2026-11-02', desde: 1, hasta: 5, cant: 5, iva21: '21000.00', total: '121000.00' }).ok, 'Z con bruto e IVA');
// Z solo con bruto
ok(Z({ z: 101, fecha: '2026-11-03', hasta: 9, cant: 4, total: '1.210,00' }).ok, 'Z solo con bruto (importe con formato argentino)');
// Z en cero el mismo día
ok(Z({ z: 102, fecha: '2026-11-03', desde: '', hasta: 9, cant: 0, total: '0' }).ok, 'Z en cero');
let v = P('periodo', { cliente: 'PRUEBA', periodo: '202611' });
const f100 = v.filas.find(f => f.z === '100'), f101 = v.filas.find(f => f.z === '101');
ok(f100.neto21 === '100000.00', 'Neto = bruto − IVA impreso (100.000,00)');
ok(f101.desde === '6' && f101.neto21 === '1000.00', 'Desde = último − cantidad + 1; neto desde bruto = 1.000,00');
ok(f101.alertas.some(a => a.includes('calculados desde el total')), 'Aviso: neto calculado desde el total');
ok(v.totales.cantidad === 2 && v.totales.total === '122210.00', 'Totales sin el Z en cero');
ok(v.controles.avisos.some(a => a.msg.startsWith('Días sin Z')) && !v.controles.diasSinZ.includes('2026-11-01'), 'Días sin Z listados, domingo 01/11 excluido');

// Errores bloqueantes
ok(Z({ z: 103, fecha: '2026-12-01', desde: 10, hasta: 10, cant: 1, iva21: '21', total: '121' }).ok, 'Alta Z con fecha fuera de período (se guarda, el control la marca)');
ok(Z({ z: 103, fecha: '2026-11-04', desde: 8, hasta: 12, cant: 5, iva21: '21', total: '121' }).ok, 'Alta Z repetido y con tiques superpuestos');
ok(Z({ z: 105, fecha: '2026-11-05', desde: 13, hasta: 13, cant: 1, iva105: '10.50', total: '110.50' }).ok, 'Alta Z con alícuota no configurada');
ok(Z({ z: 106, fecha: '2026-11-06', desde: 14, hasta: 14, cant: 1, gravado: '100', iva21: '21', total: '999' }).ok, 'Alta Z que no cierra');
v = P('periodo', { cliente: 'PRUEBA', periodo: '202611' });
const errs = v.controles.errores.map(e => e.msg).join(' | ');
['Fecha fuera del período', 'Z repetido', 'Tiques superpuestos', 'Alícuota 10,5 % no configurada', '≠ total'].forEach(t => ok(errs.includes(t), 'Error detectado: ' + t));
ok(v.controles.avisos.some(a => a.msg.includes('Salto de numeración de Z (103 → 105)')), 'Aviso: salto de Z');
ok(!!P('aprobar', { cliente: 'PRUEBA', periodo: '202611', aceptoAvisos: true }).error, 'Con errores no se puede aprobar');
ok(!!Z({ z: 'abc', fecha: '2026-11-02', total: '1' }).error, 'Nº de Z no numérico rechazado');
ok(!!Z({ z: 1, fecha: '02/11/2026', total: '1' }).error, 'Fecha con formato inválido rechazada');
ok(!!Z({ z: 1, fecha: '2026-11-02', total: '1e9' }).error, 'Importe inválido rechazado');
ok(!!Z({ id: 'zinexistente', z: 1 }).error, 'Editar fila inexistente rechazado');
const sinConf = P('guardarZ', { cliente: 'PRUEBA', periodo: '202611', fila: { z: 107, fecha: '2026-11-07', desde: 15, hasta: 15, cant: 1, iva21: '21', total: '121', confirmado: false } });
v = P('periodo', { cliente: 'PRUEBA', periodo: '202611' });
ok(v.filas.find(f => f.id === sinConf.id).alertas.includes('Sin confirmar.'), 'Fila sin confirmar bloquea');

// --- Confirmación en bloque ---
const vb = P('periodo', { cliente: 'PRUEBA', periodo: '202611' });
const ids = vb.filas.map(f => f.id);
const sinConfAntes = vb.filas.filter(f => f.confirmado !== 'SI').length;
ok(sinConfAntes === 1, 'Antes del bloque: 1 sin confirmar');
let cb = P('confirmarVarios', { cliente: 'PRUEBA', periodo: '202611', ids: ids });
ok(cb.ok && cb.confirmados === 1, 'Confirmar en bloque: solo cuenta los pendientes');
ok(P('periodo', { cliente: 'PRUEBA', periodo: '202611' }).filas.every(f => f.confirmado === 'SI'), 'Después del bloque: todos confirmados');
ok(!!P('confirmarVarios', { cliente: 'PRUEBA', periodo: '202611', ids: [] }).error, 'Bloque vacío rechazado');
ok(!!P('confirmarVarios', { cliente: 'PRUEBA', periodo: '202611', ids: ['../x'] }).error, 'ID inválido en bloque rechazado');
const filasAntes = JSON.stringify(env.hojas.Z.filas.length);
cb = P('confirmarVarios', { cliente: 'PRUEBA', periodo: '202612', ids: ids });
ok(cb.confirmados === 0 && JSON.stringify(env.hojas.Z.filas.length) === filasAntes, 'Bloque con otro período no toca filas ajenas');

// --- Subida de fotos ---
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]).toString('base64');
ok(!!P('subirFoto', { cliente: 'PRUEBA', periodo: '202611', base64: Buffer.from('<html>').toString('base64') }).error, 'Archivo que no es imagen rechazado');
ok(!!P('subirFoto', { cliente: 'PRUEBA', periodo: '202611', base64: 'no base64!!' }).error, 'Base64 inválido rechazado');
let up = P('subirFoto', { cliente: 'PRUEBA', periodo: '202611', base64: jpg });
ok(up.fila && up.fila.origen === 'manual' && up.fila.confirmado === 'NO', 'Sin clave de API: fila manual sin confirmar');
env.props.ANTHROPIC_API_KEY = 'sk-prueba';
env.setIA('Acá va:\n{"fecha":"2026-11-09","pv":9,"z":108,"tique_desde":null,"tique_hasta":"20","cantidad":5,"gravado":"826.45","iva21":"173.55","iva105":null,"no_gravado":"0.00","exento":"0.00","total":"1000.00","otros_tipos":false,"dudosos":["iva21"]}');
up = P('subirFoto', { cliente: 'PRUEBA', periodo: '202611', base64: jpg });
ok(up.fila.origen === 'ia' && up.fila.z === '108' && up.fila.desde === '16' && up.fila.dudosos === 'iva21' && up.fila.confirmado === 'NO', 'Lectura IA normalizada, desde calculado, dudoso marcado, sin confirmar');
env.setIA('{"fecha":"ayer","z":"=1+1","total":"mil","dudosos":[]}');
up = P('subirFoto', { cliente: 'PRUEBA', periodo: '202611', base64: jpg });
ok(up.fila.fecha === '' && up.fila.z === '' && up.fila.total === '' && /fecha/.test(up.fila.dudosos) && /total/.test(up.fila.dudosos), 'Respuesta IA inválida: campos vacíos y marcados dudosos');
env.setIA('no hay json');
up = P('subirFoto', { cliente: 'PRUEBA', periodo: '202611', base64: jpg });
ok(up.fila.origen === 'manual' && !!up.aviso, 'IA sin JSON: queda para carga manual con aviso');
ok(Object.keys(env.archivos).length === 4, 'Fotos guardadas en la carpeta del período');

// --- Límite de intentos de login ---
for (let i = 0; i < 10; i++) env.post({ accion: 'login', clave: 'mal' });
ok(/Demasiados intentos/.test(env.post({ accion: 'login', clave: 'clave-de-prueba-larga' }).error), 'Bloqueo tras 10 intentos fallidos');

// --- Auditoría sin secretos ---
const aud = JSON.stringify(env.hojas.Auditoria.filas);
ok(!aud.includes('clave-de-prueba-larga') && !aud.includes(token), 'Auditoría sin claves ni tokens');

console.log(fallas ? '\n' + fallas + ' FALLA(S)' : '\nTODO OK');
process.exit(fallas ? 1 : 0);
