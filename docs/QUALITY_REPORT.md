# QUALITY_REPORT — Bismillah Product Intelligence Platform

Metodología de revisión: DULCE
Fecha de esta actualización: 2026-07-20 · Commit auditado: `44f9414` (`fix: harden cross-sell response contract`)
Estado de sincronización verificado: `HEAD`, `main` y `origin/main` idénticos (`git rev-list --left-right --count origin/main...HEAD` → `0 0`). El working tree estaba limpio antes de editar este reporte; ahora contiene únicamente `docs/QUALITY_REPORT.md` modificado, sin staging.

Este reporte cubre dos capas: el **MVP core** (Panorama/Explorador/Producto 360/Motores, sección original sin cambios de fondo) y las fases añadidas desde entonces — **AI Sales Copilot**, **datos comerciales** y **proveedor remoto Gemini**.

## 1. MVP core (Panorama, Explorador, Producto 360, Motores)

| Categoría | Estado | Evidencia |
|---|---|---|
| Funcionalidad | ✅ Pasa | 4 módulos operativos. Tests headless (Node): búsqueda, filtros (universo/familia/tipo/audiencia), motores cross/subs/vars, política Baja. `ALL LOGIC TESTS PASSED`. |
| Arquitectura | ✅ Pasa | SPA de un archivo por perfil, datos columnar compactos (450 KB), índices de adyacencia O(1) por producto, tabla de 349 justificaciones deduplicadas. Sin dependencias de runtime. |
| Calidad de código | ✅ Pasa | `node --check` limpio; strict mode; escape XSS en todo render (`esc()`); estado por vista aislado; sin listeners huérfanos tras corrección. |
| UX | ✅ Pasa | Búsqueda global omnipresente (<5 s a cualquier SKU), navegación cruzada Panorama→Explorador→360→Motores, paginación incremental, estados vacíos con instrucción. |
| UI | ✅ Pasa | Sistema de diseño propio (Space Grotesk / IBM Plex, paleta clínico-botánica, universos B/F codificados por color). Firma visual: órbita de relaciones en canvas. |
| Rendimiento | ✅ Pasa | Render inicial <1.5 s con 14.915 aristas; canvas repinta solo en hover; listas limitadas a 40 filas + "mostrar más"; búsqueda con corte a 400 candidatos. |
| Seguridad | ✅ Pasa | Todo dato interpolado pasa por `esc()`; sin `eval` en producción; sin red salvo Google Fonts (con fallback tipográfico). |
| Consistencia | ✅ Pasa | KPIs calculados en vivo coinciden con la hoja Dashboard fuente: 1.094 nodos, 14.915 aristas, Alta 61,4 %, reciprocidad 32,0 %, grado medio 27,3 / máx 229. Validación cruzada superada. |

### Defectos históricos (corregidos)
1. **Motores**: el cierre del dropdown de producto base usaba un listener `{once:true}` que moría tras el primer clic. Corregido con manejador global delegado. Re-verificado visualmente.

### Verificación visual
Capturas headless (Chromium 1440×900 y 390×844): Panorama, Explorador, Producto 360 (órbita interactiva), Motores y móvil. Sin errores de consola propios (único aviso: certificado de Google Fonts en sandbox, irrelevante en navegador real).

### Límites conocidos (documentados en el Brief)
- Subcategoría/audiencia derivadas de justificaciones (cobertura 100 % / 106 SKUs respectivamente).
- Pesos del motor de venta cruzada: valores iniciales editables.
- 18 SKUs NO_CLASIFICADO fuera del grafo fuente (R-PIG-06).

## 2. AI Sales Copilot, datos comerciales y proveedor remoto (Fases 2-5)

### Regresión automática — verificada directamente en esta auditoría

Ejecuté las 16 suites (`node scripts/verify-*.js`) sobre el commit `44f9414`. Todas terminan con exit code 0:

| Suite | Checks |
|---|---|
| `verify-response-provider.js` | 9/9 |
| `verify-context-builder.js` | 10/10 |
| `verify-compare-products.js` | 10/10 |
| `verify-best-alternative.js` | 10/10 |
| `verify-cross-sell.js` | 10/10 |
| `verify-commercial-data.js` | 8/8 |
| `verify-price-availability.js` | 12/12 |
| `verify-prompt-context-builder.js` | 17/17 |
| `verify-gemini-prompt-builder.js` | 19/19 |
| `verify-gemini-proxy-server.js` | 37/37 |
| `verify-remote-response-provider.js` | 15/15 |
| `verify-ai-response-provider.js` | 15/15 |
| `verify-ai-provider-abstraction.js` | 11/11 |
| `verify-api-copilot.js` | 15/15 |
| `verify-controlled-remote-activation.js` | 6/6 |
| `verify-manual-gemini-check-safeguards.js` | 6/6 |
| **Total** | **210/210** |

