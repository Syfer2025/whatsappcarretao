'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-ai-tests-'));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATA_DIR: path.join(sandboxRoot, 'data'),
  MEDIA_ROOT: path.join(sandboxRoot, 'media'),
  WA_AUTH_DIR: path.join(sandboxRoot, 'whatsapp-auth'),
  // O fork roda localmente em modo interno via .env, mas a suíte legada ainda
  // cobre explicitamente o comportamento SaaS. Cada teste de modo interno
  // habilita a flag em seu próprio processo filho para não contaminar os
  // cenários de plataforma existentes.
  APP_MODE: 'saas',
  INTERNAL_SINGLE_TENANT: 'false',
  ADMIN_USERNAME: 'test-superadmin@example.test',
  ADMIN_PASSWORD: 'test-only-admin-password'
};

let status = 1;
try {
  // Todos os arquivos herdam o mesmo DATA_DIR descartável. Executá-los em
  // workers paralelos faria suites sem relação disputarem o mesmo master.db e
  // tornaria o CI intermitente; testes de concorrência continuam criando seus
  // próprios processos explicitamente.
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2)], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  status = result.status == null ? 1 : result.status;
} finally {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
}

process.exitCode = status;
