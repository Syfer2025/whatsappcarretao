const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} function is incomplete`);
}

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} has a real audio recorder composer`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.equal(html.includes('voiceToggle'), false);
    assert.equal(html.includes('documentToggle'), false);
    assert.match(html, /startRecording/);
    assert.match(html, /stopRecording/);
    assert.match(html, /cancelRecording/);
    assert.match(html, /MediaRecorder/);
    assert.match(html, /id="msgInput"[^>]*maxlength="10000"/);
    assert.match(html, /Gravar/);
    assert.ok(
      html.indexOf('audio/ogg;codecs=opus') < html.indexOf('audio/webm;codecs=opus'),
      'audio recorder should prefer ogg opus before webm'
    );

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    for (const [index, match] of scripts.entries()) {
      new vm.Script(match[1], { filename: `${file}#script${index + 1}` });
    }
  });

  test(`${file} treats sqlite timestamps as UTC and groups by local date`, () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'America/Sao_Paulo';
    try {
      const html = fs.readFileSync(file, 'utf8');
      const script = [
        extractFunction(html, 'parseDate'),
        extractFunction(html, 'dateKey'),
        'result = {',
        "  iso: parseDate('2026-07-07 16:36:30').toISOString(),",
        "  localKey: dateKey('2026-07-08 01:30:00')",
        '};'
      ].join('\n');
      const context = { result: null };
      vm.createContext(context);
      new vm.Script(script, { filename: `${file}#date-test` }).runInContext(context);

      assert.equal(context.result.iso, '2026-07-07T16:36:30.000Z');
      assert.equal(context.result.localKey, '2026-07-07');
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
}

// Regressao 04/set/2026: o WhatsApp Web passou a enderecar por @lid e a coluna
// phone guarda esse identificador. formatPhone tirava o sufixo e devolvia
// "+14757641879637" — um telefone inexistente na tela do atendente.
// Recursos pedidos em 04/set/2026. Os tres testes exigem PARIDADE entre
// admin.html e vendor.html: correcao que chega so no dono e meia correcao.
// Pedido em 04/set/2026: no painel a localizacao aparecia como texto com URL,
// enquanto no WhatsApp do cliente aparece o mapa.
test('localizacao aparece como mapa nas duas telas, servido pelo proprio servidor', () => {
  const fs = require('node:fs');
  const modulo = fs.readFileSync(require.resolve('./frontend/message-location.js'), 'utf8');

  // Tile pelo servidor: a CSP so permite 'self' e a coordenada do cliente nao
  // pode sair do navegador do atendente para um terceiro.
  assert.match(modulo, /\/api\/maps\/tile\//);
  assert.doesNotMatch(
    modulo,
    /https?:\/\/(tile|[a-z]\.tile)\.openstreetmap/,
    'o navegador nao deve buscar tile direto de fora'
  );
  // Licenca do OpenStreetMap exige atribuicao visivel.
  assert.match(modulo, /OpenStreetMap/);
  // Mapa fora do ar nao pode deixar quadrado quebrado na conversa.
  assert.match(modulo, /onerror=/);
  // Coordenada fora de faixa nao desenha mapa nenhum.
  assert.match(modulo, /latitude < -90 \|\| latitude > 90/);

  for (const arquivo of ['./frontend/admin.html', './frontend/vendor.html']) {
    const html = fs.readFileSync(require.resolve(arquivo), 'utf8');
    assert.match(html, /message-location\.js/, `${arquivo}: deve carregar o modulo`);
    // Precisa sair ANTES da logica de midia: localizacao nao tem media_url e
    // cairia no aviso de "Sincronizando midia...".
    const render = html.slice(html.indexOf('function renderMedia(m) {'), html.indexOf('function renderMedia(m) {') + 420);
    assert.match(render, /MessageLocation\?\.render\(m\)/, `${arquivo}: renderMedia deve delegar`);
    assert.ok(
      render.indexOf('MessageLocation') < render.indexOf('media_unavailable'),
      `${arquivo}: o mapa deve sair antes da checagem de midia`
    );
  }

  // A coordenada precisa vir em coluna: interpretar o texto quebraria a
  // qualquer ajuste de redacao da mensagem.
  const schema = fs.readFileSync(require.resolve('./schema.js'), 'utf8');
  assert.match(schema, /ensureColumn\(db, 'messages', 'location_latitude', 'REAL'\)/);
  assert.match(schema, /ensureColumn\(db, 'messages', 'location_longitude', 'REAL'\)/);
});

test('telefone aparece no cabecalho da conversa, resolvido e sem @lid', () => {
  const fs = require('node:fs');
  for (const arquivo of ['./frontend/admin.html', './frontend/vendor.html']) {
    const html = fs.readFileSync(require.resolve(arquivo), 'utf8');
    assert.match(html, /id="chatPhone"/, `${arquivo}: elemento do telefone`);
    assert.match(
      html,
      /chatPhone'\)\.textContent =\s*\n?\s*window\.ChatDirectory\?\.formatPhone\(window\.ChatDirectory\?\.conversationPhone\(conv\)\)/,
      `${arquivo}: cabecalho deve usar o telefone resolvido`
    );
    assert.doesNotMatch(
      html,
      /chatPhone'\)\.textContent = conv\?\.phone/,
      `${arquivo}: nao deve exibir conv.phone cru (e o @lid)`
    );
  }
});

test('arrastar-e-soltar e colar imagem entram pelo pipeline do botao de anexo', () => {
  const fs = require('node:fs');
  const modulo = fs.readFileSync(require.resolve('./frontend/composer-attachments.js'), 'utf8');

  for (const evento of ['dragenter', 'dragover', 'dragleave', 'drop', 'paste']) {
    assert.match(modulo, new RegExp(`'${evento}'`), `deve tratar ${evento}`);
  }
  // Sem preventDefault no drop o navegador abre o arquivo e o atendente perde a tela.
  assert.match(modulo, /event\.preventDefault\(\)/);
  // Nao pode roubar Ctrl+V de outro campo de texto.
  assert.match(modulo, /isContentEditable/);

  for (const arquivo of ['./frontend/admin.html', './frontend/vendor.html']) {
    const html = fs.readFileSync(require.resolve(arquivo), 'utf8');
    assert.match(html, /composer-attachments\.js/, `${arquivo}: deve carregar o modulo`);
    // Reusa selectedFiles + renderFilePreview: nao pode existir caminho de
    // envio paralelo, que escaparia das validacoes ja existentes.
    assert.match(html, /selectedFiles = \[\s*\n?\s*\.\.\.selectedFiles/, `${arquivo}: deve alimentar selectedFiles`);
    assert.match(html, /renderFilePreview\(\)/, `${arquivo}: deve usar a previa existente`);
  }
});

test('envio de localizacao existe nas duas telas e valida a coordenada', () => {
  const fs = require('node:fs');
  const modulo = fs.readFileSync(require.resolve('./frontend/composer-location.js'), 'utf8');
  assert.match(modulo, /getCurrentPosition/);
  // Mensagem por causa: permissao negada, sem sinal e timeout sao problemas
  // diferentes para o atendente resolver.
  assert.match(modulo, /Permissao de localizacao negada/);
  assert.match(modulo, /window\.confirm/, 'compartilhar posicao fisica precisa de confirmacao');
  assert.match(modulo, /button\.disabled = true/, 'precisa de estado de carregando');

  for (const arquivo of ['./frontend/admin.html', './frontend/vendor.html']) {
    const html = fs.readFileSync(require.resolve(arquivo), 'utf8');
    assert.match(html, /composer-location\.js/, `${arquivo}: deve carregar o modulo`);
    assert.match(html, /id="btnLocation"/, `${arquivo}: deve ter o botao`);
    assert.match(html, /aria-label="Enviar localizacao atual"/, `${arquivo}: botao precisa de rotulo acessivel`);
    assert.match(html, /function sendLocation\(button\)/, `${arquivo}: deve ter a funcao`);
    // Icone, nao emoji.
    assert.doesNotMatch(html, /title="Enviar localizacao atual"[^>]*>\s*[\u{1F300}-\u{1FAFF}]/u, `${arquivo}: sem emoji como icone`);
  }
});

test('telefone exibido vem do @c.us resolvido e nunca de um @lid', () => {
  const fs = require('node:fs');
  const dir = fs.readFileSync(require.resolve('./frontend/chat-directory.js'), 'utf8');

  assert.match(dir, /function isLidIdentifier/);
  assert.match(dir, /function conversationPhone/);
  // formatPhone tem de recusar @lid ANTES de extrair digitos, senao ja inventou.
  const fp = dir.slice(dir.indexOf('function formatPhone'), dir.indexOf('function formatPhone') + 260);
  assert.ok(
    fp.indexOf('isLidIdentifier') < fp.indexOf("replace(/\\D/g"),
    'formatPhone deve descartar @lid antes de transformar em digitos'
  );
  assert.match(dir, /conversationPhone,/, 'helper precisa ser exportado');

  // As DUAS telas — admin e agente — precisam usar o helper. A correcao nao
  // pode valer so para o super admin.
  for (const arquivo of ['./frontend/admin.html', './frontend/vendor.html']) {
    const html = fs.readFileSync(require.resolve(arquivo), 'utf8');
    assert.ok(
      (html.match(/conversationPhone/g) || []).length >= 3,
      `${arquivo} deve usar conversationPhone na lista, na previa e na busca`
    );
    assert.doesNotMatch(
      html,
      /formatPhone\(conversation\.phone/,
      `${arquivo} nao deve formatar conversation.phone direto (e o @lid)`
    );
  }

  // E o servidor precisa resolver o @c.us para a tela ter o que mostrar. A
  // resolucao vive no schema, como coluna: por subselect em cada consulta era
  // facil esquecer uma — foi o que deixou o painel de perfil mostrando @lid.
  const schema = fs.readFileSync(require.resolve('./schema.js'), 'utf8');
  assert.match(schema, /ensureColumn\(db, 'conversations', 'display_phone', 'TEXT'\)/);
  assert.match(schema, /identifier LIKE '%@c\.us'/);

  // E o perfil (o que abre ao clicar na imagem) tambem precisa do helper.
  const dir2 = fs.readFileSync(require.resolve('./frontend/chat-directory.js'), 'utf8');
  assert.doesNotMatch(
    dir2,
    /formatPhone\(profile\.phone\)/,
    'o painel de perfil nao deve formatar profile.phone direto (e o @lid)'
  );
  assert.match(dir2, /formatPhone\(conversationPhone\(profile\)\)/);
});

test('external links cannot execute script URLs or control their opener', () => {
  for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
    const html = fs.readFileSync(file, 'utf8');
    for (const link of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
      assert.match(link[0], /\brel="noopener"/, `${file} has an unsafe target=_blank link`);
    }
  }

  const admin = fs.readFileSync('frontend/admin.html', 'utf8');
  assert.doesNotMatch(admin, /invoice\.stripe\.com|safeHttpsUrl|hostedUrl/);
});

test('registration branding is rendered as text, never executable HTML', () => {
  const html = fs.readFileSync('frontend/register.html', 'utf8');
  assert.match(html, /el\.textContent\s*=\s*b\.appName/);
  assert.doesNotMatch(html, /appName[^\n]*innerHTML|innerHTML[^\n]*appName/);
  assert.match(html, /cf-turnstile-response/);
  assert.match(html, /dataset\.action = 'signup'/);
  assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  assert.match(html, /JSON\.stringify\(\{ companyName, adminName, email, password, plan, turnstileToken \}\)/);
});

test('registration is disabled before submission when Stripe billing is unavailable', () => {
  const html = fs.readFileSync('frontend/register.html', 'utf8');

  assert.match(html, /let signupBillingAvailable = true/);
  assert.match(html, /b\.signupBillingConfigured === false/);
  assert.match(html, /b\.signupConfigured === false/);
  assert.match(html, /signupBillingAvailable = false/);
  assert.match(html, /btn\.disabled = true/);
  assert.match(html, /Cadastro indisponível/);
  assert.match(html, /if \(!signupBillingAvailable\)/);
});

test('browser notifications are closed when a browser profile leaves the tenant session', () => {
  const source = fs.readFileSync('frontend/chat-notifications.js', 'utf8');
  assert.match(source, /const activeSystemNotifications = new Set\(\)/);
  assert.match(source, /activeSystemNotifications\.add\(notification\)/);
  assert.match(source, /notification\.onclose = \(\) => activeSystemNotifications\.delete\(notification\)/);
  assert.match(source, /global\.addEventListener\('pagehide', clear\)/);
  assert.match(source, /global\.addEventListener\('beforeunload', clear\)/);
  assert.match(source, /document\.getElementById\('chatNotificationStack'\)\?\.replaceChildren\(\)/);
  assert.match(source, /\bclear,/);
  for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(extractFunction(html, 'logout'), /ChatNotifications\?\.clear\(\)/);
    assert.match(html, /auth:session-replaced[\s\S]{0,180}ChatNotifications\?\.clear\(\)/);
  }
});

test('chat pages erase tenant DOM before bfcache and reload any restored session', () => {
  const source = fs.readFileSync('frontend/chat-shell.js', 'utf8');
  assert.match(source, /function clearSensitiveDom\(\)/);
  for (const selector of [
    '.conv-list',
    '#messagesList',
    '#conversationProfileContent',
    '#contactDirectoryResults',
    '#supportWidgetMessages',
  ]) {
    assert.ok(source.includes(`'${selector}'`), `${selector} must be purged before page caching`);
  }
  assert.match(source, /window\.addEventListener\('pagehide', clearSensitiveDom\)/);
  assert.match(source, /window\.addEventListener\('pageshow', reloadRestoredSession\)/);
  assert.match(source, /if \(event\.persisted\) window\.location\.reload\(\)/);
});

test('every authenticated page purges the full DOM before browser session restoration', () => {
  const source = fs.readFileSync('frontend/session-privacy.js', 'utf8');
  assert.match(source, /documentObject\.body\?\.replaceChildren\(\)/);
  assert.match(source, /global\.addEventListener\('pagehide', purge\)/);
  assert.match(source, /if \(event\.persisted\) global\.location\.reload\(\)/);
  for (const file of [
    'frontend/admin.html',
    'frontend/vendor.html',
    'frontend/superadmin.html',
    'frontend/settings.html',
    'frontend/setup.html',
  ]) {
    assert.match(fs.readFileSync(file, 'utf8'), /<script src="\/session-privacy\.js"/);
  }
});

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} opens chats at the latest message without animated scrolling`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const messagesRule = html.match(/\.messages\s*\{[^}]+\}/)?.[0] || '';

    assert.match(messagesRule, /scroll-behavior:\s*auto/);
    assert.doesNotMatch(messagesRule, /scroll-behavior:\s*smooth/);
    assert.match(html, /setMessageScrollTopImmediately\(list, list\.scrollHeight\)/);
    assert.match(
      html,
      /setMessageScrollTopImmediately\(list, previousScrollTop \+ \(list\.scrollHeight - previousHeight\)\)/
    );
    assert.match(html, /scrollIntoView\(\{ behavior: 'auto', block: 'center' \}\)/);
    assert.match(html, /list\.addEventListener\('wheel', cleanup/);
    assert.match(html, /list\.addEventListener\('touchstart', cleanup/);
    assert.match(html, /list\.addEventListener\('pointerdown', cleanup/);

    const context = {
      list: {
        scrollTop: 0,
        style: {
          scrollBehavior: 'smooth',
          removeProperty() {}
        }
      }
    };
    vm.createContext(context);
    new vm.Script([
      extractFunction(html, 'setMessageScrollTopImmediately'),
      'setMessageScrollTopImmediately(list, 850);'
    ].join('\n'), { filename: `${file}#scroll-test` }).runInContext(context);

    assert.equal(context.list.scrollTop, 850);
    assert.equal(context.list.style.scrollBehavior, 'smooth');

    const frames = [];
    const createEventTarget = properties => {
      const listeners = new Map();
      return Object.assign(properties, {
        addEventListener(type, listener) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
          listeners.get(type)?.delete(listener);
        },
        dispatch(type) {
          [...(listeners.get(type) || [])].forEach(listener => listener({ currentTarget: this }));
        }
      });
    };
    const firstMedia = createEventTarget({ tagName: 'IMG', complete: false });
    const secondMedia = createEventTarget({ tagName: 'IMG', complete: false });
    const list = createEventTarget({
      clientHeight: 300,
      scrollHeight: 1200,
      scrollTop: 0,
      style: { scrollBehavior: '', removeProperty() {} },
      querySelectorAll: () => [firstMedia, secondMedia]
    });
    const documentTarget = createEventTarget({});
    const anchorContext = {
      activeMediaAnchorCleanup: null,
      currentConvId: 7,
      document: documentTarget,
      list,
      markConversationRead() {},
      setTimeout: () => 1,
      clearTimeout() {},
      window: { requestAnimationFrame: callback => frames.push(callback) }
    };
    vm.createContext(anchorContext);
    new vm.Script([
      extractFunction(html, 'setMessageScrollTopImmediately'),
      extractFunction(html, 'cancelActiveMediaAnchor'),
      extractFunction(html, 'anchorMessagesAfterMediaMetadata'),
      'anchorMessagesAfterMediaMetadata(list, 7);'
    ].join('\n'), { filename: `${file}#media-anchor-test` }).runInContext(anchorContext);

    frames.shift()?.();
    assert.equal(list.scrollTop, 1200, 'initial media render must anchor at the bottom');
    list.scrollHeight = 1400;
    firstMedia.dispatch('load');
    assert.equal(list.scrollTop, 1400, 'late media must keep a passive viewer at the bottom');
    list.dispatch('wheel');
    list.scrollTop = 420;
    list.scrollHeight = 1500;
    secondMedia.dispatch('load');
    assert.equal(list.scrollTop, 420, 'late media must not override explicit user scrolling');
  });
}

