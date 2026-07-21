/* global window, document */
(function protectAuthenticatedPage(global, documentObject) {
  'use strict';

  // A mesma instalação pode ser usada por pessoas de empresas diferentes no
  // mesmo perfil do navegador. Remova toda a tela antes de uma possível
  // captura pelo back/forward cache; uma restauração sempre refaz auth e dados.
  function purge() {
    documentObject.body?.replaceChildren();
  }

  function reloadRestoredPage(event) {
    if (event.persisted) global.location.reload();
  }

  global.addEventListener('pagehide', purge);
  global.addEventListener('pageshow', reloadRestoredPage);
  global.SessionPrivacy = { purge };
})(window, document);
