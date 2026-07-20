# Validación manual con la API real de Gemini (Fase 4, Paso 6)

Esta guía es para un humano, no para CI ni para la suite automática. La
regresión de este proyecto (`node scripts/verify-*.js`) sigue siendo, a
propósito, 100% simulada — sin `GEMINI_API_KEY` real, sin costo — desde la
Fase 4, Paso 4. Esta guía cubre la única parte que la suite automática no
puede probar por diseño: que la integración funciona contra la API real de
Google, no solo contra un `fetch` simulado.

Nada de lo que se describe aquí deja rastro en el repositorio. Ningún
archivo versionado define `FEATURE_FLAGS` ni `REMOTE_PROVIDER_CONFIG` en
ningún perfil — el comportamiento por defecto de `index.html`,
`production.example/index.html` y `production/index.html` no cambió en
este paso, y no cambia por seguir esta guía.

## Antes de empezar

- Una API key real de Gemini, obtenida en
  [Google AI Studio](https://aistudio.google.com/). Trátala como cualquier
  otra credencial: no la pegues en un chat, no la commitees, no la dejes en
  un archivo versionado.
- Node.js instalado (el mismo que ya usa este repositorio para
  `scripts/*.js` — sin dependencias adicionales).
- Que la GEMINI_API_KEY corresponda a un proyecto de Google Cloud con
  facturación habilitada para la Gemini API — cada llamada de esta guía
  tiene un costo real, aunque pequeño.

## Paso 1 — Validación por línea de comandos (recomendado, más simple)

`scripts/manual-gemini-live-check.js` ejecuta, contra la API real, el mismo
camino de código que usaría la aplicación si el feature flag estuviera
activo: `RemoteResponseProvider` → `server/gemini-proxy-server.js` →
Gemini real. Es deliberadamente incómodo de ejecutar por accidente — exige
dos cosas explícitas:

```bash
GEMINI_API_KEY=<tu-key> node scripts/manual-gemini-live-check.js --confirmo-el-costo
```

Por defecto prueba la habilidad `explain-product` sobre el producto de
índice `0`. Para probar otra habilidad o producto:

```bash
GEMINI_API_KEY=<tu-key> node scripts/manual-gemini-live-check.js --confirmo-el-costo --skill=cross-sell --producto=52
GEMINI_API_KEY=<tu-key> node scripts/manual-gemini-live-check.js --confirmo-el-costo --skill=best-alternative --producto=17
GEMINI_API_KEY=<tu-key> node scripts/manual-gemini-live-check.js --confirmo-el-costo --skill=compare-products --producto=0
GEMINI_API_KEY=<tu-key> node scripts/manual-gemini-live-check.js --confirmo-el-costo --skill=price-availability --producto=0
```

Skills válidos: `explain-product`, `compare-products`, `best-alternative`,
`cross-sell`, `price-availability` (los mismos 5 de siempre — ver
`docs/ARCHITECTURE.md`, sección "Response Provider").

### Qué hace el script, exactamente

1. Arranca `server/gemini-proxy-server.js` como un proceso real, en tu
   máquina, en un puerto libre — con tu `GEMINI_API_KEY` real.
2. Construye un `PromptContext` real del producto indicado (mismo
   `ContextBuilder` + `PromptContextBuilder` que usa la aplicación).
3. **[1/2]** Hace una llamada HTTP directa al proxy (sin pasar por
   `RemoteResponseProvider`) para que veas el HTTP status y el cuerpo
   exacto que devolvió — incluyendo el mensaje de error si algo falla, ya
   que el fallback automático del paso siguiente lo ocultaría.
4. **[2/2]** Hace la misma llamada, esta vez a través de
   `RemoteResponseProvider` — el camino real que usaría el panel del
   Copilot si el flag estuviera activo.
5. Al final, cierra el proceso del proxy.

### Qué revisar en la salida

- **`source: "gemini"`** en el resultado del paso [2/2] — significa que la
  respuesta vino realmente del modelo, no del fallback local.
- Si en cambio ves `source: "local"`, revisa el HTTP status y el cuerpo del
  paso [1/2]: ahí está la causa exacta (API key inválida, modelo no
  disponible, límite de cuota, la respuesta del modelo no cumplió el
  contrato — ver "Qué puede fallar y por qué" más abajo).
- Que el contenido (`text`, `similitudes`, `recomendaciones`, etc.) hable
  del producto real que pediste, no de datos genéricos — confirma que el
  `PromptContext` realmente llegó al modelo y que el modelo lo usó.

### Qué puede fallar, y por qué (todo cae a Local automáticamente — ver Fase 4, Pasos 3-5)

| Síntoma en [1/2] | Causa | Dónde revisar |
|---|---|---|
| HTTP 500, "GEMINI_API_KEY no está configurada" | La key no llegó al proceso | Confirma que exportaste `GEMINI_API_KEY` en la misma shell |
| HTTP 502, "Gemini API respondió 400/403" | Key inválida o sin permisos | Revisa la key en Google AI Studio |
| HTTP 502, "Gemini API respondió 429" | Límite de cuota/tasa alcanzado | Espera o revisa tu cuota en Google Cloud |
| HTTP 502, "tiempo de espera agotado" | Timeout (`GEMINI_TIMEOUT_MS`, default 25000ms) | Revisa la categoría sanitizada en Vercel antes de ajustar `GEMINI_TIMEOUT_MS` |
| HTTP 502, "no cumple la forma esperada del contrato" | El modelo devolvió otro `skill` o una estructura interna incompleta/incompatible | El proxy la rechaza antes del navegador y `RemoteResponseProvider` cae automáticamente a Local |
| HTTP 502, "no está entre los candidatos provistos" | El modelo eligió un SKU fuera de `alternatives`/`crossSell` (grounding, Fase 4 Paso 5) | Esperado ocasionalmente; el fallback a Local es exactamente la protección diseñada para esto |
| HTTP 502, "reportó disponibilidad cuando..." | El modelo contradijo `commercialContext.disponibilidad` | Misma protección de grounding que el caso anterior |

Ninguno de estos casos requiere ninguna acción de emergencia — es
exactamente el fallback automático ya verificado en QA (Fase 4, Pasos 3-5)
funcionando como se diseñó.

### Observabilidad sanitizada en Vercel

Cada invocación válida de `/api/copilot` emite una única línea con prefijo
`[copilot]`. El JSON contiene solamente `event`, `skill`, `outcome`,
`durationMs` y, cuando hay error, `category`. Las categorías posibles son
`timeout`, `upstream_http`, `network`, `invalid_response`,
`contract_mismatch`, `grounding_rejected` y `unknown`.

Los logs nunca incluyen la API key, `PromptContext`, nombres o SKU, el texto
generado ni el mensaje interno del proveedor. La escritura del log es
best-effort: un fallo del logger no altera la respuesta ni el fallback.
Una respuesta que conserve el `skill` correcto pero omita campos requeridos
también se registra como `contract_mismatch`; nunca se registra el cuerpo
defectuoso.

## Paso 2 — Validación visual en el navegador (opcional, más profunda)

Si además quieres verlo funcionando en el panel real del Copilot:

1. Arranca el proxy en una terminal aparte:
   ```bash
   GEMINI_API_KEY=<tu-key> node server/gemini-proxy-server.js
   ```
   Anota el puerto que imprime (por defecto `8787`).
2. Sirve el perfil demo localmente (por ejemplo `npx serve .` desde la raíz
   del repo, o cualquier servidor estático — el mismo que ya usas para
   desarrollo).
3. En el navegador, ANTES de abrir la página, no hay forma de inyectar
   `FEATURE_FLAGS`/`REMOTE_PROVIDER_CONFIG` a tiempo (la línea
   `ResponseProvider.use(...)` de `app.js` los lee una sola vez, al cargar
   la página — ver `docs/ARCHITECTURE.md`, sección "Gemini Proxy Server").
   La forma más simple de probarlo de verdad es agregar TEMPORALMENTE, en
   tu copia local de `index.html` (nunca la commitees así), dos líneas
   antes de `<script src="assets/js/feature-flags.js">`:
   ```html
   <script>
     var FEATURE_FLAGS = { remoteResponseProvider: true };
     var REMOTE_PROVIDER_CONFIG = { endpoint: 'http://localhost:8787/copilot' };
   </script>
   ```
4. Recarga la página, abre Producto 360, usa cualquiera de las 5
   habilidades del Copilot. La etiqueta junto al nombre de la habilidad
   (que hoy siempre dice `local`) debería decir `gemini`.
5. **Revierte el cambio en `index.html` antes de continuar** (`git
   checkout -- index.html`, o simplemente no lo commitees) — el
   comportamiento por defecto del repositorio no debe cambiar.

## Criterios de aprobación de la validación manual

Una corrida se considera **satisfactoria** solo si se cumplen las cinco
condiciones siguientes. No basta con que el script termine sin lanzar una
excepción de Node — eso solo prueba que el *tooling* funciona, no que la
integración con Gemini es correcta.

1. **`source: "gemini"` en el resultado del paso [2/2]**, no `"local"`. Si
   cayó a Local, la corrida no es una validación de Gemini — es, como
   mucho, una confirmación (ya cubierta por QA automática) de que el
   fallback funciona.
2. **El paso [1/2] respondió HTTP 200**, sin ningún mensaje de error en el
   cuerpo. Un HTTP 200 en [1/2] junto con `source:"local"` en [2/2] sería
   contradictorio y merece investigarse aparte, no solo repetirse.
3. **El contenido está grounded en el producto real solicitado** — el
   texto/las recomendaciones mencionan datos verificables de ese producto
   específico (nombre, subcategoría, beneficios reales, etc.), no una
   respuesta genérica que serviría para cualquier producto.
4. **Para `best-alternative`/`cross-sell`: el/los sku(s) devueltos
   corresponden a candidatos reales** que el usuario puede verificar contra
   el catálogo (más allá de que el proxy ya los valida server-side —
   `validateGroundedSkuUsage`, Fase 4 Paso 5 — confirmarlo visualmente es
   parte de la aprobación humana, no solo de la validación automática).
5. **Se probó al menos `explain-product` y una habilidad con candidatos
   filtrados** (`best-alternative` o `cross-sell`) — la primera confirma
   que el modelo puede generar texto libre grounded; la segunda, que
   respeta la restricción de elegir solo entre candidatos ya filtrados por
   R-PIG-04. Probar únicamente `explain-product` no es suficiente para
   aprobar el paso: no ejercita el grounding de candidatos en absoluto.

Si alguna corrida no cumple estas condiciones, no se marca como aprobada —
se investiga con la tabla de "Qué puede fallar, y por qué" de arriba, se
corrige lo que corresponda, y se repite.

## Cuándo hay que repetir esta validación

La validación manual no caduca por tiempo, pero sí queda **obsoleta** ante
cualquiera de estos cambios — deben re-ejecutarse al menos los cinco
criterios de arriba antes de considerar el cambio correspondiente
verificado de punta a punta:

| Cambio | Por qué invalida la validación previa |
|---|---|
| `server/gemini-prompt-builder.js` (schema, texto del prompt, o cualquier `SKILL_GROUNDING_HINTS`) | El prompt que recibe Gemini es literalmente otro — una validación de la versión anterior no dice nada de la nueva |
| `server/gemini-proxy-server.js` (`callGemini`, `validateGroundedSkuUsage`, `validateAvailabilityConsistency`, o el modelo/`GEMINI_MODEL`) | Cambia cómo se llama a Gemini, cómo se valida su respuesta, o qué modelo responde |
| `assets/js/prompt-context-builder.js` (estructura del `PromptContext`) | El prompt embebe el `PromptContext` tal cual — una estructura distinta puede confundir al modelo o romper el parseo de la respuesta |
| `assets/js/response-provider-contract.js` (las 5 habilidades o su forma) | El schema que se le pide a Gemini en cada prompt está atado 1:1 a este contrato |
| `assets/js/providers/remote-response-provider.js` (timeout, fallback, o cómo arma el payload) | Cambia el camino real [2/2] que la validación ejercita |
| Una nueva versión de la API de Gemini, o cambio del `GEMINI_MODEL` configurado | El comportamiento del modelo (formato de salida, calidad del grounding) puede diferir entre versiones/modelos |

**No** hace falta repetir la validación manual ante cambios en
`LocalResponseProvider`, `ContextBuilder`, `CommercialDataProvider`, el
pipeline comercial, o cualquier parte de la UI (`app.js`,
`assets/css/styles.css`) que no toque la orquestación del Copilot — ninguno
de esos archivos participa en el camino hacia Gemini, y ya están cubiertos
por sus propias suites automáticas.

## Resumen de las salvaguardas (verificadas en la suite automática)

`scripts/verify-manual-gemini-check-safeguards.js` (parte de la regresión
normal, sin costo) confirma que `manual-gemini-live-check.js`:

- Nunca acepta la API key por línea de comandos — solo por variable de
  entorno.
- Se niega a hacer cualquier llamada sin el flag explícito
  `--confirmo-el-costo`.
- Rechaza un `--skill` desconocido antes de intentar nada.

Estas tres salvaguardas son la razón por la que este script puede vivir en
el repositorio sin riesgo de ejecutarse por accidente en ningún flujo
automático.