Toda esta suite es, por diseño, 100 % simulada — sin `GEMINI_API_KEY` real, sin costo, sin red externa ni llamadas reales a Gemini; algunas suites usan HTTP local con Gemini simulado — desde Fase 4 Paso 4 en adelante. Cubre: las 5 habilidades del Copilot sobre el catálogo completo (1.094 productos) sin regresiones, aislamiento de secretos (`verify-controlled-remote-activation.js` confirma que ningún archivo servido al navegador referencia `GEMINI_API_KEY`), fallback automático a `LocalResponseProvider`, contrato de grounding (`validateGroundedSkuUsage`), y las nuevas salvaguardas de `cross-sell` (commit `44f9414`: códigos de diagnóstico cerrados como `cross_sku_invalid` que nunca registran contenido del modelo).

### Despliegue — verificado en vivo

- `https://bismillah-intelligence-platform.vercel.app/` → perfil demo, `LocalResponseProvider`, badge "⚠ Catálogo demo · datos sintéticos". Confirmado por fetch directo.
- `https://bismillah-intelligence-platform.vercel.app/ai-preview/` → perfil con proveedor remoto controlado, badge "AI PREVIEW", carga exitosa (no error). Confirmado por fetch directo.
- Estado de `FEATURE_FLAGS` por perfil, confirmado por grep directo sobre el código fuente: `/` permanece local y no define el flag; `/ai-preview/` activa intencionalmente `remoteResponseProvider`; `production.example/` no lo activa.

### Revalidación en vivo post-hotfix contra la API real de Gemini (`docs/GEMINI_MANUAL_VALIDATION.md`)

**Reportada** como una petición real hecha desde la interfaz de `/ai-preview/` en producción, usando la `GEMINI_API_KEY` almacenada en Vercel (nunca leída ni solicitada por mí). La evidencia disponible es: una petición real desde `/ai-preview/`, HTTP 200 observado en Vercel, y `source: "gemini"` mostrado por la interfaz — no la ejecución de los pasos [1/2]/[2/2] de `scripts/manual-gemini-live-check.js`, que es un camino distinto y no se reportó haberse corrido.

- Habilidad probada: **`cross-sell`**.
- HTTP 200, `source: "gemini"`, duración 19 687 ms (~19,7 s), tres recomendaciones grounded, sin fallback ni reintentos.

No repetí esta llamada — se me indicó explícitamente no hacerlo, y el criterio es razonable para no duplicar costo. Por transparencia sobre el alcance real de esta revalidación:

⚠️ **Cobertura parcial respecto a los 5 criterios de aprobación del propio `GEMINI_MANUAL_VALIDATION.md`.** El criterio 5 exige probar **al menos** `explain-product` (confirma texto libre grounded) **y** una habilidad con candidatos filtrados (`best-alternative` o `cross-sell`, confirma que respeta R-PIG-04). Lo reportado cubre únicamente `cross-sell`. Los demás criterios verificables a partir de la evidencia disponible (HTTP 200, `source:"gemini"`, contenido grounded) están satisfechos para esa habilidad.

**Conclusión de esta capa: revalidación post-hotfix parcial.** No se recomienda declarar la Fase 4 Paso 6 completamente cerrada hasta probar específicamente `explain-product` en vivo, por el propio estándar que el proyecto se dio a sí mismo. Esto no bloquea el uso actual de `/ai-preview/` — el fallback automático a Local ya está verificado exhaustivamente por la suite automática — pero sí queda como pendiente documentado antes de considerar la integración con Gemini 100 % validada de punta a punta.

## 3. Integridad del repositorio

- `git log --oneline -1` → `44f9414 fix: harden cross-sell response contract`, sincronizado con `origin/main`.
- Antes de esta actualización, el working tree estaba limpio. Actualmente `docs/QUALITY_REPORT.md` es el único archivo modificado y no existe contenido staged.
- Historial público reescrito (commit raíz limpio, dataset real nunca expuesto): **antecedente de la auditoría de publicación del 2026-07-19, no re-verificado en esta revisión.**
- Lo que sí se re-verificó en esta revisión: el perfil `/production` (incluyendo `production/commercial-data.js`, añadido después de esa auditoría) permanece completamente fuera del control de versiones — `git check-ignore -v` confirma los tres archivos ignorados por `.gitignore`, y `git ls-files` no reporta nada bajo `production/`.
- Sin `package.json` ni `vercel.json` en el árbol — consistente con la restricción del proyecto de no añadir tooling salvo necesidad demostrada.

## Veredicto

- **MVP core**: ✅ **APTO PARA ENTREGA** (sin cambios desde la revisión anterior).
- **AI Sales Copilot + integración Gemini (código y regresión automática)**: ✅ **APTO** — 210/210 checks, cero regresiones, cero secretos expuestos, fallback verificado exhaustivamente.
- **Revalidación en vivo post-hotfix contra Gemini real**: 🟡 **PARCIAL** — `cross-sell` confirmado en producción; falta específicamente `explain-product` para satisfacer el criterio 5/5 documentado por el propio proyecto.
