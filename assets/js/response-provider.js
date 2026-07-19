/* Bismillah Product Intelligence Platform — Response Provider (Fase 2, Pasos 3-6; Fase 3, Paso 2; Fase 4, Paso 1)
 *
 * Puerto/contrato que desacopla al AI Sales Copilot de CÓMO se generan sus
 * respuestas. Cualquier proveedor —el local de hoy, o más adelante Google
 * Gemini u otro— se conecta aquí sin que el resto del sistema (el panel del
 * Copilot, el Context Builder, Producto 360) sepa ni le importe cuál está
 * activo.
 *
 * Contrato que debe cumplir un proveedor, método por método, uno por cada
 * habilidad ya aprobada del Copilot:
 *
 *   explainProduct(context) => Promise<{
 *     skill: 'explain-product',
 *     source: string,        // identifica al proveedor, p.ej. 'local' | 'gemini'
 *     generatedAt: string,   // ISO 8601
 *     text: string,          // explicación lista para mostrar en el panel
 *   }>
 *
 *   compareProducts(contextA, contextB) => Promise<{
 *     skill: 'compare-products',
 *     source: string,
 *     generatedAt: string,
 *     productos: { a: ProductoResumen, b: ProductoResumen },
 *     similitudes: string[],
 *     diferencias: string[],
 *   }>
 *   // ProductoResumen: { sku, nombre, universo, categoria, beneficios[],
 *   //   etiquetas[], relaciones:{total, porTipo} } — ver
 *   // providers/local-response-provider.js para el detalle exacto.
 *
 *   bestAlternative(context) => Promise<{
 *     skill: 'best-alternative',
 *     source: string,
 *     generatedAt: string,
 *     encontrado: boolean,
 *     alternativa: { sku: string, nombre: string } | null,
 *     afinidad: 'Alta' | 'Media' | null,   // confianza de la relación SUSTITUYE elegida
 *     justificacion: string | null,        // texto listo para mostrar
 *     mensaje: string | null,              // presente solo si encontrado === false
 *   }>
 *
 *   crossSell(context) => Promise<{
 *     skill: 'cross-sell',
 *     source: string,
 *     generatedAt: string,
 *     recomendaciones: Array<{ sku: string, nombre: string, razon: string }>,
 *     // ordenadas por relevancia (mayor score primero) — ver
 *     // providers/local-response-provider.js para el criterio exacto.
 *     mensaje: string | null,   // presente solo si recomendaciones está vacío
 *   }>
 *
 *   priceAndAvailability(context) => Promise<{
 *     skill: 'price-availability',
 *     source: string,
 *     generatedAt: string,
 *     disponible: boolean,
 *     precio: number | null,           // precio final — viene de context.comercial.precio
 *     precioLista: number | null,      // derivado: precio + priceDifference, cuando ambos existen
 *     priceDifference: number | null,  // viene de context.comercial.priceDifference (NO es margen)
 *     stock: number | null,
 *     estado: string | null,
 *     mensaje: string | null,          // presente solo si disponible === false
 *   }>
 *   // Esta habilidad NUNCA llama a CommercialDataProvider ni lee
 *   // COMMERCIAL_DATA por su cuenta — solo lee el bloque `comercial` que
 *   // Context Builder ya construyó (Fase 3, Paso 1). Ese bloque es, en sí
 *   // mismo, la única vía por la que un dato comercial entra al sistema.
 *
 * `context`/`contextA`/`contextB` son exactamente los objetos que devuelve
 * ContextBuilder.build() — ningún proveedor recibe ni el DOM, ni el índice
 * del producto, ni nada de app.js.
 *
 * Por qué el contrato es async incluso hoy, con un proveedor 100% local y
 * síncrono: el código que consume el proveedor (el panel del Copilot) ya
 * está escrito contra una Promise, así que cuando el proveedor activo pase
 * a ser una llamada de red real (Gemini), esa latencia no obliga a tocar ni
 * una línea del código que lo invoca — solo cambia cuánto tarda en
 * resolverse la misma Promise que ya se estaba esperando.
 *
 * Con `priceAndAvailability` quedan las 5 habilidades planificadas del
 * Copilot implementadas en el contrato.
 *
 * Fase 4, Paso 1: la lista de métodos exigidos ya no vive aquí como un
 * array propio — se delega a `ResponseProviderContract`
 * (response-provider-contract.js), la interfaz común y nombrada que
 * cualquier proveedor (local o de IA) debe cumplir. `use()`, `get()` e
 * `isReady()` mantienen exactamente la misma forma y el mismo mensaje de
 * error de antes — es una extracción, no un cambio de comportamiento.
 */
'use strict';

const ResponseProvider = (function () {
  let active = null;

  function assertShape(provider) {
    if (!provider) throw new Error('ResponseProvider.use: el proveedor no puede ser nulo/indefinido.');
    const missing = ResponseProviderContract.missingMethods(provider);
    if (missing.length) {
      throw new Error(`ResponseProvider.use: el proveedor no implementa "${missing[0]}(context)".`);
    }
  }

  // Único punto de reemplazo del proveedor activo. Cambiar de proveedor local
  // a Gemini (u otro) en el futuro se reduce a UNA llamada a use() con la
  // nueva implementación — ver la línea equivalente ya cableada en app.js y
  // docs/ARCHITECTURE.md.
  function use(provider) {
    assertShape(provider);
    active = provider;
  }

  function get() {
    if (!active) {
      throw new Error(
        'ResponseProvider: no hay proveedor activo. Llama a ResponseProvider.use(proveedor) antes de pedir una respuesta.'
      );
    }
    return active;
  }

  function isReady() {
    return active !== null;
  }

  return { use, get, isReady };
})();
