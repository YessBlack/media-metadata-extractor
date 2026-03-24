# Instrucciones de Copilot para Web Content Scraper

Este proyecto es una extensión de navegador para scraping de YouTube y Spotify.

## Estructura del Proyecto

- **manifest.json**: Configuración de la extensión (permisos, scripts, etc.)
- **popup.html/js/css**: Interfaz del usuario en el popup
- **content.js**: Scripts inyectados en las páginas para extraer datos
- **background.js**: Service worker para tareas de fondo
- **analyze_data.py**: Herramientas para análisis de datos extraídos

## Para Desarrolladores

### Agregar nuevo sitio (ejemplo: Twitter)

1. Agregar permiso en `manifest.json`:

   ```json
   "host_permissions": ["https://twitter.com/*"]
   ```

2. Agregar listener en `content.js`:

   ```javascript
   } else if (request.action === 'extractTwitter') {
       extractTwitterData().then(data => {
           sendResponse({success: true, data: data});
       }).catch(error => {
           sendResponse({success: false, error: error.message});
       });
   ```

3. Agregar función de extracción con selectores CSS apropiados

### Depuración

- Chrome DevTools: `Inspect` en el popup
- Ver logs: `chrome://extensions/` → Detalles de la extensión → Ver errores
- Contenido de página: Click derecho → Inspeccionar (en paginas video/playlist)

### Testing

1. Instalar localmente en modo desarrollo
2. Ir a YouTube/Spotify
3. Click en extensión y probar botones
4. Consultar la consola para errores

## Mejoras Futuras

- [ ] Soporte para descarga en otras plataformas
- [ ] Filtros de datos más avanzados
- [ ] Progreso en tiempo real
- [ ] Caché local de descargas
