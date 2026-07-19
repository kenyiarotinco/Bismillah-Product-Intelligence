/* Bismillah Product Intelligence Platform — Remote Response Provider (Fase 4, Pasos 3-4)
 *
 * Primer consumidor real de PromptContextBuilder: cumple exactamente el
 * mismo ResponseProviderContract que LocalResponseProvider y AIResponseProvider
 * (verificado dinámicamente en QA), pero para cada habilidad transforma el
 * `context` con `PromptContextBuilder.build()` y lo envía por HTTP a un
 * endpoint configurable — en vez de sintetizar la respuesta por reglas
 * locales, como hace LocalResponseProvider, o rechazar siempre, como hace
 * AIResponseProvider hoy.
 *
 * Activación: gobernada enteramente por el feature flag
 * `remoteResponseProvider` (ver assets/js/feature-flags.js). Ningún perfil
 * de este repositorio lo habilita hoy — `app.js` sigue seleccionando
 * LocalResponseProvider exactamente como antes de este paso (ver la línea
 * `ResponseProvider.use(...)` en app.js). Aunque alguien flipeara el flag,
 * el comportamiento observado seguiría siendo idéntico a Local: no hay
 * ningún endpoint real configurado en ningún perfil (`REMOTE_PROVIDER_CONFIG`
 * no está definido en ninguna de las tres páginas), así que cada llamada
 * cae de inmediato al fallback descrito abajo.
 *
 * Fallback automático ante CUALQUIER error — no solo errores de red:
 *   - flag deshabilitado,
 *   - sin `REMOTE_PROVIDER_CONFIG.endpoint` configurado,
 *   - `fetch` no disponible en el entorno,
 *   - la llamada de red falla, se agota el tiempo de espera, o la respuesta
 *     HTTP no es exitosa,
 *   - la respuesta remota no es JSON válido o no trae el `skill` esperado,
 *   - incluso un `context` inválido que haría fallar la propia construcción
 *     del PromptContext.
 * En todos los casos, este proveedor delega en LocalResponseProvider y
 * devuelve exactamente lo que Local hubiera devuelto — nunca deja una
 * Promise sin resolver ni propaga un error de red hacia el panel del
 * Copilot. Es la misma garantía de "nunca romper la UI" que ya sostienen
 * las cinco habilidades de Local, extendida a un canal que sí puede fallar.
 *
 * Fase 4, Paso 4: se agrega manejo de TIMEOUT (`AbortController`,
 * configurable vía `REMOTE_PROVIDER_CONFIG.timeoutMs`, con
 * DEFAULT_TIMEOUT_MS de respaldo) — el único cambio de este archivo en ese
 * paso. Este módulo sigue sin saber nada de qué backend hay detrás del
 * endpoint (Gemini, OpenAI, Claude, o cualquier otro): timeout es una
 * preocupación de transporte HTTP genérica, no específica de un proveedor
 * de IA — mantenerla aquí (y no en ningún adaptador de proveedor
 * específico) es precisamente lo que preserva el agnosticismo exigido por
 * la especificación de ese paso. La integración real con la API de Gemini
 * vive enteramente en server/gemini-proxy-server.js — un componente nuevo,
 * server-side, que este archivo ni siquiera conoce: solo sabe que existe
 * "un endpoint HTTP que responde con la forma del contrato".
 *
 * Por qué usa PromptContextBuilder sin modificar su API: cada método
 * llama a `PromptContextBuilder.build(context, { intent: { skill: '...' } })`
 * exactamente con la firma que ya define el Paso 2 — `intent` aquí es
 * honesto, no inventado: es literalmente el nombre del método que se está
 * invocando, la misma información que ya lleva `skill` en la respuesta de
 * cualquier proveedor.
 */
'use strict';

const RemoteResponseProvider = (function () {
  const FLAG_NAME = 'remoteResponseProvider';
  const DEFAULT_TIMEOUT_MS = 8000;

  function getConfig() {
    return (typeof REMOTE_PROVIDER_CONFIG !== 'undefined' && REMOTE_PROVIDER_CONFIG) || null;
  }

  function getFetch() {
    return typeof fetch !== 'undefined' ? fetch : null;
  }

  function getTimeoutMs(config) {
    return (config && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0)
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  }

  async function callRemote(skill, promptContext) {
    if (!FeatureFlags.isEnabled(FLAG_NAME)) {
      throw new Error(`RemoteResponseProvider: feature flag "${FLAG_NAME}" deshabilitado.`);
    }
    const config = getConfig();
    if (!config || typeof config.endpoint !== 'string' || !config.endpoint) {
      throw new Error('RemoteResponseProvider: no hay endpoint remoto configurado (REMOTE_PROVIDER_CONFIG.endpoint).');
    }
    const fetchFn = getFetch();
    if (!fetchFn) {
      throw new Error('RemoteResponseProvider: fetch no está disponible en este entorno.');
    }

    const timeoutMs = getTimeoutMs(config);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let httpResponse;
    try {
      httpResponse = await fetchFn(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill, promptContext }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      if (controller && controller.signal.aborted) {
        throw new Error(`RemoteResponseProvider: tiempo de espera agotado (${timeoutMs}ms) esperando al proveedor remoto.`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!httpResponse || !httpResponse.ok) {
      throw new Error(`RemoteResponseProvider: respuesta HTTP no exitosa (${httpResponse ? httpResponse.status : 'sin respuesta'}).`);
    }
    const body = await httpResponse.json();
    if (!body || typeof body !== 'object' || body.skill !== skill) {
      throw new Error('RemoteResponseProvider: la respuesta remota no cumple la forma esperada del contrato.');
    }
    return body;
  }

  // Envuelve el intento remoto en Promise.resolve().then(...) para que
  // incluso un throw SÍNCRONO (p. ej. PromptContextBuilder.build() ante un
  // context inválido) se convierta en un rechazo capturable por el
  // .catch() — ninguna ruta de error escapa sin pasar por el fallback.
  function withFallback(remoteAttempt, localFallback) {
    return Promise.resolve().then(remoteAttempt).catch(localFallback);
  }

  function explainProduct(context) {
    return withFallback(
      () => callRemote('explain-product', PromptContextBuilder.build(context, { intent: { skill: 'explain-product' } })),
      () => LocalResponseProvider.explainProduct(context)
    );
  }

  function compareProducts(contextA, contextB) {
    return withFallback(
      () => callRemote('compare-products', {
        a: PromptContextBuilder.build(contextA, { intent: { skill: 'compare-products' } }),
        b: PromptContextBuilder.build(contextB, { intent: { skill: 'compare-products' } }),
      }),
      () => LocalResponseProvider.compareProducts(contextA, contextB)
    );
  }

  function bestAlternative(context) {
    return withFallback(
      () => callRemote('best-alternative', PromptContextBuilder.build(context, { intent: { skill: 'best-alternative' } })),
      () => LocalResponseProvider.bestAlternative(context)
    );
  }

  function crossSell(context) {
    return withFallback(
      () => callRemote('cross-sell', PromptContextBuilder.build(context, { intent: { skill: 'cross-sell' } })),
      () => LocalResponseProvider.crossSell(context)
    );
  }

  function priceAndAvailability(context) {
    return withFallback(
      () => callRemote('price-availability', PromptContextBuilder.build(context, { intent: { skill: 'price-availability' } })),
      () => LocalResponseProvider.priceAndAvailability(context)
    );
  }

  return { explainProduct, compareProducts, bestAlternative, crossSell, priceAndAvailability };
})();
