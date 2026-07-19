# Bismillah · Product Intelligence Platform

> Plataforma de inteligencia de producto construida sobre el grafo de conocimiento de un catálogo maestro mayorista.

![Status](https://img.shields.io/badge/status-MVP-blue) ![Stack](https://img.shields.io/badge/stack-vanilla%20JS%20%2B%20HTML%2FCSS-informational) ![Backend](https://img.shields.io/badge/backend-none-lightgrey) ![Data](https://img.shields.io/badge/data-synthetic%20by%20default-success)

Convierte el grafo de conocimiento de un catálogo maestro (1,094 productos, 14,915 relaciones, 7 tipos de relación) en una herramienta operativa para el equipo comercial: explorar productos, entender su red de relaciones y extraer recomendaciones accionables con gobernanza de confianza.

Generado como primer MVP público con el **DULCE Engineering System**.

## Tabla de contenidos

- [Módulos](#módulos)
- [Perfiles de despliegue](#perfiles-de-despliegue)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Cómo ejecutarlo](#cómo-ejecutarlo)
- [Regenerar el dataset sintético](#regenerar-el-dataset-sintético)
- [Stack](#stack)
- [Documentación](#documentación)
- [Licencia](#licencia)

## Módulos

| Módulo | Descripción |
|---|---|
| **Panorama** | Salud del grafo: KPIs, distribución por tipo, confianza por tipo, mezcla Bienestar/Farma, hubs de conectividad, registro de riesgos. |
| **Explorador** | Búsqueda por nombre/SKU/tags, filtros por universo, familia, audiencia y tipo de relación. |
| **Producto 360** | Ficha con órbita de relaciones (grafo ego interactivo en canvas), relaciones agrupadas por tipo con justificación y confianza. Incluye el panel lateral **AI Sales Copilot**, con sus 5 habilidades planificadas ya implementadas por un Local Response Provider sin IA ni red — **Explicar producto**, **Comparar productos**, **Mejor alternativa**, **Venta cruzada inteligente** (Fase 2) y **Precio y disponibilidad** (Fase 3, servida por datos comerciales reales opcionales — ver "Datos comerciales" abajo). |
| **Motores** | Simulador de recomendación: venta cruzada, sustitución y variantes, con scoring transparente y exclusión de confianza Baja por defecto. |

Los cuatro módulos, todos los KPIs, gráficos, filtros y motores de recomendación funcionan **de forma idéntica** en ambos perfiles de despliegue descritos abajo — la única diferencia entre ellos es de dónde vienen los nombres de producto.

## Perfiles de despliegue

Este repositorio es **público por defecto**: lo que hay en la raíz (`index.html` + `assets/js/data.js`) es el perfil demo, con un dataset 100 % sintético. El catálogo real vive en un segundo perfil que **nunca se commitea**.

| | Raíz del repo (demo) | `/production` |
|---|---|---|
| Dataset | **Sintético** — nombres de producto, marcas, SKUs y tags 100 % ficticios | **Real** — catálogo comercial de la distribuidora |
| Seguro para GitHub público | ✅ Sí — es el perfil por defecto | ❌ **No — nunca** |
| Estado en git | Versionado (`assets/js/data.js` sí se commitea) | **Ignorado por completo** (`/production/` está en `.gitignore`) |
| KPIs, distribución por tipo, confianza, grado, reciprocidad | — | Idénticos al demo |
| Cómo se genera | `node scripts/generate-demo-data.js` a partir de `production/data.js` | Exportado del Excel/BD fuente por el equipo interno |

**Por qué los KPIs son idénticos:** el generador conserva el grafo de relaciones exacto (mismos índices, mismos tipos, misma confianza, misma cantidad de aristas) y solo reemplaza la capa que contenía información real del negocio — nombre de producto, SKU y tags (que incluían marcas/fabricantes reales). La taxonomía de categorías, audiencias y textos de justificación son vocabulario genérico de la industria (p. ej. "Vitamina C", "Belleza", "Inmunidad") y se mantienen igual en ambos perfiles.

⚠️ **Regla de oro: `/production` nunca se commitea.** Está excluido en `.gitignore` como directorio completo, no archivo por archivo, para que sea imposible subirlo por accidente — y no forma parte del historial de git de este repositorio. Si necesitas correr el perfil de producción localmente, usa el scaffold en [`production.example/`](production.example/):

```bash
cp -r production.example production
# luego reemplaza production/data.js.example → production/data.js con tu export real
# (ver production.example/data.js.example para el formato exacto)
mv production/data.js.example production/data.js   # y complétalo con tus datos reales
```

### Datos comerciales (opcional, Fase 3)

`production/commercial-data.js` es un archivo **opcional** y gitignored (mismo tratamiento que `production/data.js`) con precio, stock y estado real por SKU. Si no existe, `CommercialDataProvider` no encuentra nada y el bloque `comercial` del Context Builder queda igual que siempre (`disponible:false`, todo `null`) — nada se rompe.

Se genera con `scripts/import-commercial-data.js` a partir de la salida ya generada por un pipeline comercial externo (Excel → JSON), cruzada por SKU con `production/data.js`:

```bash
node scripts/import-commercial-data.js <ruta-a-products.js-del-pipeline-comercial>
```

Ver [ARCHITECTURE.md](docs/ARCHITECTURE.md#commercial-data-provider-fase-3-paso-1) para el detalle de esa arquitectura. Formato exacto: [`production.example/commercial-data.js.example`](production.example/commercial-data.js.example).

## Estructura del repositorio

SPA de un solo archivo HTML por perfil (vanilla JS + Canvas), sin backend ni build step. La lógica de la aplicación y el sistema de diseño son 100 % compartidos entre perfiles; solo cambia el archivo de datos.

```
.
├── index.html                     # Perfil demo (público, por defecto) — carga assets/js/data.js
├── assets/
│   ├── css/
│   │   └── styles.css             # Sistema de diseño compartido (Space Grotesk / IBM Plex)
│   └── js/
│       ├── app.js                 # Lógica de la aplicación (vistas, búsqueda, motores, canvas, orquestación del Copilot)
│       ├── context-builder.js     # Construye el contexto de producto para el AI Sales Copilot (sin IA, sin red)
│       ├── response-provider-contract.js  # Interfaz común que debe cumplir cualquier proveedor de respuestas (Fase 4)
│       ├── response-provider.js   # Puerto: registro del proveedor de respuestas activo del Copilot (5 habilidades)
│       ├── commercial-data-provider.js  # Adaptador: Context Builder pide datos comerciales por SKU, sin conocer su fuente (Fase 3)
│       ├── providers/
│       │   ├── local-response-provider.js  # Proveedor local (sin IA, sin red) — las 5 habilidades del Copilot, activo hoy
│       │   └── ai-response-provider.js     # Placeholder de proveedor de IA (Fase 4) — cumple el contrato, rechaza toda llamada, inactivo
│       └── data.js                # Dataset SINTÉTICO — es el dato por defecto del repo, versionado
├── production/                    # Perfil real — IGNORADO POR GIT (no existe en el repo clonado)
│   ├── index.html
│   ├── data.js                    # Catálogo real — nunca se commitea
│   └── commercial-data.js         # Datos comerciales reales (opcional) — nunca se commitea
├── production.example/            # Scaffold versionado para reconstruir /production localmente
│   ├── index.html
│   ├── data.js.example            # Plantilla del formato de datos (3 productos de muestra)
│   └── commercial-data.js.example # Plantilla del formato de datos comerciales (1 registro de muestra)
├── scripts/
│   ├── generate-demo-data.js        # Genera assets/js/data.js a partir de production/data.js
│   ├── import-commercial-data.js    # Genera production/commercial-data.js desde el pipeline comercial externo
│   ├── verify-context-builder.js    # QA headless (Node) del Context Builder
│   ├── verify-commercial-data.js    # QA headless (Node) del Commercial Data Provider
│   ├── verify-response-provider.js  # QA headless (Node) de "Explicar producto"
│   ├── verify-compare-products.js   # QA headless (Node) de "Comparar productos"
│   ├── verify-best-alternative.js   # QA headless (Node) de "Mejor alternativa"
│   ├── verify-cross-sell.js         # QA headless (Node) de "Venta cruzada inteligente"
│   ├── verify-price-availability.js # QA headless (Node) de "Precio y disponibilidad"
│   └── verify-ai-provider-abstraction.js # QA headless (Node) del contrato de proveedores y del placeholder de IA (Fase 4)
└── docs/
    ├── PROJECT_BRIEF.md           # Objetivo, dominio, alcance y supuestos del MVP; estado de las Fases 2-4
    ├── ARCHITECTURE.md            # Arquitectura del AI Sales Copilot y de los datos comerciales (Fases 2-4)
    └── QUALITY_REPORT.md          # Resultados de verificación por categoría
```

## Cómo ejecutarlo

No requiere instalación ni dependencias. Sirve el directorio raíz como archivos estáticos:

```bash
# Con Python
python -m http.server 8080

# Con Node
npx serve .
```

- `http://localhost:8080/` → perfil demo (seguro, datos sintéticos), abierto por defecto.
- `http://localhost:8080/production/` → perfil real, solo si reconstruiste `/production` localmente (ver arriba).

> Abrir `index.html` directamente con `file://` también funciona en la mayoría de navegadores, ya que no hay llamadas a APIs externas más allá de Google Fonts (con fallback tipográfico si no hay red).

## Regenerar el dataset sintético

Si el catálogo real (`production/data.js`) cambia, regenera el demo con:

```bash
node scripts/generate-demo-data.js
```

El generador usa una semilla fija, así que el resultado es reproducible y el diff en `assets/js/data.js` queda acotado a lo que realmente cambió en el grafo. Preserva exactamente: cantidad de productos, cantidad de relaciones, tipo y confianza de cada arista, y por lo tanto todos los KPIs de Panorama. Regenera desde cero: nombres de producto, SKUs y tags — usando vocabulario de marcas 100 % ficticio.

## Stack

- HTML5 + CSS3 (sin frameworks)
- JavaScript vanilla (ES6+, `'use strict'`)
- Node.js solo para el script de generación de datos sintéticos (no es una dependencia de runtime de la app)
- Canvas 2D para la visualización de relaciones (órbita de producto)
- Tipografía: Space Grotesk / IBM Plex Sans / IBM Plex Mono (Google Fonts)

## Documentación

- [PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) — objetivo, dominio, modelo de datos, supuestos críticos y estado de las Fases 2 y 3.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — arquitectura y contrato del Context Builder, el Response Provider (incl. cómo se reemplaza el proveedor local por Gemini sin tocar el resto del sistema) y el Commercial Data Provider.
- [QUALITY_REPORT.md](docs/QUALITY_REPORT.md) — verificación funcional, de arquitectura, seguridad y consistencia.

## Licencia

Uso interno. Sin licencia de distribución pública definida todavía. El dataset por defecto de este repositorio es sintético y puede compartirse libremente; el catálogo real del perfil `/production` no debe distribuirse bajo ninguna circunstancia sin autorización explícita del negocio, y no forma parte del historial de este repositorio.