test('superadmin manages fixed plans and nullable per-tenant user limits', () => {
  const html = fs.readFileSync('frontend/superadmin.html', 'utf8');
  const submitEditSource = extractFunction(html, 'submitEdit');

  assert.match(html, /<select id="newPlan">[\s\S]*?value="basico"[\s\S]*?value="profissional"/);
  assert.match(html, /<select id="editPlan">[\s\S]*?value="basico"[\s\S]*?value="profissional"/);
  assert.match(html, /id="editUserLimitOverride"[^>]*type="number"[^>]*min="1"/);
  assert.match(html, /function effectiveUserLimit\(tenant\)/);
  assert.match(html, /t\.db_healthy \? `\$\{Number\(t\.user_count \?\? t\.vendor_count\)\} \/ \$\{effectiveUserLimit\(t\)\}` : '—'/);
  assert.match(html, /dbHealthLabel\(t\.db_health\)/);
  assert.match(submitEditSource, /overrideInput === '' \? null : Number\(overrideInput\)/);
  assert.match(submitEditSource, /user_limit_override: userLimitOverride/);
  assert.match(extractFunction(html, 'submitCreate'), /body: \{ companyName, adminEmail, adminPassword, plan \}/);
});

test('superadmin lists and securely resolves persistent admin password requests', () => {
  const html = fs.readFileSync('frontend/superadmin.html', 'utf8');
  const loadSource = extractFunction(html, 'loadPasswordResetRequests');
  const submitSource = extractFunction(html, 'submitPasswordReset');

  assert.match(html, /data-view="passwordResets"/);
  assert.match(html, /id="viewPasswordResets"/);
  assert.match(html, /id="passwordResetBody"/);
  assert.match(html, /id="passwordResetNewPassword"[^>]*type="password"[^>]*minlength="10"/);
  assert.match(html, /id="passwordResetConfirmPassword"[^>]*type="password"[^>]*minlength="10"/);
  assert.match(loadSource, /api\('\/api\/password-reset-requests'\)/);
  assert.match(loadSource, /if \(!res\.ok\)/);
  assert.match(submitSource, /newPassword !== confirmation/);
  assert.match(submitSource, /`\/api\/password-reset-requests\/\$\{requestId\}\/resolve`/);
  assert.match(submitSource, /method: 'POST'/);
  assert.match(submitSource, /body: \{ newPassword \}/);
  assert.match(submitSource, /if \(!res\.ok\)/);
});

