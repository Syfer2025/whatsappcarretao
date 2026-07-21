#!/usr/bin/env node

const { buildTotpUri, generateTotpSecret } = require('../totp');

const account = String(process.argv[2] || process.env.SUPERADMIN_EMAIL || '').trim();
const issuer = String(process.env.APP_NAME || 'WhatsApp AI').trim();
if (!account) {
  process.stderr.write('Uso: node scripts/generate-superadmin-totp.js email@empresa.com\n');
  process.exit(1);
}

const secret = generateTotpSecret();
const uri = buildTotpUri({ secret, account, issuer });
process.stdout.write(`SUPERADMIN_TOTP_SECRET=${secret}\n`);
process.stdout.write(`${uri}\n`);
