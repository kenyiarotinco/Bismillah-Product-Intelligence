/* Bismillah Product Intelligence Platform — AI Response Provider (Fase 4, Paso 1)
 *
 * Placeholder arquitectónico: implementa la misma interfaz que
 * LocalResponseProvider (ResponseProviderContract — ver
 * response-provider-contract.js), pero sin ninguna lógica real. Cada
 * método rechaza su Promise de inmediato con un error que dice,
 * literalmente, "todavía no implementado" — no hay IA, no hay red, no hay
 * SDK de ningún proveedor (Gemini, OpenAI o cualquier otro), ni una sola
 * llamada externa.
 *
 * Este archivo se carga en las tres páginas (perfil demo y perfil de
 * producción) para que exista como global, exactamente igual que
 * LocalResponseProvider — pero NADA en app.js lo activa todavía:
 * `ResponseProvider.use(LocalResponseProvider)` sigue siendo, en este
 * paso, la única línea que decide qué proveedor sirve al Copilot. Activar
 * `AIResponseProvider` (o sustituirlo por una implementación real de IA)
 * es, para cuando llegue ese paso, cambiar esa única línea — nada más en
 * el sistema necesita tocarse, exactamente la garantía que ya documenta
 * response-provider.js.
 *
 * Se puede registrar hoy mismo con `ResponseProvider.use(AIResponseProvider)`
 * en una consola o en un test (cumple el contrato), pero cualquier llamada
 * a sus métodos rechazará — nunca devuelve una respuesta fabricada.
 */
'use strict';

const AIResponseProvider = (function () {
  const NOT_IMPLEMENTED = method => Promise.reject(
    new Error(`AIResponseProvider.${method}: proveedor de IA todavía no implementado — placeholder arquitectónico (Fase 4, Paso 1).`)
  );

  return {
    explainProduct: () => NOT_IMPLEMENTED('explainProduct'),
    compareProducts: () => NOT_IMPLEMENTED('compareProducts'),
    bestAlternative: () => NOT_IMPLEMENTED('bestAlternative'),
    crossSell: () => NOT_IMPLEMENTED('crossSell'),
    priceAndAvailability: () => NOT_IMPLEMENTED('priceAndAvailability'),
  };
})();
