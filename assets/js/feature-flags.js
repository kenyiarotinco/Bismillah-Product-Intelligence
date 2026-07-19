/* Bismillah Product Intelligence Platform — Feature Flags (Fase 4, Paso 3)
 *
 * Mecanismo de activación mínimo: no existía ningún feature flag en el
 * proyecto antes de este paso, así que este módulo es "uno equivalente" al
 * pedido por la especificación. Mismo patrón ya usado por
 * CommercialDataProvider para `COMMERCIAL_DATA` — un global opcional
 * (`FEATURE_FLAGS`), leído con `typeof ... !== 'undefined'`, nunca
 * `window.` — que ningún perfil de este repositorio define hoy. Sin ese
 * global, TODOS los flags quedan deshabilitados por defecto: es el mismo
 * comportamiento, para cualquier flag futuro, que ya usa `COMMERCIAL_DATA`
 * cuando no hay dataset comercial cargado.
 *
 * Para habilitar un flag en un despliegue concreto, ese perfil define su
 * propio `FEATURE_FLAGS` antes de cargar app.js — p. ej.:
 *   const FEATURE_FLAGS = { remoteResponseProvider: true };
 * Este repositorio no define ese global en ninguna de sus tres páginas: el
 * proveedor remoto (ver providers/remote-response-provider.js) permanece
 * deshabilitado en los tres perfiles tal como están hoy.
 */
'use strict';

const FeatureFlags = (function () {
  function isEnabled(name) {
    return typeof FEATURE_FLAGS !== 'undefined' && FEATURE_FLAGS !== null && FEATURE_FLAGS[name] === true;
  }

  return { isEnabled };
})();
