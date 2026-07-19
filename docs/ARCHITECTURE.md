# ARCHITECTURE — Context Builder (Fase 2, Paso 2)

## Responsabilidad

`assets/js/context-builder.js` recibe un producto (índice o SKU) y devuelve un
objeto JSON-serializable con todo lo que el proyecto sabe hoy sobre ese
producto y su red de relaciones. Es la única responsabilidad del módulo: no
renderiza, no decide qué mostrar en pantalla, no llama a ningún servicio.

Es el primer eslabón de una cadena que, en pasos futuros ya fuera de este
alcance, seguirá con: *Context Builder → formateo de prompt → llamada a un
proveedor de IA → render en el panel AI Sales Copilot*. Este paso entrega
únicamente el primer eslabón.

## Por qué es un módulo independiente

`app.js` ya calcula estructuras equivalentes (`P`, `adj`, `famOf`, `uniOf`)
para dibujar Producto 360, pero están acopladas al ciclo de vida de la UI:
se recalculan una vez al cargar la página, viven en el scope global de
`app.js` y existen para alimentar `renderP360()`. Reutilizarlas habría
significado:

- que el Context Builder solo funcionara si `app.js` ya se cargó y ejecutó
  (orden de `<script>` importa, y ligeramente frágil ante refactors futuros
  de Producto 360);
- que cualquier construcción de contexto quedara *acoplada* a una vista que
  el enunciado de este paso prohíbe explícitamente modificar.

En su lugar, `context-builder.js` recalcula su propio índice de adyacencia a
partir de `DATA.rels` en cada llamada a `build()`. Es un recorrido de ~15k
aristas (el tamaño actual del catálogo), del orden de un milisegundo — un
costo aceptable a cambio de cero acoplamiento con `app.js` o con el DOM. El
módulo puede cargarse antes o después de `app.js`, se puede probar en Node
sin `document`, y un cambio futuro en cómo Producto 360 renderiza no puede
romperlo.

Patrón usado: IIFE que expone un único global, `ContextBuilder`, igual que el
resto del proyecto usa globals de script planos (sin bundler ni ES modules).
Todo lo interno vive en el closure — cero colisión con los identificadores
top-level de `app.js` (`P`, `adj`, `N`, `TYPE_META`, etc.).

## Contrato

```js
ContextBuilder.build(productRef, options?)
// productRef: número (índice, igual semántica que P[i] / p360Current en app.js) o string (SKU)
// options.data: dataset alternativo — para tests; por defecto usa el DATA global
// options.maxPerType: tope de relaciones detalladas por tipo (default 8)
// devuelve: objeto de contexto, o null si el producto no existe
```

Forma del objeto devuelto:

```jsonc
{
  "meta": {
    "schemaVersion": "1.0.0",
    "generadoEn": "2026-...Z",
    "productoIndice": 865
  },
  "producto": {
    "sku": "45471",
    "nombre": "...",
    "universoCodigo": "B",           // "B" | "F" | null
    "universo": "Bienestar",         // "Bienestar" | "Farma" | null
    "familiaCodigo": "B1",           // "B1".."F10" | null
    "subcategoria": "B1.1 Colágeno hidrolizado", // string | null
    "tags": ["colágeno", "..."],
    "audiencias": ["Mujer", "..."]
  },
  "relaciones": {
    "total": 229,                    // conteo real, recalculado del grafo — no copiado de un campo cacheado
    "porTipo": [ { "tipo": "MISMA_CATEGORIA", "cantidad": 46, "confianza": { "alta": 40, "media": 6, "baja": 0 } }, ... ],
    "detalle": [ { "sku": "...", "nombre": "...", "tipo": "...", "confianza": "Alta", "justificacion": "..." }, ... ],
    "detalleLimitadoPorTipo": 8       // aclara que `detalle` está recortado; `porTipo` siempre es el total real
  },
  "comercial": {
    "disponible": false,
    "precio": null,
    "stock": null,
    "margen": null,
    "estado": null,
    "pendienteDe": "Fase 1 — Integración de Datos"
  }
}
```

### Decisiones de diseño relevantes

- **`relaciones.total` se recalcula del grafo, no se copia de `product[3]`
  (`grado`).** Ambos deberían coincidir siempre según los supuestos del
  Brief, pero como el módulo ya recorre `adj[idx]` para todo lo demás, tomar
  el total de esa misma fuente evita que existan dos "verdades" sobre el
  mismo hecho.
