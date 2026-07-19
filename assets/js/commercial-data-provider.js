/* Bismillah Product Intelligence Platform — Commercial Data Provider (Fase 3, Paso 1)
 *
 * Adaptador que encapsula el acceso a los datos comerciales reales
 * (precio, stock, estado, diferencia de precio) de este catálogo. Es la
 * ÚNICA pieza del sistema que sabe que esos datos viven en el global
 * `window.COMMERCIAL_DATA` — Context Builder nunca lo lee directamente, ni
 * conoce el pipeline externo que lo genera (ver
 * scripts/import-commercial-data.js): solo llama a
 * `CommercialDataProvider.getBySku(sku)` y recibe un registro ya
 * normalizado, o `null`.
 *
 * `window.COMMERCIAL_DATA` se carga desde `production/commercial-data.js`
 * — un archivo generado localmente, gitignored, con datos comerciales
 * reales y sensibles (nunca se commitea, mismo tratamiento que
 * `production/data.js`). En el perfil demo público ese archivo no existe:
 * `COMMERCIAL_DATA` queda `undefined` y `getBySku()` devuelve `null` para
 * cualquier SKU — el comportamiento es idéntico al de antes de este paso.
 */
'use strict';

const CommercialDataProvider = (function () {
  function bySkuMap() {
    return (typeof COMMERCIAL_DATA !== 'undefined' && COMMERCIAL_DATA && COMMERCIAL_DATA.bySku) || null;
  }

  /**
   * @param {number|string} sku
   * @returns {{precio:number|null, stock:number|null, estado:string|null, priceDifference:number|null}|null}
   *   `null` si no hay dataset comercial cargado, o si este SKU no tiene registro en él.
   */
  function getBySku(sku) {
    const map = bySkuMap();
    if (!map) return null;
    return map[String(sku)] || null;
  }

  function isAvailable() {
    return bySkuMap() !== null;
  }

  return { getBySku, isAvailable };
})();