test('superadmin logout uses the csrf-aware API helper', () => {
  const html = fs.readFileSync('frontend/superadmin.html', 'utf8');
  const logoutSource = extractFunction(html, 'logout');

  assert.match(logoutSource, /api\('\/api\/logout', \{ method: 'POST' \}\)/);
  assert.doesNotMatch(logoutSource, /fetch\('\/api\/logout'/);
});

test('superadmin support requests stay bound to the thread captured before each await', () => {
  const html = fs.readFileSync('frontend/superadmin.html', 'utf8');
  const openThread = html.match(/async function openSupportThread[\s\S]*?async function loadOlderSupportMessages/)?.[0] || '';
  const older = html.match(/async function loadOlderSupportMessages[\s\S]*?function fileAsBase64/)?.[0] || '';
  const send = html.match(/async function sendSupportReply[\s\S]*?socket\.on\('support:new'/)?.[0] || '';

  assert.match(openThread, /const targetThreadId = Number\(threadId\)/);
  assert.match(openThread, /requestSequence !== supportOpenSequence/);
  assert.match(openThread, /currentSupportThreadId !== targetThreadId/);
  assert.match(older, /const targetThreadId = Number\(currentSupportThreadId\)/);
  assert.match(older, /requestSequence !== supportOlderSequence/);
  assert.match(older, /openSequence !== supportOpenSequence/);
  assert.match(send, /const targetThreadId = Number\(currentSupportThreadId\)/);
  assert.match(send, /threads\/\$\{targetThreadId\}\/messages/);
  assert.doesNotMatch(send, /threads\/\$\{currentSupportThreadId\}\/messages/);
});

test('admin setup deep links open connection, sectors and users as well as statistics', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');
  assert.match(html, /\['statistics', 'connection', 'sectors', 'users'\]\.includes\(params\.get\('tab'\)\)/);
  assert.match(html, /switchSection\(params\.get\('tab'\)\)/);
});

test('forgot-password only reports success for a successful HTTP response', async () => {
  const html = fs.readFileSync('frontend/forgot-password.html', 'utf8');
  const source = extractFunction(html, 'handleForgot');

  assert.match(source, /if \(!res\.ok\)/);
  assert.match(source, /data\.error \|\| 'Não foi possível enviar a solicitação/);
  assert.match(source, /else \{[\s\S]*?msg\.className = 'msg ok'/);

  const elements = {
    msg: { className: '', textContent: '' },
    btn: { disabled: false, textContent: '' },
    email: { value: 'admin@empresa.test' }
  };
  const context = {
    document: { getElementById: id => elements[id] },
    fetch: async () => ({ ok: false, json: async () => ({ error: 'Falha controlada' }) })
  };
  vm.createContext(context);
  new vm.Script(source.replace(/^function /, 'async function '), { filename: 'frontend/forgot-password.html#handleForgot' }).runInContext(context);

  await context.handleForgot({ preventDefault() {} });
  assert.equal(elements.msg.className, 'msg erro');
  assert.equal(elements.msg.textContent, 'Falha controlada');

  context.fetch = async () => ({ ok: true, json: async () => ({ message: 'Solicitação registrada' }) });
  await context.handleForgot({ preventDefault() {} });
  assert.equal(elements.msg.className, 'msg ok');
  assert.equal(elements.msg.textContent, 'Solicitação registrada');
});

test('login uses only username and password without exposing a second-factor field', async () => {
  const html = fs.readFileSync('frontend/login.html', 'utf8');
  const source = extractFunction(html, 'login');

  assert.doesNotMatch(html, /id="totpCode"|name="totp_code"|Código do autenticador/);
  assert.doesNotMatch(source, /totp_code|totpCode/);

  const elements = {
    username: { value: 'owner' },
    password: { value: 'correct horse battery staple' },
    erro: { textContent: '', style: { display: 'none' } }
  };
  let request;
  const context = {
    document: { getElementById: id => elements[id] },
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ role: 'vendor' }) };
    },
    window: { location: { href: '' } }
  };
  vm.createContext(context);
  new vm.Script(source.replace(/^function /, 'async function '), { filename: 'frontend/login.html#login' }).runInContext(context);

  await context.login();

  assert.equal(request.url, '/api/login');
  assert.deepEqual(JSON.parse(request.options.body), {
    username: 'owner',
    password: 'correct horse battery staple'
  });
  assert.equal(context.window.location.href, '/vendor.html');

  context.fetch = async () => ({ ok: false, json: async () => ({ error: 'Usuário ou senha inválidos' }) });
  await context.login();
  assert.equal(elements.erro.textContent, 'Usuário ou senha inválidos');
  assert.equal(elements.erro.style.display, 'block');
});

