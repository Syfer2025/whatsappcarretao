const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Regressao 04/set/2026: um outage do endpoint de auditoria da npm (503 /
// network timeout) derrubava o deploy e o CI como se houvesse vulnerabilidade,
// bloqueando producao sem nada errado nas dependencias.
test('o gate de auditoria distingue outage da npm de vulnerabilidade real', () => {
  const fs = require('node:fs');
  const deploy = fs.readFileSync(require.resolve('./deploy.sh'), 'utf8');

  assert.match(deploy, /audit_com_retentativa/, 'deploy.sh deve usar o wrapper com retentativa');
  assert.match(deploy, /Service Unavailable/, 'deve reconhecer o 503 do registry');
  assert.match(deploy, /network timeout/, 'deve reconhecer timeout de rede');
  // A trava tem de continuar FECHADA para vulnerabilidade: erro que nao seja
  // de rede aborta na hora, sem repetir.
  assert.match(deploy, /vulnerabilidade de severidade alta/);
  assert.ok(
    !/^npm audit --omit=dev --audit-level=high$/m.test(deploy),
    'nao deve mais chamar npm audit direto, sem tratamento'
  );

  const ci = fs.readFileSync(new URL('./.github/workflows/ci.yml', `file://${__dirname}/`), 'utf8');
  assert.match(ci, /Audit dependencies/, 'ci.yml deve usar o passo tratado');
  assert.ok(
    !/^\s+- run: npm audit --audit-level=high\s*$/m.test(ci),
    'ci.yml nao deve mais chamar npm audit direto'
  );
});

test('docker deployment files persist database whatsapp auth and media', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const dockerignore = fs.readFileSync('.dockerignore', 'utf8');
  const gitignore = fs.readFileSync('.gitignore', 'utf8');

  assert.match(dockerfile, /FROM node:/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /PUPPETEER_SKIP_DOWNLOAD=true/);
  assert.match(dockerfile, /chromium-sandbox/);
  assert.match(dockerfile, /ffmpeg/);
  assert.match(dockerfile, /FFMPEG_PATH=\/usr\/bin\/ffmpeg/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
  assert.match(dockerfile, /health\/ready/);
  assert.match(compose, /whatscarretao:/);
  assert.match(compose, /127\.0\.0\.1.*3100:3100/);
  // Persistência: monta a PASTA data/ inteira (master.db, data.db e bancos por
  // tenant com seus -wal/-shm). Montar arquivos .db avulsos perdia o WAL.
  assert.match(compose, /\.\/data:\/app\/data/);
  assert.doesNotMatch(compose, /:\/app\/data\.db/);
  assert.doesNotMatch(compose, /:\/app\/master\.db/);
  assert.match(compose, /\/app\/media/);
  assert.match(compose, /\/app\/\.wwebjs_auth/);
  assert.match(compose, /\.\/backups:\/app\/backups/);
  assert.match(compose, /JWT_SECRET/);
  assert.match(compose, /TRUST_PROXY/);
  assert.match(compose, /ADMIN_PASSWORD/);
  assert.match(dockerignore, /node_modules/);
  assert.match(dockerignore, /\.wwebjs_auth/);
  assert.match(dockerignore, /backups/);
  assert.match(dockerignore, /data\.db/);
  assert.match(dockerignore, /data_\*\.db/);
  assert.match(gitignore, /\.env/);
  assert.match(gitignore, /data\.db/);
  assert.match(gitignore, /^data\/$/m);
  assert.match(gitignore, /master\.db/);
  assert.match(gitignore, /media/);
  assert.match(gitignore, /\.wwebjs_auth/);
  assert.match(gitignore, /backups/);
});

test('container runs as non-root with reduced privileges', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');

  assert.match(dockerfile, /USER node:node/);
  assert.match(dockerfile, /chown -R node:node data media backups \.wwebjs_auth \.wwebjs_cache/);
  assert.doesNotMatch(dockerfile, /chown -R node:node \/app/);
  assert.match(compose, /user:\s+['"]\$\{APP_UID:-1000\}:\$\{APP_GID:-1000\}['"]/);
  assert.match(compose, /security_opt:\n\s+- no-new-privileges:true/);
  assert.doesNotMatch(compose, /seccomp=unconfined/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /tmpfs:\n\s+- \/tmp/);
  assert.match(compose, /pids_limit:/);
  assert.match(compose, /mem_limit:/);
  assert.match(compose, /cpus:/);
  assert.match(compose, /ulimits:[\s\S]*nofile:[\s\S]*65536/);
  assert.match(compose, /logging:[\s\S]*max-size:[\s\S]*max-file:/);
  assert.match(server, /process\.umask\(0o077\)/);
});

test('project has lint formatting and CI entrypoints', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const eslint = fs.readFileSync('eslint.config.js', 'utf8');
  const prettier = fs.readFileSync('.prettierrc', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(pkg.scripts.lint, /eslint/);
  assert.match(pkg.scripts.test, /scripts\/run-tests\.js/);
  assert.match(fs.readFileSync('scripts/run-tests.js', 'utf8'), /--test-concurrency=1/);
  assert.match(pkg.scripts.check, /npm run lint/);
  assert.match(pkg.scripts.check, /npm test/);
  assert.match(pkg.scripts.backup, /scripts\/backup\.js/);
  assert.match(pkg.scripts['backup:verify'], /scripts\/verify-backup\.js/);
  assert.match(pkg.scripts['restore:prepare'], /scripts\/prepare-restore\.js/);
  assert.match(pkg.scripts['production:validate'], /validate-production-env\.js/);
  assert.match(pkg.scripts.format, /prettier/);
  assert.equal(pkg.engines.node, '>=22 <25');
  assert.match(eslint, /globals/);
  assert.match(prettier, /singleQuote/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run lint/);
  assert.equal((ci.match(/APP_MODE: internal/g) || []).length, 2);
  assert.equal((ci.match(/INTERNAL_SINGLE_TENANT: 'true'/g) || []).length, 2);
  assert.doesNotMatch(ci, /STRIPE_PRICE_ID_(?:BASIC|PRO):\s+price_[A-Za-z0-9]+_[A-Za-z0-9]+/);
  assert.match(ci, /docker compose config --quiet/);
  assert.match(ci, /docker build --check/);
  assert.match(ci, /docker build --tag whatscarretao:ci/);
  assert.match(
    ci,
    /docker run[\s\S]*--user 1000:1000[\s\S]*--cap-drop ALL[\s\S]*no-new-privileges:true[\s\S]*\/usr\/bin\/chromium[\s\S]*--dump-dom about:blank/,
  );
});

test('security operations runbook and CI cover production controls', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const runbook = fs.readFileSync('docs/operations/security-runbook.md', 'utf8');

  assert.match(compose, /CLAMSCAN_PATH/);
  assert.match(compose, /WA_BROWSER_MODE:\s+isolated/);
  assert.match(compose, /WA_NO_SANDBOX:\s+\$\{WA_NO_SANDBOX:-false\}/);
  assert.match(ci, /npm audit --audit-level=high/);
  for (const term of [
    'WAF',
    'SIEM',
    'EDR',
    'backup',
    'restore',
    'RPO',
    'RTO',
    'SBOM',
    'CLAMSCAN_PATH',
    'SPF',
    'DKIM',
    'DMARC',
    'DNSSEC',
    'incidente',
  ]) {
    assert.match(runbook, new RegExp(term, 'i'), `${term} must be documented`);
  }
});

test('production compose fails closed on internal authentication and single-company invariants', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');

  for (const variable of [
    'JWT_SECRET',
    'CORS_ORIGIN',
    'APP_URL',
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
  ]) {
    assert.match(compose, new RegExp(`${variable}: \\${'${'}${variable}:\\?`));
  }
  assert.match(compose, /APP_MODE:\s+internal/);
  assert.match(compose, /INTERNAL_SINGLE_TENANT:\s+['"]true['"]/);
  assert.match(compose, /INTERNAL_AGENT_LIMIT:/);
  assert.match(compose, /BILLING_REQUIRED:\s+['"]false['"]/);
  assert.match(compose, /WA_MAX_CONCURRENT_SESSIONS:\s+['"]1['"]/);
  assert.doesNotMatch(compose, /STRIPE_(?:SECRET|WEBHOOK|PRICE)/);
  assert.doesNotMatch(compose, /TURNSTILE_(?:SITE|SECRET)/);
  assert.doesNotMatch(compose, /TRIAL_DAYS:/);
  assert.match(compose, /WA_BROWSER_MODE:\s+isolated/);
  assert.match(compose, /COOKIE_SECURE:\s+['"]true['"]/);
  assert.match(compose, /SQLITE_SYNCHRONOUS:\s+FULL/);
  assert.match(compose, /SINGLE_WRITER_LEASE_TTL_MS:\s+\$\{SINGLE_WRITER_LEASE_TTL_MS:-90000\}/);
  assert.match(compose, /SINGLE_WRITER_LEASE_HEARTBEAT_MS:\s+\$\{SINGLE_WRITER_LEASE_HEARTBEAT_MS:-20000\}/);
  assert.match(compose, /stop_grace_period:\s+\$\{DEPLOY_STOP_TIMEOUT:-120\}s/);
  assert.match(compose, /healthcheck:[\s\S]*\/health\/ready/);
  assert.match(dockerfile, /HEALTHCHECK[^\n]*\/health\/ready/);
});

test('deploy builds online, snapshots once while quiescent and rolls back every post-stop failure', () => {
  const deploy = fs.readFileSync('deploy.sh', 'utf8');
  const checksIndex = deploy.indexOf('npm run check');
  const buildIndex = deploy.indexOf('docker compose build');
  const candidateTestIndex = deploy.indexOf('docker run --rm --network none');
  const stopIndex = deploy.indexOf('docker compose stop --timeout');
  const backupIndex = deploy.indexOf('npm run --silent backup 2>&1');
  const verifyIndex = deploy.indexOf('npm run --silent backup:verify');
  const upIndex = deploy.indexOf('docker compose up -d --force-recreate', backupIndex);

  assert.ok(checksIndex >= 0 && checksIndex < buildIndex, 'tests must finish while the current service stays online');
  assert.ok(buildIndex >= 0 && buildIndex < stopIndex, 'candidate image must be built before the planned stop');
  assert.ok(
    buildIndex < candidateTestIndex && candidateTestIndex < stopIndex,
    'candidate image must be tested without production volumes before the planned stop',
  );
  assert.ok(stopIndex < backupIndex, 'the application must stop before the global snapshot');
  assert.match(deploy, /ffmpeg[\s\S]*libopus/);
  assert.match(
    deploy,
    /--user "\$APP_UID:\$APP_GID"[\s\S]*--cap-drop ALL[\s\S]*--security-opt no-new-privileges:true[\s\S]*--entrypoint \/usr\/bin\/chromium[\s\S]*--dump-dom about:blank/,
    'candidate must prove Chromium starts with the same non-root sandbox restrictions used in production',
  );
  assert.doesNotMatch(
    deploy,
    /--entrypoint \/usr\/bin\/chromium[^\n]*--no-sandbox/,
    'candidate smoke must not hide an unusable Chromium sandbox',
  );
  assert.ok(backupIndex < verifyIndex, 'the new snapshot must be independently verified');
  assert.ok(verifyIndex < upIndex, 'no candidate container may start before backup verification');
  assert.equal(
    (deploy.match(/docker compose stop --timeout/g) || []).length,
    1,
    'nominal deploy must have exactly one planned graceful stop',
  );
  assert.doesNotMatch(deploy, /docker compose down/);
  assert.match(deploy, /docker compose config --quiet/);
  assert.match(deploy, /health\/ready/);
  assert.match(deploy, /rollback/);
  assert.match(deploy, /PREVIOUS_IMAGE_ID/);
  assert.match(deploy, /validate-production-env\.js/);
  assert.match(deploy, /validate-host-capacity\.js/);
  assert.match(deploy, /DEPLOY_LOCK_FILE=.*\.deploy\.lock/);
  assert.match(deploy, /flock -n 9/);
  assert.match(deploy, /BACKUP_RETENTION="\$\{BACKUP_RETENTION:-4\}"/);
  assert.match(deploy, /DEPLOY_STOP_TIMEOUT="\$\{DEPLOY_STOP_TIMEOUT:-120\}"/);
  assert.match(deploy, /parseEnv/);
  assert.doesNotMatch(deploy, /source\s+["']?\$ENV_FILE/);
  assert.match(deploy, /DEPLOY_APP_NAME/);
  assert.match(deploy, /npm audit --omit=dev --audit-level=high/);
  assert.match(deploy, /APP_UID deve ser o UID/);
  assert.match(deploy, /MIN_FREE_DISK_MB/);
  assert.match(deploy, /BACKUP_FREE_MARGIN_MB/);
  assert.match(deploy, /BACKUP_QUIESCED=true/);
  assert.match(deploy, /BACKUP_REQUIRE_NO_LIVE_LEASE=true/);
  assert.match(deploy, /BACKUP_REQUIRE_GLOBAL_CONSISTENCY=true/);
  assert.match(deploy, /backup global quiescente falhou.*imagem anterior/s);
  assert.match(deploy, /trap emergency_recover_on_exit EXIT/);
  assert.match(deploy, /POST_STOP_UNVALIDATED=true/);
  assert.match(
    deploy,
    /if ! docker compose stop --timeout "\$DEPLOY_STOP_TIMEOUT" "\$DEPLOY_APP_NAME"; then[\s\S]*rollback "falha ao solicitar a parada graciosa/,
  );
  assert.match(deploy, /force-recreate/);
  assert.match(deploy, /CANDIDATE_IMAGE/);
  assert.match(deploy, /PREVIOUS_STABLE_IMAGE/);
  assert.ok(fs.statSync('deploy.sh').mode & 0o111, 'deploy.sh must be executable');
});

test('example environment uses placeholders and backup implementation excludes env secrets', () => {
  const example = fs.readFileSync('.env.example', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const backup = fs.readFileSync('scripts/backup.js', 'utf8');
  const backupTest = fs.readFileSync('backup.test.js', 'utf8');

  for (const variable of [
    'DOMAIN',
    'APP_URL',
    'CORS_ORIGIN',
    'JWT_SECRET',
    'ADMIN_PASSWORD',
    'APP_MODE',
    'INTERNAL_SINGLE_TENANT',
    'INTERNAL_ADMIN_NAME',
    'INTERNAL_AGENT_LIMIT',
    'BACKUP_RETENTION',
    'BACKUP_LOCK_STALE_MS',
    'BACKUP_FREE_MARGIN_MB',
    'FFMPEG_PATH',
    'MAX_MESSAGE_QUEUE_BYTES',
    'MAX_GLOBAL_MESSAGE_QUEUE_BYTES',
    'DEPLOY_STOP_TIMEOUT',
    'MIN_FREE_DISK_MB',
    'APP_UID',
    'APP_GID',
    'MEMORY_LIMIT',
    'CPU_LIMIT',
    'PIDS_LIMIT',
    'REGISTER_RATE_LIMIT_MAX',
    'GET_CHATS_TIMEOUT_MS',
    'HISTORY_CHAT_FETCH_TIMEOUT_MS',
    'HISTORY_IMPORT_LOCK_WAIT_MS',
    'RECENT_SYNC_INTERVAL_MS',
    'RECENT_SYNC_CHAT_LIMIT',
    'RECENT_SYNC_MESSAGE_LIMIT',
    'RECENT_SYNC_MAX_FETCH_LIMIT',
    'FULL_SYNC_MAX_FETCH_LIMIT',
    'FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT',
    'FULL_RECONCILE_INTERVAL_MS',
    'CONVERSATION_SYNC_MESSAGE_LIMIT',
    'CONVERSATION_SYNC_TIMEOUT_MS',
    'CONVERSATION_SYNC_SETTLE_MS',
    'CONVERSATION_SYNC_COOLDOWN_MS',
    'OLDER_SYNC_MAX_FETCH_LIMIT',
    'OLDER_SYNC_TIMEOUT_MS',
    'INCOMING_ENRICHMENT_CONCURRENCY',
    'INCOMING_ENRICHMENT_MAX_PENDING',
    'REALTIME_MEDIA_DOWNLOAD_ATTEMPTS',
    'REALTIME_MEDIA_RETRY_BASE_DELAY_MS',
    'REALTIME_MEDIA_REPAIR_MAX_ATTEMPTS',
    'REALTIME_MEDIA_REPAIR_LOOKBACK_HOURS',
    'REALTIME_MEDIA_REPAIR_BATCH_LIMIT',
    'CONTACT_SYNC_MANUAL_COOLDOWN_MS',
  ]) {
    assert.match(example, new RegExp(`^${variable}=`, 'm'));
  }
  assert.match(example, /JWT_SECRET=CHANGE_ME/);
  assert.match(example, /^APP_MODE=internal$/m);
  assert.match(example, /^INTERNAL_SINGLE_TENANT=true$/m);
  assert.doesNotMatch(example, /^STRIPE_/m);
  assert.doesNotMatch(example, /^TURNSTILE_/m);
  assert.match(backup, /database\.backup\(destination\)/);
  assert.match(backup, /\.wwebjs_auth/);
  assert.match(backup, /manifest\.json/);
  assert.match(backup, /applyRetention/);
  assert.match(backup, /integrity_check/);
  assert.match(backup, /summarizeSnapshotTree/);
  assert.match(example, /WA_MAX_CONCURRENT_SESSIONS=1/);
  assert.match(example, /WA_START_DEFAULT_SESSION=false/);
  assert.match(compose, /WA_START_DEFAULT_SESSION:\s+\$\{WA_START_DEFAULT_SESSION:-false\}/);
  assert.match(example, /^BACKUP_RETENTION=4$/m);
  assert.match(example, /^DEPLOY_STOP_TIMEOUT=120$/m);
  assert.match(compose, /BACKUP_RETENTION:\s+\$\{BACKUP_RETENTION:-4\}/);
  assert.match(compose, /BACKUP_FREE_MARGIN_MB:\s+\$\{BACKUP_FREE_MARGIN_MB:-2048\}/);
  assert.match(compose, /CONTACT_SYNC_MANUAL_COOLDOWN_MS:\s+\$\{CONTACT_SYNC_MANUAL_COOLDOWN_MS:-30000\}/);
  assert.match(backup, /DEFAULT_RETENTION = 4/);
  assert.match(backup, /DEFAULT_FREE_MARGIN_MB = 2048/);
  assert.match(backup, /syncDirectoryTree\(stagingPath\)/);
  assert.match(compose, /SHUTDOWN_DRAIN_TIMEOUT_MS:\s+\$\{SHUTDOWN_DRAIN_TIMEOUT_MS:-15000\}/);
  assert.match(compose, /SHUTDOWN_HTTP_TIMEOUT_MS:\s+\$\{SHUTDOWN_HTTP_TIMEOUT_MS:-15000\}/);
  assert.match(compose, /SHUTDOWN_WHATSAPP_TIMEOUT_MS:\s+\$\{SHUTDOWN_WHATSAPP_TIMEOUT_MS:-25000\}/);
  assert.match(compose, /FFMPEG_PATH:\s+\/usr\/bin\/ffmpeg/);
  assert.match(example, /RECENT_SYNC_INTERVAL_MS=10000/);
  for (const variable of [
    'GET_CHATS_TIMEOUT_MS',
    'HISTORY_CHAT_FETCH_TIMEOUT_MS',
    'HISTORY_IMPORT_LOCK_WAIT_MS',
    'RECENT_SYNC_MAX_FETCH_LIMIT',
    'FULL_SYNC_MAX_FETCH_LIMIT',
    'FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT',
    'FULL_RECONCILE_INTERVAL_MS',
    'OLDER_SYNC_MAX_FETCH_LIMIT',
    'OLDER_SYNC_TIMEOUT_MS',
    'INCOMING_ENRICHMENT_CONCURRENCY',
    'INCOMING_ENRICHMENT_MAX_PENDING',
    'REALTIME_MEDIA_DOWNLOAD_ATTEMPTS',
    'REALTIME_MEDIA_RETRY_BASE_DELAY_MS',
    'REALTIME_MEDIA_REPAIR_MAX_ATTEMPTS',
    'REALTIME_MEDIA_REPAIR_LOOKBACK_HOURS',
    'REALTIME_MEDIA_REPAIR_BATCH_LIMIT',
  ]) {
    assert.match(compose, new RegExp(`${variable}: \\${'${'}${variable}:-`));
  }
  assert.match(backupTest, /doesNotMatch\(manifestText, \/super-secret/);
  assert.match(fs.readFileSync('scripts/prepare-restore.js', 'utf8'), /verifyBackup\(stagingPath\)/);
});

test('nginx proxy accepts base64 uploads and bounds abusive connections', () => {
  const nginx = fs.readFileSync('nginx.conf.example', 'utf8');
  assert.match(nginx, /client_max_body_size\s+50M/);
  assert.match(nginx, /limit_req_zone/);
  assert.match(nginx, /limit_conn_zone/);
  assert.match(nginx, /client_header_timeout/);
  assert.match(nginx, /client_body_timeout/);
  assert.match(nginx, /proxy_connect_timeout/);
});
