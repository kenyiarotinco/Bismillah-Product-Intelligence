/* Bismillah Product Intelligence Platform — Response Provider Contract (Fase 4, Paso 1)
 *
 * Interfaz común, formal y nombrada, que debe implementar cualquier
 * proveedor de respuestas del AI Sales Copilot — hoy `LocalResponseProvider`
 * (activo) y `AIResponseProvider` (placeholder arquitectónico, inactivo,
 * preparado para una fase posterior). Antes de este paso, ese contrato
 * existía solo como un array interno (`REQUIRED_METHODS`) dentro de
 * `response-provider.js`; este módulo lo extrae a un lugar único y
 * reutilizable para que cualquier proveedor —presente o futuro— se valide
 * contra la misma definición, sin duplicarla.
 *
 * Este módulo no ejecuta ninguna habilidad, no conoce a `ContextBuilder`,
 * no hace red ni IA — es solo la forma que un proveedor debe tener. La
 * documentación completa de qué devuelve cada método (forma exacta de la
 * Promise resuelta) sigue viviendo en `response-provider.js`, que es quien
 * efectivamente registra y usa al proveedor activo.
 */
'use strict';

const ResponseProviderContract = (function () {
  // Un método por cada habilidad aprobada del Copilot (Fase 2, Pasos 3-6;
  // Fase 3, Paso 2) — mismo orden y mismos nombres que ya usaba
  // REQUIRED_METHODS en response-provider.js antes de este paso.
  const METHODS = ['explainProduct', 'compareProducts', 'bestAlternative', 'crossSell', 'priceAndAvailability'];

  function missingMethods(provider) {
    if (!provider) return [...METHODS];
    return METHODS.filter(m => typeof provider[m] !== 'function');
  }

  function implementedBy(provider) {
    return missingMethods(provider).length === 0;
  }

  return { METHODS, implementedBy, missingMethods };
})();