test('login, superadmin and forgot-password inline scripts are syntactically valid', () => {
  for (const file of ['frontend/login.html', 'frontend/superadmin.html', 'frontend/forgot-password.html']) {
    const html = fs.readFileSync(file, 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    for (const [index, match] of scripts.entries()) {
      new vm.Script(match[1], { filename: `${file}#script${index + 1}` });
    }
  }
});

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} exposes production contact, profile, archive and realtime notification flows`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const directory = fs.readFileSync('frontend/chat-directory.js', 'utf8');
    const notifications = fs.readFileSync('frontend/chat-notifications.js', 'utf8');

    assert.match(html, /chat-directory\.js/);
    assert.match(html, /Nova conversa/);
    assert.match(html, /openConversationProfile/);
    assert.match(html, /toggleCurrentConversationArchive/);
    assert.match(directory, /\/api\/contacts/);
    assert.match(directory, /\/api\/conversations\/start/);
    assert.match(directory, /\/profile\?refresh=1/);
    assert.match(directory, /\/archive/);
    assert.match(directory, /Participantes/);
    assert.match(notifications, /chat-notification-card/);
    assert.match(notifications, /createOscillator/);
  });
}

test('conversation profile drawer exposes guarded privacy and notification controls', () => {
  const directory = fs.readFileSync('frontend/chat-directory.js', 'utf8');

  assert.match(directory, /data-profile-action="archive"/);
  assert.match(directory, /data-profile-action="mute"/);
  assert.match(directory, /data-profile-action="block"/);
  assert.match(directory, /Notificações silenciadas/);
  assert.match(directory, /blocked \? 'Bloqueado' : 'Permitido'/);
  assert.match(directory, /isGroup \? '' : `<button[\s\S]*data-profile-action="block"/);
  assert.match(directory, /action === 'block' && Number\(activeProfile\.is_group\) === 1/);
  assert.match(directory, /\/api\/conversations\/\$\{conversationId\}\/block/);
  assert.match(directory, /JSON\.stringify\(\{ blocked: Boolean\(blocked\) \}\)/);
  assert.match(directory, /\/api\/conversations\/\$\{conversationId\}\/state/);
  assert.match(directory, /JSON\.stringify\(\{ muted: Boolean\(muted\) \}\)/);
  assert.match(directory, /profileActionInFlight/);
  assert.match(directory, /actionDisabled \? 'disabled' : ''/);
  assert.match(directory, /loadProfile\(conversationId, \{ showLoading: false \}\)/);
});

test('admin replaces the destructive close action with department assignment and archive', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');

  assert.doesNotMatch(html, /onclick="closeConversation\(\)"/);
  assert.match(html, /Departamento/);
  assert.match(html, /Responsável/);
  assert.match(html, /handleSectorChange/);
  assert.match(html, /handleAssigneeChange/);
  assert.match(html, /archiveConversationBtn/);
});

test('login page does not expose whatsapp qr before authentication', () => {
  const html = fs.readFileSync('frontend/login.html', 'utf8');

  assert.equal(html.includes('/api/status'), false);
  assert.equal(html.includes('qrBox'), false);
  assert.equal(html.includes('qrImg'), false);
  assert.equal(html.includes('qrserver'), false);
});

test('admin page exposes users sectors and connection panels', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');

  assert.match(html, /Agentes/);
  assert.match(html, /Setores/);
  assert.match(html, /Conexao/);
  assert.match(html, /loadUsers/);
  assert.match(html, /loadSectors/);
  assert.match(html, /loadConnection/);
  assert.match(html, /resetWhatsAppSession/);
  assert.match(html, /connectionSyncObservability/);
  assert.match(html, /Sincronização e integridade/);
  assert.match(html, /Última reconciliação/);
  assert.match(html, /Fila de enriquecimento/);
  assert.match(html, /sync\.lastError/);
});

