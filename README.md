# Tiques Z → ARCA · Laboratorio

Módulo de prueba para el estudio de Celeste Vila: fotos de informes Z → tabla de control → aprobación de la contadora → TXT para el Libro IVA Digital (RG 4597) → Resumen de cierre → Tablero IVA Ventas.

**Es un laboratorio separado del dashboard productivo.** No usa su repo, su URL, su planilla ni su Apps Script. Celeste sigue trabajando igual mientras se prueba.

**La IA prepara y la contadora decide.** La lectura automática propone cada Z como «sin confirmar». Ningún período pasa a *Controlado* sin el botón «Aprobar», y presentar en ARCA sigue siendo decisión de Celeste.

## Qué hace

1. **Fotos desde el celular**, por cliente y período. El navegador reduce cada foto a 2000 px y le borra los metadatos (EXIF/GPS) antes de subirla. Se guarda en Drive, en `Tiques Z (LAB)/<CLIENTE>/<AAAAMM>`.
2. **Lectura con la API de Claude.** Se le piden fecha, PV, Z, primer y último tique, cantidad, gravado, IVA por alícuota, exento, no gravado y total. Los datos dudosos quedan marcados.
3. **Tabla de control por Z.** Marca errores que bloquean la aprobación: fecha fuera del período, Z repetido, tiques superpuestos, una alícuota no configurada, sumas que no cierran o filas sin confirmar. También muestra avisos, que Celeste puede aceptar: saltos de Z o de tiques, días sin Z y diferencias entre el IVA impreso y el calculado.
4. **Aprobar → Controlado.** Habilita los dos TXT (CBTE de 266 caracteres y ALÍCUOTAS de 62, en ASCII/ANSI con CRLF) y actualiza el Tablero.
5. **Importado → Verificado.** Celeste marca la importación y carga el total de la vista previa de ARCA. Si la diferencia es 0, el período pasa a *Verificado*.
6. **Resumen de cierre** en CSV, con el mismo formato que el procedimiento IVA_01.

### Reglas de cálculo (verificadas con octubre 2026)

| Lo que imprime el Z | Cómo se obtiene el neto |
|---|---|
| Gravado + IVA de una sola alícuota | neto = gravado |
| Gravado + IVA 21 % + IVA 10,5 % | neto 10,5 % = redondeo(IVA 10,5 % / 0,105); neto 21 % = gravado − neto 10,5 % |
| Total + IVA (sin gravado) | gravado = total − IVA − exento − no gravado |
| Solo el total | neto = redondeo(base / (1 + alícuota)), IVA = base − neto (queda como aviso) |

El IVA que se informa es siempre el impreso en el Z. El exento va en el campo 12 del archivo de comprobantes y el no gravado en el 10. Las líneas de alícuotas van en orden 21 % → 10,5 %. Los Z en cero no se exportan.

## Instalación (una vez)

1. **Cuenta de Google del proyecto.** Crear una Gmail exclusiva del laboratorio; no usar la personal ni la de Celeste.
2. **Planilla de datos.** En esa cuenta, crear una planilla «Tiques Z LAB» y abrir *Extensiones → Apps Script*. Pegar `backend/Codigo.gs` y guardar.
3. **Carpeta de fotos.** Crear en Drive la carpeta `Tiques Z (LAB)`, privada, y copiar su ID de la URL.
4. **Tablero.** Subir `Tablero_IVA_Ventas_por_cliente.xlsx` a Drive, abrirlo con *Hojas de cálculo de Google*, guardarlo como planilla «Tablero IVA Ventas (LAB)» y copiar su ID.
5. **Propiedades del script** (⚙ Configuración del proyecto → Propiedades del script):
   - `NUEVA_CLAVE`: contraseña del laboratorio, de 12 caracteres o más.
   - `ANTHROPIC_API_KEY`: clave de la API de Claude.
   - `CARPETA_RAIZ_ID` y `TABLERO_ID`.
   - Opcionales: `CLAUDE_MODEL` (por defecto `claude-sonnet-5-5`) y `RETENCION_DIAS` (por defecto 90).
6. **Ejecutar una vez**, desde el editor, `setup` y después `establecerClave`. La segunda borra `NUEVA_CLAVE`.
7. **Implementar** → Nueva implementación → *Aplicación web* · Ejecutar como: *Yo* · Acceso: *Cualquier persona*. Copiar la URL `/exec` en `config.js`.
8. **Publicar el frontend con GitHub Pages:** *Settings → Pages → Deploy from branch → main / root*.

> Para actualizar el script más adelante, usar *Gestionar implementaciones → Editar → Nueva versión*, así la URL no cambia.

## Seguridad

- Clave guardada como hash con sal en las Propiedades del script. El inicio de sesión devuelve un token aleatorio que dura 8 h; en la caché del servidor queda solo el hash del token, y en el navegador el token se guarda en `sessionStorage`.
- 10 intentos fallidos bloquean el inicio de sesión durante 15 minutos. Cada token tiene un límite de 120 llamadas por minuto.
- Toda la validación y los cálculos se hacen en el servidor. Las respuestas de la IA se validan campo por campo y nunca se confirman solas.
- Escrituras con `LockService`. Los errores llegan al usuario como mensajes genéricos. Se aplica protección contra fórmulas inyectadas en la hoja y una auditoría de cada acción, sin claves ni tokens.
- El frontend no tiene dependencias externas, aplica una CSP estricta y arma el DOM solo con `textContent`.
- **El repo no contiene datos de clientes ni claves.** Las pruebas con datos reales leen los archivos desde rutas externas (`OCT_FIXTURE`, `OCT_REF`).
- Límites conocidos: un Apps Script publicado como «Cualquier persona» no permite restringir CORS, así que la barrera es la clave y el token. GitHub Pages no permite encabezados HTTP propios; la CSP va en una etiqueta `meta`.

## Pruebas

```bash
node tests/test_reglas_y_seguridad.js          # datos inventados (46 casos)
OCT_FIXTURE=… OCT_REF=… node tests/test_octubre.js   # aceptación: octubre 2026 byte a byte (datos fuera del repo)
node tests/e2e_server.js 8765 & python3 tests/e2e.py # punta a punta en Chrome, vista de celular
```
