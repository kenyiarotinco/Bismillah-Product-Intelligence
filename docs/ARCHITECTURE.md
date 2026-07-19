# ARCHITECTURE — AI Sales Copilot: Context Builder & Response Provider (Fase 2)

Este documento cubre los dos módulos de datos/lógica que sostienen al AI
Sales Copilot, en el orden en que los atraviesa una petición:

```
Usuario → AI Sales Copilot (panel, app.js) → Context Builder → Response Provider → Respuesta en el panel
```

- **Context Builder** (Paso 2): construye el contexto de un producto.
- **Response Provider** (Paso 3): a partir de ese contexto, genera la
  respuesta de una habilidad concreta del Copilot (por ahora, solo
  "Explicar producto").

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

## Response Provider (Fase 2, Paso 3)

### Responsabilidad

Dado el contexto que entrega `ContextBuilder.build()`, generar la respuesta
de texto de una habilidad concreta del Copilot. En este paso, una sola
habilidad: **Explicar producto**. El módulo no sabe nada de productos, del
grafo o de `DATA` — solo sabe transformar el objeto `context` que recibe en
un `{skill, source, generatedAt, text}`. Tampoco decide cuándo se le invoca
ni dónde se pinta la respuesta: eso lo orquesta `app.js` (ver más abajo).

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
`onExplainProductClick()`). No se extrajo a un archivo aparte porque, a
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
ResponseProvider.use(provider)   // registra el proveedor activo; valida que implemente explainProduct()
ResponseProvider.get()           // devuelve el proveedor activo; lanza si no hay ninguno
ResponseProvider.isReady()       // true/false

// Contrato que debe cumplir cualquier proveedor:
provider.explainProduct(context) => Promise<{
  skill: 'explain-product',
  source: string,        // 'local' | 'gemini' | ...
  generatedAt: string,   // ISO 8601
  text: string,
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

- Las otras cuatro habilidades (Comparar productos, Precio y disponibilidad,
  Mejor alternativa, Venta cruzada inteligente) siguen en "Próximamente",
  sin `data-skill` ni listener — el contrato de `ResponseProvider` solo
  exige `explainProduct` hoy; se ampliará método por método cuando cada
  habilidad tenga su propia especificación aprobada.
- No hay proveedor Gemini, ni configuración de API key, ni ningún código de
  red — ver la sección anterior sobre qué queda pendiente para ese paso.
- No hay caché de respuestas entre productos ni entre sesiones: cada clic
  reconstruye el contexto y regenera el texto. Con un proveedor local
  instantáneo no hay necesidad real de cachear; puede revisarse cuando el
  costo (latencia o cuota de API) de un proveedor real lo justifique.

### QA — Response Provider

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
