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

test('login page does not expose whatsapp qr before authentication', () => {
  const html = fs.readFileSync('frontend/login.html', 'utf8');

  assert.equal(html.includes('/api/status'), false);
  assert.equal(html.includes('qrBox'), false);
  assert.equal(html.includes('qrImg'), false);
  assert.equal(html.includes('qrserver'), false);
});

test('admin page exposes users sectors and connection panels', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');

  assert.match(html, /Usuarios/);
  assert.match(html, /Setores/);
  assert.match(html, /Conexao/);
  assert.match(html, /loadUsers/);
  assert.match(html, /loadSectors/);
  assert.match(html, /loadConnection/);
  assert.match(html, /resetWhatsAppSession/);
});

test('admin page separates unassigned and forwarded conversation queues', () => {
  const html = fs.readFileSync('frontend/admin.html', 'utf8');

  assert.match(html, /Não encaminhadas/);
  assert.match(html, /Encaminhadas/);
  assert.match(html, /id="tabForwarded"/);
  assert.match(html, /adminConversationQueue/);
  assert.match(html, /queue=unassigned/);
  assert.match(html, /queue=forwarded/);
  assert.match(html, /loadForwardedConversations/);
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
  test(`${file} keeps an auth cookie available for private media requests`, () => {
    const html = fs.readFileSync(file, 'utf8');

    assert.match(html, /function setAuthCookie/);
    assert.match(html, /auth_token=/);
    assert.match(html, /SameSite=Lax/);
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
    assert.match(html, /class="reply-btn" onclick="replyToMessage\(event, \$\{m\.id\}\)"/);
    assert.match(html, /payload\.quoted_message_id = quotedMessageId/);
    assert.match(sendMessageSource, /const res = await api\(`\/api\/conversations\/\$\{currentConvId\}\/messages`/);
    assert.match(sendMessageSource, /data\.delivery_status === 'failed'/);
    assert.ok(
      sendMessageSource.indexOf('const res = await api(`/api/conversations/${currentConvId}/messages`') < sendMessageSource.indexOf('cancelReply();'),
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
    assert.match(html, /Notification\.requestPermission/);
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
