# ARCHITECTURE — AI Sales Copilot: Context Builder & Response Provider (Fase 2)

Este documento cubre los dos módulos de datos/lógica que sostienen al AI
Sales Copilot, en el orden en que los atraviesa una petición:

```
Usuario → AI Sales Copilot (panel, app.js) → Context Builder → Response Provider → Respuesta en el panel
```

- **Context Builder** (Paso 2): construye el contexto de un producto.
- **Response Provider** (Pasos 3-6): a partir de uno o más contextos, genera
  la respuesta de una habilidad concreta del Copilot — hoy, "Explicar
  producto" (Paso 3), "Comparar productos" (Paso 4), "Mejor alternativa"
  (Paso 5) y "Venta cruzada inteligente" (Paso 6).

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

## Response Provider (Fase 2, Pasos 3-6)

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
ResponseProvider.use(provider)   // registra el proveedor activo; valida que implemente las 4 habilidades del contrato
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