test('admin user management handles quotas, live presence and concurrent edits safely', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');
  const saveUser = extractFunction(html, 'saveUser');
  const saveSector = extractFunction(html, 'saveSector');
  const loadUsers = extractFunction(html, 'loadUsers');
  const deactivateUser = extractFunction(html, 'deactivateUserAccess');

  assert.match(html, /id="vVersion" type="hidden"/);
  assert.match(html, /id="sectorVersion" type="hidden"/);
  assert.match(html, /10 a 72 bytes/);
  assert.match(saveUser, /Array\.from\(password\)\.length < 10/);
  assert.match(saveUser, /utf8ByteLength\(password\) > 72/);
  assert.match(saveUser, /row_version/);
  assert.match(saveUser, /error\.code === 'STALE_WRITE'/);
  assert.match(saveUser, /setButtonPending\('saveUserButton', true\)/);
  assert.match(saveSector, /row_version/);
  assert.match(saveSector, /error\.code === 'STALE_WRITE'/);
  assert.match(saveSector, /conversas abertas serão liberadas para a fila geral/);
  assert.match(loadUsers, /apiJson\('\/api\/vendors'\)/);
  assert.match(loadUsers, /connection_count/);
  assert.match(loadUsers, /Novos agentes ainda podem ser preparados como inativos/);
  assert.match(deactivateUser, /method: 'DELETE'/);
  assert.match(deactivateUser, /row_version: Number\(rowVersion\)/);
  assert.match(html, /socket\.on\('presence:changed'[\s\S]*?setTimeout\(loadUsers, 250\)/);
});

test('admin page renders whatsapp qr through a local POST without leaking qr data in urls', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');
  const vendor = fs.readFileSync('frontend/vendor.html', 'utf8');

  assert.match(html, /renderQrImage/);
  assert.match(html, /api\('\/api\/qrcode',\s*\{\s*method:\s*'POST'/);
  assert.match(html, /URL\.createObjectURL/);
  assert.doesNotMatch(html, /\/api\/qrcode\?data=/);
  assert.doesNotMatch(html, /api\.qrserver\.com/);
  assert.match(html, /st === 'qr'/);
  assert.match(vendor, /String\(data\?\.state \|\| ''\)\.toLowerCase\(\) === 'qr'/);
});

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} keeps media filenames out of executable inline handlers`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /data-media-preview-url=/);
    assert.match(html, /decodeURIComponent\(target\.dataset\.mediaPreviewFilename/);
    assert.doesNotMatch(html, /onclick="openMediaPreview\(event,/);
    assert.doesNotMatch(html, /function jsString\(/);
  });
}

test('admin page separates unassigned and forwarded conversation queues', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');

  assert.match(html, /Não encaminhadas/);
  assert.match(html, /Encaminhadas/);
  assert.match(html, /id="tabForwarded"/);
  assert.match(html, /adminConversationQueue/);
  assert.match(html, /encodeURIComponent\(normalizedQueue\)/);
  assert.match(html, /queue:\s*'forwarded'/);
  assert.match(html, /loadForwardedConversations/);
  assert.match(html, /Arquivadas/);
  assert.match(html, /id="tabArchived"/);
  assert.match(html, /queue:\s*'archived'/);
});

test('vendor page keeps chat scroll isolated and shows whatsapp connection alerts', () => {
  const html = fs.readFileSync('frontend/vendor.html', 'utf8');

  assert.match(html, /height:100dvh/);
  assert.match(html, /overscroll-behavior:contain/);
  assert.match(html, /id="connectionBanner"/);
  assert.match(html, /monitorConnection/);
  assert.match(html, /\/api\/status/);
});

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} uses Socket.IO realtime updates instead of conversation polling`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /\/socket\.io\/socket\.io\.js/);
    assert.match(html, /const socket = io\(/);
    assert.match(html, /conversation:updated/);
    assert.match(html, /message:new/);
    assert.match(html, /connection:status/);
    assert.doesNotMatch(html, /setInterval\(loadConversations,\s*3000\)/);
    assert.doesNotMatch(html, /setInterval\(refreshCurrentConversation,\s*3000\)/);
  });
}

