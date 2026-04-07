# BALANCE360 - Digital Intelligence

BALANCE360 evalua posicion digital y brechas competitivas por frente: app, web, RRSS, reviews, Google Business y menciones organicas.

## Variables de entorno

Usa `.env.example` como plantilla. Variables clave de seguridad:

- `REQUIRE_AUTH_ANALYZE=true`: obliga login para `/api/analyze`.
- `STRICT_CORS=true`: aplica CORS estricto con `ALLOWED_ORIGIN`.
- `ALLOWED_ORIGIN=https://tu-dominio.com` (o lista CSV).
- `RATE_LIMIT_MAX=12`: limite por ventana.
- `SIGNALS_FETCH_TIMEOUT_MS=9000`: timeout de llamadas externas.

## Seguridad implementada

- Autenticacion obligatoria en `/api/analyze`.
- Validacion de membresia de `workspace_members` antes de leer contexto.
- Verificacion de pertenencia de `company_id` al `workspace_id`.
- CORS configurable con modo estricto.
- Rate-limit en memoria + verificacion persistente por `analysis_requests`.
- Timeout de red en `api/lib/sources.js`.

## Scripts

```bash
npm run build
npm run audit
npm run security:dast
npm run security:sat
npm run security:check
```

`security:dast` y `security:sat` usan `BASE_URL` (default `http://localhost:5173`).

## UI

- El buscador de empresa/producto es el bloque principal.
- Dashboard personal y historial ahora estan en vistas separadas por pestanas.

