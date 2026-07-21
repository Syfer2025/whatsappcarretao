'use strict';

const { sleep, withTimeout } = require('./runtimeUtils');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function mediaReady(media) {
  return Boolean(media?.data && media?.mimetype);
}

/**
 * A mensagem chega pelo evento do WhatsApp antes de a chave/URL da mídia estar
 * disponível em alguns aparelhos. Recarregar o Message pelo external_id é
 * importante: repetir downloadMedia() no mesmo objeto costuma repetir o cache
 * incompleto que originou o evento.
 */
async function downloadRealtimeMediaWithRetry({
  message,
  client,
  externalId,
  attempts = 4,
  baseDelayMs = 750,
  downloadTimeoutMs = 8000,
  lookupTimeoutMs = 5000,
  sleepFn = sleep,
  onAttemptFailure = null
}) {
  const maximumAttempts = positiveInteger(attempts, 4);
  const retryBaseDelayMs = Math.max(0, Number(baseDelayMs) || 0);
  let candidate = message;
  let lastError = null;
  let completedAttempts = 0;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    completedAttempts = attempt;
    if (attempt > 1) {
      const delayMs = retryBaseDelayMs * (2 ** (attempt - 2));
      if (delayMs > 0) await sleepFn(delayMs);

      if (externalId && typeof client?.getMessageById === 'function') {
        try {
          const refreshed = await withTimeout(
            () => client.getMessageById(externalId),
            lookupTimeoutMs,
            'getMessageById para mídia'
          );
          if (refreshed) candidate = refreshed;
        } catch (err) {
          // O objeto original ainda pode se tornar baixável; a falha de lookup
          // não encerra a tentativa atual.
          lastError = err;
        }
      }
    }

    try {
      if (typeof candidate?.downloadMedia !== 'function') {
        throw new Error('Mensagem ainda não expõe downloadMedia');
      }
      const media = await withTimeout(
        () => candidate.downloadMedia(),
        downloadTimeoutMs,
        'downloadMedia'
      );
      if (!mediaReady(media)) throw new Error('Mídia ainda não disponível no WhatsApp Web');
      return { media, message: candidate, attempts: attempt, lastError: null };
    } catch (err) {
      lastError = err;
      try {
        onAttemptFailure?.(err, { attempt, maximumAttempts });
      } catch {}
      // withTimeout cannot cancel downloadMedia() inside Chromium. Starting a
      // second download immediately after a timeout leaves both operations in
      // flight, multiplying ArrayBuffer/base64 memory during an outage. The
      // caller already schedules a later targeted repair, so stop this burst
      // after a timeout while retaining retries for quick "not ready" failures.
      if (err?.code === 'OPERATION_TIMEOUT') break;
    }
  }

  return { media: null, message: candidate, attempts: completedAttempts, lastError };
}

module.exports = { downloadRealtimeMediaWithRetry };
