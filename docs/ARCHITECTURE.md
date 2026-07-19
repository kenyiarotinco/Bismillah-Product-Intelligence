# ARCHITECTURE — AI Sales Copilot & Commercial Data (Fases 2-4)

Este documento cubre los módulos de datos/lógica que sostienen al AI Sales
Copilot, en el orden en que los atraviesa una petición:

```
Usuario → AI Sales Copilot (panel, app.js) → Context Builder → Response Provider → Respuesta en el panel
                                                    ↑
                                        Commercial Data Provider (Fase 3)
```

- **Context Builder** (Paso 2): construye el contexto de un producto.
- **Response Provider** (Fase 2, Pasos 3-6; Fase 3, Paso 2): a partir de uno
  o más contextos, genera la respuesta de una habilidad concreta del
  Copilot — "Explicar producto" (Paso 3), "Comparar productos" (Paso 4),
  "Mejor alternativa" (Paso 5), "Venta cruzada inteligente" (Paso 6) y
  "Precio y disponibilidad" (Fase 3, Paso 2) — las 5 habilidades
  planificadas del Copilot, completas.
- **Commercial Data Provider** (Fase 3, Paso 1): adaptador que Context
  Builder consulta por SKU para completar el bloque `comercial` con datos
  reales (precio, stock, estado) cuando existen — ver la sección dedicada
  más abajo. Es la única vía por la que un dato comercial entra al
  sistema; "Precio y disponibilidad" (Paso 2) nunca lo consulta
  directamente, solo lee el bloque ya completado en `context.comercial`.

## Context Builder (Fase 2, Paso 2)

### Responsabilidad

`assets/js/context-builder.js` recibe un producto (índice o SKU) y devuelve un
objeto JSON-serializable con todo lo que el proyecto sabe hoy sobre ese
producto y su red de relaciones. Es la única responsabilidad del módulo: no
renderiza, no decide qué mostrar en pantalla, no llama a ningún servicio.

Es el primer eslabón de una cadena que, en pasos futuros ya fuera de este
alcance, seguirá con: *Context Builder → formateo de prompt → llamada a un
proveedor de IA → render en el panel AI Sales Copilot*. Este paso entrega
únicamente el primer eslabón.

### Por qué es un módulo independiente

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

### Contrato

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
    "disponible": false,          // true si CommercialDataProvider tiene registro para este SKU — ver Fase 3, Paso 1
    "precio": null,
    "stock": null,
    "margen": null,                // margen de utilidad real — sigue sin existir en ninguna fuente, ver Fase 3
    "estado": null,
    "priceDifference": null,       // añadido en la Fase 3 — precio lista − precio final; NO es margen
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
  ahora, con `disponible:false` y `pendienteDe` documentando por qué. Esta
  predicción del Paso 2 se cumplió literalmente en la Fase 3, Paso 1: el
  cambio fue *rellenar* ese bloque (y flipear `disponible`) por SKU, sin
  rediseñar el esquema ni migrar a los cuatro consumidores que ya lo leían
  — ver la sección "Commercial Data Provider" más abajo.
- **`resolveIndex` acepta índice o SKU** porque Producto 360 ya usa el índice
  numérico como identidad de trabajo (`p360Current`), pero el SKU es la
  identidad estable de negocio. Ambos caminos producen el mismo contexto
  (verificado en QA).
- **Referencia inválida devuelve `null`, no lanza.** Mismo estilo que el
  resto del proyecto (`searchProducts` devuelve `[]`, no lanza) — un
  producto inexistente es un caso esperado, no un error de programación.

### Fuera de alcance (deliberado, en el Paso 2)

- No arma el *prompt* de texto que eventualmente se le pasaría a un modelo
  — eso presupone decisiones (idioma del prompt, formato, proveedor) que
  corresponden a la siguiente especificación, no a este paso. (Esa pieza
  llegó en el Paso 3 como el Response Provider — ver más abajo.)
- No incluye caché/memoización de la adyacencia entre llamadas: con el
  tamaño actual del catálogo el recálculo es insignificante, y agregar una
  capa de caché sin una necesidad medida sería complejidad especulativa.

### QA — Context Builder

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

## Response Provider (Fase 2, Pasos 3-6; Fase 3, Paso 2)

### Responsabilidad

Dado uno o más contextos que entrega `ContextBuilder.build()`, generar la
respuesta de una habilidad concreta del Copilot. Dos habilidades
implementadas hasta ahora: **Explicar producto** (Paso 3, un contexto →
texto) y **Comparar productos** (Paso 4, dos contextos → similitudes y
diferencias). El módulo no sabe nada de productos, del grafo o de `DATA` —
solo sabe transformar el/los objeto(s) `context` que recibe en la forma que
exige `response-provider.js`. Tampoco decide cuándo se le invoca ni dónde se
pinta la respuesta: eso lo orquesta `app.js` (ver más abajo).

Son dos archivos con responsabilidades distintas, a propósito:

- **`assets/js/response-provider.js`** — el *puerto*: define el contrato y
  un registro (`ResponseProvider.use()` / `.get()`) de cuál proveedor está
  activo. No sabe generar ningún texto por sí mismo.
- **`assets/js/providers/local-response-provider.js`** — la *implementación*
  local de ese contrato. Es un archivo que, en principio, podría borrarse y
  reemplazarse por `providers/gemini-response-provider.js` sin que
  `response-provider.js` cambie una sola línea.

### Dónde vive y por qué ahí

`response-provider.js` se ubica junto a `context-builder.js`, al mismo
nivel (`assets/js/`), porque cumple el mismo rol arquitectónico: es
infraestructura del Copilot, no parte de una vista. `providers/` es una
carpeta aparte porque va a crecer — cuando exista un proveedor Gemini real,
vivirá ahí también, como una alternativa intercambiable al local, nunca como
un reemplazo que se edita en el mismo archivo.

Ninguno de los dos depende de `app.js` ni del DOM. `local-response-provider.js`
depende únicamente de la forma del objeto `context` (el contrato de
`ContextBuilder`), nunca de cómo se construyó. Esto significa que todo el
pipeline Context Builder → Response Provider se puede ejecutar y probar
íntegramente en Node, sin navegador — tal como hace
`scripts/verify-response-provider.js`.

### Dónde vive la orquestación (y por qué ahí sí en app.js)

Alguien tiene que decidir: cuándo se llama a `ContextBuilder.build()`, con
qué opciones, cuándo se le pasa el resultado a `ResponseProvider`, y qué
hacer con la respuesta (mostrarla, mostrar un error, mostrar "cargando").
Esa pieza es UI por definición — vive en `app.js`, junto al resto del panel
del Copilot (`copilotPanelHTML()`, `wireCopilotPanel()`,
`onExplainProductClick()`, desde el Paso 4 también
`onCompareProductsClick()` / `onCompareSearchInput()` /
`onCompareProductBSelected()`, desde el Paso 5 también
`onBestAlternativeClick()`, y desde el Paso 6 también
`onCrossSellClick()`). No se extrajo a un archivo aparte porque, a
diferencia de Context Builder y Response Provider, esta pieza SÍ necesita el
DOM y el estado de Producto 360 (`p360Current`) — no hay nada que ganar
desacoplándola, y el proyecto no usa un framework de componentes que
justifique una capa de "controlador" separada.

Importante: la orquestación actualiza **solo el nodo `.copilot-panel`**
(`refreshCopilotPanel()`, vía `outerHTML` + re-wiring), nunca llama de nuevo
a `renderP360()` completo. Si lo hiciera, cada respuesta del Copilot
volvería a dibujar el canvas de la órbita y perdería el scroll — un efecto
secundario sobre Producto 360 que el enunciado de este paso prohíbe
explícitamente. Esta es la garantía técnica, no solo de intención, de "no
modificar Producto 360".

### Contrato

```js
// response-provider.js — el puerto
ResponseProvider.use(provider)   // registra el proveedor activo; valida que implemente las 5 habilidades del contrato
ResponseProvider.get()           // devuelve el proveedor activo; lanza si no hay ninguno
ResponseProvider.isReady()       // true/false

// Contrato que debe cumplir cualquier proveedor — un método por habilidad:
provider.explainProduct(context) => Promise<{
  skill: 'explain-product',
  source: string,        // 'local' | 'gemini' | ...
  generatedAt: string,   // ISO 8601
  text: string,
}>

provider.compareProducts(contextA, contextB) => Promise<{
  skill: 'compare-products',
  source: string,
  generatedAt: string,
  productos: { a: ProductoResumen, b: ProductoResumen },
  similitudes: string[],
  diferencias: string[],
}>
// ProductoResumen: { sku, nombre, universo, categoria, beneficios[],
//   etiquetas[], relaciones: {total, porTipo} }

provider.bestAlternative(context) => Promise<{
  skill: 'best-alternative',
  source: string,
  generatedAt: string,
  encontrado: boolean,
  alternativa: { sku: string, nombre: string } | null,
  afinidad: 'Alta' | 'Media' | null,
  justificacion: string | null,
  mensaje: string | null,   // presente solo si encontrado === false
}>

provider.crossSell(context) => Promise<{
  skill: 'cross-sell',
  source: string,
  generatedAt: string,
  recomendaciones: Array<{ sku: string, nombre: string, razon: string }>,
  mensaje: string | null,   // presente solo si recomendaciones está vacío
}>

provider.priceAndAvailability(context) => Promise<{
  skill: 'price-availability',
  source: string,
  generatedAt: string,
  disponible: boolean,
  precio: number | null,           // precio final — de context.comercial.precio
  precioLista: number | null,      // derivado: precio + priceDifference
  priceDifference: number | null,  // de context.comercial.priceDifference (NO es margen)
  stock: number | null,
  estado: string | null,
  mensaje: string | null,          // presente solo si disponible === false
}>
```

`context` es exactamente lo que devuelve `ContextBuilder.build()` — ningún
proveedor ve el DOM, el índice de producto ni nada de `app.js`.

### Cómo se conecta hoy (y cómo se desconecta)

Una sola línea en `app.js`, junto a la definición de `COPILOT_SKILLS`:

```js
ResponseProvider.use(LocalResponseProvider);
```

Reemplazar el proveedor local por Gemini el día que se apruebe esa
especificación es, literalmente, cambiar esa línea por:

```js
ResponseProvider.use(GeminiResponseProvider);
```

Nada más en el sistema necesita cambiar. Esto es cierto por tres decisiones
de diseño concretas, no por buena voluntad:

1. **Mismo contrato de entrada.** `GeminiResponseProvider.explainProduct`
   recibiría el mismo objeto `context` que hoy recibe el local — el mismo
   que ya produce `ContextBuilder.build()`. Ninguna parte del sistema que
   arma el contexto necesita saber qué proveedor lo va a consumir.
2. **Mismo contrato de salida.** Ambos proveedores devuelven
   `{skill, source, generatedAt, text}`. La UI (`copilotSkillRowHTML()`,
   `onExplainProductClick()`) solo lee `res.text` y `res.source` — nunca
   asume nada sobre *cómo* se generó ese texto.
3. **Async desde el día uno.** El proveedor local es 100 % síncrono por
   dentro (no hay nada que esperar), pero `explainProduct()` devuelve una
   `Promise` de todas formas. `onExplainProductClick()` ya está escrito como
   `ResponseProvider.get().explainProduct(context).then(...).catch(...)` —
   exactamente la forma que necesitará una llamada de red real a Gemini
   (latencia de cientos de ms, posibilidad de error de red, timeout). El
   cambio de "instantáneo" a "tarda 800 ms y a veces falla" no rompe ni una
   línea del código que ya maneja los estados `loading` / `done` / `error`
   en el panel, porque ese código nunca asumió que la Promise se resolvería
   rápido.

Lo que si tendría que decidirse en la especificación de ese paso futuro (no
en este): manejo de API key / autenticación, límites de tasa, timeout y
reintentos, y qué hacer si Gemini devuelve algo que no cumple el contrato
(`text` vacío, respuesta bloqueada por seguridad, etc.) — nada de eso existe
hoy porque no hay llamada de red que lo necesite.

### Por qué el texto no fabrica nada

`buildText()` en `local-response-provider.js` solo concatena fragmentos que
existen literalmente en el `context`:

- Nombre, universo, subcategoría, tags, audiencias → copiados tal cual de
  `context.producto`.
- "Beneficios asociados" → **no** es un campo del contexto. Se extrae con
  una expresión regular (`/'([^']+)'/`) de las justificaciones de las
  relaciones `MISMO_BENEFICIO` que ya vienen en `relaciones.detalle` — el
  100 % de esas 21 justificaciones únicas en el catálogo (sintético y real)
  sigue el patrón *"Ambos aportan al beneficio 'X' desde subcategorías
  distintas"*, verificado en `scripts/verify-response-provider.js` antes de
  escribir esta lógica. No es una heurística arriesgada: es leer un dato que
  ya estaba ahí, en texto plano.
- El resumen de relaciones y el "ejemplo concreto" (`pickExample`) usan
  `relaciones.porTipo` y `relaciones.detalle` sin modificarlos.
- Si `comercial.disponible` es `false` (siempre, hoy), el texto lo dice
  explícitamente en vez de omitirlo en silencio — es más honesto que un
  Copilot que simplemente no menciona precio, dejando al vendedor sin saber
  si el dato no existe o si el Copilot lo olvidó.

`TYPE_LABELS`, el pequeño diccionario de rótulos en español dentro del
proveedor (`"MISMO_BENEFICIO" → "mismo beneficio"`), es la misma clase de
decisión que `familiaCodigo` en el Context Builder (Paso 2): duplica 7
entradas estables que también existen como `TYPE_META` en `app.js`, a
propósito, para que el proveedor no dependa de `app.js` en absoluto. Es
vocabulario de presentación, no un dato de negocio — el candidato correcto
para vivir junto a quien lo usa, no en un módulo de datos compartido.

### Por qué la respuesta se guarda en estado de módulo (`copilotExplain`)

Sigue exactamente el patrón que ya usaba `p360Expanded` para "mostrar más"
en los grupos de relaciones: una variable a nivel de módulo en `app.js`, que
se reinicia en `openProduct()` (producto nuevo → explicación anterior ya no
aplica) y sobrevive a los re-renders parciales de Producto 360 mientras el
producto no cambie — por ejemplo, expandir un grupo de relaciones no borra
la respuesta que el Copilot ya generó. Se verificó manualmente en navegador.

### Fuera de alcance (deliberado, en el Paso 3)

- La única habilidad restante (Precio y disponibilidad) sigue en
  "Próximamente", sin `data-skill` ni listener — depende de la Fase 1 de
  Integración de Datos. El contrato de `ResponseProvider` solo exigía
  `explainProduct` en este paso; se amplió con `compareProducts` en el
  Paso 4, con `bestAlternative` en el Paso 5 y con `crossSell` en el
  Paso 6 (ver más abajo).
- No hay proveedor Gemini, ni configuración de API key, ni ningún código de
  red — ver la sección anterior sobre qué queda pendiente para ese paso.
- No hay caché de respuestas entre productos ni entre sesiones: cada clic
  reconstruye el contexto y regenera el texto. Con un proveedor local
  instantáneo no hay necesidad real de cachear; puede revisarse cuando el
  costo (latencia o cuota de API) de un proveedor real lo justifique.

### QA — Explicar producto

