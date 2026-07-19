# PROJECT_BRIEF — Bismillah Product Intelligence Platform (MVP v1)

## Objetivo real
Convertir el grafo de conocimiento del catálogo maestro (1.094 productos, 14.915 relaciones, 7 tipos) en una herramienta operativa para el equipo comercial: explorar productos, entender su red de relaciones y extraer recomendaciones accionables (venta cruzada, sustitución, variantes) con gobernanza de confianza.

## Dominio
Distribuidora mayorista peruana con dos universos de catálogo:
- **B — Bienestar** (suplementos, colágenos, herbolaria, gomitas…): 29 subcategorías.
- **F — Farma** (analgésicos, antibióticos, SNC, tópicos…): 26 subcategorías.

## Usuarios
Analistas comerciales, compras y category managers. Uso interno, escritorio primero, responsive.

## Alcance MVP (4 módulos)
1. **Panorama** — salud del grafo: KPIs, distribución por tipo, confianza por tipo, mezcla B/F, hubs, registro de riesgos.
2. **Explorador** — búsqueda por nombre/SKU/tags, filtros por universo, familia, audiencia y tipo de relación.
3. **Producto 360** — ficha con órbita de relaciones (grafo ego interactivo), relaciones agrupadas por tipo con justificación y confianza.
4. **Motores** — simulador de recomendación: venta cruzada, sustitución y variantes, con scoring transparente y exclusión de confianza Baja por defecto (mitigación R-PIG-04).

## Arquitectura
SPA de un solo archivo HTML (vanilla JS + Canvas) por perfil de despliegue, datos embebidos en un `data.js` propio de cada perfil en formato columnar compacto (~450 KB), separados de la lógica de aplicación compartida en `assets/js/app.js`. Sin backend: portable, auditable, cero dependencias de servidor.

Dos perfiles comparten la misma lógica y solo difieren en el dataset: la raíz del repositorio (`assets/js/data.js`, sintético, versionado, seguro para GitHub público — es el perfil por defecto) y `production/` (catálogo real, excluido por completo de git y de su historial — ver README, "Perfiles de despliegue"). El dataset sintético preserva el grafo de relaciones exacto, por lo que todos los KPIs y comportamientos del MVP descritos en este brief son idénticos en ambos perfiles.

## Modelo de datos
- `products[sku, nombre, subcatIdx, grado, tags, audiencias]`
- `rels[srcIdx, dstIdx, tipo(0-6), confianza(0-2), justIdx]` con tabla de 349 justificaciones únicas.
- Subcategoría y audiencia **derivadas de las justificaciones** de MISMA_CATEGORIA / MISMA_AUDIENCIA (cobertura 100 % de subcategoría).

## Supuestos críticos
1. La subcategoría de cada SKU se infiere de sus aristas MISMA_CATEGORIA (fuente única disponible); cobertura verificada: 1.094/1.094.
2. Familias (B1…F10) nombradas por síntesis de sus subcategorías; ajustables.
3. Pesos del motor de venta cruzada (COMPLEMENTA 3.0 > MISMO_BENEFICIO 2.0 > MISMA_AUDIENCIA 1.5 > MISMO_INGREDIENTE 1.0; Alta ×1.0, Media ×0.6) son valores iniciales editables, alineados con la intención comercial de cada tipo.
4. Confianza Baja excluida por defecto en Motores (política R-PIG-04), con interruptor visible.
5. Los 18 productos NO_CLASIFICADO (R-PIG-06) no están en el grafo fuente y quedan fuera del MVP.

## Riesgos heredados
Se integra el registro R-PIG-01…06 del catálogo maestro dentro de Panorama para trazabilidad.

## Criterio de éxito
Un analista encuentra un producto en <5 s, entiende su red en una pantalla y obtiene una lista de venta cruzada justificada sin salir de la herramienta.

## Fase 2 — AI Sales Copilot (en curso)
Paso 1 (aprobado): scaffold visual del panel lateral **AI Sales Copilot** en Producto 360 — layout de dos columnas con panel sticky en la columna derecha, cinco habilidades planificadas (Explicar producto, Comparar productos, Precio y disponibilidad, Mejor alternativa, Venta cruzada inteligente), todas en estado "Próximamente". Es exclusivamente interfaz: sin lógica de negocio, sin llamadas a APIs, sin integración de IA (Gemini u otro proveedor).

Paso 2 (aprobado): módulo **Context Builder** (`assets/js/context-builder.js`) — ver [ARCHITECTURE.md](ARCHITECTURE.md) para el detalle. Construye, a partir de un producto, el contexto estructurado que el futuro AI Sales Copilot podrá recibir como entrada. Módulo independiente y puro: no depende del DOM ni de `app.js`, no llama a ninguna API ni SDK de IA, no modifica Producto 360 ni el panel del Copilot, y no fabrica datos comerciales — el bloque `comercial` (precio/stock/margen/estado) queda declarado en `null`, listo para poblarse cuando la Fase 1 (Integración de Datos) esté disponible. Verificado con `node scripts/verify-context-builder.js` (10/10 checks) contra el dataset sintético y el real.

Paso 3 (aprobación pendiente): primera habilidad funcional del Copilot, **Explicar producto**, servida por un **Local Response Provider** (`assets/js/response-provider.js` + `assets/js/providers/local-response-provider.js`) — ver [ARCHITECTURE.md](ARCHITECTURE.md) para el detalle completo. Flujo: Usuario → panel AI Sales Copilot → `ContextBuilder.build()` → `ResponseProvider.get().explainProduct(context)` → texto mostrado en el panel. El proveedor sintetiza el texto por reglas a partir, exclusivamente, de campos ya devueltos por el Context Builder (nombre, universo, subcategoría, tags, audiencias, beneficios reales extraídos de justificaciones MISMO_BENEFICIO, resumen de relaciones) — sin IA, sin red, sin datos inventados. El contrato es `async` desde el día uno específicamente para que sustituir este proveedor por uno de Gemini más adelante sea un cambio de una sola línea (`ResponseProvider.use(...)` en `app.js`), sin tocar el panel, el Context Builder ni Producto 360. Verificado con `node scripts/verify-response-provider.js` (9/9 checks, incluyendo los 1.094 productos del catálogo sin excepción) y con `node scripts/verify-context-builder.js` (10/10, sin regresión).

Los pasos siguientes de esta fase (las cuatro habilidades restantes, elegir proveedor de IA real, diseñar el prompt) requieren su propia especificación (Product/UI/Technical Spec + criterios de aceptación) antes de implementarse.
