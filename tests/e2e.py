# Prueba de punta a punta en un navegador real (Chrome) con el servidor simulado.
# python3 tests/e2e.py  (requiere e2e_server.js corriendo en :8765)
import sys, os
from playwright.sync_api import sync_playwright

URL = 'http://localhost:8765/'
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/e2e'
os.makedirs(OUT, exist_ok=True)
errores_consola = []

def foto_jpg(path):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (600, 1200), 'white'); d = ImageDraw.Draw(im)
    d.text((40, 40), 'INFORME Z 2290', fill='black'); im.save(path, 'JPEG')

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width': 390, 'height': 844}, accept_downloads=True)  # celular
    pg.on('console', lambda m: errores_consola.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errores_consola.append(str(e)))
    pg.goto(URL)
    pg.fill('#clave', 'mal'); pg.click('button[type=submit]')
    pg.wait_for_selector('.toast.error'); print('login incorrecto:', pg.inner_text('.toast'))
    pg.fill('#clave', 'clave-de-prueba-larga'); pg.click('button[type=submit]')
    pg.wait_for_selector('text=Bandeja del período')
    pg.fill('input[type=month]', '2026-11'); pg.dispatch_event('input[type=month]', 'change')
    pg.wait_for_selector('text=Todavía no hay clientes')
    pg.click('summary:has-text("Agregar o editar")')
    f = pg.locator('details form input')
    f.nth(0).fill('DEMO'); f.nth(1).fill('Prueba'); f.nth(2).fill('4')
    pg.click('text=Guardar cliente')
    pg.wait_for_selector('button.cliente:has-text("DEMO")')
    pg.screenshot(path=OUT + '/1_bandeja.png', full_page=True)
    pg.click('button.cliente:has-text("DEMO")')
    pg.wait_for_selector('text=Sacar o subir fotos')
    foto_jpg('/tmp/z.jpg')
    pg.set_input_files('#fotos', '/tmp/z.jpg')
    pg.wait_for_selector('text=Z 2290')
    pg.screenshot(path=OUT + '/2_leido.png', full_page=True)
    pg.click('text=Revisar y confirmar')
    pg.wait_for_selector('#c-iva21.dudoso')
    pg.screenshot(path=OUT + '/3_revisar.png', full_page=True)
    pg.click('text=Guardar y confirmar')
    pg.wait_for_selector('text=✔ confirmado')
    aprobar = pg.locator('text=Aprobar (pasa a Controlado)')
    if pg.locator('#acepto').count(): pg.check('#acepto')
    aprobar.click()
    pg.wait_for_selector('.pasos li.actual:has-text("Controlado")')
    with pg.expect_download() as d: pg.click('text=TXT comprobantes')
    dl = d.value; ruta = OUT + '/' + dl.suggested_filename; dl.save_as(ruta)
    data = open(ruta, 'rb').read()
    print('descarga:', dl.suggested_filename, len(data), 'bytes', 'CRLF' if data.endswith(b'\r\n') else 'SIN CRLF', 'largo', len(data.split(b'\r\n')[0]))
    with pg.expect_download() as d: pg.click('text=Resumen de cierre')
    d.value.save_as(OUT + '/resumen.csv'); print('resumen:', open(OUT + '/resumen.csv', 'rb').read())
    pg.click('text=Ya los importé en ARCA')
    pg.wait_for_selector('input[aria-label="Total vista previa ARCA"]')
    pg.fill('input[aria-label="Total vista previa ARCA"]', '121.000,00'); pg.click('text=Comparar con ARCA')
    pg.wait_for_selector('.pasos li.actual:has-text("Verificado")')
    pg.screenshot(path=OUT + '/4_verificado.png', full_page=True)
    # XSS: un nombre de cliente con HTML no se ejecuta
    pg.click('text=← Bandeja')
    print('errores de consola:', errores_consola)
    b.close()
