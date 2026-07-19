/* Bismillah Product Intelligence Platform — Response Provider (Fase 2, Pasos 3-4)
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
 * Habilidades futuras (Precio y disponibilidad, Mejor alternativa, Venta
 * cruzada) se añadirán a este mismo contrato como nuevos métodos cuando se
 * aprueben sus propios pasos — no antes, para no comprometerse hoy con una
 * forma que todavía no se ha diseñado.
 */
'use strict';

const ResponseProvider = (function () {
  const REQUIRED_METHODS = ['explainProduct', 'compareProducts'];
  let active = null;

  function assertShape(provider) {
    if (!provider) throw new Error('ResponseProvider.use: el proveedor no puede ser nulo/indefinido.');
    for (const method of REQUIRED_METHODS) {
      if (typeof provider[method] !== 'function') {
        throw new Error(`ResponseProvider.use: el proveedor no implementa "${method}(context)".`);
      }
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