- **`detalle` tiene tope por tipo (`maxPerType`, default 8), `porTipo` no.**
  Un producto hub puede tener 229 relaciones; listarlas todas en el detalle
  sería impracticable para lo que sea que consuma este contexto más adelante
  (previsiblemente un prompt). El resumen agregado (`porTipo`) sí es
  completo siempre, así que ningún consumidor pierde la magnitud real, solo
  el listado exhaustivo.
- **`familiaCodigo` se expone, el nombre legible de familia (p. ej. "Colágenos
  y belleza") no.** Ese diccionario (`FAMILY`) hoy vive solo en `app.js`
  como constante de presentación. Duplicarlo aquí habría creado una segunda
  fuente de verdad que puede desalinearse; y moverlo fuera de `app.js` está
  fuera del alcance de este paso ("no modificar Producto 360"). Cualquier
  consumidor que necesite el nombre legible lo resuelve con `familiaCodigo`
  contra `FAMILY`, igual que ya hace Producto 360.
- **`comercial` es un objeto siempre presente, con valores `null`.** No es un
  campo opcional que aparece cuando hay datos — está en el esquema desde
  ahora, con `disponible:false` y `pendienteDe` documentando por qué. Así,
  cuando la Fase 1 entregue precio/stock/margen/estado, el cambio es
  *rellenar* ese bloque (y flipear `disponible`), no *rediseñar* el esquema
  ni migrar a los consumidores que ya lo lean.
- **`resolveIndex` acepta índice o SKU** porque Producto 360 ya usa el índice
  numérico como identidad de trabajo (`p360Current`), pero el SKU es la
  identidad estable de negocio. Ambos caminos producen el mismo contexto
  (verificado en QA).
- **Referencia inválida devuelve `null`, no lanza.** Mismo estilo que el
  resto del proyecto (`searchProducts` devuelve `[]`, no lanza) — un
  producto inexistente es un caso esperado, no un error de programación.

## Fuera de alcance (deliberado)

- No arma el *prompt* de texto que eventualmente se le pasaría a un modelo
  — eso presupone decisiones (idioma del prompt, formato, proveedor) que
  corresponden a la siguiente especificación, no a este paso.
- No se invoca desde ningún sitio todavía: ni Producto 360 ni el panel AI
  Sales Copilot llaman a `ContextBuilder`. El módulo existe, está probado,
  pero permanece "desconectado" hasta que se apruebe el paso que lo
  conecte.
- No incluye caché/memoización de la adyacencia entre llamadas: con el
  tamaño actual del catálogo el recálculo es insignificante, y agregar una
  capa de caché sin una necesidad medida sería complejidad especulativa.

## QA

`scripts/verify-context-builder.js` — smoke test headless en Node (mismo
enfoque que las pruebas de búsqueda/filtros/motores descritas en
`QUALITY_REPORT.md`), sin DOM ni red. Carga `data.js` + `context-builder.js`
en un sandbox de `vm` y verifica:

1. El código fuente no contiene referencias a `fetch`, `XMLHttpRequest`,
   `document`, `window`, ni a `gemini`/`openai`/`anthropic` — guardrail
   estático de las restricciones de este paso.
2. El módulo carga y expone `build()` / `SCHEMA_VERSION`.
3. `build(0)` devuelve la forma esperada y coincide con el dataset.
4. El contexto sobrevive un round-trip `JSON.stringify` → `JSON.parse` sin
   pérdida (garantiza que es serializable de verdad, no solo "parece" un
   POJO).
5. `build(índice)` y `build(sku)` del mismo producto son equivalentes.
6. El bloque `comercial` nunca contiene datos distintos de `null` /
   `disponible:false` hoy.
7. Un producto sin subcategoría (`subcatIdx < 0`) no rompe el builder
   (verificado también contra el dataset real de producción, aunque en la
   práctica ni el dataset sintético ni el real tienen hoy productos en ese
   estado — los NO_CLASIFICADO quedan fuera del grafo fuente, no dentro con
   `-1`).
8. En el producto de mayor grado (229 relaciones), la suma de `porTipo`
   cuadra exactamente con `relaciones.total`, y ningún tipo excede
   `maxPerType` en `detalle`.
9. Referencias inválidas (índice fuera de rango, SKU inexistente) devuelven
   `null`.
10. Llamadas repetidas con el mismo producto son puras — no acumulan estado.

Resultado: **10/10 checks OK**, verificado también manualmente contra
`production/data.js` (1.094 productos reales, misma forma, mismo
comportamiento).

Verificación adicional en navegador: `index.html` con el nuevo
`<script src="assets/js/context-builder.js">` cargado antes de `app.js` —
`ContextBuilder` disponible en consola, Producto 360 y el panel AI Sales
Copilot se renderizan igual que antes de este paso, sin errores de consola.
