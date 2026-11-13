/* Tiques Z → ARCA · Laboratorio · frontend sin dependencias.
   Regla: la IA prepara y Celeste decide. El navegador solo muestra y envía;
   cálculos, controles, aprobación y archivos los resuelve el servidor. */
'use strict';
(function () {
  const API = (window.TIQUESZ_CONFIG || {}).API_URL;
  const $app = document.getElementById('app');
  const estado = { token: sessionStorage.getItem('tz_token') || '', periodo: periodoActual(), cliente: '', vista: null };

  // ---------- utilidades DOM (siempre textContent: nada de innerHTML con datos) ----------
  function el(tag, attrs, ...hijos) {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    });
    hijos.flat().forEach(h => { if (h !== null && h !== undefined && h !== false) e.append(h instanceof Node ? h : document.createTextNode(String(h))); });
    return e;
  }
  function limpiar(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function toast(msg, tipo) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast ' + (tipo || ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4500);
  }
  function periodoActual() { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0'); }
  function pesos(s) {
    if (s === '' || s == null) return '';
    const n = Number(s); if (isNaN(n)) return s;
    return n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fechaCorta(f) { return f ? f.slice(8, 10) + '/' + f.slice(5, 7) : ''; }

  // ---------- API ----------
  async function api(accion, datos, extra) {
    if (!API || API.includes('REEMPLAZAR')) throw new Error('Falta configurar la URL del Apps Script en config.js.');
    let r;
    try {
      r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ accion, token: estado.token, datos }, extra || {})), redirect: 'follow', credentials: 'omit' });
    } catch (e) { throw new Error('Sin conexión con el servidor. Probá de nuevo.'); }
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('Respuesta inválida del servidor.'); }
    if (j.error === 'No autorizado' && accion !== 'login') { salir(); throw new Error('La sesión venció. Volvé a entrar.'); }
    if (j.error) throw new Error(j.error);
    return j;
  }
  async function conEspera(boton, fn) {
    const txt = boton ? boton.textContent : '';
    if (boton) { boton.disabled = true; boton.textContent = 'Procesando…'; }
    try { return await fn(); }
    catch (e) { toast(e.message, 'error'); }
    finally { if (boton) { boton.disabled = false; boton.textContent = txt; } }
  }

  // ---------- sesión ----------
  function salir() { estado.token = ''; sessionStorage.removeItem('tz_token'); document.getElementById('btn-salir').hidden = true; pantallaLogin(); }
  document.getElementById('btn-salir').addEventListener('click', salir);

  function pantallaLogin() {
    limpiar($app);
    const inp = el('input', { type: 'password', id: 'clave', autocomplete: 'current-password', required: true, 'aria-label': 'Clave' });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Entrar' });
    const form = el('form', { class: 'tarjeta login' }, el('h1', { text: 'Ingresar al laboratorio' }), el('label', { for: 'clave', text: 'Clave' }), inp, btn,
      el('p', { class: 'nota', text: 'Ambiente de prueba, separado del dashboard de Celeste.' }));
    form.onsubmit = async ev => {
      ev.preventDefault();
      await conEspera(btn, async () => {
        const r = await api('login', null, { clave: inp.value });
        estado.token = r.token; sessionStorage.setItem('tz_token', r.token);
        inp.value = '';
        document.getElementById('btn-salir').hidden = false;
        await pantallaBandeja();
      });
    };
    $app.append(form);
    inp.focus();
  }

  // ---------- bandeja ----------
  async function pantallaBandeja() {
    limpiar($app);
    $app.append(el('p', { class: 'cargando', text: 'Cargando…' }));
    let b;
    try { b = await api('bandeja', { periodo: estado.periodo }); } catch (e) { limpiar($app); $app.append(el('p', { class: 'error', text: e.message })); return; }
    limpiar($app);
    const selector = el('input', { type: 'month', value: estado.periodo.slice(0, 4) + '-' + estado.periodo.slice(4), 'aria-label': 'Período',
      onchange: ev => { if (ev.target.value) { estado.periodo = ev.target.value.replace('-', ''); pantallaBandeja(); } } });
    $app.append(el('section', { class: 'cabecera' }, el('h1', { text: 'Bandeja del período' }), selector));
    if (!b.clientes.length) $app.append(el('p', { class: 'nota', text: 'Todavía no hay clientes. Agregá el primero abajo.' }));
    const lista = el('div', { class: 'lista' });
    b.clientes.forEach(c => {
      lista.append(el('button', { class: 'tarjeta cliente', onclick: () => { estado.cliente = c.alias; pantallaCliente(); } },
        el('div', { class: 'fila-sep' }, el('strong', { text: c.alias }), chipEstado(c.estado)),
        el('div', { class: 'meta', text: 'PV ' + c.pv + ' · ' + c.z + ' Z' + (c.sinConfirmar ? ' · ' + c.sinConfirmar + ' sin confirmar' : '') }),
        el('div', { class: 'monto', text: c.z ? '$ ' + pesos(c.total) : '—' })));
    });
    $app.append(lista, formCliente());
  }
  function chipEstado(e) { return el('span', { class: 'chip chip-' + e.toLowerCase().replace(/\s/g, '-'), text: e }); }

  function formCliente() {
    const campos = {
      alias: el('input', { required: true, maxlength: 30, placeholder: 'CLIENTE', pattern: '[A-Za-z0-9_\\-]{2,30}' }),
      nombre: el('input', { maxlength: 80, placeholder: 'Nombre o fantasía (opcional)' }),
      pv: el('input', { type: 'number', min: 1, max: 99999, required: true, inputmode: 'numeric' }),
      alicuotas: el('select', {}, el('option', { value: '21', text: '21 %' }), el('option', { value: '10.5', text: '10,5 %' }), el('option', { value: '21,10.5', text: '21 % y 10,5 %' })),
      numeracion: el('select', {}, el('option', { value: 'tique', text: 'Por número de tique (recomendado)' }), el('option', { value: 'z', text: 'Por número de Z' })),
      dias: el('select', {}, el('option', { value: 'dom', text: 'No abre los domingos' }), el('option', { value: '', text: 'Abre todos los días' }))
    };
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Guardar cliente' });
    return el('details', { class: 'tarjeta' }, el('summary', { text: 'Agregar o editar un cliente' }),
      el('form', { class: 'grilla-form', onsubmit: async ev => {
        ev.preventDefault();
        await conEspera(btn, async () => {
          await api('guardarCliente', { alias: campos.alias.value.trim(), nombre: campos.nombre.value.trim(), pv: campos.pv.value,
            alicuotas: campos.alicuotas.value, numeracion: campos.numeracion.value, diasSinActividad: campos.dias.value });
          toast('Cliente guardado.', 'ok'); pantallaBandeja();
        });
      } },
        el('label', { text: 'Nombre corto (el mismo del Tablero)' }), campos.alias,
        el('label', { text: 'Nombre' }), campos.nombre,
        el('label', { text: 'Punto de venta del controlador' }), campos.pv,
        el('label', { text: 'Alícuotas' }), campos.alicuotas,
        el('label', { text: 'Numeración a informar' }), campos.numeracion,
        el('label', { text: 'Días sin actividad' }), campos.dias, btn));
  }

  // ---------- cliente / período ----------
  async function pantallaCliente() {
    limpiar($app);
    $app.append(el('p', { class: 'cargando', text: 'Cargando…' }));
    let v;
    try { v = await api('periodo', { cliente: estado.cliente, periodo: estado.periodo }); }
    catch (e) { limpiar($app); $app.append(el('p', { class: 'error', text: e.message })); return; }
    estado.vista = v;
    limpiar($app);
    const editable = v.estado === 'Borrador';
    $app.append(
      el('button', { class: 'btn-link', onclick: pantallaBandeja, text: '← Bandeja' }),
      el('section', { class: 'cabecera' },
        el('div', {}, el('h1', { text: v.cliente.alias + ' · ' + v.periodo.slice(4) + '/' + v.periodo.slice(0, 4) }),
          el('div', { class: 'meta', text: 'PV ' + v.cliente.pv + ' · alícuotas ' + v.cliente.alicuotas.map(a => a.replace('.', ',') + ' %').join(' y ') + ' · numeración por ' + v.cliente.numeracion })),
        pasos(v.estado)),
      editable ? bloqueSubida() : null,
      bloqueControles(v),
      bloqueTabla(v, editable),
      bloqueTotales(v),
      bloqueAcciones(v));
  }

  function pasos(actual) {
    const lista = ['Borrador', 'Controlado', 'Importado', 'Verificado'];
    const i = lista.indexOf(actual);
    return el('ol', { class: 'pasos' }, lista.map((p, k) => el('li', { class: k < i ? 'hecho' : k === i ? 'actual' : '', text: p })));
  }

  function bloqueSubida() {
    const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/heic,image/*', multiple: true, id: 'fotos', class: 'oculto' });
    const prog = el('p', { class: 'meta', 'aria-live': 'polite' });
    const btn = el('label', { for: 'fotos', class: 'btn btn-grande', text: '📷 Sacar o subir fotos de los Z' });
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      let hechas = 0, conAviso = 0;
      for (const f of files) {
        prog.textContent = 'Subiendo y leyendo ' + (hechas + 1) + ' de ' + files.length + '…';
        try {
          const { base64, mime } = await reducirImagen(f);
          const r = await api('subirFoto', { cliente: estado.cliente, periodo: estado.periodo, base64, mime });
          if (r.aviso) conAviso++;
        } catch (e) { toast(f.name + ': ' + e.message, 'error'); }
        hechas++;
      }
      prog.textContent = '';
      toast(hechas + ' foto(s) procesadas' + (conAviso ? ' · ' + conAviso + ' para cargar a mano' : '') + '. Revisalas y confirmá cada Z.', 'ok');
      input.value = '';
      pantallaCliente();
    });
    return el('section', { class: 'tarjeta' }, el('h2', { text: '1 · Fotos' }), btn, input, prog,
      el('p', { class: 'nota', text: 'Un Z por foto, de frente y con buena luz. La lectura automática propone los datos; nada pasa a Controlado sin tu aprobación.' }));
  }

  // Reduce la foto en el navegador (lado mayor 2000 px, JPEG 85 %) y quita los metadatos (EXIF/GPS).
  function reducirImagen(file) {
    return new Promise((resolve, reject) => {
      if (file.size > 25 * 1024 * 1024) return reject(new Error('La foto pesa demasiado.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 2000, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const data = c.toDataURL('image/jpeg', 0.85);
        resolve({ base64: data.split(',')[1], mime: 'image/jpeg' });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir la imagen (probá con JPG).')); };
      img.src = url;
    });
  }

  function bloqueControles(v) {
    const c = v.controles;
    const caja = el('section', { class: 'tarjeta' }, el('h2', { text: '2 · Controles' }));
    if (!c.errores.length && !c.avisos.length) caja.append(el('p', { class: 'ok', text: '✔ Sin errores ni avisos.' }));
    if (c.errores.length) caja.append(el('p', { class: 'error', text: '✖ ' + c.errores.length + ' error(es): hay que corregirlos para aprobar.' }),
      el('ul', { class: 'alertas' }, c.errores.slice(0, 30).map(e => el('li', { text: (e.id ? 'Z ' + zDe(v, e.id) + ': ' : '') + e.msg }))));
    if (c.avisos.length) caja.append(el('p', { class: 'aviso', text: '⚠ ' + c.avisos.length + ' aviso(s): revisalos; podés aprobar si están bien.' }),
      el('details', {}, el('summary', { text: 'Ver avisos' }), el('ul', { class: 'alertas' }, c.avisos.map(e => el('li', { text: (e.id ? 'Z ' + zDe(v, e.id) + ': ' : '') + e.msg })))));
    return caja;
  }
  function zDe(v, id) { const f = v.filas.find(x => x.id === id); return f ? (f.z || '?') : '?'; }

  const CAMPOS = [
    ['fecha', 'Fecha', 'date'], ['z', 'Nº Z', 'num'], ['desde', 'Tique desde', 'num'], ['hasta', 'Tique hasta', 'num'], ['cant', 'Cant.', 'num'],
    ['gravado', 'Gravado', 'imp'], ['iva21', 'IVA 21 %', 'imp'], ['iva105', 'IVA 10,5 %', 'imp'], ['exento', 'Exento', 'imp'], ['no_gravado', 'No gravado', 'imp'], ['total', 'Total', 'imp']
  ];

  function bloqueTabla(v, editable) {
    const caja = el('section', { class: 'tarjeta' }, el('h2', { text: '3 · Tabla de control por Z (' + v.filas.length + ')' }));
    if (editable) caja.append(el('button', { class: 'btn-sec', onclick: () => editarFila(null), text: '+ Cargar un Z a mano' }));
    const tabla = el('div', { class: 'tabla-z' });
    v.filas.forEach(f => {
      const tieneError = f.alertas.some(a => !esAviso(a));
      tabla.append(el('article', { class: 'z ' + (f.confirmado !== 'SI' ? 'pendiente ' : '') + (tieneError ? 'con-error' : f.alertas.length ? 'con-aviso' : 'ok') },
        el('div', { class: 'fila-sep' },
          el('strong', { text: 'Z ' + (f.z || '—') + ' · ' + (fechaCorta(f.fecha) || 'sin fecha') }),
          el('span', { class: 'meta', text: f.confirmado === 'SI' ? '✔ confirmado' : (f.origen.startsWith('ia') ? 'leído por IA · sin confirmar' : 'sin confirmar') })),
        el('div', { class: 'meta', text: 'Tiques ' + (f.desde || '?') + '–' + (f.hasta || '?') + ' (' + (f.cant || '?') + ')' }),
        el('dl', { class: 'importes' },
          dt('Total', pesos(f.total)), f.neto21 && Number(f.neto21) ? dt('Neto 21 %', pesos(f.neto21)) : null, f.iva21 ? dt('IVA 21 %', pesos(f.iva21)) : null,
          f.neto105 && Number(f.neto105) ? dt('Neto 10,5 %', pesos(f.neto105)) : null, f.iva105 ? dt('IVA 10,5 %', pesos(f.iva105)) : null,
          Number(f.exento) ? dt('Exento', pesos(f.exento)) : null, Number(f.no_gravado) ? dt('No gravado', pesos(f.no_gravado)) : null),
        f.alertas.length ? el('ul', { class: 'alertas' }, f.alertas.map(a => el('li', { class: esAviso(a) ? 'aviso' : 'error', text: a }))) : null,
        el('div', { class: 'acciones-fila' },
          f.foto_id ? el('button', { class: 'btn-link', onclick: () => verFoto(f), text: 'Ver foto' }) : null,
          editable ? el('button', { class: 'btn-sec', onclick: () => editarFila(f), text: f.confirmado === 'SI' ? 'Editar' : 'Revisar y confirmar' }) : null)));
    });
    caja.append(tabla);
    return caja;
  }
  function esAviso(a) { return /^(IVA 21 % calculado|Neto e IVA calculados|Lectura dudosa|Observación|Salto de|La cantidad)/.test(a); }
  function dt(k, v) { return el('div', {}, el('dt', { text: k }), el('dd', { text: v })); }

  async function verFoto(f) {
    abrirModal(el('p', { text: 'Cargando foto…' }));
    try {
      const r = await api('foto', { id: f.id });
      abrirModal(el('img', { class: 'foto', alt: 'Foto del Z ' + (f.z || ''), src: 'data:' + r.mime + ';base64,' + r.base64 }));
    } catch (e) { abrirModal(el('p', { class: 'error', text: e.message })); }
  }

  function editarFila(f) {
    f = f || { pv: estado.vista.cliente.pv };
    const inputs = {};
    const form = el('form', { class: 'grilla-form' });
    const foto = f.foto_id ? el('button', { type: 'button', class: 'btn-link', onclick: () => verFoto(f), text: 'Ver foto' }) : null;
    CAMPOS.forEach(([k, label, tipo]) => {
      const i = el('input', { id: 'c-' + k, value: f[k] || '', inputmode: tipo === 'imp' ? 'decimal' : tipo === 'num' ? 'numeric' : undefined,
        type: tipo === 'date' ? 'date' : 'text', placeholder: tipo === 'imp' ? '0,00' : '', autocomplete: 'off' });
      if (f.dudosos && f.dudosos.split(', ').some(d => d === k || (d === 'tique_desde' && k === 'desde') || (d === 'tique_hasta' && k === 'hasta') || (d === 'cantidad' && k === 'cant'))) i.className = 'dudoso';
      inputs[k] = i; form.append(el('label', { for: 'c-' + k, text: label }), i);
    });
    const obs = el('input', { id: 'c-obs', value: (f.obs || '').replace(/^'/, ''), maxlength: 300 });
    form.append(el('label', { for: 'c-obs', text: 'Observaciones' }), obs);
    const btnConf = el('button', { class: 'btn', type: 'submit', text: 'Guardar y confirmar' });
    const btnBorr = f.id ? el('button', { class: 'btn-peligro', type: 'button', text: 'Borrar este Z', onclick: async () => {
      if (btnBorr.dataset.ok !== '1') { btnBorr.dataset.ok = '1'; btnBorr.textContent = 'Tocá de nuevo para borrar'; return; }
      await conEspera(btnBorr, async () => { await api('borrarZ', { cliente: estado.cliente, periodo: estado.periodo, id: f.id }); cerrarModal(); pantallaCliente(); });
    } }) : null;
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fila = { id: f.id, pv: f.pv, obs: obs.value, confirmado: true };
      Object.keys(inputs).forEach(k => { fila[k] = inputs[k].value.trim(); });
      await conEspera(btnConf, async () => {
        await api('guardarZ', { cliente: estado.cliente, periodo: estado.periodo, fila });
        cerrarModal(); toast('Z guardado y confirmado.', 'ok'); pantallaCliente();
      });
    });
    form.append(el('div', { class: 'acciones-fila' }, btnConf, btnBorr));
    abrirModal(el('h2', { text: f.id ? 'Z ' + (f.z || '') : 'Nuevo Z' }),
      el('p', { class: 'nota', text: 'Copiá lo que imprime el Z. Los netos por alícuota los calcula el sistema. Los campos en amarillo la IA no los leyó con seguridad.' }),
      foto, form);
  }

  function bloqueTotales(v) {
    const t = v.totales;
    return el('section', { class: 'tarjeta' }, el('h2', { text: 'Totales del mes' }),
      el('dl', { class: 'importes totales' },
        dt('Comprobantes (Z con ventas)', String(t.cantidad)), dt('Neto 21 %', pesos(t.neto21)), dt('IVA 21 %', pesos(t.iva21)),
        dt('Neto 10,5 %', pesos(t.neto105)), dt('IVA 10,5 %', pesos(t.iva105)), dt('Exento y no gravado', pesos(t.exentoNoGravado)), dt('Total', '$ ' + pesos(t.total))));
  }

  function bloqueAcciones(v) {
    const caja = el('section', { class: 'tarjeta' }, el('h2', { text: '4 · Aprobar, descargar y seguir en ARCA' }));
    const P = { cliente: estado.cliente, periodo: estado.periodo };
    if (v.estado === 'Borrador') {
      const chk = el('input', { type: 'checkbox', id: 'acepto' });
      const btn = el('button', { class: 'btn btn-grande', text: '✔ Aprobar (pasa a Controlado)', disabled: v.controles.errores.length > 0,
        onclick: async () => conEspera(btn, async () => {
          await api('aprobar', Object.assign({ aceptoAvisos: chk.checked }, P)); toast('Período aprobado: Controlado.', 'ok'); pantallaCliente();
        }) });
      if (v.controles.avisos.length) caja.append(el('label', { class: 'check' }, chk, ' Revisé los ' + v.controles.avisos.length + ' avisos y están bien.'));
      caja.append(btn);
      if (v.controles.errores.length) caja.append(el('p', { class: 'nota', text: 'Se habilita cuando no queden errores.' }));
    }
    const descargas = el('div', { class: 'acciones-fila' },
      botonDescarga('Resumen de cierre (.csv)', 'resumen'),
      v.estado !== 'Borrador' ? botonDescarga('TXT comprobantes', 'cbte') : null,
      v.estado !== 'Borrador' ? botonDescarga('TXT alícuotas', 'alicuotas') : null);
    caja.append(descargas);
    if (v.estado === 'Controlado') {
      caja.append(el('p', { class: 'nota', text: 'En ARCA: primero «Importar desde ARCA» (facturas electrónicas). Después «Importar archivos» con los dos TXT, eligiendo «Conservar». Revisá el Historial de importaciones.' }));
      const b = el('button', { class: 'btn', text: 'Ya los importé en ARCA', onclick: () => conEspera(b, async () => { await api('marcarImportado', P); pantallaCliente(); }) });
      caja.append(b);
    }
    if (v.estado === 'Importado' || v.estado === 'Verificado') {
      const inp = el('input', { inputmode: 'decimal', placeholder: 'Total de la vista previa del Libro IVA', value: v.totalVistaPrevia || '', 'aria-label': 'Total vista previa ARCA' });
      const b = el('button', { class: 'btn', text: 'Comparar con ARCA', onclick: () => conEspera(b, async () => {
        const r = await api('registrarVistaPrevia', Object.assign({ total: inp.value }, P));
        toast(r.estado === 'Verificado' ? 'Coincide con ARCA: Verificado.' : 'Diferencia de $ ' + pesos(r.diferencia) + ' contra ARCA.', r.estado === 'Verificado' ? 'ok' : 'error');
        pantallaCliente();
      }) });
      caja.append(el('div', { class: 'fila-form' }, inp, b));
      if (v.diferencia !== '') caja.append(el('p', { class: Number(v.diferencia) === 0 ? 'ok' : 'error', text: 'Diferencia contra ARCA: $ ' + pesos(v.diferencia) }));
    }
    if (v.estado !== 'Borrador') {
      const motivo = el('input', { placeholder: 'Motivo (obligatorio)', maxlength: 300, 'aria-label': 'Motivo para reabrir' });
      const b = el('button', { class: 'btn-peligro', text: 'Reabrir (vuelve a Borrador)', onclick: () => conEspera(b, async () => {
        const r = await api('reabrir', Object.assign({ motivo: motivo.value }, P)); if (r.aviso) toast(r.aviso); pantallaCliente();
      }) });
      caja.append(el('details', {}, el('summary', { text: 'Reabrir el período' }), el('div', { class: 'fila-form' }, motivo, b)));
    }
    caja.append(el('p', { class: 'nota', text: 'Presentar en ARCA es siempre decisión de la contadora.' }));
    return caja;
  }

  function botonDescarga(texto, tipo) {
    const b = el('button', { class: 'btn-sec', text: '⬇ ' + texto });
    b.addEventListener('click', () => conEspera(b, async () => {
      const r = await api('descargar', { cliente: estado.cliente, periodo: estado.periodo, tipo });
      // Todo el contenido es ASCII (lo valida el servidor): 1 carácter = 1 byte, igual en Windows-1252.
      const bytes = new Uint8Array(r.contenido.length);
      for (let i = 0; i < r.contenido.length; i++) {
        const c = r.contenido.charCodeAt(i);
        if (c > 255) throw new Error('El archivo trae caracteres no válidos para ARCA.');
        bytes[i] = c;
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: tipo === 'resumen' ? 'text/csv' : 'text/plain' }));
      const a = el('a', { href: url, download: r.nombre }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }));
    return b;
  }

  // ---------- modal ----------
  function abrirModal(...nodos) { const c = document.getElementById('modal-cuerpo'); limpiar(c); c.append(...nodos.filter(Boolean)); document.getElementById('modal').hidden = false; }
  function cerrarModal() { document.getElementById('modal').hidden = true; limpiar(document.getElementById('modal-cuerpo')); }
  document.getElementById('modal-cerrar').addEventListener('click', cerrarModal);
  document.getElementById('modal').addEventListener('click', ev => { if (ev.target.id === 'modal') cerrarModal(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') cerrarModal(); });

  // ---------- arranque ----------
  if (estado.token) { document.getElementById('btn-salir').hidden = false; pantallaBandeja(); } else pantallaLogin();
})();
