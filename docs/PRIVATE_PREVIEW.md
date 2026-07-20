# Perfil privado — catálogo y datos comerciales reales con Gemini (controlado)

Este documento cubre el perfil privado: la única superficie de este proyecto donde
Gemini recibe el catálogo y los datos comerciales **reales** (precio, precio de
lista, stock, estado), en vez del dataset sintético que usan `/` y `/ai-preview/`.

## Qué NO cambia

- `index.html` (raíz) y `/ai-preview/` siguen sin `FEATURE_FLAGS` propio o con
  `remoteResponseProvider` apuntando siempre al mismo endpoint público — su
  comportamiento observable es idéntico al de antes de esta fase.
- `production/` sigue completamente fuera de Git (`.gitignore`), igual que
  `private-preview-build/` (el artefacto generado — ver más abajo).
- Ningún archivo de este repositorio contiene ni referencia una
  `GEMINI_API_KEY` real.

## Arquitectura

```
Navegador (proyecto Vercel PRIVADO, detrás de autenticación)
  index.html (generado desde production.example/index-privado.html.example)
    → FEATURE_FLAGS = { remoteResponseProvider: true }
    → REMOTE_PROVIDER_CONFIG = { endpoint: '/api/copilot' }  (same-origin)
    → carga data.js + commercial-data.js REALES junto a los mismos módulos
      compartidos que usan / y /ai-preview/ — cero lógica duplicada
    ↓
  ContextBuilder.build(sku) → PromptContextBuilder.build()
    → PromptContext: SOLO el SKU consultado + candidatos ya filtrados
      (R-PIG-04, Baja excluida) — nunca el catálogo comercial completo
    ↓ POST {skill, promptContext}
  /api/copilot (mismo api/copilot.js, GEMINI_API_KEY propia y separada del
                proyecto privado — nunca solicitada/leída/mostrada por el
                asistente que preparó esta fase)
    ↓
  server/gemini-proxy-server.js (COMPARTIDO con el proyecto público)
    → construye el prompt, llama a Gemini real
    → validateResponseContract + validateGroundedSkuUsage (sin cambios)
    → validateCommercialFieldsMatch (NUEVO — ver más abajo)
    → responde, o lanza error → RemoteResponseProvider cae a Local
```

## Frontera de privacidad — sin promesas que el código no sostiene

- Usuarios **no autenticados**: no deben poder obtener `/`, `/data.js`,
  `/commercial-data.js` ni `/api/copilot` en absoluto (Vercel Authentication).
- Usuarios **internos autorizados**: reciben el **dataset completo** en el
  navegador (`data.js`/`commercial-data.js` son `<script>` estático — es
  consecuencia de que este proyecto es "sin backend", no un descuido de esta
  fase). Cualquiera con acceso puede inspeccionarlo por DevTools. Aceptable
  únicamente para usuarios internos de confianza — no es una barrera técnica
  contra un insider, es control de acceso perimetral.
- **Gemini** recibe únicamente el `PromptContext` del SKU consultado y sus
  candidatos ya filtrados — nunca el catálogo comercial completo.

## `priceDifference` en `PromptContext` (cambio a un archivo antes protegido)

`assets/js/prompt-context-builder.js` — `buildCommercialContext()` ahora incluye
`priceDifference`, tomado tal cual de `context.comercial.priceDifference`
(nunca derivado por resta, para no introducir una semántica distinta del dato
real del Dashboard). `SCHEMA_VERSION` de `PromptContextBuilder` pasó de
`1.0.0` a `1.1.0` (cambio aditivo, retrocompatible — ningún consumidor
existente leía ese campo). Afecta también a `/ai-preview/` (dataset
sintético): el campo ahora existe en su `PromptContext`, siempre `null` allí,
sin cambio de comportamiento observable.

## Validación comercial estricta — alcance exacto (matriz honesta)

| Habilidad | ¿Recibe `commercialContext`? | ¿Validación estricta de valores comerciales? |
|---|---|---|
| `explain-product` | Sí (texto libre, el prompt le pide usarlo) | **No** — nada impide mencionar un valor comercial en el texto |
| `compare-products` | Sí (por cada producto) | **No** — `similitudes`/`diferencias` son texto libre |
| `best-alternative` | Sí | **No** en `justificacion` (solo el SKU de la alternativa tiene grounding, ya existente) |
| `cross-sell` | Sí | **No** en `razon` (solo el SKU de cada recomendación tiene grounding, ya existente) |
| `price-availability` | Sí, y es la única instruida a usarlo *exclusivamente* | **Sí — nueva en esta fase**: igualdad estricta en 6 campos |

`validateCommercialFieldsMatch()` (`server/gemini-proxy-server.js`) compara,
solo para `price-availability`, por igualdad estricta (`===`):
`disponible`, `precio`, `precioLista`, `priceDifference`, `stock`, `estado`
contra `promptContext.commercialContext`. Cualquier discrepancia →
`contractViolation()` con un código de razón cerrado y sanitizado
(`commercial_*_mismatch`, sin ningún valor) → `RemoteResponseProvider` cae a
`LocalResponseProvider`. Sustituye a la validación anterior (que solo cubría
`disponible=false`); cualquier caso que esa cubría, esta lo sigue cubriendo.

**Límite conocido, documentado, no resuelto en esta fase:** las otras 4
habilidades reciben el mismo `commercialContext` (es una propiedad de primer
nivel del `PromptContext`, no oculta) pero devuelven texto libre — nada aquí
impide que el modelo mencione un valor comercial dentro de ese texto. Ver
"Extensión futura" abajo.

