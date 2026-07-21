'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ChatAudioPlayer = require('./frontend/chat-audio-player');

function fakeButton(rate) {
  const classes = new Set();
  const attributes = new Map();
  return {
    dataset: { audioSpeed: String(rate) },
    classList: {
      toggle(name, active) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); }
  };
}

function fakePlayer(key = 'message:1') {
  const audio = {
    playbackRate: 1,
    defaultPlaybackRate: 1,
    preservesPitch: false,
    webkitPreservesPitch: false
  };
  const buttons = [1, 2, 3].map(fakeButton);
  return {
    audio,
    buttons,
    player: {
      dataset: { audioKey: key },
      querySelector(selector) { return selector === 'audio' ? audio : null; },
      querySelectorAll(selector) { return selector === '[data-audio-speed]' ? buttons : []; }
    }
  };
}

test('chat audio player exposes only 1x, 2x and 3x with accessible controls', () => {
  assert.deepEqual([...ChatAudioPlayer.ALLOWED_RATES], [1, 2, 3]);
  const html = ChatAudioPlayer.render('/media/audio.ogg', {
    key: 'message:7',
    label: 'Mensagem de voz'
  });

  assert.match(html, /data-audio-player/);
  assert.match(html, /data-audio-key="message:7"/);
  assert.match(html, /<audio controls preload="metadata"/);
  assert.match(html, /role="group" aria-label="Velocidade de reprodução"/);
  assert.equal((html.match(/data-audio-speed=/g) || []).length, 3);
  assert.match(html, /data-audio-speed="1"[^>]+aria-pressed="true"/);
  assert.match(html, /data-audio-speed="2"[^>]+aria-pressed="false"/);
  assert.match(html, /data-audio-speed="3"[^>]+aria-pressed="false"/);
  assert.doesNotMatch(html, /data-audio-speed="(?:0|4)"/);
});

test('chat audio player escapes source key and label attributes', () => {
  const html = ChatAudioPlayer.render('/media/x" onerror="alert(1)', {
    key: '<message>',
    label: 'Áudio "urgente"'
  });

  assert.doesNotMatch(html, /onerror="alert/);
  assert.match(html, /x&quot; onerror=&quot;alert\(1\)/);
  assert.match(html, /data-audio-key="&lt;message&gt;"/);
  assert.match(html, /aria-label="Áudio &quot;urgente&quot;"/);
});

test('changing speed updates native playback and the selected accessible state', () => {
  const { player, audio, buttons } = fakePlayer();
  const applied = ChatAudioPlayer.applyRate(player, 3);

  assert.equal(applied, 3);
  assert.equal(audio.playbackRate, 3);
  assert.equal(audio.defaultPlaybackRate, 3);
  assert.equal(audio.preservesPitch, true);
  assert.equal(audio.webkitPreservesPitch, true);
  assert.equal(player.dataset.playbackRate, '3');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'false');
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[2].classList.contains('active'), true);
});

test('invalid playback speeds safely fall back to 1x and player state stays keyed', () => {
  const first = fakePlayer('message:first');
  const second = fakePlayer('message:second');

  ChatAudioPlayer.applyRate(first.player, 2);
  ChatAudioPlayer.applyRate(second.player, 'not-a-rate');

  assert.equal(first.audio.playbackRate, 2);
  assert.equal(second.audio.playbackRate, 1);
  assert.equal(ChatAudioPlayer.normalizeRate(0), 1);
  assert.equal(ChatAudioPlayer.normalizeRate(-1), 1);
  assert.equal(ChatAudioPlayer.normalizeRate(2), 2);
  assert.equal(ChatAudioPlayer._remembered('message:first').rate, 2);
  assert.equal(ChatAudioPlayer._remembered('message:second').rate, 1);
});
