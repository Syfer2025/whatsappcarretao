'use strict';

const path = require('path');
const { SCHEMA_VERSION } = require('../schema');
const { auditGlobalIntegrity } = require('./global-integrity');

const rootDir = path.resolve(__dirname, '..');
const result = auditGlobalIntegrity({
  rootDir,
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
  mediaDir: process.env.MEDIA_ROOT || path.join(rootDir, 'media'),
  authDir: process.env.WA_AUTH_DIR || path.join(rootDir, '.wwebjs_auth'),
  expectedSchema: SCHEMA_VERSION,
  requireApplicationLayout: false,
  allowFirstInstall: true,
  // O auditor operacional preserva o aviso para bancos orfaos vazios, mas
  // falha se houver dados. Backups de producao usam a politica estrita.
  strictOrphanDatabases: 'nonempty',
});

process.stdout.write(
  `${JSON.stringify({
    ok: result.ok,
    applicable: result.applicable,
    firstInstall: result.firstInstall,
    summary: result.summary,
    warnings: result.warnings,
    errors: result.errors,
  })}\n`,
);
if (!result.ok) process.exitCode = 1;