`scripts/verify-response-provider.js` — mismo enfoque headless que el del
Context Builder: carga `data.js` + `context-builder.js` +
`response-provider.js` + `providers/local-response-provider.js` en un
sandbox de Node, sin DOM ni red, y verifica:

1. Guardrail estático sobre el **código ejecutable** (no los comentarios) de
   los cuatro archivos del paso: cero referencias a `fetch`, `XMLHttpRequest`,
   `document`, `window`, `gemini`, `openai`, `anthropic`. (Los comentarios sí
   mencionan "Gemini" a propósito, como documentación de este mismo diseño
   de intercambiabilidad — el check ignora comentarios para no confundir
   documentación con integración real.)
2. `ResponseProvider.use()` exige el contrato (rechaza un proveedor sin
   `explainProduct`) y `isReady()` refleja el estado correctamente.
3. `LocalResponseProvider` se registra y `get()` devuelve exactamente ese
   proveedor.
4. `explainProduct(context)` devuelve la forma exacta del contrato,
   incluyendo que es una `Promise`.
5. El texto nunca contiene lo que parecería un precio inventado, y siempre
   menciona honestamente que los datos comerciales están pendientes de la
   Fase 1.
6. Cada beneficio citado en el texto se verifica contra las justificaciones
   reales de ese producto — no basta con que el formato "se vea bien", se
   comprueba que cada palabra citada exista en el dato fuente.
7. `build(índice)` + `explainProduct` y `build(sku)` + `explainProduct` del
   mismo producto producen exactamente el mismo texto.
8. Un contexto inválido (`null`) rechaza la Promise en vez de lanzar de
   forma síncrona o devolver algo inservible.
9. **Los 1.094 productos del catálogo**, uno por uno, generan texto sin
   lanzar ninguna excepción — no solo un puñado de casos de muestra.

Resultado: **9/9 checks OK**. Se volvió a correr
`scripts/verify-context-builder.js` en el mismo momento — **10/10 checks
OK** — para confirmar que este paso no introdujo ninguna regresión en el
Paso 2.

Verificación adicional en navegador: producto con relaciones `SUSTITUYE`,
`COMPLEMENTA` y `MISMO_BENEFICIO` (229 relaciones) y producto con solo
`MISMA_CATEGORIA`/`MISMO_BENEFICIO` (10 relaciones, universo Farma) — clic
real en "Explicar producto" en ambos, texto generado y mostrado
correctamente en el panel. Estados `loading` → `done` verificados, estado
`error` verificado forzando un proveedor que rechaza la Promise. Cambiar de
producto reinicia el estado. "Mostrar más" en un grupo de relaciones no
borra la respuesta ya generada. Layout responsive (375 px) verificado con
la respuesta visible. Sin errores de consola en ningún caso. Habilidades
2–5 permanecen visualmente idénticas a como quedaron aprobadas en el Paso 1
("Próximamente", sin interacción).

## Comparar productos (Fase 2, Paso 4)

### Por qué vive en el mismo archivo, no en un `CompareProductsProvider` aparte

La primera versión de este paso creó un archivo independiente
(`providers/compare-products-provider.js`) para el algoritmo de comparación.
Se descartó y el algoritmo se movió dentro de
`providers/local-response-provider.js`, junto a `explainProduct`, por
indicación explícita de la especificación: *"Implementar la funcionalidad en
LocalResponseProvider"* + *"No duplicar lógica"*. Un archivo aparte habría
obligado a elegir entre dos malas opciones: duplicar el vocabulario de
rótulos (`TYPE_LABELS`) y la extracción de beneficios
(`extractQuoted`/`collectBenefits`) que `explainProduct` ya tiene, o acoplar
el nuevo archivo a los internos de `local-response-provider.js`. Con todo en
el mismo archivo, `compareProducts()` reutiliza directamente esas mismas
funciones — cero duplicación, cero acoplamiento nuevo.

`compareProducts(contextA, contextB)` es, igual que `explainProduct`, una
función que solo conoce la forma del objeto `context` — nunca llama a
`ContextBuilder` ni sabe que existe. Construir los dos contextos sigue
siendo responsabilidad exclusiva de la orquestación en `app.js`
(`onCompareProductBSelected()`), exactamente el mismo reparto de
responsabilidades que ya regía para "Explicar producto".

### Quién es el Producto A y quién el Producto B

Producto A es siempre `p360Current` — el producto que Producto 360 ya tiene
abierto. No existe un selector aparte para "elegir Producto A": Producto 360
**es** ese selector, ya reutilizado tal cual (nada nuevo que aprender, nada
que duplique su buscador). Producto B se elige con un campo de búsqueda
propio del Copilot que aparece al abrir la tarjeta "Comparar productos",
reutilizando la función `searchProducts()` que ya usa la búsqueda global de
la topbar — no se reimplementó ninguna lógica de búsqueda.

### Por qué el buscador de Producto B actualiza solo su propio contenedor

`refreshCopilotPanel()` reemplaza el panel completo vía `outerHTML` — barato
y suficiente para transiciones discretas (clic en una tarjeta, clic en un
resultado). Pero llamarlo en cada tecla del buscador destruiría el
`<input>` en cada pulsación y el usuario perdería el foco y el cursor. Por
eso `onCompareSearchInput()` **no** llama a `refreshCopilotPanel()`: escribe
directamente en `#compare-b-results` y vuelve a enganchar solo los ítems
nuevos (`wireCompareResultItems()`). Es el mismo patrón que ya usa la
búsqueda global del topbar (`gsIn` / `gsDrop` en `app.js`, sin modificar),
aplicado de forma independiente al buscador del Copilot.

### Cómo se detecta una relación directa real entre A y B

`ContextBuilder.build()` limita `relaciones.detalle` a `maxPerType` por tipo
(8 por defecto) para no sobrecargar el contexto. Para "Comparar productos"
eso no basta: si el Producto B es un vecino real de A pero cae fuera de esa
muestra recortada, la comparación diría —incorrectamente— que no hay
relación directa. La orquestación en `app.js` resuelve esto pidiendo ambos
contextos con `COMPARE_MAX_PER_TYPE = 300`, mayor que el grado máximo
conocido del catálogo actual (229), así que para cualquier producto de hoy
`relaciones.detalle` contiene **todas** sus relaciones de cada tipo, no solo
una muestra. `findDirectRelation()` entonces busca honestamente si el SKU de
B aparece en el detalle de A (o viceversa) — un hecho verificable, no una
inferencia.

### Qué compara y qué NO inventa

Todo sale de campos que `ContextBuilder` ya expone para cada producto por
separado — nada se computa a partir de datos externos a los dos contextos:

- **Universo, subcategoría**: comparación directa de `producto.universo` /
  `producto.subcategoria`.
- **Beneficios**: mismo mecanismo que `explainProduct` (extracción de
  justificaciones `MISMO_BENEFICIO`) aplicado a cada producto por separado;
  similitudes = intersección, diferencias = beneficios exclusivos de cada
  uno.
- **Etiquetas**: intersección de `producto.tags`.
- **Relaciones**: se compara el volumen total (`relaciones.total`) y se
  reporta como diferencia solo si la brecha es grande (≥10) para no listar
  ruido en productos con volúmenes similares; y se reporta la relación
  directa real entre A y B si existe (ver arriba).

