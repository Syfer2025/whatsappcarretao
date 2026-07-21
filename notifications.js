const nodemailer = require('nodemailer');

let transporter = null;
let warnedMissingConfig = false;

function getTransporter(logger) {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      logger?.warn('SMTP não configurado (SMTP_HOST ausente) — e-mails serão apenas logados, não enviados.');
    }
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporter;
}

// Nunca lança erro — falha de e-mail não deve derrubar a requisição que a disparou.
async function sendEmail({ to, subject, html }, logger) {
  const t = getTransporter(logger);
  if (!t) {
    logger?.info({ to, subject }, '[email não enviado — SMTP não configurado]');
    return false;
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html
    });
    return true;
  } catch (err) {
    logger?.error({ err, to, subject }, 'Falha ao enviar e-mail');
    return false;
  }
}

function notifyNewSignup({ companyName, email }, logger) {
  const notifyTo = process.env.SUPERADMIN_NOTIFY_EMAIL;
  if (!notifyTo) return Promise.resolve(false);
  return sendEmail({
    to: notifyTo,
    subject: `Novo cliente cadastrado: ${companyName}`,
    html: `<p>Empresa <strong>${escapeHtml(companyName)}</strong> se cadastrou (admin: ${escapeHtml(email)}).</p>`
  }, logger);
}

function notifyTrialEnding({ to, companyName, daysLeft }, logger) {
  return sendEmail({
    to,
    subject: `Seu trial termina em ${daysLeft} dia(s)`,
    html: `<p>Olá! O período de teste da sua conta (<strong>${escapeHtml(companyName)}</strong>) termina em ${Number(daysLeft)} dia(s). Assine para não perder o acesso.</p>`
  }, logger);
}

function notifyPaymentFailed({ to, companyName }, logger) {
  return sendEmail({
    to,
    subject: 'Falha no pagamento da sua assinatura',
    html: `<p>Não conseguimos processar o pagamento da assinatura de <strong>${escapeHtml(companyName)}</strong>. O acesso foi suspenso até a regularização.</p>`
  }, logger);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notifyPasswordResetRequested({ companyName, email }, logger) {
  const notifyTo = process.env.SUPERADMIN_NOTIFY_EMAIL;
  if (!notifyTo) return Promise.resolve(false);
  return sendEmail({
    to: notifyTo,
    subject: `Solicitação de senha: ${String(companyName || 'cliente').slice(0, 120)}`,
    html: `<p>O administrador <strong>${escapeHtml(email)}</strong>, da empresa <strong>${escapeHtml(companyName)}</strong>, solicitou recuperação de senha.</p><p>Acesse o painel de superadmin para definir uma nova senha.</p>`
  }, logger);
}

module.exports = {
  sendEmail,
  notifyNewSignup,
  notifyTrialEnding,
  notifyPaymentFailed,
  notifyPasswordResetRequested
};