for (const file of ['frontend/login.html', 'frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} relies on the server-issued httpOnly auth cookie`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.doesNotMatch(html, /function setAuthCookie/);
    assert.doesNotMatch(html, /document\.cookie\s*=\s*`auth_token=/);
  });
}

test('operational pages load shared button tooltips', () => {
  const tooltipJs = fs.readFileSync('frontend/tooltips.js', 'utf8');

  for (const file of ['frontend/admin.html', 'frontend/vendor.html', 'frontend/settings.html', 'frontend/superadmin.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /<script src="\/tooltips\.js"><\/script>/);
  }

  assert.match(tooltipJs, /Sincroniza conversas e mensagens antigas/);
  assert.match(tooltipJs, /Fixa ou desafixa esta conversa/);
  assert.match(tooltipJs, /Envia a resposta para o WhatsApp/);
  assert.match(tooltipJs, /MutationObserver/);
});

test('shared support widget loads sends reads and refreshes the real support thread', () => {
  const widget = fs.readFileSync('frontend/support-widget.js', 'utf8');

  assert.match(widget, /request\('\/api\/support\/thread'\)/);
  assert.match(widget, /request\('\/api\/support\/messages',\s*\{ method: 'POST', body \}\)/);
  assert.match(widget, /request\('\/api\/support\/thread\/read',\s*\{ method: 'PATCH' \}\)/);
  assert.match(widget, /headers\['X-CSRF-Token'\]/);
  assert.match(widget, /readAsDataURL\(file\)/);
  assert.match(widget, /tenant_unread_count/);
  assert.match(widget, /socket\.on\('support:new', supportEvent\)/);
  assert.match(widget, /status === 401/);
  assert.match(widget, /status === 403/);
  assert.match(widget, /ChatAudioPlayer\.createElement/);
  assert.doesNotMatch(widget, /Online agora/);
});

test('internal operational pages do not expose the SaaS support channel', () => {
  for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /<script src="\/support-widget\.js"><\/script>/);
    assert.doesNotMatch(html, /SupportWidget\?\.attachSocket/);
  }
});

test('internal admin has no orphaned SaaS support trigger or mock messages', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');

  assert.doesNotMatch(html, /class="help-btn" onclick="openHelpModal\(\)"/);
  assert.doesNotMatch(html, /class="help-badge" hidden/);
  assert.doesNotMatch(html, /id="helpModal"/);
  assert.doesNotMatch(html, /Online agora/);
  assert.doesNotMatch(html, /Olá! Como posso ajudar você hoje/);
  assert.doesNotMatch(html, /Estou com uma dúvida sobre como reimportar/);
});

test('shared sticker library loads recent stickers and forwards a selected sticker safely', () => {
  const library = fs.readFileSync('frontend/sticker-library.js', 'utf8');

  assert.match(library, /request\('\/api\/stickers\/recent\?limit=48'\)/);
  assert.match(library, /request\(`\/api\/messages\/\$\{messageId\}\/forward`,\s*\{/);
  assert.match(library, /body:\s*JSON\.stringify\(\{ conversation_id: conversationId \}\)/);
  assert.match(library, /document\.getElementById\('stickerInput'\)\?\.click\(\)/);
  assert.match(library, /if \(!state\.open\) return;[\s\S]*?event\.key === 'Escape'/);
  assert.match(library, /event\.target === overlay/);
  assert.match(library, /replaceChildren/);
  assert.match(library, /textContent/);
  assert.doesNotMatch(library, /\.innerHTML\s*=/);
});

test('admin and vendor share the same responsive chat shell and audio player', () => {
  const shellCss = fs.readFileSync('frontend/chat-shell.css', 'utf8');
  const audioCss = fs.readFileSync('frontend/chat-audio-player.css', 'utf8');

  for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.equal((html.match(/href="\/chat-shell\.css"/g) || []).length, 1);
    assert.equal((html.match(/src="\/chat-shell\.js"/g) || []).length, 1);
    assert.equal((html.match(/href="\/chat-audio-player\.css"/g) || []).length, 1);
    assert.equal((html.match(/src="\/chat-audio-player\.js"/g) || []).length, 1);
    assert.match(html, /class="[^"]*chat-app[^"]*app-shell/);
    assert.match(html, /class="[^"]*app-nav/);
    assert.match(html, /class="[^"]*app-content/);
    assert.match(html, /class="[^"]*chat-sidebar/);
    assert.match(html, /class="[^"]*chat-main/);
    assert.match(html, /class="[^"]*chat-header/);
    assert.match(html, /class="[^"]*chat-composer/);
    assert.match(html, /ChatAudioPlayer\?\.render/);
    assert.match(html, /window\.ChatShell\?\.openConversation\(\)/);
    assert.doesNotMatch(html, /fonts\.googleapis\.com/);
    assert.doesNotMatch(html, /user-images\.githubusercontent\.com/);
  }

  assert.match(shellCss, /--accent:/);
  assert.match(shellCss, /\.chat-sidebar/);
  assert.match(shellCss, /\.chat-header/);
  assert.match(shellCss, /\.chat-composer/);
  assert.match(shellCss, /\.search-wrapper\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/);
  assert.match(shellCss, /\.search-wrapper input\s*\{[^}]*max-width:\s*160px[^}]*flex:\s*0 1 160px/);
  assert.match(shellCss, /\.search-wrapper button\s*\{[^}]*min-width:\s*128px[^}]*flex:\s*1 0 128px/);
  assert.match(shellCss, /\[data-theme="dark"\]/);
  assert.match(shellCss, /@media \(max-width: 680px\)/);
  assert.match(shellCss, /\.chat-app\.chat-open \.chat-main/);
  assert.match(shellCss, /\[data-theme="dark"\] \.chat-app \.sidebar-toolbar button\s*\{[^}]*background:\s*#202c33/);
  assert.match(shellCss, /\[data-theme="dark"\] \.chat-app \.sidebar-toolbar button:not\(:disabled\):hover/);
  assert.match(shellCss, /\.sidebar-toolbar button:focus-visible\s*\{[^}]*box-shadow:/);
  assert.match(audioCss, /\.audio-speed-btn\.active/);
  assert.match(audioCss, /\.audio-speed-btn:focus-visible/);
});

test('vendor shares admin aesthetics without receiving administrative options', () => {
  const html = fs.readFileSync('frontend/vendor.html', 'utf8');

  assert.match(html, /Navegação do atendente/);
  assert.match(html, /data-chat-mobile-back/);
  assert.match(html, /id="conversationsToggle"/);
  assert.match(html, /class="input-wrapper"/);
  assert.match(html, /id="syncMessagesBtn"[^>]*onclick="syncCurrentConversation\(\)"[^>]*disabled/);
  assert.match(html, /function requestConversationSync\(id\)/);
  assert.match(html, /async function syncCurrentConversation\(\)/);
  assert.match(html, /const manualConversationSyncs = new Set\(\)/);
  assert.match(html, /const syncing = hasConversation && manualConversationSyncs\.has\(conversationId\)/);
  assert.match(html, /manualConversationSyncs\.delete\(id\)[\s\S]*?updateSyncMessagesButton\(\)/);
  assert.doesNotMatch(html, /id="sectionUsers"/);
  assert.doesNotMatch(html, /id="sectionStatistics"/);
  assert.doesNotMatch(html, /id="sectionSectors"/);
  assert.doesNotMatch(html, /id="sectionConnection"/);
  assert.doesNotMatch(html, /id="sectionFinanceiro"/);
  assert.doesNotMatch(html, /id="sectorSelect"/);
  assert.doesNotMatch(html, /id="assignSelect"/);
});

test('vendor sync button stays busy when an older conversation finishes first', () => {
  const html = fs.readFileSync('frontend/vendor.html', 'utf8');
  const updateSource = extractFunction(html, 'updateSyncMessagesButton');
  const script = [
    'const button = { disabled: false, textContent: "", attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };',
    'const document = { getElementById() { return button; } };',
    'let currentConvId = 2;',
    'const manualConversationSyncs = new Set([1, 2]);',
    updateSource,
    'manualConversationSyncs.delete(1);',
    'updateSyncMessagesButton();',
    'const whileSecondPending = { disabled: button.disabled, busy: button.attrs["aria-busy"] };',
    'manualConversationSyncs.delete(2);',
    'updateSyncMessagesButton();',
    'result = JSON.stringify({ whileSecondPending, afterSecond: { disabled: button.disabled, busy: button.attrs["aria-busy"] } });'
  ].join('\n');
  const context = { result: null };
  vm.createContext(context);
  new vm.Script(script, { filename: 'vendor-sync-button-race-test.js' }).runInContext(context);

  assert.equal(context.result, JSON.stringify({
    whileSecondPending: { disabled: true, busy: 'true' },
    afterSecond: { disabled: false, busy: 'false' }
  }));
});

test('sticker library replaces direct upload buttons while preserving the existing upload flow', () => {
  for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /<script src="\/sticker-library\.js"><\/script>/);
    assert.match(html, /id="stickerLibraryButton"[\s\S]*?onclick="openStickerLibrary\(\)"/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, /id="stickerInput"[\s\S]*?onchange="handleStickerSelect\(event\)"/);
    assert.match(html, /function handleStickerSelect\(event\)/);
    assert.match(html, /StickerLibrary\?\.configure\(\{[\s\S]*?getCurrentConversationId:\s*\(\) => currentConvId/);
    assert.doesNotMatch(html, /onclick="document\.getElementById\('stickerInput'\)\.click\(\)"/);
  }
});

test('shared csrf client recovers stale tokens without retrying authorization failures', () => {
  const client = fs.readFileSync('frontend/csrf-client.js', 'utf8');
  assert.match(client, /const liveToken = readCookie\(getCookieHeader\(\)\)/);
  assert.match(client, /let tokenRequest = null/);
  assert.match(client, /data\.code === 'CSRF_INVALID'/);
  assert.match(client, /await ensureToken\(\{ forceRefresh: true \}\)/);
  assert.match(client, /return send\(retryToken\)/);
  new vm.Script(client, { filename: 'frontend/csrf-client.js' });
});

for (const file of ['frontend/admin.html', 'frontend/vendor.html', 'frontend/superadmin.html', 'frontend/settings.html']) {
  test(`${file} uses the shared csrf-aware api client`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.equal((html.match(/src="\/csrf-client\.js"/g) || []).length, 1);
    assert.match(html, /ensureCsrfToken/);
    assert.match(html, /window\.CsrfClient\.ensureToken/);
    assert.match(html, /window\.CsrfClient\.fetch/);
    assert.doesNotMatch(html, /let csrfToken\s*=/);
  });
}

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} shows personal unread state and marks conversations read`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /unread-badge/);
    assert.match(html, /unread_count/);
    assert.match(html, /last_message_preview/);
    assert.match(html, /markConversationRead/);
    assert.match(html, /\/api\/conversations\/\$\{id\}\/read/);
  });

  test(`${file} avoids chat refresh flicker and stale message overwrites`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /messageLoadSeq/);
    assert.match(html, /lastRenderedMessageSignature/);
    assert.match(html, /function messagesSignature/);
    assert.match(html, /requestId !== messageLoadSeq \|\| id !== currentConvId/);
    assert.match(html, /lastRenderedConversationId === id && lastRenderedMessageSignature === signature/);
    assert.match(html, /loadMessages\(currentConvId, \{ preserveScroll: true \}\)/);
  });

  test(`${file} canonically merges message pages and guards realtime refresh races`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const script = [
      extractFunction(html, 'parseDate'),
      extractFunction(html, 'compareMessagesCanonical'),
      extractFunction(html, 'mergeMessagesById'),
      `result = JSON.stringify(mergeMessagesById(
        [{ id: 3, created_at: '2026-07-10 10:01:00', content: 'old' }, { id: 1, created_at: '2026-07-10 10:00:00' }],
        [{ id: 4, created_at: '2026-07-10 10:01:00' }, { id: 2, created_at: '2026-07-10 10:01:00' }, { id: 3, created_at: '2026-07-10 10:01:00', content: 'new' }]
      ).map(message => [message.id, message.content]));`
    ].join('\n');
    const context = { result: null };
    vm.createContext(context);
    new vm.Script(script, { filename: `${file}#message-merge-test` }).runInContext(context);

    assert.equal(context.result, JSON.stringify([[1, undefined], [2, undefined], [3, 'new'], [4, undefined]]));
    assert.match(html, /m\.media_type[\s\S]*m\.media_mimetype[\s\S]*m\.media_size/);
    assert.match(html, /m\.quoted_media_type[\s\S]*m\.quoted_media_url[\s\S]*m\.quoted_media_filename/);
    assert.match(html, /loadedMessagesConversationId === id && loadedMessagesFilter === activeMediaFilter/);
    assert.match(html, /olderMessagesLoading/);
    assert.match(html, /generation !== messageListGeneration/);
    assert.match(html, /requestId !== conversationLoadSeq/);
    assert.match(html, /socket\.on\('connect'/);
    assert.match(html, /conversationId == null \|\| conversationId === Number\(currentConvId\)/);

    const syncSource = extractFunction(html, 'syncSelectedConversation');
    assert.match(syncSource, file.includes('admin') ? /if \(!res\.ok\)/ : /if \(!result\.ok\)/);
    assert.match(syncSource, file.includes('admin') ? /showToast/ : /showVendorWarning/);
  });

  test(`${file} syncs the selected conversation from WhatsApp on open`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const syncSource = extractFunction(html, 'syncSelectedConversation');
    const requestSource = file.includes('vendor') ? extractFunction(html, 'requestConversationSync') : syncSource;

    assert.match(html, /async function selectConv\(id, options = \{\}[\s\S]*?syncSelectedConversation\(id\)/);
    assert.match(requestSource, /\/api\/conversations\/\$\{(?:id|conversationId)\}\/sync/);
    assert.match(requestSource, /method:\s*'POST'/);
    assert.match(syncSource, /messagesImported/);
    assert.match(syncSource, /loadMessages\(id,\s*\{ force: true \}\)/);
  });

  test(`${file} avoids sidebar refresh flicker when conversations are unchanged`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /lastRenderedConversationSignature/);
    assert.match(html, /function conversationsSignature/);
    assert.match(html, /lastRenderedConversationSignature === signature/);
    assert.match(html, /loadConversations\(\{ force: true \}\)/);
  });

  test(`${file} keeps replied message selected until the send request succeeds`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const sendMessageSource = extractFunction(html, 'sendMessage');

    assert.match(html, /class="msg-main" onclick="replyToMessage\(event, \$\{m\.id\}\)"/);
    assert.match(html, /class="reply-btn" onclick="replyToMessage\(event, \$\{message\.id\}\)"/);
    assert.match(html, /if \(task\.quotedMessageId\) payload\.quoted_message_id = task\.quotedMessageId/);
    assert.match(sendMessageSource, /const res = await api\(`\/api\/conversations\/\$\{conversationId\}\/messages`/);
    assert.match(sendMessageSource, /classifyDeliveryStatus\(data\.delivery_status\)/);
    assert.match(sendMessageSource, /outcome === 'uncertain'/);
    assert.ok(
      sendMessageSource.indexOf('const res = await api(`/api/conversations/${conversationId}/messages`') < sendMessageSource.indexOf('completeSendTask(attempt, task)'),
      `${file} must clear reply only after the send response`
    );
  });

  test(`${file} keeps the reply marker as a compact bar above the composer`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const quoteBarRule = html.match(/\.quote-bar\s*\{([^}]+)\}/)?.[1] || '';
    const quoteInfoRule = html.match(/\.quote-bar \.quote-info\s*\{([^}]+)\}/)?.[1] || '';

    assert.match(quoteBarRule, /flex:none/);
    assert.match(quoteBarRule, /max-height/);
    assert.doesNotMatch(quoteBarRule, /flex-basis\s*:\s*100%/);
    assert.match(quoteInfoRule, /border-left/);
  });

  if (file === 'frontend/admin.html') {
    test(`${file} keeps history sync non-blocking`, () => {
      const html = fs.readFileSync(file, 'utf8');
      const syncRule = html.match(/\.sync-loader-overlay\s*\{([^}]+)\}/)?.[1] || '';
      const importHistorySource = extractFunction(html, 'importHistory');

      assert.doesNotMatch(syncRule, /inset\s*:\s*0/);
      assert.doesNotMatch(syncRule, /backdrop-filter/);
      assert.doesNotMatch(syncRule, /position\s*:\s*fixed/);
      assert.doesNotMatch(syncRule, /bottom\s*:/);
      assert.match(syncRule, /pointer-events:\s*none/);
      assert.match(html, /<div id="syncLoader" class="sync-loader-overlay">[\s\S]*?<div id="tabConversations"/);
      assert.match(html, /socket\.on\('history:import',\s*applyHistoryImportStatus\)/);
      assert.match(importHistorySource, /setHistorySyncStatus\(true/);
      assert.doesNotMatch(importHistorySource, /syncLoader[\s\S]*classList\.add\('open'\)/);
    });
  }

  test(`${file} exposes per-user search, state actions, pagination, media filters and notifications`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /id="globalSearch"/);
    assert.match(html, /performGlobalSearch/);
    assert.match(html, /\/api\/search\?q=/);
    assert.match(html, /loadOlderMessages/);
    assert.match(html, /before_id=\$\{oldestLoadedMessageId\}/);
    assert.match(html, /id="mediaFilter"/);
    assert.match(html, /media_type=\$\{encodeURIComponent\(activeMediaFilter\)\}/);
    assert.match(html, /toggleConversationPinned/);
    assert.match(html, /markConversationUnread/);
    assert.match(html, /\/api\/conversations\/\$\{id\}\/state/);
    const notificationSource = fs.readFileSync('frontend/chat-notifications.js', 'utf8');
    assert.match(html, /chat-notifications\.js/);
    assert.match(notificationSource, /Notification\.requestPermission/);
    assert.match(notificationSource, /playSound/);
    assert.match(html, /notification:new/);
  });

  test(`${file} supports exact favorite navigation, multi-file previews and typing indicators`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /selectedFiles/);
    assert.match(html, /multiple/);
    assert.match(html, /renderFilePreview/);
    assert.match(html, /removeSelectedFile/);
    assert.match(html, /sendPayloadsSequentially/);
    assert.match(html, /selectConv\(m\.conversation_id,\s*\{ targetMessageId: m\.target_message_id/);
    assert.match(html, /highlightMessage/);
    assert.match(html, /data-message-id="\$\{m\.id\}"/);
    assert.match(html, /id="typingStatus"/);
    assert.match(html, /emitTyping/);
    assert.match(html, /typing:update/);
  });
}

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} treats unknown delivery as ambiguous and keeps logical retry ids stable`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const context = { result: null };
    vm.createContext(context);
    new vm.Script([
      'let currentUser = { role: "vendor", id: 7 };',
      'let composerRevision = 0;',
      'let pendingSendAttempt = null;',
      'let quotedMessageId = 31;',
      'let selectedFiles = [];',
      'let nextId = 0;',
      'const window = { crypto: { randomUUID: () => `request-${++nextId}` } };',
      'const document = { getElementById: id => id === "msgInput" ? { value: "mensagem importante" } : { value: "" } };',
      extractFunction(html, 'deliveryLabel'),
      extractFunction(html, 'createClientRequestId'),
      extractFunction(html, 'buildMessagePayloads'),
      extractFunction(html, 'sendPayloadsSequentially'),
      extractFunction(html, 'createSendAttempt'),
      extractFunction(html, 'getOrCreateSendAttempt'),
      extractFunction(html, 'invalidatePendingSendAttempt'),
      'const first = getOrCreateSendAttempt(44);',
      'const repeated = getOrCreateSendAttempt(44);',
      'const stableId = first.tasks[0].clientRequestId;',
      'invalidatePendingSendAttempt();',
      'const changed = getOrCreateSendAttempt(44);',
      'result = {',
      '  unknown: deliveryLabel({ from_type: "vendor", delivery_status: "unknown" }),',
      '  sent: deliveryLabel({ from_type: "vendor", delivery_status: "sent" }),',
      '  stable: repeated.tasks[0].clientRequestId === stableId,',
      '  renewedAfterEdit: changed.tasks[0].clientRequestId !== stableId',
      '};'
    ].join('\n'), { filename: `${file}#delivery-retry-test` }).runInContext(context);

    assert.match(context.result.unknown, /envio incerto/);
    assert.doesNotMatch(context.result.unknown, />enviado</);
    assert.match(context.result.sent, />enviado</);
    assert.equal(context.result.stable, true);
    assert.equal(context.result.renewedAfterEdit, true);
  });

  test(`${file} removes only confirmed batch items and limits delete-for-everyone`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const context = { result: null };
    vm.createContext(context);
    new vm.Script([
      'const firstFile = { file: { name: "primeiro.png" } };',
      'const secondFile = { file: { name: "segundo.png" } };',
      'let selectedFiles = [firstFile, secondFile];',
      'let currentUser = { role: "vendor", id: 7 };',
      'const fields = { fileInput: { value: "files" }, stickerInput: { value: "stickers" } };',
      'const document = { getElementById: id => fields[id] };',
      'function renderFilePreview() {}',
      extractFunction(html, 'removeCompletedSendTask'),
      extractFunction(html, 'canDeleteMessageForEveryone'),
      'const firstTask = { fileItem: firstFile };',
      'const secondTask = { fileItem: secondFile };',
      'const attempt = { tasks: [firstTask, secondTask] };',
      'removeCompletedSendTask(attempt, firstTask);',
      'const ownAllowed = canDeleteMessageForEveryone({ from_type: "vendor", vendor_id: 7 });',
      'const otherDenied = canDeleteMessageForEveryone({ from_type: "vendor", vendor_id: 8 });',
      'const inboundDenied = canDeleteMessageForEveryone({ from_type: "client", vendor_id: 7 });',
      'currentUser = { role: "admin", id: 2 };',
      'const adminAllowed = canDeleteMessageForEveryone({ from_type: "vendor", vendor_id: 8 });',
      'result = { remainingTasks: attempt.tasks.length, remainingFiles: selectedFiles.length, keptSecond: selectedFiles[0] === secondFile, ownAllowed, otherDenied, inboundDenied, adminAllowed };'
    ].join('\n'), { filename: `${file}#partial-batch-test` }).runInContext(context);

    assert.deepEqual(
      JSON.parse(JSON.stringify(context.result)),
      { remainingTasks: 1, remainingFiles: 1, keptSecond: true, ownAllowed: true, otherDenied: false, inboundDenied: false, adminAllowed: true }
    );
  });
}

