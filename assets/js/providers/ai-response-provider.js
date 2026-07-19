/* Bismillah Product Intelligence Platform — AI Response Provider (Fase 4 Paso 1; Fase 5 Paso 1)
 *
 * Fase 5, Paso 1: deja de ser un placeholder que siempre rechaza y pasa a
 * ser el proveedor de IA real — Gemini, hoy — pero SIN reimplementar nada:
 * es un delegado puro y transparente hacia RemoteResponseProvider, que ya
 * hace exactamente todo lo que este paso pide (consumir PromptContext,
 * enviar la solicitud al proxy, devolver la respuesta de Gemini, caer a
 * LocalResponseProvider ante cualquier error) desde la Fase 4, Pasos 3-5.
 * Cero lógica nueva, cero duplicación — "Implementar únicamente
 * AIResponseProvider" significa, aquí, una capa de una línea por método.
 *
 * Por qué existen AMBOS módulos (RemoteResponseProvider y AIResponseProvider)
 * en vez de fusionarlos:
 *   - RemoteResponseProvider es el mecanismo de transporte, deliberadamente
 *     agnóstico al proveedor (Fase 4, Paso 3): sabe hablar HTTP con
 *     cualquier endpoint que cumpla el contrato, sin saber ni que Gemini
 *     existe. Es reutilizable tal cual el día que exista un
 *     OpenAIResponseProvider o ClaudeResponseProvider — cada uno delegaría
 *     en RemoteResponseProvider exactamente igual que este archivo.
 *   - AIResponseProvider es el nombre con el que el resto del sistema
 *     (`ResponseProvider`, `app.js`) conoce "el proveedor de IA" — la cara
 *     pública y estable del concepto, independiente de qué mecanismo de
 *     transporte use por dentro. Es el mismo global que ya existía como
 *     placeholder desde la Fase 4, Paso 1: este paso lo completa, no lo
 *     reemplaza por otro archivo.
 *
 * "Consumir exclusivamente PromptContext": este archivo nunca lee ni
 * interpreta ningún campo de `context` (el objeto que produce
 * ContextBuilder.build()) — lo recibe únicamente porque el
 * ResponseProviderContract exige esa firma para cualquier proveedor
 * registrable, y lo relaya sin tocarlo. La conversión real de Context a
 * PromptContext —la única transformación que sí importa— ocurre enteramente
 * dentro de RemoteResponseProvider (`PromptContextBuilder.build()`), nunca
 * aquí.
 *
 * Fallback: no se implementa aquí porque ya está completamente resuelto un
 * nivel más abajo. RemoteResponseProvider cubre, él solo, los seis modos de
 * fallo mínimos exigidos por este paso — timeout, error HTTP, respuesta
 * vacía (JSON.parse falla igual que con JSON inválido), JSON inválido,
 * error del proxy, y una respuesta del modelo que no cumple el contrato— y
 * en todos los casos devuelve exactamente lo que LocalResponseProvider
 * hubiera devuelto, nunca una Promise sin resolver ni un error técnico
 * visible para el usuario. Ver assets/js/providers/remote-response-
 * provider.js y docs/ARCHITECTURE.md (Fase 4, Pasos 3-5) para el detalle
 * completo, ya verificado en QA.
 *
 * Activación: este archivo NO se registra en app.js — `ResponseProvider.use(...)`
 * sigue seleccionando entre LocalResponseProvider y RemoteResponseProvider
 * según el feature flag (sin cambios en este paso). AIResponseProvider
 * existe, cumple el contrato, y es completamente funcional si se registra
 * manualmente — pero activarlo en la aplicación real es una decisión fuera
 * del alcance de este paso ("Implementar únicamente AIResponseProvider").
 */
'use strict';

const AIResponseProvider = (function () {
  return {
    explainProduct: context => RemoteResponseProvider.explainProduct(context),
    compareProducts: (contextA, contextB) => RemoteResponseProvider.compareProducts(contextA, contextB),
    bestAlternative: context => RemoteResponseProvider.bestAlternative(context),
    crossSell: context => RemoteResponseProvider.crossSell(context),
    priceAndAvailability: context => RemoteResponseProvider.priceAndAvailability(context),
  };
})();