### Extensión futura (no implementada)

- **(a) Minimizar exposición**: no enviar `commercialContext` en el
  `PromptContext` de las 4 habilidades no comerciales. Requiere modificar
  `RemoteResponseProvider` y reescribir el grounding hint de `explain-product`
  (hoy depende de recibirlo).
- **(b) Extender la validación estructural**: forzar a las 4 habilidades a
  devolver un sub-objeto comercial tipado y validable. Cambia
  `response-provider-contract.js` y `LocalResponseProvider` (ambos deben
  implementar la misma forma).

Ambas quedan fuera de esta fase — requieren autorización explícita separada.

## Artefacto privado — generación

`scripts/build-private-preview.js` construye, **fuera de Git**, un directorio
(`private-preview-build/`, gitignored) listo para `vercel deploy`:

- Allowlist **derivada automáticamente**: parsea
  `production.example/index-privado.html.example` (`src=`/`href=` hacia
  `assets/...`) y cada CSS referenciado (por si trae `url()` locales — hoy no
  hay ninguna, se revisa en cada corrida).
- Lista fija (no derivada del HTML): `server/gemini-proxy-server.js`,
  `server/gemini-prompt-builder.js`, `api/copilot.js`, y — el único paso que
  toca datos reales — `production/data.js` → `data.js`,
  `production/commercial-data.js` → `commercial-data.js`.
- Rechaza activamente: symlinks, rutas fuera de
  `assets/`+`server/`+`api/`+`production/`+`production.example/`, y patrones
  denegados (`.git`, `docs/`, `*.md`, `scripts/verify-*`, `scripts/manual-*`,
  `.env*`, `node_modules/`, `*.zip`/`*.tar*`) — aunque algo así apareciera
  referenciado por error.
- Todo o nada: valida el plan completo antes de escribir un byte. Tras
  escribir, verifica que no falte ni sobre ningún archivo.
- Genera `MANIFEST.json` (nombre, tamaño, sha256 por archivo) — nunca
  contenido ni valores comerciales.
- Probado con fixtures 100% ficticias (`scripts/verify-build-private-preview.js`,
  9/9 checks) y verificado contra `production/` real (ver "Estado verificado"
  más abajo) — sin imprimir nunca un valor real.

```bash
node scripts/build-private-preview.js [--out <directorio>]
```

## Despliegue en dos etapas (canario primero)

**Etapa A — canario sintético** (mismas rutas/nombres, cero datos reales):
1. Generar el artefacto usando el dataset sintético público como `data.js` y
   un `commercial-data.js` sintético equivalente en forma/escala.
2. Desplegar al proyecto Vercel privado.
3. Activar Vercel Authentication.
4. Verificar negativo (sin autenticar): `/`, `/data.js`, `/commercial-data.js`,
   `/api/copilot` — las 4 deben quedar bloqueadas. Un `404` en `/api/copilot`
   **no cuenta como bloqueada** — significa que la petición llegó al handler,
   no que Vercel Authentication la interceptó. Válido: `401`/`403`/redirección
   de autenticación, antes de tocar el código de la función.
5. Verificar positivo (sesión autorizada): las 4 rutas responden.

**Etapa B — artefacto real** — solo si la Etapa A pasa sus 5 verificaciones:
6. Regenerar el artefacto con `production/data.js`/`commercial-data.js` reales.
7. Desplegar.
8. Repetir exactamente las mismas 5 verificaciones, sin imprimir ni inspeccionar
   ningún dato comercial real durante la prueba.

## Controles de costo y abuso

Antes de cualquier dato real: autenticación obligatoria (Vercel Authentication),
límite razonable de peticiones, presupuesto/alerta en el proyecto de Google
Cloud asociado a la `GEMINI_API_KEY` privada (configuración externa a este
repositorio).

## Estado verificado en esta fase (sin Vercel, sin GEMINI_API_KEY disponibles)

| Verificación | Estado |
|---|---|
| Regresión automática completa | ✅ 213 + 9 (nuevo `verify-build-private-preview.js`) checks, 0 fallos |
| `/` sigue local | ✅ verificado (grep: sin `FEATURE_FLAGS`) |
| `/ai-preview/` sigue sintético | ✅ sin cambios |
| Artefacto generado desde `production/` real | ✅ 21 archivos, manifiesto con hashes |
| `price-availability` refleja el snapshot real exacto | ✅ verificado programáticamente (igualdad estricta en 5 campos + disponibilidad), sin imprimir valores |
| Al menos una combinación real relaciones+comercial | ✅ verificado: producto real con relaciones>0 y comercial disponible simultáneamente en su `PromptContext` |
| Fallback a Local sin `GEMINI_API_KEY`, HTTP real | ✅ verificado contra el proxy real del artefacto, `source:"local"` |
| Respuesta real con `source:"gemini"` | ❌ **bloqueado** — sin `GEMINI_API_KEY` disponible en este entorno |
| Despliegue Vercel (canario o real) | ❌ **bloqueado** — sin Vercel CLI/token en este entorno |
| Protección anónima comprobada en vivo | ❌ **bloqueado** — depende del despliegue anterior |
| Ausencia de secretos/datos reales en Git | ✅ verificado (`git status`, `git check-ignore`) |

## Rollback

- `server/gemini-proxy-server.js`, `assets/js/prompt-context-builder.js`,
  scripts nuevos: `git revert <sha>`.
- Artefacto (`private-preview-build/`): se descarta y regenera; nunca hay
  estado de git que revertir (nunca se stagea).
- Proyecto Vercel privado: pausar/eliminar desde el dashboard — acción externa
  a este repositorio.
