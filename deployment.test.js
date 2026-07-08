const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('docker deployment files persist database whatsapp auth and media', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const dockerignore = fs.readFileSync('.dockerignore', 'utf8');
  const gitignore = fs.readFileSync('.gitignore', 'utf8');

  assert.match(dockerfile, /FROM node:/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /CMD \["npm", "start"\]/);
  assert.match(compose, /whatsapp-bot:/);
  assert.match(compose, /127\.0\.0\.1.*3000:3000/);
  assert.match(compose, /\/app\/data\.db/);
  assert.match(compose, /\/app\/media/);
  assert.match(compose, /\/app\/\.wwebjs_auth/);
  assert.match(compose, /JWT_SECRET/);
  assert.match(compose, /TRUST_PROXY/);
  assert.match(compose, /ADMIN_PASSWORD/);
  assert.match(dockerignore, /node_modules/);
  assert.match(dockerignore, /\.wwebjs_auth/);
  assert.match(dockerignore, /data\.db/);
  assert.match(gitignore, /\.env/);
  assert.match(gitignore, /data\.db/);
  assert.match(gitignore, /media/);
  assert.match(gitignore, /\.wwebjs_auth/);
});

test('project has lint formatting and CI entrypoints', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const eslint = fs.readFileSync('eslint.config.js', 'utf8');
  const prettier = fs.readFileSync('.prettierrc', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(pkg.scripts.lint, /eslint/);
  assert.match(pkg.scripts.format, /prettier/);
  assert.match(eslint, /globals/);
  assert.match(prettier, /singleQuote/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run lint/);
});