Si dos productos no comparten nada de lo anterior, `similitudes` queda como
un arreglo vacío y el panel lo muestra honestamente ("Sin hallazgos en esta
categoría") en vez de forzar una similitud que no existe — verificado en
navegador comparando un antibiótico (Farma) contra un colágeno (Bienestar).

*Nota de alcance:* la especificación original de este paso mencionaba
también una "conclusión/recomendación comercial" sintetizada. La
especificación final, más acotada, solo exige similitudes y diferencias —
por disciplina de alcance ("Implementa únicamente este alcance") esa pieza
no se construyó en este paso. Los datos para hacerlo (relación directa,
tipo `SUSTITUYE`/`COMPLEMENTA`/`VARIANTE`, beneficios en común) ya están
disponibles en el resultado de `compareProducts()`; sería una extensión
aditiva menor si se aprueba en un paso futuro.

### Fuera de alcance (deliberado, en el Paso 4)

- Sin recomendación/conclusión comercial sintetizada (ver nota de alcance
  arriba).
- Sin comparación de precio/stock/margen/estado — el bloque `comercial` del
  Context Builder sigue en `null` (Fase 1 de Integración de Datos pendiente).
- El buscador de Producto B no excluye productos ya descartados en una
  comparación anterior ni recuerda comparaciones previas entre sesiones —
  cada comparación es independiente, sin historial.

### QA — Comparar productos

`scripts/verify-compare-products.js` — mismo enfoque headless que los pasos
anteriores: carga `data.js` + `context-builder.js` + `response-provider.js`
+ `providers/local-response-provider.js` en un sandbox de Node, sin DOM ni
red, y verifica:

1. Guardrail estático sobre código ejecutable (no comentarios) de
   `response-provider.js` y `local-response-provider.js`: cero referencias a
   `fetch`, `XMLHttpRequest`, `document`, `window`, `gemini`, `openai`,
   `anthropic`.
2. `ResponseProvider.use()` ahora exige **también** `compareProducts` — un
   proveedor que solo implemente `explainProduct` es rechazado.
3. `compareProducts(contextA, contextB)` devuelve la forma exacta del
   contrato, y los SKUs de `productos.a`/`productos.b` corresponden
   exactamente a los contextos originales (no se mezclan ni se invierten).
4. Se usan dos `ContextBuilder.build()` genuinamente independientes
   (índices y SKUs distintos verificados explícitamente).
5. Dos productos de la misma subcategoría producen la similitud de
   subcategoría explícita en el texto.
6. Dos productos de subcategorías distintas producen al menos una
   diferencia.
7. Dos productos con una arista real en el grafo (probado con el producto
   de mayor grado del catálogo y uno de sus vecinos reales) producen la
   similitud de "relación directa".
8. Un contexto inválido (`null`) rechaza la Promise en vez de lanzar de
   forma síncrona.
9. `explainProduct` sigue funcionando exactamente igual tras ampliar el
   contrato — regresión verificada explícitamente dentro de este mismo
   script, además de re-correr `verify-response-provider.js` completo.
10. **1.093 pares consecutivos** de todo el catálogo (`i` con `i+1`, para
    cada `i`) generan una comparación sin lanzar ninguna excepción.

Resultado: **10/10 checks OK**. Se volvieron a correr
`scripts/verify-context-builder.js` (**10/10**) y
`scripts/verify-response-provider.js` (**9/9**) en el mismo momento — cero
regresión sobre los Pasos 2 y 3.

Verificación adicional en navegador: flujo completo clic → buscar → elegir
Producto B → comparación renderizada, probado con dos productos de la misma
familia (colágenos, similitudes ricas incluyendo relación directa real) y
con dos productos sin ninguna relación entre sí (antibiótico Farma vs.
colágeno Bienestar — similitudes vacías mostradas honestamente, cinco
diferencias concretas). Guardas verificadas: comparar un producto consigo
mismo muestra un error amigable sin llegar a construir contexto; buscar un
término sin resultados muestra el estado vacío correcto. El buscador
mantiene el foco mientras se escribe (actualización dirigida, no
re-render del panel completo). "Comparar con otro producto" reinicia
correctamente al estado de búsqueda. "Explicar producto" verificado
funcionando en paralelo sin interferencia de estado. Cambiar de producto
reinicia ambas habilidades. Responsive (375 px) verificado con una
comparación completa visible. Sin errores de consola en ningún caso.
Habilidades 3–5 permanecen visualmente idénticas a como quedaron aprobadas
en el Paso 1.

## Mejor alternativa (Fase 2, Paso 5)

### Por qué usa un solo contexto (no dos, a diferencia de Comparar productos)

A diferencia de "Comparar productos", que necesita el contexto de dos
productos elegidos independientemente por el usuario, "Mejor alternativa"
solo necesita el contexto del producto que ya está abierto en Producto 360:
el candidato a sustituto y su justificación **ya vienen incluidos** en ese
mismo contexto, dentro de `relaciones.detalle` (las entradas con
`tipo === 'SUSTITUYE'` traen `sku`, `nombre`, `confianza` y `justificacion`
del candidato). No hace falta una segunda llamada a `ContextBuilder.build()`
para saber cuál es el mejor sustituto ni por qué — el grafo ya lo dice.

Esto también respeta al pie de la letra la Technical Specification de este
paso ("reutilizando Context Builder para obtener el contexto del producto
actual", en singular) y evita reabrir la tensión que sí existe en Comparar
Productos entre "quién construye contextos" (la orquestación en `app.js`) y
"quién decide cuál es el mejor candidato" (el proveedor): aquí no hace falta
resolver esa tensión porque no hay un segundo contexto que construir.

### Flujo, calcado de "Explicar producto" (no de "Comparar productos")

La UI Specification pide que la respuesta se obtenga *automáticamente* al
hacer clic en la tarjeta, sin pasos intermedios — a diferencia de "Comparar
productos", que necesita que el usuario elija un segundo producto. Por eso
`onBestAlternativeClick()` reutiliza exactamente la forma de
`onExplainProductClick()` (clic → `loading` → un único
`ContextBuilder.build()` → `ResponseProvider.get().bestAlternative(context)`
→ `done`/`error`) y no la de `onCompareProductsClick()` (que necesita un
estado `picking` intermedio con buscador). Mismo patrón que ya existía,
aplicado a la habilidad que realmente lo necesita — no se inventó nada
nuevo.

### Cómo se elige "el mejor" sustituto, y por qué eso no es una nueva heurística

`relaciones.detalle` ya llega ordenado con confianza Alta antes que Media
antes que Baja (`ContextBuilder.buildDetail`, Paso 2). `bestAlternative`
filtra las entradas `SUSTITUYE` excluyendo confianza Baja y toma la
primera — que, por ese orden ya garantizado, es la de mayor confianza
disponible. Excluir Baja no es una regla inventada para este paso: es la
política R-PIG-04 (*"aristas de confianza Baja quedan fuera de los motores
por defecto"*) que el proyecto ya aplica en Panorama y en el motor de
"Sustitución" de Motores — aplicarla aquí es consistencia con una decisión
de negocio ya tomada, no una heurística nueva. `app.js` pide el contexto con
`COMPARE_MAX_PER_TYPE` (el mismo valor ya usado por Comparar Productos, no
uno nuevo) para asegurarse de ver todas las relaciones SUSTITUYE del
producto, no solo una muestra recortada.

Si el único/los únicos candidatos son de confianza Baja, o no hay ninguna
relación SUSTITUYE, `bestAlternative` no fuerza una recomendación débil:
devuelve `encontrado: false` con un mensaje honesto — el mismo principio ya
aplicado en "Comparar productos" cuando dos productos no comparten nada
("Sin hallazgos en esta categoría").

### De dónde sale cada parte de la justificación

Todo proviene del contexto del producto actual, sin inventar nada:

- **Candidato, afinidad y motivo base**: `sku`/`nombre`/`confianza`/
  `justificacion` de la entrada `SUSTITUYE` elegida — texto real del
  catálogo (p. ej. *"Equivalentes genéricos (EQ-018 Levotiroxina 100MG);
  distinto laboratorio"*).
- **Categoría**: `producto.subcategoria` del producto actual.
- **Beneficios**: `collectBenefits(relaciones.detalle)` — la misma función
  que ya usa `explainProduct`, sin duplicarla.
- **Etiquetas**: `producto.tags` del producto actual.
- **"Nivel de afinidad"** (UI Specification): es literalmente el campo
  `confianza` de la relación SUSTITUYE elegida (`Alta` o `Media`) — el
  mismo concepto de confianza que ya se usa en todo el resto de la
  aplicación, sin inventar una escala nueva.

*Nota de alcance:* la justificación se basa en los datos del producto
**actual**, no en una comparación bilateral con los propios beneficios/
etiquetas del candidato (eso habría requerido un segundo
`ContextBuilder.build()`, la ruta que se descartó — ver arriba). El texto
real de la relación SUSTITUYE (p. ej. *"mismo ingrediente... misma
subcategoría, laboratorio alternativo"*) ya suele cubrir esa comparación de
forma implícita. Si en un paso futuro se pide una comparación explícita
candidato-vs-producto, el patrón de dos contextos de "Comparar productos"
ya está disponible para reutilizar.

### Reutilización de UI: el chip de afinidad no necesitó CSS nuevo

"Mostrar el nivel de afinidad" se renderiza con la misma clase `.chip
.conf0/.conf1` que ya usan las relaciones de Producto 360 y de "Comparar
productos" — resuelta con `CONF_META`, el mismo diccionario que ya existe
en `app.js` para esa taxonomía de confianza. El único CSS nuevo de este
paso son dos reglas (`.bestalt-pick`, `.bestalt-nm`) para el layout del
nombre del candidato; el indicador de confianza en sí es 100 % Design
System existente.

### Fuera de alcance (deliberado, en el Paso 5)

- Sin comparación bilateral candidato-vs-producto (ver nota de alcance
  arriba).
- Sin Venta cruzada (explícitamente fuera de alcance en la especificación
  de este paso) ni Precio/Stock/Margen/Estado.
- Sin desempate adicional entre dos candidatos de la misma confianza más
  allá del orden que ya entrega `ContextBuilder` — no había una señal real
  adicional disponible sin fabricar un criterio.

### QA — Mejor alternativa

`scripts/verify-best-alternative.js` — mismo enfoque headless que los pasos
anteriores: carga `data.js` + `context-builder.js` + `response-provider.js`
+ `providers/local-response-provider.js` en un sandbox de Node, sin DOM ni
red, y verifica:

1. Guardrail estático sobre código ejecutable (no comentarios): cero
   referencias a `fetch`, `XMLHttpRequest`, `document`, `window`, `gemini`,
   `openai`, `anthropic`.
2. `ResponseProvider.use()` ahora exige **también** `bestAlternative` — un
   proveedor sin ese método es rechazado.
3. Un producto sin relaciones `SUSTITUYE` (verificado con un índice real del
   catálogo) devuelve `encontrado: false` con mensaje honesto.
4. Un producto cuyos únicos sustitutos son de confianza Baja también
   devuelve `encontrado: false` (política R-PIG-04 verificada, no solo
   documentada).
5. Un producto con un sustituto de confianza Alta lo recomienda con
   `afinidad: 'Alta'`, y el `sku` recomendado corresponde exactamente a esa
   relación real (no a otra).
6. Un producto con sustitutos solo de confianza Media (sin ninguno Alta)
   lo recomienda con `afinidad: 'Media'`.
7. La justificación menciona la subcategoría y las etiquetas reales del
   producto cuando existen — no texto genérico.
8. Un contexto inválido (`null`) rechaza la Promise en vez de lanzar de
   forma síncrona.
9. `explainProduct` y `compareProducts` siguen funcionando exactamente
   igual tras ampliar el contrato con `bestAlternative`.
10. **Los 1.094 productos del catálogo**, uno por uno: nunca se recomienda
    un sustituto de confianza Baja, nunca se devuelve una alternativa sin
    `sku`, y nunca hay inconsistencia entre `encontrado` y los campos
    `alternativa`/`afinidad`.

Resultado: **10/10 checks OK**. Se volvieron a correr
`scripts/verify-context-builder.js` (**10/10**),
`scripts/verify-response-provider.js` (**9/9**) y
`scripts/verify-compare-products.js` (**10/10**) en el mismo momento — cero
regresión sobre los Pasos 2, 3 y 4.

Verificación adicional en navegador: producto Farma con un sustituto de
confianza Alta (chip "Afinidad Alta" en verde, justificación completa con
subcategoría/beneficios/etiquetas reales) y producto sin ningún sustituto
elegible (mensaje honesto, sin forzar una recomendación). "Explicar
producto" y "Mejor alternativa" verificados funcionando en paralelo sin
interferencia de estado. Cambiar de producto reinicia las tres habilidades.
Responsive (375 px) verificado con una recomendación de confianza Media
visible, chip ámbar renderizado correctamente. Sin errores de consola en
ningún caso. Habilidades 3 y 5 permanecen visualmente idénticas a como
quedaron aprobadas en el Paso 1.

## Venta cruzada inteligente (Fase 2, Paso 6)

### Mismo patrón que "Mejor alternativa": un solo contexto, disparo automático

Igual que "Mejor alternativa" y a diferencia de "Comparar productos", los
candidatos de venta cruzada y sus justificaciones ya vienen incluidos en
`relaciones.detalle` del contexto del producto actual — no hace falta un
segundo `ContextBuilder.build()` por candidato. `onCrossSellClick()` es,
línea por línea, la misma forma que `onBestAlternativeClick()`: clic →
`loading` → un único `ContextBuilder.build(p360Current, { maxPerType:
COMPARE_MAX_PER_TYPE })` → `ResponseProvider.get().crossSell(context)` →
`done`/`error`. No se inventó un patrón nuevo para este paso: se reutilizó
el que ya existía para la habilidad más parecida.

### El criterio de negocio ya existe — no se duplica su código, se reaplica

El motor de "Venta cruzada" en Motores (`engineRecos()`, pestaña `cross`,
`app.js`) ya resolvió esta pregunta: qué tipos de relación cuentan para
venta cruzada y cuánto pesa cada uno.

```js
// app.js — ya existente, sin tocar
const CROSS_TYPE_W = {4:3.0, 1:2.0, 5:1.5, 2:1.0};  // COMPLEMENTA, MISMO_BENEFICIO, MISMA_AUDIENCIA, MISMO_INGREDIENTE
const CONF_W = [1.0, 0.6, 0.25];
```

`local-response-provider.js` no puede *importar* estas constantes — son
internas de `app.js`, y depender de ellas rompería la independencia del
proveedor respecto de `app.js` que se viene sosteniendo desde el Paso 2. En
su lugar, `crossSellWeight()` reexpresa el mismo criterio con sus propias
constantes (`CROSS_SELL_TYPE_WEIGHT`, `CROSS_SELL_CONF_WEIGHT`), usando los
mismos nombres de tipo (`COMPLEMENTA`, `MISMO_BENEFICIO`, etc.) que ya
expone `ContextBuilder`, y con Baja excluida directamente en el diccionario
de pesos en vez de un `if` aparte — una forma distinta de aplicar la misma
regla de negocio, no una regla nueva. Es la tercera vez que este proyecto
toma esta decisión (`familiaCodigo` en el Paso 2, `TYPE_LABELS` en el
Paso 3, y ahora los pesos de venta cruzada): mantener al proveedor
desacoplado de `app.js` vale más que ahorrarse siete líneas de constantes
duplicadas.

### Cómo se agregan y ordenan las recomendaciones

A diferencia de "Mejor alternativa" (un solo ganador), aquí un mismo
producto candidato puede aparecer conectado al producto actual por **más
de una** relación elegible a la vez (p. ej. `COMPLEMENTA` y
`MISMO_BENEFICIO` simultáneamente). `buildCrossSell()` agrupa por SKU del
candidato en un `Map`, sumando el peso de cada relación elegible que
comparten — un candidato con dos señales reales pesa más que uno con una
sola, y eso se refleja directamente en su posición en la lista. El
desempate (mismo score) usa primero la cantidad de señales distintas y
luego el nombre alfabético — determinista, sin fabricar un criterio nuevo
para romper empates.

La razón mostrada por candidato cita la relación de **mayor peso** entre
todas las que aportó (no la primera que aparece en `relaciones.detalle`,
que sigue el orden de `ContextBuilder`, no el de relevancia para venta
cruzada) y, si hay señales adicionales, las menciona en una segunda frase
("También comparte: ..."). Se limita a 5 recomendaciones
(`CROSS_SELL_MAX_RESULTS`) — suficiente para una lista útil en un panel
lateral de 340px sin abrumar, mostrando que las recomendaciones "están
ordenadas por relevancia" (criterio de aceptación) de forma visible, no
solo internamente.

### Qué pasa si no hay ningún candidato elegible

Mismo principio ya aplicado en "Mejor alternativa" y "Comparar productos":
si ningún producto está conectado al actual por COMPLEMENTA,
MISMO_BENEFICIO, MISMA_AUDIENCIA o MISMO_INGREDIENTE con confianza
suficiente, `crossSell` devuelve `recomendaciones: []` con un `mensaje`
honesto — nunca una lista vacía sin explicación, y nunca un candidato
forzado solo para no devolver nada.

### Fuera de alcance (deliberado, en el Paso 6)

- Sin Precio/Stock/Margen/Estado en la justificación — el bloque
  `comercial` del Context Builder sigue en `null`.
- Tope fijo de 5 recomendaciones, no configurable desde la UI — no había un
  requisito que lo pidiera, y un tope fijo es más simple que exponer un
  control nuevo para algo no solicitado.
- No se reutilizó el candidato de "Mejor alternativa" (SUSTITUYE) como
  señal de venta cruzada — son conceptualmente opuestos (sustituir vs.
  complementar), y el motor de Motores tampoco los mezcla.

### QA — Venta cruzada inteligente

`scripts/verify-cross-sell.js` — mismo enfoque headless que los pasos
anteriores: carga `data.js` + `context-builder.js` + `response-provider.js`
+ `providers/local-response-provider.js` en un sandbox de Node, sin DOM ni
red, y verifica:

1. Guardrail estático sobre código ejecutable (no comentarios): cero
   referencias a `fetch`, `XMLHttpRequest`, `document`, `window`, `gemini`,
   `openai`, `anthropic`.
2. `ResponseProvider.use()` ahora exige **también** `crossSell` — un
   proveedor sin ese método es rechazado.
3. Un producto sin relaciones elegibles (verificado con un índice real del
   catálogo que sí tiene otras relaciones, para confirmar que no es un nodo
   aislado) devuelve una lista vacía con mensaje honesto.
4. Un producto con relaciones elegibles devuelve recomendaciones reales,
   verificablemente ordenadas por score descendente (recalculado de forma
   independiente en el test a partir de los datos crudos del contexto), con
   `sku` y `razon` en cada una, acotadas a 5.
5. Ninguna razón cita jamás una relación de confianza Baja.
6. Un candidato con varias relaciones elegibles distintas (probado con un
   producto real con 3 tipos elegibles) queda reflejado como tal en su
   razón ("También comparte").
7. La razón del primer recomendado incluye el texto real de al menos una
   de sus relaciones reales con el producto actual — no texto genérico.
8. Un contexto inválido (`null`) rechaza la Promise en vez de lanzar de
   forma síncrona.
9. `explainProduct`, `compareProducts` y `bestAlternative` siguen
   funcionando exactamente igual tras ampliar el contrato con `crossSell`.
10. **Los 1.094 productos del catálogo**, uno por uno: la lista nunca supera
    5 elementos y nunca queda vacía sin `mensaje`.

Resultado: **10/10 checks OK**. Se volvieron a correr
`scripts/verify-context-builder.js` (**10/10**),
`scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**) y
`scripts/verify-best-alternative.js` (**10/10**) en el mismo momento — cero
regresión sobre los Pasos 2, 3, 4 y 5.

Verificación adicional en navegador: producto con 3 tipos de relación
elegibles (lista de 5 recomendaciones rankeadas, primera razón combinando
COMPLEMENTA + MISMO_BENEFICIO vía "También comparte") y producto sin
candidatos elegibles (mensaje honesto). Las cuatro habilidades
—"Explicar producto", "Comparar productos" (implícito, sin regresión),
"Mejor alternativa" y "Venta cruzada"— verificadas coexistiendo sin
interferencia de estado. Cambiar de producto reinicia las cuatro. Responsive
(375 px) verificado con la lista completa de 5 recomendaciones visible. Sin
errores de consola en ningún caso. La habilidad restante (Precio y
disponibilidad) permanece visualmente idéntica a como quedó aprobada en el
Paso 1.

## Commercial Data Provider (Fase 3, Paso 1)

### Responsabilidad

Completar, con datos reales, el bloque `comercial` que `ContextBuilder.build()`
ya devolvía desde el Paso 2 (hasta ahora, siempre en `null`). No implementa
ninguna habilidad nueva del Copilot, no toca la UI, no modifica ninguna de
las cuatro habilidades existentes — es exclusivamente infraestructura de
datos, consistente con el alcance aprobado de este paso.

### El pipeline externo (analizado, no modificado)

Existe, fuera de este repositorio, un pipeline comercial ya funcional y
estable (un dashboard ejecutivo independiente, "Bismillah Digital Twin
Comercial") con su propio flujo:

```
Excel fuente (catálogo comercial real)
        │  python tools/build_data.py <excel>
        ▼
data/products.js  →  window.BISMILLAH_DATA = { metadata, products[] }
```

Cada producto de esa salida trae, entre otros campos: `code` (identificador
del producto), `finalPrice`/`listPrice` (precios), `stockTotal` (stock),
`stockStatus` (estado de inventario, calculado por umbrales de stock) y
`marginGap` (`listPrice − finalPrice`).

Este paso **no toca ni reemplaza** ese pipeline (`build_data.py` y su paso
de empaquetado siguen siendo, exactamente como antes, la única fuente de
verdad de `data/products.js`). Solo se verificó y se documenta cómo
funciona, y se consume su salida ya generada, tal como llega.

**Join verificado con datos reales:** el campo `code` de esa fuente coincide
exactamente (mismo número, mismo nombre de producto) con el `sku` real de
`production/data.js` de este proyecto — confirmado por muestreo antes de
implementar y, de forma exhaustiva, en la importación real: **1.094/1.094**
productos del catálogo de este proyecto tienen registro comercial
correspondiente.

### Separación de responsabilidades: dos capas, cada una con una sola preocupación

1. **`scripts/import-commercial-data.js`** (Node, se ejecuta manualmente,
   igual que `generate-demo-data.js`) — la única pieza del sistema que
   conoce la forma cruda de la fuente externa (`code`, `finalPrice`,
   `stockTotal`, `stockStatus`, `marginGap`). Lee el `data/products.js` ya
   generado por el pipeline externo, lo cruza por SKU contra
   `production/data.js`, y escribe `production/commercial-data.js` ya en
   la forma mínima y limpia que este proyecto necesita:
   ```js
   window.COMMERCIAL_DATA = {
     meta: { generatedAt, sourceRowCount, skusSinCode, coverage },
     bySku: { "<sku>": { precio, stock, estado, priceDifference }, ... },
   };
   ```
   Uso: `node scripts/import-commercial-data.js <ruta-a-products.js-del-pipeline-comercial>`.

2. **`assets/js/commercial-data-provider.js`** (navegador) — no sabe nada
   de la fuente externa ni de cómo se generó `COMMERCIAL_DATA`; solo sabe
   leer ese global ya normalizado y exponer `CommercialDataProvider.getBySku(sku)`.
   Si `COMMERCIAL_DATA` no está cargado (perfil demo público, o el archivo
   gitignored aún no se generó localmente), `getBySku()` devuelve `null`
   para cualquier SKU.

`Context Builder` solo conoce la capa 2 — nunca lee `window.COMMERCIAL_DATA`
directamente, nunca conoce `code`/`finalPrice`/`marginGap`. Esto es lo que
pedía explícitamente el criterio de diseño aprobado ("Context Builder solo
debe solicitar información por SKU"): si mañana la fuente comercial cambia
de forma completamente (otro Excel, otro pipeline, incluso otro negocio),
solo cambia el script de importación — `commercial-data-provider.js` y
`context-builder.js` no se enteran.

### Por qué `priceDifference` y no `margen`

`marginGap` en la fuente es `listPrice − finalPrice`: cuánto se descontó
respecto al precio de lista. **No es un margen de utilidad** — no hay dato
de costo en ninguna fuente disponible, ni en este proyecto ni en el
pipeline externo. Nombrarlo `margen` habría inducido a leerlo como
rentabilidad. Por eso:

- El campo nuevo en `comercial` se llama `priceDifference`, no `margen`.
- El campo `margen` que el contrato ya tenía desde el Paso 2 (pensado para
  un margen de utilidad real) **permanece `null` siempre** — `buildComercial()`
  nunca lo rellena a partir de `priceDifference`, ni aunque haya datos
  comerciales disponibles para ese SKU. Verificado explícitamente en QA
  (`scripts/verify-commercial-data.js`) y en la importación real: ningún
  registro generado contiene la clave `margen`.
- El script de importación documenta esta distinción en un comentario junto
  al cálculo, no solo en este documento.

### Cómo Context Builder consulta al proveedor sin acoplarse a él

```js
// context-builder.js
const commercialProvider = options.commercialProvider
  || (typeof CommercialDataProvider !== 'undefined' ? CommercialDataProvider : null);
...
comercial: buildComercial(String(sku), commercialProvider),
```

`options.commercialProvider` sigue exactamente el mismo patrón de
inyección ya usado por `options.data` desde el Paso 2 — pensado para tests:
un test puede pasar un `commercialProvider` de mentira (`{getBySku: () =>
{...}}`) sin necesitar cargar `commercial-data-provider.js` ni fabricar un
`window.COMMERCIAL_DATA`. Si no se pasa nada, cae al global real si existe,
o a `null` si no — el mismo comportamiento que tenía cualquier llamada a
`build()` antes de este paso.

`buildComercial()` es una función nueva y pura: si `commercialProvider` es
`null` o no tiene registro para ese SKU, devuelve exactamente el objeto
`{disponible:false, precio:null, stock:null, margen:null, estado:null,
priceDifference:null, pendienteDe:'Fase 1 — Integración de Datos'}` — el
mismo objeto, campo por campo, que `context-builder.js` devolvía de forma
hardcodeada desde el Paso 2 (con `priceDifference` añadido, siempre `null`
en ese caso). Solo cuando hay registro real cambia el resultado.

### La prueba de "aditivo" no es una afirmación, es un resultado de test

`scripts/verify-context-builder.js` — el mismo script del Paso 2, **sin
modificar ni una línea** — solo carga `data.js` + `context-builder.js`
(nunca `commercial-data-provider.js`) y sigue pasando **10/10 checks**
exactamente como antes de este paso. Eso es la demostración de que, sin el
proveedor comercial cargado, el comportamiento es *idéntico*, no solo
"parecido" — el mismo test, sin tocar, sigue validando la misma forma.

### Un efecto secundario esperado y deliberadamente no evitado

Las cuatro habilidades del Copilot **no se modificaron** (cero líneas
tocadas en `local-response-provider.js`), pero `explainProduct()` ya
contenía, desde el Paso 3, esta rama:

```js
if (!comercial.disponible) {
  parrafos.push('Precio, stock, margen y estado todavía no están disponibles...');
}
```

Para un SKU que ahora sí tiene dato comercial real, `comercial.disponible`
es `true` y esa rama simplemente no se ejecuta — el texto de "Explicar
producto" para ESE producto ya no incluye la advertencia de "no
disponible", sin que se haya tocado el código de esa habilidad. Es
exactamente el comportamiento que ese `if` fue diseñado para tener, y no
constituye una regresión: para cualquier SKU sin cobertura comercial (o en
el perfil demo público, siempre) el texto es idéntico al de antes.
Verificado explícitamente en navegador, en ambos sentidos, contra el perfil
de producción con datos reales cargados.

### Fuera de alcance (deliberado, en este paso)

- No se implementa la habilidad "Precio y disponibilidad" del Copilot.
- No se modifica ninguna de las cuatro habilidades existentes para
  *aprovechar* activamente los nuevos campos (más allá del efecto
  secundario honesto ya descrito arriba).
- No se toca el pipeline externo (`build_data.py`, `build_bundle.py`) de
  ninguna forma.
- No se resuelve margen de utilidad real — sigue sin existir esa fuente.
- `production.example/commercial-data.js.example` es un stub versionado de
  1 registro (mismo patrón que `data.js.example`) — no un dataset de
  referencia completo.

### QA — Commercial Data Provider

`scripts/verify-commercial-data.js` — mismo enfoque headless que los pasos
anteriores: carga `data.js` + `context-builder.js` +
`commercial-data-provider.js` en un sandbox de Node, sin DOM ni red, y
verifica:

1. Guardrail estático sobre código ejecutable (no comentarios) de
   `context-builder.js` y `commercial-data-provider.js`: cero referencias a
   `fetch`, `XMLHttpRequest`, `document`, `gemini`, `openai`, `anthropic`.
2. Sin `window.COMMERCIAL_DATA` cargado, `getBySku()` devuelve `null` e
   `isAvailable()` es `false`.
3. `ContextBuilder.build()` sin proveedor comercial produce un `comercial`
   idéntico al del Paso 2 (mismos 6 campos originales en los mismos
   valores, más `priceDifference:null`) — ninguna clave inesperada.
4. Inyectando un `commercialProvider` de prueba con registro para el SKU:
   `disponible`/`precio`/`stock`/`estado`/`priceDifference` se completan
   correctamente, y **`margen` permanece `null`** — verificado
   explícitamente, no solo por inspección.
5. Inyectando un `commercialProvider` disponible pero sin registro para
   ese SKU específico: mismo resultado que sin proveedor — la cobertura
   parcial no rompe nada.
6. El resto del contexto (`producto`, `relaciones`, `meta`) es
   *byte-idéntico* con y sin proveedor comercial — el bloque `comercial`
   es la única parte que cambia.
7. Recorre **todo el catálogo** con y sin un proveedor simulado, sin
   lanzar ninguna excepción.

Resultado: **7/7 checks OK**. Se volvieron a correr
`scripts/verify-context-builder.js` (**10/10**, sin cambios en el script),
`scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**),
`scripts/verify-best-alternative.js` (**10/10**) y
`scripts/verify-cross-sell.js` (**10/10**) en el mismo momento — cero
regresión sobre los Pasos 2 a 6.

**Verificación adicional con datos reales** (no solo fixtures de prueba):
se ejecutó `scripts/import-commercial-data.js` contra la salida real del
pipeline externo y `production/data.js` real de este proyecto.
Resultado: **1.094/1.094** productos del catálogo con dato comercial
disponible; ninguna clave `margen` presente en ningún registro generado;
`ContextBuilder.build()` sobre los 1.094 productos reales produjo
`comercial.disponible === true` para el 100 % de ellos, con el shape
esperado. Verificado también en navegador: perfil demo público
(`CommercialDataProvider.isAvailable() === false`, `comercial` idéntico al
original, "Explicar producto" muestra la misma advertencia de siempre) y
perfil de producción con el archivo comercial real cargado
(`isAvailable() === true`, `comercial.disponible === true`, la advertencia
desaparece del texto de "Explicar producto" para el producto probado, las
cuatro habilidades del Copilot funcionan sin errores de consola).

Durante la implementación se encontró y corrigió un bug real (no una
regresión de este proyecto, sino un defecto nuevo en el propio script de
importación): `sandbox.DATA` no queda expuesto como propiedad tras
`vm.runInContext()` en Node cuando el script fuente declara `const DATA`
—mismo comportamiento del módulo `vm` ya documentado para los scripts de
QA de pasos anteriores—, así que `loadCatalogSkus()` intentaba leer
`sandbox.DATA.products` y fallaba. Se corrigió leyendo `DATA.products...`
con una segunda evaluación dentro del mismo contexto, el mismo patrón que
ya usan los scripts `verify-*.js`. No fue necesario ningún cambio de
arquitectura para resolverlo.

## Precio y disponibilidad (Fase 3, Paso 2)

### La quinta habilidad, y la primera que consume datos comerciales

Con esta habilidad quedan implementadas las 5 habilidades planificadas del
AI Sales Copilot (Paso 1 de la Fase 2). Es la primera que muestra
`context.comercial` al usuario — las cuatro anteriores solo lo consultaban
de forma indirecta y defensiva (`explainProduct` menciona honestamente
cuando *no* hay dato disponible; ninguna otra lo toca).

### Nunca toca CommercialDataProvider — solo lee `context.comercial`

La especificación de este paso pide "utilizar únicamente
CommercialDataProvider" y "nunca acceder directamente a
`COMMERCIAL_DATA`". Ambas reglas se cumplen, pero no porque
`priceAndAvailability()` llame a `CommercialDataProvider.getBySku()` — no
lo hace, y no necesita hacerlo. `ContextBuilder.build()` ya consultó a
`CommercialDataProvider` (Fase 3, Paso 1) y dejó el resultado, ya
normalizado, en `context.comercial`. `priceAndAvailability()` es un
consumidor más de ese contrato — el mismo que ya usan `explainProduct`,
`bestAlternative`, etc. para `producto`/`relaciones` — y nunca se entera de
que `CommercialDataProvider` existe.

```js
function priceAndAvailability(context) {
  ...
  const { producto, comercial } = context;
  // nunca: CommercialDataProvider.getBySku(...)
  // nunca: COMMERCIAL_DATA[...]
}
```

Esto es, en la práctica, más estricto que "usar CommercialDataProvider":
como `CommercialDataProvider` es la ÚNICA vía por la que un dato comercial
entra al sistema (Fase 3, Paso 1), y esta habilidad solo lee lo que esa vía
ya produjo, es imposible que el precio/stock/estado mostrado provenga de
otro lugar. Verificado explícitamente en QA (`scripts/verify-price-availability.js`,
check 2): el código fuente de `local-response-provider.js` no contiene
ninguna referencia textual a `CommercialDataProvider` ni a
`COMMERCIAL_DATA`.

### El "precio de lista": real cuando existe, derivado solo como respaldo

La primera versión de este paso solo calculaba `precioLista` (`precio +
priceDifference`), porque `import-commercial-data.js` no capturaba el
precio de lista real de la fuente externa — aunque esa fuente sí lo
provee (`listPrice` en `data/products.js` del pipeline comercial, ya
usado por `build_data.py` para calcular `marginGap`, pero nunca
propagado tal cual hacia este proyecto). Observación de revisión de
código: priorizar el valor real cuando el dataset lo trae, y usar el
cálculo derivado únicamente como respaldo. Se ajustaron tres archivos,
todos de forma aditiva:

- **`scripts/import-commercial-data.js`** — ahora también captura
  `p.listPrice` (cuando es un número) en un nuevo campo
  `bySku[sku].precioLista`, junto al ya existente `priceDifference`. No
  se tocó el pipeline externo (`listPrice` ya estaba en su salida, este
  script simplemente empezó a leerlo).
- **`context-builder.js`** — `buildComercial()` hace *relay* de
  `registro.precioLista` hacia `comercial.precioLista`, sin derivar nada
  — sigue siendo una función de datos pura, no de presentación. Si el
  registro no trae `precioLista` (dato más antiguo, o proveedor de
  prueba), el campo queda en `null` como cualquier otro campo ausente.
- **`local-response-provider.js`** — `buildPriceAndAvailability()` es
  quien decide la prioridad:

  ```js
  const precioLista = typeof comercial.precioLista === 'number'
    ? comercial.precioLista                                    // 1) real, si está
    : (typeof comercial.precio === 'number' && typeof comercial.priceDifference === 'number')
      ? Math.round((comercial.precio + comercial.priceDifference) * 100) / 100  // 2) respaldo derivado
      : null;                                                  // 3) ninguno de los dos
  ```

  Esta decisión de prioridad es lógica de presentación — vive en la
  habilidad, no en Context Builder, igual que toda la demás lógica de
  negocio de las 5 habilidades.

Verificado con datos reales (no solo fixtures): tras regenerar
`production/commercial-data.js` con el script corregido, **1.114/1.114**
registros comerciales reales trajeron un `precioLista` real, y en el
100 % de los casos coincide con lo que habría dado el cálculo derivado
(diferencia < 0.01) — confirmando que ambos caminos son consistentes, y
que ahora se usa el más directo. QA agrega dos checks dedicados: uno
prueba que un `precioLista` real gana sobre un derivado distinto cuando
ambos existen: otro prueba que, sin `precioLista` real, el cálculo de
respaldo se sigue usando exactamente igual que antes de este ajuste.

### Los 3 casos de la especificación, uno a uno

- **Caso 1 (producto con datos comerciales):** `comercial.disponible ===
  true` → se muestran precio final, precio de lista (si se pudo derivar),
  diferencia de precio, stock y estado — los 5 campos que pide la
  especificación.
- **Caso 2 (producto sin datos comerciales):** `comercial.disponible ===
  false` → `disponible:false` y un `mensaje` honesto
  (`No hay información comercial disponible para "<nombre>" en este
  momento.`), sin ningún campo numérico poblado.
- **Caso 3 (perfil Demo):** el perfil demo público nunca carga
  `production/commercial-data.js`, así que `CommercialDataProvider.isAvailable()`
  es siempre `false` y `context.comercial.disponible` es siempre `false`
  para cualquier producto — el Caso 3 es, en la práctica, el Caso 2 aplicado
  universalmente a todo el catálogo demo. No hizo falta ninguna rama de
  código "si es el perfil demo" — es la misma lógica del Caso 2,
  ejecutándose sobre datos que genuinamente no existen ahí.

### UI: cero CSS nuevo

El bloque de respuesta reutiliza `.copilot-response`/`.copilot-response-h`/
`.dot-live` (ya usados por las 4 habilidades anteriores), `.compare-none`
(ya usado por "Mejor alternativa"/"Venta cruzada" para sus mensajes
"no encontrado") y `.compare-prod-row` (ya usado por "Comparar productos"
para sus filas etiqueta/valor). No se agregó ninguna clase CSS nueva para
esta habilidad — el layout "Precio final / Precio lista / Diferencia /
Stock / Estado" es, visualmente, el mismo patrón de filas que ya existía.
Los montos usan el formateador `es-PE` con 2 decimales y el prefijo "S/"
(soles peruanos, consistente con el dominio descrito en
`docs/PROJECT_BRIEF.md`).

### Orquestación: sin `maxPerType` especial

A diferencia de "Comparar productos"/"Mejor alternativa"/"Venta cruzada",
`onPriceAvailabilityClick()` llama a `ContextBuilder.build(p360Current)`
sin pasar `maxPerType` — el bloque `comercial` no depende de
`relaciones.detalle` en absoluto, así que no hay riesgo de truncamiento
que evitar. Es el `ContextBuilder.build()` más simple de los cinco.

### Fuera de alcance (deliberado, en este paso)

- No se modificó `CommercialDataProvider` ni el pipeline externo
  (`build_data.py`/`build_bundle.py`) — cero cambios en ninguno de los
  dos. `import-commercial-data.js` sí recibió un ajuste mínimo y aditivo
  post-aprobación (capturar `listPrice` ya existente en la fuente,
  detallado arriba) — no está exento de cambios como se planteó
  originalmente, pero el pipeline externo y `CommercialDataProvider` sí.
- No se modificó ninguna de las cuatro habilidades anteriores.
- Sin proveedor Gemini ni ningún código de red.

### QA — Precio y disponibilidad

`scripts/verify-price-availability.js` — mismo enfoque headless que los
pasos anteriores: carga `data.js` + `context-builder.js` +
`response-provider.js` + `providers/local-response-provider.js` en un
sandbox de Node, sin DOM ni red, y verifica:

1. Guardrail estático sobre código ejecutable (no comentarios) de
   `response-provider.js` y `local-response-provider.js`: cero referencias
   a `fetch`, `XMLHttpRequest`, `document`, `window`, `gemini`, `openai`,
   `anthropic`.
2. `local-response-provider.js` no contiene, en absoluto, las cadenas
   `CommercialDataProvider` ni `COMMERCIAL_DATA` — la regla "nunca acceder
   directamente" verificada por inspección del código fuente, no solo por
   comportamiento observado.
3. `ResponseProvider.use()` ahora exige **también** `priceAndAvailability`
   — un proveedor sin ese método es rechazado.
4. **Caso 1**: producto con dato comercial simulado → precio final, precio
   de lista, diferencia, stock y estado, todos presentes.
5. **precioLista real** tiene prioridad sobre el cálculo derivado cuando el
   registro trae ambos y difieren entre sí — verificado explícitamente,
   no solo por inspección.
6. **precioLista** cae al cálculo derivado (respaldo) exactamente igual
   que antes de este ajuste cuando el dataset no trae un valor real.
7. **Caso 2**: producto sin dato comercial → `disponible:false`, todos los
   campos numéricos/estado en `null`, mensaje honesto sin un precio con
   formato de moneda inventado.
8. **Caso 3**: sin `CommercialDataProvider` cargado en el sandbox en
   absoluto (la situación real del perfil demo) → siempre
   `disponible:false`, nunca lanza.
9. `precioLista` queda en `null`, no en un número incompleto, cuando no
   hay valor real ni forma de derivarlo (falta `priceDifference`).
10. Un contexto inválido (`null`) rechaza la Promise en vez de lanzar de
    forma síncrona.
11. `explainProduct`, `compareProducts`, `bestAlternative` y `crossSell`
    siguen funcionando exactamente igual tras ampliar el contrato con
    `priceAndAvailability`.
12. Recorre **los 1.094 productos del catálogo**, con un proveedor
    comercial simulado que cubre una parte de ellos, sin lanzar ninguna
    excepción.

Resultado: **12/12 checks OK**. `scripts/verify-commercial-data.js` ganó
un check dedicado (`precioLista` se relaya tal cual desde
`ContextBuilder.build()` cuando el proveedor lo trae) y actualizó su
aserción de shape exacto para incluir el nuevo campo — resultado
**8/8**. Se volvieron a correr `scripts/verify-context-builder.js`
(**10/10**), `scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**),
`scripts/verify-best-alternative.js` (**10/10**) y
`scripts/verify-cross-sell.js` (**10/10**) en el mismo momento — cero
regresión sobre los pasos anteriores de las Fases 2 y 3.

Verificación con datos reales (no solo fixtures): se regeneró
`production/commercial-data.js` con el script corregido —
**1.114/1.114** registros comerciales reales trajeron un `precioLista`
real, consistente en el 100 % de los casos con el cálculo derivado.
Verificación adicional en navegador: perfil demo público (clic en
"Precio y disponibilidad" → mensaje honesto de "no disponible",
consistente con el Caso 3) y perfil de producción con
`production/commercial-data.js` real regenerado (precio final, precio de
lista real, diferencia, stock y estado mostrados correctamente, con
formato de moneda "S/" y separador de miles `es-PE`). Las 5 habilidades
del Copilot verificadas coexistiendo sin interferencia de estado, en
ambos perfiles. Cambiar de producto reinicia las 5. Responsive (375 px)
verificado con la respuesta completa visible. Sin errores de consola en
ningún caso.

## AI Provider Abstraction (Fase 4, Paso 1)

### Objetivo: extraer un contrato ya implícito, no inventar uno nuevo

Desde el Paso 3 (ver la sección "Response Provider" arriba),
`response-provider.js` ya definía y exigía, en su propio código, la lista de
métodos que un proveedor debe implementar (`REQUIRED_METHODS`, un array
inline en `assertShape()`). Ese contrato ya era real y ya se cumplía — solo
vivía escondido dentro del puerto, sin nombre propio ni forma de
consultarlo de manera independiente. Este paso lo extrae a un módulo con
identidad propia, `ResponseProviderContract`
(`assets/js/response-provider-contract.js`), y crea `AIResponseProvider`
como segundo proveedor que lo cumple — sin cambiar en ningún momento qué
hace `LocalResponseProvider` ni cómo responde el Copilot hoy.

```
Context Builder → Response Provider Interface → { LocalResponseProvider (activo), AIResponseProvider (placeholder) }
                          ↑
              ResponseProviderContract (Fase 4, Paso 1)
```

### `ResponseProviderContract` — la interfaz nombrada

```js
ResponseProviderContract.METHODS          // ['explainProduct', 'compareProducts', 'bestAlternative', 'crossSell', 'priceAndAvailability']
ResponseProviderContract.missingMethods(provider)  // string[] — nombres de métodos ausentes; provider nulo/indefinido devuelve los 5
ResponseProviderContract.implementedBy(provider)   // boolean — missingMethods(provider).length === 0
```

Un módulo deliberadamente mínimo: no valida firmas de parámetros ni formas
de retorno (eso ya lo hacen, indirectamente, los QA de cada habilidad
contra datos reales) — solo la forma superficial que `ResponseProvider.use()`
necesita para decidir si un proveedor es válido antes de activarlo.

### `response-provider.js` pasa de definir el contrato a consultarlo

`assertShape()` ya no mantiene su propio array de métodos requeridos:
delega en `ResponseProviderContract.missingMethods(provider)`. `use()`,
`get()` e `isReady()` no cambiaron ni una línea de su lógica ni su mensaje
de error (`'ResponseProvider.use: el proveedor no implementa "X(context)".'`)
— es una extracción pura, verificada como tal en QA (el texto exacto del
error se comprueba con una aserción de regex dedicada).

### `AIResponseProvider` — placeholder, no una integración

```js
// assets/js/providers/ai-response-provider.js
AIResponseProvider.explainProduct()        // => Promise.reject(Error(...))
AIResponseProvider.compareProducts()       // => Promise.reject(Error(...))
AIResponseProvider.bestAlternative()       // => Promise.reject(Error(...))
AIResponseProvider.crossSell()             // => Promise.reject(Error(...))
AIResponseProvider.priceAndAvailability()  // => Promise.reject(Error(...))
```

Implementa las 5 claves del contrato (cumple `ResponseProviderContract`,
verificado dinámicamente) pero cada método rechaza de inmediato con un
mensaje que dice, literalmente, "todavía no implementado" — nunca resuelve,
nunca fabrica una respuesta, nunca toca red. Existe únicamente para que
`ResponseProvider.use(AIResponseProvider)` sea una operación válida hoy (un
hecho comprobado en QA), preparando el terreno para que una fase futura
reemplace el cuerpo de estos 5 métodos por llamadas reales — sin que ese
cambio futuro toque `response-provider.js`, `response-provider-contract.js`
ni ningún consumidor del panel.

### Por qué `LocalResponseProvider` no se tocó

El archivo `providers/local-response-provider.js` tiene cero diff en este
paso — su conformidad con `ResponseProviderContract` se prueba llamando a
`ResponseProviderContract.implementedBy(LocalResponseProvider)` en QA, no
editando el archivo para "declarar" que implementa una interfaz (este
proyecto no tiene ni necesita una noción de tipos/interfaces declaradas;
JavaScript vainilla verifica forma en tiempo de ejecución, como ya hacía
`assertShape()` desde el Paso 3). Es la misma razón por la que
`ResponseProvider.use(LocalResponseProvider)` seguía funcionando sin
cambios: el contrato que ahora tiene nombre propio es, byte a byte, el
mismo que `LocalResponseProvider` ya cumplía.

### Qué NO activa este paso

`app.js` sigue teniendo una única línea de activación,
`ResponseProvider.use(LocalResponseProvider);`, sin tocar. Los `<script>` de
`response-provider-contract.js` y `providers/ai-response-provider.js` se
agregaron a las tres páginas (`index.html`, `production/index.html`,
`production.example/index.html`) para que ambos globals existan en el
navegador — exactamente como ya existe `LocalResponseProvider` sin estar
necesariamente en uso — pero ningún código de la aplicación llama a
`AIResponseProvider` ni lo registra como proveedor activo. Verificado en
navegador: `ResponseProvider.get() === LocalResponseProvider` sigue siendo
cierto tras cargar la página.

### Fuera de alcance (deliberado, en este paso)

- Sin lógica de IA real, sin SDK de Gemini/OpenAI/Anthropic, sin llamada de
  red — `AIResponseProvider` rechaza sus 5 métodos de forma síncrona con un
  error, nada más.
- Sin cambios en Context Builder, `CommercialDataProvider`, el pipeline
  comercial, ni ninguna de las 5 habilidades de `LocalResponseProvider`.
- Sin activar `AIResponseProvider` en `app.js` — sigue siendo, en este
  paso, un proveedor registrable pero inactivo.

### QA — AI Provider Abstraction

`scripts/verify-ai-provider-abstraction.js` — mismo enfoque headless que
los pasos anteriores: carga `data.js` + `context-builder.js` +
`response-provider-contract.js` + `response-provider.js` +
`providers/local-response-provider.js` + `providers/ai-response-provider.js`
en un sandbox de Node, sin DOM ni red, y verifica:

1. Guardrail estático sobre código ejecutable (no comentarios) de los 4
   archivos de infraestructura del Copilot: cero referencias a `fetch`,
   `XMLHttpRequest`, `document`, `window`, `gemini`, `openai`, `anthropic`.
2. `ResponseProviderContract.METHODS` contiene exactamente las 5 habilidades
   esperadas.
3. `missingMethods()`/`implementedBy()` se comportan correctamente sobre un
   objeto vacío, uno parcial (2 de 5 métodos) y uno completo.
4. `missingMethods(null)`/`missingMethods(undefined)` no lanzan y reportan
   las 5 como faltantes.
5. `ResponseProviderContract.implementedBy(LocalResponseProvider) === true`
   — verificado dinámicamente contra el archivo real, sin haberlo
   modificado.
6. `AIResponseProvider` existe como objeto global y también cumple el
   contrato.
7. Cada uno de los 5 métodos de `AIResponseProvider` rechaza su Promise con
   un mensaje de error — ninguno resuelve con una respuesta fabricada.
8. `ResponseProvider.use()` acepta tanto a `LocalResponseProvider` como a
   `AIResponseProvider` (ambos son proveedores válidos por forma), y puede
   alternar entre ambos sin lanzar.
9. El mensaje de error de `ResponseProvider.use()` ante un proveedor
   incompleto no cambió tras la extracción del contrato (mismo texto exacto
   que en el Paso 3).
10. Regresión explícita: `LocalResponseProvider`, reactivado como proveedor,
    sigue respondiendo con la forma correcta en sus 5 habilidades
    (`explainProduct`, `compareProducts`, `bestAlternative`, `crossSell`,
    `priceAndAvailability`).

Resultado: **10/10 checks OK**. Se volvieron a correr las 7 suites
anteriores en el mismo momento —
`scripts/verify-context-builder.js` (**10/10**),
`scripts/verify-commercial-data.js` (**8/8**),
`scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**),
`scripts/verify-best-alternative.js` (**10/10**),
`scripts/verify-cross-sell.js` (**10/10**) y
`scripts/verify-price-availability.js` (**12/12**) — cero regresión sobre
las Fases 2 y 3. Las 5 primeras necesitaron un ajuste mínimo (no
funcional): cargar también `response-provider-contract.js` en su sandbox de
Node, en el mismo orden que ahora exige `response-provider.js` en
navegador, ya que dejó de traer su lista de métodos inline.

Verificación en navegador (perfil demo): sin errores de consola;
`typeof ResponseProviderContract === 'object'` y
`typeof AIResponseProvider === 'object'` en ambas páginas;
`ResponseProviderContract.implementedBy(LocalResponseProvider)` y
`...implementedBy(AIResponseProvider)` ambos `true`; `ResponseProvider.get()
=== LocalResponseProvider` tras la carga (ningún cambio de proveedor
activo). Flujo completo probado en Producto 360: "Venta cruzada
inteligente" (habilidad 5) generó recomendaciones reales y correctamente
justificadas, exactamente igual que antes de este paso — prueba funcional
de que el refactor del puerto no alteró el comportamiento visible del
Copilot. Sin cambio visual en el panel; las 5 habilidades siguen
mostrándose idénticas a como quedaron tras la Fase 3.

## Prompt Context Builder (Fase 4, Paso 2)

### Responsabilidad: organizar, no razonar

`assets/js/prompt-context-builder.js` transforma el `Context` que ya
produce `ContextBuilder.build()` en un `PromptContext` — la forma
estructurada, determinística y desacoplada que un futuro
`AIResponseProvider` recibirá para razonar. No genera texto en lenguaje
natural, no llama a ningún modelo ni API, no decide qué proveedor usar y no
accede a ninguna fuente de datos por su cuenta: toda la información sale,
exclusivamente, del objeto `context` que recibe como parámetro. Nunca llama
a `ContextBuilder` — quien orquesta la llamada (hoy nadie; en un paso
futuro, `app.js`) sigue siendo responsable de construir el `Context` antes.

```
Context Builder → Context → Prompt Context Builder → PromptContext → (futuro) AIResponseProvider
```

### Contrato

```js
PromptContextBuilder.build(context, options?)
// context: el objeto que devuelve ContextBuilder.build() — obligatorio, lanza si falta o está incompleto
// options.intent: lo que el llamador considere la intención del usuario — se relaya tal cual en
//   `userIntent`; si se omite, `userIntent` queda en `null`. Nunca se infiere.
// devuelve: PromptContext serializable
```

Forma del objeto devuelto:

```jsonc
{
  "schemaVersion": "1.0.0",
  "productKnowledge": {
    "nombre": "...",
    "familia": "B1.1 Colágeno hidrolizado",   // producto.subcategoria — el descriptor de familia más legible, sin el diccionario de app.js
    "beneficios": ["Piel y colágeno", "..."],  // extraídos de justificaciones MISMO_BENEFICIO
    "ingredientes": ["Colágeno hidrolizado"],  // extraídos de justificaciones MISMO_INGREDIENTE
    "relaciones": { "total": 229, "porTipo": [ /* igual forma que en Context */ ] },
    "metadata": { "sku": "...", "familiaCodigo": "B1", "universoCodigo": "B", "universo": "Bienestar", "tags": [...], "audiencias": [...], "schemaVersion": "1.0.0", "generadoEn": "...", "productoIndice": 17 }
  },
  "commercialContext": {
    "precio": 39.90, "precioLista": 45.00, "stock": 120, "estado": "Disponible", "disponibilidad": true
    // o, sin cobertura comercial: todos en null salvo disponibilidad: false — nunca fabricado
  },
  "alternatives": [
    { "sku": "...", "nombre": "...", "relaciones": [ { "tipo": "SUSTITUYE", "confianza": "Alta", "justificacion": "..." } ] }
  ],
  "crossSell": [
    { "sku": "...", "nombre": "...", "relaciones": [ { "tipo": "COMPLEMENTA", "confianza": "Media", "justificacion": "..." }, { "tipo": "MISMO_BENEFICIO", "confianza": "Alta", "justificacion": "..." } ] }
  ],
  "userIntent": null   // o exactamente lo que se pasó en options.intent
}
```

### Por qué la estructura separa `productKnowledge.relaciones` (agregado) de `alternatives`/`crossSell` (candidatos)

`productKnowledge.relaciones` es el mismo resumen agregado
(`total`/`porTipo`) que ya usa `ProductoResumen` en "Comparar productos" —
le da al futuro modelo una noción de cuán conectado está el producto sin
listar cada arista. `alternatives` y `crossSell`, en cambio, son listas de
candidatos reales (otros SKUs) con sus relaciones elegibles adjuntas —
exactamente lo que un modelo necesitaría para razonar sobre "con qué lo
sustituyo" o "qué le ofrezco además". Mantenerlos como bloques separados
(no anidados dentro de `relaciones`) sigue al pie de la letra la estructura
de la especificación y evita que el mismo hecho (una arista SUSTITUYE, por
ejemplo) tenga que interpretarse dos veces desde dos lugares distintos del
objeto.

### Por qué `alternatives`/`crossSell` agrupan por SKU en vez de listar relaciones sueltas

Un mismo candidato puede estar conectado al producto actual por más de una
relación elegible a la vez (p. ej. `COMPLEMENTA` y `MISMO_BENEFICIO`
simultáneamente — el mismo caso ya documentado en "Venta cruzada
inteligente", Fase 2 Paso 6). Sin agrupar, ese candidato aparecería dos
veces en la lista — una violación directa del requisito de QA "no existen
duplicados". Agrupar por `sku` en un `Map` (igual técnica que ya usa
`buildCrossSell` en `local-response-provider.js`, pero sin su cálculo de
`score`) resuelve el duplicado sin perder ningún dato: todas las relaciones
elegibles del candidato quedan preservadas dentro de su propio
`relaciones[]`, listas para que quien razone sobre ellas decida cuánto pesa
cada una.

### Por qué NO hay score ni ranking en `alternatives`/`crossSell`

Puntuar candidatos y elegir un ganador es, precisamente, lo que ya hacen
`bestAlternative()`/`crossSell()` en `LocalResponseProvider` — una decisión
de **respuesta**, no de organización de contexto. La especificación de este
paso es explícita: *"PromptContextBuilder será responsable únicamente de
organizar la información"* y *"no debe generar respuestas"*. Por eso
`alternatives`/`crossSell` entregan los candidatos elegibles tal cual están
en el grafo (filtrados por política de calidad, ver abajo) sin ordenarlos
por relevancia — ese criterio de negocio (pesos por tipo de relación,
ponderación por confianza) sigue viviendo, sin duplicarse, únicamente en
`LocalResponseProvider`. Un futuro `AIResponseProvider` puede razonar sobre
`crossSell` con su propio criterio (o reaplicar el mismo) sin que este
módulo le imponga uno.

### Política R-PIG-04, reaplicada una cuarta vez

`alternatives`/`crossSell` excluyen relaciones de confianza Baja por
defecto — la misma política de calidad de dato ya vigente en Panorama,
Motores, "Mejor alternativa" y "Venta cruzada" (Fase 2, Pasos 5 y 6). Es la
cuarta vez que este proyecto reaplica esta política en un módulo
independiente sin importarla desde ningún sitio: cada consumidor del grafo
la reafirma localmente. `productKnowledge.relaciones` (el agregado), en
cambio, sigue reportando el total real sin filtrar — igual que
`context.relaciones` en el Context Builder — porque ahí no se trata de
candidatos "elegibles para actuar", sino de una magnitud descriptiva.

### `beneficios`/`ingredientes`: misma técnica de extracción ya validada, reaplicada sin importar el archivo

`extractQuoted()` (regex sobre el texto entre comillas simples de la
justificación) es la misma técnica que ya usa `local-response-provider.js`
para "beneficios" desde el Paso 3 — no se pudo importar desde ahí (sus
funciones viven en un closure privado, y ese archivo está fuera de alcance
de este paso), así que se reaplicó de forma independiente. Antes de
aplicarla también a "ingredientes" (`MISMO_INGREDIENTE`), se verificó el
mismo nivel de confianza exigido para "beneficios" en su momento: el 100%
de las 159 justificaciones únicas de tipo `MISMO_INGREDIENTE`, en el
catálogo sintético **y** en el real, sigue el patrón *"Comparten elemento
base 'X' (otras presentaciones del mismo ingrediente)"* — no es una
heurística nueva sin verificar, es la misma disciplina ya aplicada dos
veces antes (`beneficios` en el Paso 3, y de nuevo aquí).

### `UserIntent`: nunca inferido

`Context` no contiene ninguna noción de intención del usuario — es
puramente conocimiento de catálogo y grafo. Por eso `userIntent` es
exactamente lo que el llamador pasa en `options.intent`, relayado sin
tocar; si no se pasa nada, queda en `null`. Este módulo no intenta adivinar
qué habilidad o pregunta originó la llamada a partir del `context` — eso
sería fabricar un dato que no existe en la fuente, la misma disciplina que
ya rige `comercial.pendienteDe` o `relaciones.total` en el Context Builder
(nunca inventar, declarar honestamente lo que falta o no se tiene).

### Por qué `build()` lanza en vez de devolver `null` ante un contexto inválido

A diferencia de `ContextBuilder.build()` (que devuelve `null` cuando el
producto referenciado no existe — un caso de negocio esperado, no un error
de programación), `PromptContextBuilder.build()` siempre recibe un
`Context` que, en el flujo real, ya salió de una llamada válida a
`ContextBuilder.build()`. Un `context` nulo o incompleto aquí solo puede
significar un error del llamador — el mismo criterio que ya aplican los
métodos de `LocalResponseProvider` al rechazar su Promise ante un contexto
inválido. `PromptContextBuilder.build()` no es async (es una transformación
pura y síncrona, sin I/O), así que la señal equivalente es lanzar de forma
síncrona en vez de rechazar una Promise.

### Fuera de alcance (deliberado, en este paso)

- Sin generación de prompts en lenguaje natural — `PromptContext` es un
  objeto estructurado, no texto.
- Sin ningún cambio en Context Builder, `CommercialDataProvider`, el
  pipeline comercial, `LocalResponseProvider` ni `AIResponseProvider` —
  cero diff en los cinco.
- Sin ninguna integración en `app.js` ni en el panel del Copilot: este
  módulo no tiene todavía ningún consumidor real. El `<script>` se agregó a
  las tres páginas por consistencia con `AIResponseProvider` en el Paso
  1 (existe como global, listo para usarse, sin que nada lo invoque
  todavía) — cero impacto de comportamiento, verificado en navegador.

### QA — Prompt Context Builder

`scripts/verify-prompt-context-builder.js` — mismo enfoque headless que los
pasos anteriores: carga `data.js` + `context-builder.js` +
`commercial-data-provider.js` + `prompt-context-builder.js` en un sandbox
de Node, sin DOM ni red, y verifica:

1. Guardrail estático sobre código ejecutable (no comentarios): cero
   referencias a `fetch`, `XMLHttpRequest`, `document`, `window`, `gemini`,
   `openai`, `anthropic`.
2. El módulo no referencia `LocalResponseProvider`, `AIResponseProvider` ni
   `ResponseProvider` en absoluto — no se acopla a ningún proveedor de
   respuestas, verificado por inspección del código fuente.
3. El módulo carga y expone `build()`/`SCHEMA_VERSION`.
4. `build(context)` devuelve exactamente los 6 bloques de la
   especificación (`schemaVersion`, `productKnowledge`, `commercialContext`,
   `alternatives`, `crossSell`, `userIntent`) — ni de más ni de menos.
5. `productKnowledge` tiene exactamente sus 6 sub-bloques esperados;
   `commercialContext` tiene exactamente sus 5 campos esperados por la
   especificación (nada de `margen`/`priceDifference`/`pendienteDe`, que
   son detalles de implementación fuera de la forma pedida).
6. **Ningún campo del `PromptContext` es `undefined`** — verificado con un
   recorrido recursivo propio, no con `JSON.stringify` (que omite en
   silencio las claves `undefined` en vez de señalarlas — una trampa que
   habría dejado pasar el bug que este check existe para atrapar).
7. `beneficios`/`ingredientes` citados se verifican contra las
   justificaciones reales de ese producto — no basta con que el formato
   "se vea bien".
8. `alternatives`/`crossSell` nunca contienen un `sku` duplicado — cada
   candidato aparece una sola vez, con todas sus relaciones elegibles
   agrupadas.
9. `alternatives`/`crossSell` nunca incluyen una relación de confianza Baja
   (R-PIG-04 verificado dinámicamente, no solo documentado).
10. `alternatives` contiene únicamente relaciones `SUSTITUYE`; `crossSell`
    únicamente los 4 tipos elegibles de venta cruzada — sin mezcla entre
    bloques.
11. `userIntent` relaya exactamente lo que se pasa en `options.intent`, y
    queda en `null` cuando se omite — nunca se infiere.
12. `commercialContext` relaya fielmente tanto el caso sin cobertura
    comercial (`disponibilidad:false`, todo en `null`) como el caso con un
    proveedor comercial simulado (`disponibilidad:true` con los 4 campos
    poblados).
13. Un contexto inválido (`null`, o un objeto incompleto) lanza de forma
    síncrona.
14. Llamadas repetidas con el mismo `context` son puras — no acumulan
    estado entre llamadas.
15. **Los 1.094 productos del catálogo**, uno por uno: sin excepciones, sin
    campos `undefined`, sin `sku` duplicado en `alternatives`/`crossSell`.

Resultado: **17/17 checks OK**, verificado también manualmente contra
`production/data.js` (1.094 productos reales, misma forma, mismo
comportamiento, cero fallos). Se volvieron a correr las 8 suites
anteriores en el mismo momento — `scripts/verify-context-builder.js`
(**10/10**), `scripts/verify-commercial-data.js` (**8/8**),
`scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**),
`scripts/verify-best-alternative.js` (**10/10**),
`scripts/verify-cross-sell.js` (**10/10**),
`scripts/verify-price-availability.js` (**12/12**) y
`scripts/verify-ai-provider-abstraction.js` (**10/10**) — cero regresión
sobre las Fases 2, 3 y 4 · Paso 1. Ninguna de las ocho suites necesitó
ningún ajuste: este módulo no introduce ninguna dependencia nueva en
ningún archivo existente.

Verificación adicional en navegador (perfil demo): sin errores de consola;
`typeof PromptContextBuilder === 'object'` tras la carga;
`PromptContextBuilder.build(ContextBuilder.build(52, {maxPerType:300}), {intent:{skill:'cross-sell'}})`
devuelve la estructura completa esperada en consola. Flujo completo
probado en Producto 360: "Venta cruzada inteligente" (habilidad 5) sigue
generando recomendaciones reales exactamente igual que antes de este paso
— prueba funcional de que agregar el módulo (sin conectarlo a nada) no
alteró el comportamiento visible del Copilot. Sin cambio visual en el
panel.

## Remote Response Provider (Fase 4, Paso 3)

### Responsabilidad: el primer consumidor real de PromptContextBuilder

`assets/js/providers/remote-response-provider.js` es el primer proveedor
que efectivamente construye un `PromptContext` (vía
`PromptContextBuilder.build()`, sin tocar su API) y hace algo con él: lo
envía por HTTP a un endpoint configurable. A diferencia de
`AIResponseProvider` (Paso 1, un placeholder que siempre rechaza) y de
`LocalResponseProvider` (reglas locales, sin red), `RemoteResponseProvider`
cumple exactamente el mismo `ResponseProviderContract` pero delega en un
backend externo — y cae automáticamente a `LocalResponseProvider` ante
cualquier fallo de esa ruta.

```
Context → PromptContextBuilder.build() → PromptContext → fetch(endpoint) → respuesta
                                                                │
                                                    cualquier error ──▶ LocalResponseProvider (fallback)
```

### El mecanismo de activación: `FeatureFlags`, un módulo nuevo porque no existía ninguno

La especificación pedía "el feature flag existente (o uno equivalente si
aún no existe)" — no existía ninguno en el proyecto, así que se creó
`assets/js/feature-flags.js`, deliberadamente mínimo:

```js
FeatureFlags.isEnabled(name)  // boolean
```

Mismo patrón ya usado por `CommercialDataProvider` para `COMMERCIAL_DATA`:
un global opcional (`FEATURE_FLAGS`), leído con `typeof ... !== 'undefined'`
— nunca `window.` — que ningún perfil de este repositorio define hoy. Sin
ese global, **todos** los flags quedan deshabilitados por defecto, para
cualquier flag futuro, no solo `remoteResponseProvider`. Es la misma
garantía de "ausencia de configuración = comportamiento de siempre" que ya
sostiene `COMMERCIAL_DATA` desde la Fase 3.

### Dónde se lee el flag: una sola línea en `app.js`, igual que en cada paso anterior

```js
// app.js
ResponseProvider.use(
  FeatureFlags.isEnabled('remoteResponseProvider') ? RemoteResponseProvider : LocalResponseProvider
);
```

Es, literalmente, la línea que Paso 1 y Paso 3 de la Fase 2 ya
anticipaban ("cambiar ESTA línea por `ResponseProvider.use(GeminiResponseProvider)`")
— ahora es una expresión condicional en vez de una referencia fija, pero
sigue siendo la única línea de todo el sistema que decide qué proveedor
sirve al Copilot. Ningún handler de skill (`onExplainProductClick()`,
`onCompareProductsClick()`, etc.) cambió: todos siguen llamando a
`ResponseProvider.get().<skill>(context)` sin saber ni que existe un
proveedor remoto.

Como ningún perfil de este repositorio define `FEATURE_FLAGS`, esta línea
resuelve exactamente igual que antes de este paso:
`ResponseProvider.use(LocalResponseProvider)`. **Cero cambio de
comportamiento**, verificado en navegador y en las 1.094+1.094 (sintético
y real) comparaciones de la suite de este paso.

### Fallback automático: por qué cubre más que "la llamada de red falla"

`callRemote()` puede fallar por seis razones distintas, y las seis se
tratan exactamente igual — un `throw`/rechazo que activa el fallback:

1. El flag está deshabilitado.
2. No hay `REMOTE_PROVIDER_CONFIG.endpoint` configurado.
3. `fetch` no existe en el entorno.
4. La promesa de `fetch` se rechaza (fallo de red real).
5. La respuesta HTTP no es `ok` (4xx/5xx).
6. El cuerpo no es JSON válido, o no trae el `skill` esperado (contrato de
   forma incumplido por el backend).

Cada método público (`explainProduct`, `compareProducts`, etc.) envuelve su
intento remoto en `Promise.resolve().then(remoteAttempt).catch(localFallback)`
— no un simple `.catch()` sobre una llamada directa. La razón: construir el
`PromptContext` (`PromptContextBuilder.build(context, ...)`) puede lanzar
de forma **síncrona** si `context` es inválido (mismo comportamiento que
Paso 2 diseñó a propósito — ver la sección anterior). Sin el
`Promise.resolve().then(...)`, ese throw síncrono escaparía antes de que
cualquier `.catch()` pudiera capturarlo. Con él, hasta ese caso límite cae
al mismo fallback que un fallo de red — verificado explícitamente en QA
(`RemoteResponseProvider.explainProduct(null)` rechaza con el mismo mensaje
que `LocalResponseProvider.explainProduct(null)`).

El fallback nunca "reintenta" ni "arregla" nada: simplemente delega en
`LocalResponseProvider.<skill>(context)` y devuelve exactamente lo que ese
proveedor hubiera devuelto — la misma respuesta, byte a byte (salvo
`generatedAt`, inevitablemente distinto entre dos llamadas independientes
al reloj), que si `LocalResponseProvider` hubiera estado activo desde el
principio.

### Por qué `compareProducts` construye DOS `PromptContext`, no uno

`compareProducts(contextA, contextB)` recibe dos contextos ya construidos
de forma independiente (misma responsabilidad de siempre: la orquestación
en `app.js` los arma, este proveedor nunca llama a `ContextBuilder`).
`RemoteResponseProvider` los transforma cada uno por separado
(`PromptContextBuilder.build(contextA, ...)` /
`PromptContextBuilder.build(contextB, ...)`) y envía ambos en el mismo
payload (`{a, b}`) — el backend remoto recibiría la misma información
completa y desacoplada que ya usa `LocalResponseProvider.compareProducts`
internamente (`summarizeForCompare` para A y para B), solo que en la forma
`PromptContext` en vez de la forma interna de Local.

### `userIntent`: el único dato que este proveedor SÍ aporta, honestamente

Cada método pasa `{ intent: { skill: '<nombre-del-método>' } }` a
`PromptContextBuilder.build()`. No es una intención inferida ni adivinada
— es literalmente el nombre de la habilidad que se está invocando, la
misma información que ya viaja en el campo `skill` de cualquier respuesta
del contrato. Sigue al pie de la letra el diseño del Paso 2: `userIntent`
nunca se fabrica, solo se relaya lo que el llamador sabe con certeza.

### Qué NO valida `RemoteResponseProvider` del cuerpo remoto, y por qué

Solo se verifica `body.skill === skill` antes de confiar en la respuesta —
no se valida cada campo interno (`text`, `similitudes`, `precio`, etc.)
contra el contrato completo. Validar de más, contra un backend que hoy no
existe, sería código especulativo sin nada real que lo ejercite. El
`skill` es la única señal barata y universal (aplica a las 5 habilidades
por igual) de que "esto parece una respuesta con sentido" — cualquier
forma más profundamente incorrecta que igual declare el `skill` correcto
quedaría, en la práctica, expuesta al usuario tal cual, la misma confianza
que ya se deposita en `LocalResponseProvider` (no hay una segunda capa de
validación de sus respuestas tampoco).

### Fuera de alcance (deliberado, en este paso)

- Sin backend real: `REMOTE_PROVIDER_CONFIG` no está definido en ninguna de
  las tres páginas — no existe ningún endpoint al que efectivamente se
  pueda llamar hoy. Este paso entrega el mecanismo, no un servicio.
- Sin API key, autenticación, rate limiting, timeout explícito ni
  reintentos — nada de eso tiene sentido diseñar todavía sin un backend
  real contra el cual validarlo; quedan para cuando exista una
  especificación de ese backend.
- Sin cambios en `ContextBuilder`, `CommercialDataProvider`, el pipeline
  comercial, `LocalResponseProvider`, `PromptContextBuilder` ni
  `AIResponseProvider` — cero diff en los seis.
- `AIResponseProvider` (Paso 1) y `RemoteResponseProvider` (este paso)
  siguen siendo proveedores independientes, no relacionados: el primero es
  un placeholder que siempre rechaza: el segundo, un proveedor funcional
  con fallback. Unificarlos no fue pedido y mezclaría dos propósitos
  distintos.

### QA — Remote Response Provider

`scripts/verify-remote-response-provider.js` — mismo enfoque headless que
los pasos anteriores, con una diferencia: en vez de simular ausencia de
datos, simula respuestas de `fetch` inyectando una implementación falsa en
el sandbox de Node **antes** de cargar los módulos (mismo mecanismo que ya
usa `CommercialDataProvider` para inyectar un `commercialProvider` de
prueba). Verifica:

1. Guardrail estático de `remote-response-provider.js`: cero referencias a
   `XMLHttpRequest`, `document`, `window`, `gemini`, `openai`, `anthropic`
   — pero **sí** se exige la presencia de `fetch` (positivo, no negativo):
   este archivo es el único de todo el proyecto donde una llamada de red
   real es el comportamiento correcto, no una violación.
2. Guardrail estático de `feature-flags.js`: cero referencias a red, DOM o
   SDKs de IA — es un mecanismo puro, sin ningún efecto secundario.
3. `ResponseProviderContract.implementedBy(RemoteResponseProvider) === true`
   — cumple el mismo contrato que Local y AI, verificado dinámicamente; y
   `ResponseProvider.use(RemoteResponseProvider)` lo acepta como proveedor
   válido.
4. `FeatureFlags.isEnabled()` es `false` por defecto (sin `FEATURE_FLAGS`),
   `false` para cualquier flag no listado explícitamente, y `true`
   únicamente cuando el flag correspondiente está explícitamente en `true`.
5. **Flag desactivado (el estado real de las tres páginas hoy):** las 5
   habilidades de `RemoteResponseProvider` producen exactamente el mismo
   resultado que `LocalResponseProvider` — y `fetch` nunca se invoca.
6. Flag activado sin `REMOTE_PROVIDER_CONFIG`: cae a Local sin invocar
   `fetch`.
7. Flag activado + config presente + `fetch` rechaza (fallo de red): cae a
   Local automáticamente.
8. Flag activado + config presente + `fetch` resuelve con `ok:false`
   (HTTP 500): cae a Local automáticamente.
9. Flag activado + config presente + cuerpo remoto con `skill` que no
   coincide (contrato de forma incumplido): cae a Local automáticamente.
10. Flag activado + config presente + `.json()` rechaza (cuerpo no es JSON
    válido): cae a Local automáticamente.
11. **Caso feliz:** flag activado + config presente + `fetch` resuelve con
    una respuesta válida → se devuelve el cuerpo remoto tal cual (no el de
    Local) — prueba de que la ruta feliz también está genuinamente cableada,
    no solo el fallback.
12. `compareProducts` construye y envía dos `PromptContext` completos e
    independientes (A y B) — verificado inspeccionando el cuerpo real
    capturado de la llamada a `fetch`, no solo el resultado final.
13. Un contexto inválido (`null`) rechaza con el **mismo mensaje exacto**
    que produciría `LocalResponseProvider` directamente — el caso límite
    del throw síncrono dentro de `PromptContextBuilder.build()`.
14. **Los 1.094 productos del catálogo**, con el flag desactivado: las
    habilidades "Explicar producto" y "Precio y disponibilidad" son
    idénticas a Local en cada uno, sin excepciones, y sin una sola llamada
    a `fetch` en todo el recorrido.

Resultado: **14/14 checks OK**, verificado también manualmente contra
`production/data.js` (1.094 productos reales, cero diferencias frente a
Local). Se volvieron a correr las 9 suites anteriores en el mismo
momento — `scripts/verify-context-builder.js` (**10/10**),
`scripts/verify-commercial-data.js` (**8/8**),
`scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**),
`scripts/verify-best-alternative.js` (**10/10**),
`scripts/verify-cross-sell.js` (**10/10**),
`scripts/verify-price-availability.js` (**12/12**),
`scripts/verify-ai-provider-abstraction.js` (**10/10**) y
`scripts/verify-prompt-context-builder.js` (**17/17**) — cero regresión
sobre las Fases 2, 3 y 4 · Pasos 1-2. Ninguna de las nueve suites
necesitó ningún ajuste.

Verificación adicional en navegador (perfil demo): sin errores de consola;
`ResponseProvider.get() === LocalResponseProvider` tras la carga (el flag
sigue sin definirse en las tres páginas); `FeatureFlags.isEnabled('remoteResponseProvider') === false`;
`ResponseProviderContract.implementedBy(RemoteResponseProvider) === true`.
Flujo completo probado en Producto 360: "Venta cruzada inteligente"
(habilidad 5) etiquetada `local` en el panel, generando recomendaciones
reales exactamente igual que antes de este paso — prueba funcional
definitiva de que introducir el mecanismo completo (flag + proveedor
remoto + fallback) sin habilitarlo no altera en absoluto el comportamiento
visible del Copilot.

## Gemini Proxy Server (Fase 4, Paso 4)

### La tensión estructural, resuelta antes de escribir código

El proyecto es, desde el MVP original, explícitamente "sin backend, sin
build step" (`docs/PROJECT_BRIEF.md`). El requisito de este paso —"la API
key debe almacenarse exclusivamente en el backend o mediante variables de
entorno; nunca en el frontend"— es imposible de cumplir sin introducir, por
primera vez en todo el proyecto, una pieza de servidor real: un navegador
no puede leer `process.env`, y cualquier key embebida en `assets/js/`
quedaría visible para cualquiera que abra las herramientas de desarrollador.
Antes de escribir una sola línea se presentó esta tensión al usuario (mismo
patrón ya usado en la Fase 3, Paso 1, ante un límite estructural similar) y
se confirmaron dos decisiones explícitas: (1) sí, construir un servidor
Node real y ejecutable dentro del repositorio; (2) la QA de este paso se
mantiene 100% simulada, sin ninguna llamada real a la API de Gemini ni
necesidad de una key real en esta sesión.

### `server/gemini-proxy-server.js` — la única excepción a "sin backend"

Servidor HTTP mínimo, sin dependencias externas (usa únicamente el módulo
`http` de Node — mismo espíritu "sin build step" que ya rige
`scripts/*.js`), que expone `POST /copilot` y es la única pieza de todo el
sistema que:

1. Conoce el formato real de la API de Gemini (`generateContent`).
2. Lee `GEMINI_API_KEY` — exclusivamente de `process.env`, nunca del cuerpo
   de la petición del cliente (verificado en QA por inspección del código
   fuente, no solo por comportamiento observado).
3. Traduce un `{skill, promptContext}` a un prompt de texto para el modelo
   (`buildPrompt()`) y de vuelta a la forma del contrato
   (`{skill, source:'gemini', generatedAt, ...}`).

```
Navegador                          server/gemini-proxy-server.js              Gemini API
RemoteResponseProvider  ──POST──▶  /copilot (lee GEMINI_API_KEY de env)  ──▶  generateContent
                         ◀─────── {skill, source:'gemini', ...}         ◀───  candidates[...]
```

`assets/js/` (todo lo que se sirve al navegador) no importa ni referencia
este archivo en absoluto — `RemoteResponseProvider` solo conoce "un
endpoint HTTP que responde con la forma del contrato", exactamente el mismo
contrato genérico que ya esperaba desde el Paso 3, antes de que este
servidor existiera.

### Cómo ejecutarlo

```
GEMINI_API_KEY=<tu-key> node server/gemini-proxy-server.js
```

Variables de entorno soportadas (documentadas también en
`server/.env.example`, un archivo de ejemplo sin ningún secreto real):
`GEMINI_API_KEY` (obligatoria para responder con éxito), `GEMINI_MODEL`,
`PORT`, `GEMINI_TIMEOUT_MS`, `ALLOWED_ORIGIN`. Sin `GEMINI_API_KEY`, el
servidor arranca igual (para poder probarse) pero responde `500` a toda
petición real — nunca falla en silencio ni inventa una respuesta.

### Por qué `RemoteResponseProvider` no cambió su relación con Gemini (porque no tiene ninguna)

El único cambio de este paso en `assets/js/providers/remote-response-provider.js`
es agregar manejo de **timeout** (`AbortController`, configurable vía
`REMOTE_PROVIDER_CONFIG.timeoutMs`, con `DEFAULT_TIMEOUT_MS = 8000` de
respaldo) a la llamada `fetch` que ya existía desde el Paso 3. Es una
preocupación de transporte HTTP genérica — cualquier backend detrás del
endpoint la necesitaría, sea Gemini, OpenAI o Claude — por eso vive aquí y
no en `server/gemini-proxy-server.js`. Ningún otro cambio: `callRemote()`
sigue sin saber qué hay detrás de `REMOTE_PROVIDER_CONFIG.endpoint`. Esto
es, literalmente, lo que satisface el requisito de "mantener
RemoteResponseProvider agnóstico al proveedor" — no por una abstracción
nueva que se construyó en este paso, sino porque ese proveedor nunca tuvo
ningún acoplamiento a Gemini que hubiera que quitar. Incorporar OpenAI o
Claude en el futuro significa escribir `server/openai-proxy-server.js` (o
similar) y apuntar `REMOTE_PROVIDER_CONFIG.endpoint` a ese otro proceso —
cero cambios en `remote-response-provider.js`.

### El error síncrono del sandbox de QA, encontrado y corregido antes de reportar resultados

Al agregar el test de timeout a `scripts/verify-remote-response-provider.js`,
la primera corrida no imprimió NINGÚN resultado y terminó con código de
salida 0 — ni un solo check reportado. Causa raíz: `vm.createContext({})`
crea un sandbox vacío que NO incluye `setTimeout`/`clearTimeout`/
`AbortController` (a diferencia de `fetch`, que ya se inyectaba
explícitamente desde el Paso 3). Dentro del sandbox,
`typeof AbortController !== 'undefined'` se evaluaba `false`, así que
`callRemote()` nunca armaba ningún temporizador — el mock de `fetch` del
test de timeout, diseñado para colgarse hasta que se abortara la señal,
literalmente nunca recibía ningún `signal` y quedaba pendiente para
siempre. Sin ningún timer activo, el event loop de Node quedaba vacío a
mitad de un `await` y el proceso terminaba solo, sin haber llegado nunca al
bucle de reporte final. Se corrigió inyectando `setTimeout`, `clearTimeout`
y `AbortController` reales de Node en `freshSandbox()` — el mismo tipo de
gotcha del `vm` de Node ya documentado dos veces antes en este archivo
(top-level `const` no expuesto como propiedad del sandbox), ahora con un
tercer caso: globals de temporización que hay que inyectar explícitamente,
no solo el dataset o los módulos bajo prueba.

### Seguridad: qué se decidió y por qué

- **La API key nunca se acepta desde la petición del cliente** — ni en el
  cuerpo, ni en query string, ni en un header enviado por el navegador.
  Solo se lee una vez, al arrancar el proceso, desde `process.env`.
- **La key se envía a Gemini por header (`x-goog-api-key`), nunca en la URL**
  — evita que quede expuesta en logs de acceso o en el historial de
  cualquier proxy/CDN intermedio.
- **CORS restringido a localhost por defecto.** Sin `ALLOWED_ORIGIN`
  configurado explícitamente, `isOriginAllowed()` solo acepta orígenes
  `http://localhost`/`http://127.0.0.1` — suficiente para desarrollo local,
  y deliberadamente NO permisivo (`*`) por defecto, para que un despliegue
  real tenga que decidir y declarar su origen explícitamente en vez de
  heredar un valor por defecto inseguro.
- **`source`/`generatedAt` los fija el servidor, nunca el modelo** — misma
  disciplina que ya aplica `LocalResponseProvider`: son metadata del
  sistema, no contenido en el que se confíe a ciegas.
- **`.gitignore` ya cubría `.env`/`.env.*`** desde antes de este paso — no
  fue necesario ningún cambio; `server/.env.example` no contiene ningún
  secreto real.

### Fuera de alcance (deliberado, en este paso)

- Sin despliegue real de este servidor a ningún hosting — es un
  script Node ejecutable localmente. Dónde y cómo desplegarlo en
  producción es una decisión pendiente, fuera del alcance de este paso.
- Sin `GEMINI_API_KEY` real configurada en ningún entorno de este
  repositorio ni de esta sesión — por decisión explícita del usuario, toda
  la QA de este paso permanece simulada.
- Sin autenticación adicional entre el frontend y este proxy (más allá de
  CORS) — hoy nada lo necesita, porque ningún perfil del repositorio activa
  el feature flag; sería una decisión a tomar junto con la de despliegue
  real.
- Sin soporte para otros proveedores (OpenAI, Claude) todavía — el diseño
  los deja igual de fáciles de agregar que Gemini (un proxy nuevo,
  independiente), pero construirlos no fue pedido en este paso.
- Sin cambios en `ContextBuilder`, `CommercialDataProvider`, el pipeline
  comercial, `LocalResponseProvider`, `PromptContextBuilder` ni
  `AIResponseProvider` — cero diff en los cinco.

### QA — Remote Response Provider (ampliada) y Gemini Proxy Server (nueva)

**`scripts/verify-remote-response-provider.js`** ganó un check nuevo sobre
los 14 ya existentes del Paso 3 — **15/15 checks OK**:

15. Flag activado + config presente + `fetch` nunca resuelve (cuelgue de
    red simulado, respetando `AbortController` igual que el `fetch` real):
    el timeout configurado (`50ms` en el test) aborta la petición y cae a
    Local automáticamente — verificado también que el tiempo total del test
    es coherente con ese timeout, no con haberse colgado indefinidamente.

**`scripts/verify-gemini-proxy-server.js`** (nuevo) — combina pruebas
unitarias de las funciones internas del servidor con pruebas de servidor
HTTP real (puerto efímero vía `port: 0`) y una prueba end-to-end genuina:

1. El archivo referencia realmente `generativelanguage.googleapis.com` (no
   es otro placeholder inerte) y no referencia SDKs de otros proveedores.
2. La API key nunca se lee desde el cuerpo de la petición del cliente —
   verificado por inspección del código fuente.
3. `buildPrompt()` incluye el contenido real del `PromptContext`, la regla
   explícita de "nunca inventes datos" y el schema de salida esperado para
   ese skill.
4. `isOriginAllowed()`: localhost/127.0.0.1 permitidos por defecto sin
   `ALLOWED_ORIGIN`; con `ALLOWED_ORIGIN` configurado, solo ese origen
   exacto — cualquier otro, rechazado.
5. `callGemini()`: URL con el modelo correcto, API key enviada por header
   (nunca en la URL/query string), respuesta exitosa parseada
   correctamente, `source`/`generatedAt` fijados por el servidor.
6. `callGemini()`: HTTP no exitoso de Gemini, fallo de red, timeout (con
   verificación de que realmente aborta, no solo que "eventualmente
   funciona"), texto no-JSON, y `skill` no coincidente — los 5 modos de
   fallo, cada uno con un mensaje de error claro, ninguno crashea el
   proceso.
7. Servidor real (HTTP genuino en un puerto efímero): responde `500` sin
   `GEMINI_API_KEY` (y nunca intenta llamar a Gemini); `OPTIONS` responde
   `204` con las cabeceras CORS correctas para un origen localhost; ruta o
   método incorrecto responde `404`; cuerpo JSON inválido o `skill`
   desconocido responden `400`; la ruta feliz responde `200` con el cuerpo
   normalizado; un fallo simulado de Gemini responde `502` sin crashear.
8. **END-TO-END genuino**: `RemoteResponseProvider` (cargado en un sandbox
   de `vm`, con el `fetch` REAL de Node inyectado) habla por HTTP real
   contra una instancia real de este proxy (puerto efímero), que a su vez
   usa un `fetchImpl` simulado para "Gemini" — sin ninguna llamada real a
   Google, se prueba el cableado completo de punta a punta: Context Builder
   → PromptContextBuilder → RemoteResponseProvider → HTTP real →
   gemini-proxy-server → "Gemini" simulado → HTTP real de vuelta →
   RemoteResponseProvider devuelve `source:'gemini'` con el contenido
   exacto que "el modelo" produjo.

Resultado: **17/17 checks OK** en `verify-gemini-proxy-server.js`,
**15/15** en `verify-remote-response-provider.js` (con el nuevo check de
timeout). Se volvieron a correr las 9 suites restantes en el mismo
momento — `scripts/verify-context-builder.js` (**10/10**),
`scripts/verify-commercial-data.js` (**8/8**),
`scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**),
`scripts/verify-best-alternative.js` (**10/10**),
`scripts/verify-cross-sell.js` (**10/10**),
`scripts/verify-price-availability.js` (**12/12**),
`scripts/verify-ai-provider-abstraction.js` (**10/10**) y
`scripts/verify-prompt-context-builder.js` (**17/17**) — cero regresión
sobre las Fases 2, 3 y 4 · Pasos 1-3.

Verificación adicional fuera de Node/QA: el servidor se arrancó como
proceso independiente real (`node server/gemini-proxy-server.js`, sin
`GEMINI_API_KEY`) y se le hicieron peticiones HTTP reales con `curl` —
`POST /copilot` respondió `500` con la advertencia esperada, y
`OPTIONS /copilot` con `Origin: http://localhost:5500` respondió `204` con
las cabeceras CORS correctas. Verificación en navegador (perfil demo): sin
errores de consola; `ResponseProvider.get() === LocalResponseProvider` tras
la carga (el flag sigue sin definirse en ninguna página); "Venta cruzada
inteligente" etiquetada `local` en el panel, generando recomendaciones
reales exactamente igual que antes de este paso — el servidor nuevo existe
en el repositorio pero no altera en absoluto el comportamiento del perfil
demo ni del de producción, ninguno de los cuales lo invoca hoy.

## Flujo conversacional real con Gemini (Fase 4, Paso 5)

### Qué significa "conversacional" en este paso (aclarado antes de implementar)

Antes de escribir código se resolvieron tres ambigüedades directamente con
el usuario: (1) "flujo conversacional" significa las 5 habilidades ya
existentes del contrato de `response-provider.js`, respondidas por Gemini
real en vez de simuladas — **no** se agrega un modo de chat multi-turno con
historial, eso habría sido un contrato nuevo, fuera de alcance; (2) la QA
sigue siendo 100% simulada, sin `GEMINI_API_KEY` real ni costo, mismo
criterio que el Paso 4; (3) el feature flag permanece desactivado en los
tres perfiles — ningún comportamiento por defecto cambia. Con esas tres
respuestas, el trabajo de este paso se concentra en **finalizar la
construcción del prompt** y en **ampliar la validación end-to-end** a las 5
habilidades (el Paso 4 solo había probado el flujo completo con una,
"Venta cruzada").

### `server/gemini-prompt-builder.js` — la construcción del prompt, extraída y endurecida

`buildPrompt()`/`SKILL_SCHEMAS` se extrajeron de `gemini-proxy-server.js` a
su propio archivo — misma disciplina de una responsabilidad por módulo que
ya rige el resto del proyecto (Context Builder vs. Response Provider,
PromptContextBuilder vs. LocalResponseProvider). Lo verdaderamente nuevo es
`SKILL_GROUNDING_HINTS`: una instrucción específica por habilidad, además
de la regla genérica "no inventes datos" que ya existía desde el Paso 4.

La razón concreta: "Mejor alternativa" y "Venta cruzada" reciben sus
candidatos ya **pre-filtrados** por `PromptContextBuilder` según la
política R-PIG-04 (excluir confianza Baja — ver Fase 4, Paso 2). Sin una
instrucción explícita, nada le impide al modelo "mejorar" la respuesta
sugiriendo un producto que no está en esa lista ya filtrada — deshaciendo
esa política de negocio en silencio, en la capa que menos control
determinístico tiene sobre el resultado. Los cinco *grounding hints*:

- **explain-product**: usar `productKnowledge`/`commercialContext`; decir
  honestamente cuando no hay disponibilidad, sin inventar precio ni stock.
- **compare-products**: el `PromptContext` trae DOS productos
  independientes en `a`/`b` — no mezclar datos de uno con el otro.
- **best-alternative**: la alternativa devuelta debe ser EXACTAMENTE uno de
  los candidatos ya listados en `alternatives` — nunca uno fuera de esa
  lista, "aunque parezca más adecuado".
- **cross-sell**: las recomendaciones deben ser EXCLUSIVAMENTE candidatos
  ya listados en `crossSell` — mismo principio.
- **price-availability**: si `commercialContext.disponibilidad` es `false`,
  la respuesta debe declarar `disponible:false` con los campos numéricos en
  `null` — nunca reportar disponibilidad que el contexto no confirma.

### La instrucción del prompt es defensa en profundidad, no la única barrera

Un prompt bien escrito reduce cuántas respuestas necesitan corrección, pero
no es una garantía — los LLM pueden ignorar instrucciones. Por eso
`gemini-proxy-server.js` gana una segunda capa, ejecutada DESPUÉS de recibir
la respuesta del modelo, antes de devolverla al cliente:

```js
validateGroundedSkuUsage(skill, promptContext, parsed)
// best-alternative: rechaza si alternativa.sku no está en promptContext.alternatives
// cross-sell: rechaza si CUALQUIER recomendación.sku no está en promptContext.crossSell

validateAvailabilityConsistency(skill, promptContext, parsed)
// price-availability: rechaza disponible:true cuando
// promptContext.commercialContext.disponibilidad === false
```

Ambas se tratan exactamente igual que un `skill` que no coincide (ya
existente desde el Paso 4): lanzan, `callGemini()` rechaza, y
`RemoteResponseProvider` cae automáticamente a `LocalResponseProvider` — el
mismo mecanismo de fallback de siempre, ahora también protegiendo contra
una violación de grounding, no solo contra errores de transporte. Esto es
lo que convierte "el modelo puede alucinar un SKU" de un riesgo real en un
fallback silencioso y seguro, verificado explícitamente en QA con un sku
inventado que el proxy rechaza sin que llegue nunca al panel del Copilot.

### Por qué la validación no cubre los 5 skills por igual

`explain-product` y `compare-products` no tienen una lista cerrada de
candidatos contra la cual validar (son texto/comparación libre sobre datos
ya dados, no una elección entre opciones enumeradas) — no hay un "sku
inventado" posible que detectar ahí de la misma forma. Extender la
validación a esos dos habría significado inventar una regla sin una
violación real y concreta que prevenir — la misma disciplina de "no
construir código especulativo" que ya rige el resto del proyecto.

### QA — Gemini Prompt Builder (nueva) y Gemini Proxy Server (ampliada)

**`scripts/verify-gemini-prompt-builder.js`** (nuevo) — **17/17 checks**:
define exactamente las 5 habilidades en `SKILL_SCHEMAS`/`SKILL_GROUNDING_HINTS`;
cada `buildPrompt(skill, ...)` incluye el skill solicitado, su schema, la
regla genérica y su propia instrucción de grounding — y verificado
explícitamente que NO incluye la instrucción de ninguna otra habilidad;
`best-alternative`/`cross-sell` prohíben explícitamente elegir fuera de sus
listas; `price-availability` exige consistencia con `disponibilidad`;
`compare-products` explica la estructura `a`/`b`; el prompt es
determinístico (función pura); un skill desconocido no crashea.

**`scripts/verify-gemini-proxy-server.js`** ganó, sobre los 17 checks del
Paso 4, 5 checks nuevos — **22/22 checks OK**:

18. `validateGroundedSkuUsage()`: rechaza una alternativa/recomendación con
    un sku fuera de los candidatos reales; acepta skus reales; no lanza
    ante listas vacías o `encontrado:false`.
19. `validateAvailabilityConsistency()`: rechaza `disponible:true` cuando
    el contexto real indica sin cobertura; acepta el caso consistente; no
    aplica a otras habilidades.
20. **END-TO-END actualizado**: el test heredado del Paso 4 usaba un sku
    inventado (`'999'`) para "Venta cruzada" — con la validación nueva, eso
    ahora se rechaza correctamente (el test viejo habría fallado). Se
    corrigió para calcular, de un producto real del catálogo, un candidato
    real de `crossSell` y usar ESE sku en la respuesta simulada del modelo.
21. **END-TO-END (grounding)**: un sku de `crossSell` inventado por el
    "Gemini" simulado se rechaza y cae a Local — verificado que la
    respuesta que llega al cliente nunca trae `source:'gemini'` en ese
    caso.
22. **END-TO-END (5 habilidades)**: cada una de las 5 habilidades, con un
    `PromptContext` real construido desde el catálogo real, recibe
    correctamente una respuesta remota `source:'gemini'` a través de HTTP
    real de punta a punta — no solo "Venta cruzada" como en el Paso 4.

Resultado: **22/22** en `verify-gemini-proxy-server.js`, **17/17** en
`verify-gemini-prompt-builder.js`. Se volvieron a correr las 10 suites
restantes en el mismo momento —
`scripts/verify-context-builder.js` (**10/10**),
`scripts/verify-commercial-data.js` (**8/8**),
`scripts/verify-response-provider.js` (**9/9**),
`scripts/verify-compare-products.js` (**10/10**),
`scripts/verify-best-alternative.js` (**10/10**),
`scripts/verify-cross-sell.js` (**10/10**),
`scripts/verify-price-availability.js` (**12/12**),
`scripts/verify-ai-provider-abstraction.js` (**10/10**),
`scripts/verify-prompt-context-builder.js` (**17/17**) y
`scripts/verify-remote-response-provider.js` (**15/15**) — cero regresión
sobre las Fases 2, 3 y 4 · Pasos 1-4. **Total: 160/160 checks.**

Verificación adicional fuera de Node/QA: el servidor, ya con
`gemini-prompt-builder.js` extraído, se volvió a arrancar como proceso
independiente real y respondió correctamente por HTTP real (`curl`).
Verificación en navegador (perfil demo): sin errores de consola,
`ResponseProvider.get() === LocalResponseProvider` sin cambios — este paso
no modificó ningún archivo servido al navegador (`assets/js/`), solo
`server/` y `scripts/`, así que no había ningún comportamiento de UI que
pudiera haber cambiado.