test('admin custom dropdown renders option labels as text, never HTML', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');
  const source = extractFunction(html, 'makeCustomDropdown');
  assert.match(source, /display\.textContent = selectedOpt \? selectedOpt\.text : 'Selecione\.\.\.'/);
  assert.doesNotMatch(source, /display\.innerHTML/);
});

for (const file of ['frontend/admin.html', 'frontend/vendor.html']) {
  test(`${file} paginates conversations incrementally without automatic full scans`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const loadSource = html.match(/async function loadConversations[\s\S]*?\n}\n\nfunction scheduleConversationRefresh/)?.[0] || '';
    const loadMoreSource = extractFunction(html, 'loadMoreConversations');
    const scheduleSource = extractFunction(html, 'scheduleConversationRefresh');

    assert.match(html, /const CONVERSATION_PAGE_SIZE = 200/);
    assert.match(html, /Carregar conversas anteriores/);
    assert.match(html, /aria-label="Carregar conversas anteriores"/);
    assert.match(loadSource, /const offset = append \? conversationNextOffset : 0/);
    assert.match(html, /limit=\$\{CONVERSATION_PAGE_SIZE\}&offset=\$\{offset\}/);
    assert.match(loadSource, /mergeConversationPage\(cachedConversations, convsPage, \{ append, preserveTail \}\)/);
    assert.match(loadSource, /list\.scrollTop = previousScrollTop/);
    assert.match(loadMoreSource, /append: true/);
    assert.doesNotMatch(loadMoreSource, /\bwhile\s*\(/);
    assert.doesNotMatch(loadMoreSource, /\bfor\s*\(/);
    assert.doesNotMatch(scheduleSource, /append:\s*true/);
    assert.match(html, /resetPagination:\s*true/);
  });

  test(`${file} deduplicates appended pages and preserves already loaded tails on first-page refresh`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const mergeSource = html.match(/function mergeConversationPage[\s\S]*?\n}\n\nfunction resetConversationPagination/)?.[0]
      ?.replace(/\n\nfunction resetConversationPagination$/, '') || '';
    const context = { result: null };
    vm.createContext(context);
    new vm.Script([
      'const CONVERSATION_PAGE_SIZE = 200;',
      extractFunction(html, 'dedupeConversationPages'),
      mergeSource,
      'const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, value: `old-${index + 1}` }));',
      'const appended = mergeConversationPage(firstPage, [{ id: 200, value: "duplicate" }, { id: 201 }, { id: 202 }], { append: true });',
      'const refreshedFirstPage = [{ id: 999, value: "new" }, ...Array.from({ length: 199 }, (_, index) => ({ id: index + 2 }))];',
      'const refreshed = mergeConversationPage(appended, refreshedFirstPage, { preserveTail: true });',
      'result = {',
      '  appendedLength: appended.length,',
      '  duplicateUsesOriginal: appended.find(item => item.id === 200).value === "old-200",',
      '  refreshedLength: refreshed.length,',
      '  firstId: refreshed[0].id,',
      '  tailIds: refreshed.slice(-2).map(item => item.id)',
      '};'
    ].join('\n'), { filename: `${file}#conversation-pagination-test` }).runInContext(context);

    assert.deepEqual(
      JSON.parse(JSON.stringify(context.result)),
      { appendedLength: 202, duplicateUsesOriginal: true, refreshedLength: 202, firstId: 999, tailIds: [201, 202] }
    );
  });
}
