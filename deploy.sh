#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Deploy single-node: valida e constroi com a versao atual online, faz uma unica
# parada graciosa planejada, cria um snapshot global quiescente e so entao
# inicia a nova imagem. Qualquer falha apos a parada religa a imagem anterior.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DEPLOY_APP_NAME="whatscarretao"
ENV_FILE="${ENV_FILE:-.env}"

die() {
  echo "ERRO: $*" >&2
  exit 1
}

command -v flock >/dev/null 2>&1 || die "comando obrigatório ausente: flock (pacote util-linux)"
# O arquivo permanece entre execuções de propósito: o lock é mantido pelo inode
# e liberado automaticamente quando este processo termina. Removê-lo no trap
# abriria uma corrida em que dois deploys poderiam bloquear arquivos distintos.
DEPLOY_LOCK_FILE="$ROOT_DIR/.deploy.lock"
exec 9>"$DEPLOY_LOCK_FILE"
flock -n 9 || die "já existe outro deploy em execução para $ROOT_DIR"

[[ "$(id -u)" -ne 0 ]] || die "execute o deploy com um usuário de serviço não-root pertencente ao grupo docker"

for command in docker node npm; do
  command -v "$command" >/dev/null 2>&1 || die "comando obrigatório ausente: $command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 é obrigatório"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js 22 ou superior é obrigatório para as verificações"

if [[ -f "$ENV_FILE" ]]; then
  [[ ! -L "$ENV_FILE" ]] || die "$ENV_FILE não pode ser um link simbólico"
  ENV_MODE="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  ENV_OWNER="$(stat -c '%u' "$ENV_FILE" 2>/dev/null || stat -f '%u' "$ENV_FILE")"
  (( (8#$ENV_MODE & 077) == 0 )) || die "$ENV_FILE deve ter permissão 0600"
  [[ "$ENV_OWNER" == "$(id -u)" ]] || die "$ENV_FILE deve pertencer ao usuário que executa o deploy"
  # Não execute .env como shell. Além de aceitar corretamente valores dotenv
  # com espaços, isso impede command substitution mesmo em arquivo adulterado.
  while IFS= read -r -d '' env_key && IFS= read -r -d '' env_value; do
    [[ "$env_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "chave inválida em $ENV_FILE"
    printf -v "$env_key" '%s' "$env_value"
    export "$env_key"
  done < <(ENV_FILE="$ENV_FILE" node <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const file = process.env.ENV_FILE;
const source = fs.readFileSync(file, 'utf8');
const parsed = parseEnv(source);
const keys = [...new Set(source.split(/\r?\n/).flatMap(line => {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? [match[1]] : [];
}))];
for (const key of keys) {
  process.stdout.write(`${key}\0${parsed[key] ?? ''}\0`);
}
NODE
  )
fi

DEPLOY_WAIT_TIMEOUT="${DEPLOY_WAIT_TIMEOUT:-180}"
SMOKE_RETRIES="${SMOKE_RETRIES:-12}"
SMOKE_RETRY_DELAY="${SMOKE_RETRY_DELAY:-5}"
MIN_FREE_DISK_MB="${MIN_FREE_DISK_MB:-4096}"
BACKUP_FREE_MARGIN_MB="${BACKUP_FREE_MARGIN_MB:-2048}"
BACKUP_RETENTION="${BACKUP_RETENTION:-4}"
DEPLOY_STOP_TIMEOUT="${DEPLOY_STOP_TIMEOUT:-120}"
MEMORY_LIMIT="${MEMORY_LIMIT:-4g}"
CPU_LIMIT="${CPU_LIMIT:-2.0}"
WA_MAX_CONCURRENT_SESSIONS="${WA_MAX_CONCURRENT_SESSIONS:-1}"
export BACKUP_RETENTION DEPLOY_STOP_TIMEOUT MEMORY_LIMIT CPU_LIMIT WA_MAX_CONCURRENT_SESSIONS

export APP_UID="${APP_UID:-$(id -u)}"
export APP_GID="${APP_GID:-$(id -g)}"
[[ "$APP_UID" == "$(id -u)" ]] || die "APP_UID deve ser o UID do usuário de serviço para os bind mounts"
[[ "$APP_GID" == "$(id -g)" ]] || die "APP_GID deve ser o GID do usuário de serviço para os bind mounts"

export APP_MODE=internal
export INTERNAL_SINGLE_TENANT=true
export BILLING_REQUIRED=false

node scripts/validate-production-env.js
node scripts/validate-host-capacity.js

AVAILABLE_DISK_KB="$(df -Pk "$ROOT_DIR" | awk 'NR == 2 { print $4 }')"
[[ "$AVAILABLE_DISK_KB" =~ ^[0-9]+$ ]] || die "não foi possível medir o espaço livre em disco"
[[ "$MIN_FREE_DISK_MB" =~ ^[1-9][0-9]*$ ]] || die "MIN_FREE_DISK_MB deve ser um inteiro positivo"
[[ "$BACKUP_FREE_MARGIN_MB" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_FREE_MARGIN_MB deve ser um inteiro positivo"
(( BACKUP_FREE_MARGIN_MB >= 512 )) || die "BACKUP_FREE_MARGIN_MB deve reservar ao menos 512 MiB"
[[ "$DEPLOY_STOP_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die "DEPLOY_STOP_TIMEOUT deve ser um inteiro positivo"
(( AVAILABLE_DISK_KB >= MIN_FREE_DISK_MB * 1024 )) \
  || die "espaço livre insuficiente; são necessários ao menos ${MIN_FREE_DISK_MB} MiB"

export NODE_ENV=production
export WA_BROWSER_MODE=isolated
# Preferimos manter o sandbox do Chromium ligado; alguns hosts restringem
# namespaces de usuário e o operador precisa desligá-lo via .env (ver runbook).
export WA_NO_SANDBOX="${WA_NO_SANDBOX:-false}"
export APP_IMAGE="${APP_IMAGE:-whatscarretao:local}"
export DOMAIN JWT_SECRET CORS_ORIGIN APP_URL ADMIN_USERNAME ADMIN_PASSWORD
export APP_UID APP_GID

echo "==> Preparando diretórios persistentes..."
mkdir -p data media backups .wwebjs_auth .wwebjs_cache
chmod 0700 data media backups .wwebjs_auth .wwebjs_cache
for directory in data media backups .wwebjs_auth .wwebjs_cache; do
  [[ -w "$directory" ]] || die "diretório persistente sem permissão de escrita: $directory"
done

echo "==> Instalando dependências de verificação..."
npm ci --include=dev

echo "==> Executando verificações locais..."
# `npm audit` sai com codigo 1 tanto para vulnerabilidade encontrada quanto
# para falha de rede no endpoint da npm. Sob `set -e` os dois derrubavam o
# deploy — e um outage do registry (04/set/2026) bloqueou producao sem que
# nada estivesse errado com as dependencias. A trava segue fechada para
# vulnerabilidade; so a falha de infraestrutura ganha novas tentativas.
audit_com_retentativa() {
  local tentativa saida
  for tentativa in 1 2 3 4; do
    if saida="$(npm audit --omit=dev --audit-level=high 2>&1)"; then
      printf '%s\n' "$saida"
      return 0
    fi
    if printf '%s' "$saida" | grep -qiE 'audit endpoint returned an error|Service Unavailable|network timeout|ENOTFOUND|ECONNRESET|EAI_AGAIN'; then
      echo "==> Endpoint de auditoria da npm indisponivel (tentativa $tentativa/4); repetindo em $((tentativa * 15))s..."
      sleep "$((tentativa * 15))"
      continue
    fi
    printf '%s\n' "$saida"
    die "auditoria de dependencias reprovou: vulnerabilidade de severidade alta"
  done
  die "nao foi possivel consultar o endpoint de auditoria da npm apos 4 tentativas; deploy abortado por precaucao"
}
audit_com_retentativa
npm run check

echo "==> Validando configuração do Compose..."
docker compose config --quiet

smoke_test() {
  local url="$1"
  local label="$2"
  local attempt
  for ((attempt = 1; attempt <= SMOKE_RETRIES; attempt += 1)); do
    if SMOKE_URL="$url" node <<'NODE'
(async () => {
  const response = await fetch(process.env.SMOKE_URL, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) process.exit(1);
  const payload = await response.json();
  if (payload.ok !== true) process.exit(1);
})().catch(() => process.exit(1));
NODE
    then
      echo "==> Smoke test aprovado: $label"
      return 0
    fi
    sleep "$SMOKE_RETRY_DELAY"
  done
  return 1
}

CURRENT_CONTAINER_ID="$(docker compose ps -q "$DEPLOY_APP_NAME" 2>/dev/null || true)"
PREVIOUS_IMAGE_ID=""
ROLLBACK_IMAGE="whatscarretao:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
CANDIDATE_IMAGE="whatscarretao:candidate-$(date -u +%Y%m%dT%H%M%SZ)"
PREVIOUS_STABLE_IMAGE="${DEPLOY_APP_NAME}:previous"
CURRENT_WAS_RUNNING=false
POST_STOP_UNVALIDATED=false
ROLLBACK_IN_PROGRESS=false
if [[ -n "$CURRENT_CONTAINER_ID" ]]; then
  PREVIOUS_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CURRENT_CONTAINER_ID")"
  docker image tag "$PREVIOUS_IMAGE_ID" "$ROLLBACK_IMAGE"
  echo "==> Imagem atual preservada para rollback."
  if [[ "$(docker inspect --format '{{.State.Running}}' "$CURRENT_CONTAINER_ID")" == "true" ]]; then
    CURRENT_WAS_RUNNING=true
    smoke_test "${LOCAL_SMOKE_URL:-http://127.0.0.1:3100/health/ready}" "versao atual antes do deploy" \
      || die "a versao atual nao esta pronta; deploy abortado sem interrompe-la"
  fi
fi

rollback() {
  local reason="$1"
  ROLLBACK_IN_PROGRESS=true
  echo "ERRO: $reason" >&2
  if [[ -n "$PREVIOUS_IMAGE_ID" ]]; then
    echo "==> Restaurando imagem anterior..." >&2
    if ! docker image tag "$ROLLBACK_IMAGE" "$APP_IMAGE"; then
      echo "ERRO: não foi possível recuperar a tag da imagem anterior; candidato será parado" >&2
      docker compose stop "$DEPLOY_APP_NAME" >/dev/null 2>&1 || true
    elif ! docker compose up -d --force-recreate --wait --wait-timeout "$DEPLOY_WAIT_TIMEOUT" --remove-orphans "$DEPLOY_APP_NAME"; then
      echo "ERRO: rollback automático da imagem também falhou; intervenção manual necessária" >&2
    fi
  else
    echo "ERRO: não há imagem anterior disponível para rollback automático" >&2
    docker compose stop "$DEPLOY_APP_NAME" >/dev/null 2>&1 || true
  fi
  docker compose ps >&2 || true
  exit 1
}

# set -e sozinho derrubava o script sem religar a versão saudável se um erro
# não antecipado ocorresse depois do stop (inclusive sinal/terminal fechado).
# O trap cobre essa classe de falha; os caminhos esperados continuam usando a
# função rollback para registrar a causa específica.
emergency_recover_on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$POST_STOP_UNVALIDATED" == "true" && "$ROLLBACK_IN_PROGRESS" != "true" ]]; then
    echo "ERRO: deploy interrompido após a parada; religando a imagem anterior..." >&2
    set +e
    if [[ -n "$PREVIOUS_IMAGE_ID" ]]; then
      if docker image tag "$ROLLBACK_IMAGE" "$APP_IMAGE"; then
        docker compose up -d --force-recreate --wait --wait-timeout "$DEPLOY_WAIT_TIMEOUT" --remove-orphans "$DEPLOY_APP_NAME"
      else
        echo "ERRO: imagem anterior indisponível para recuperação de emergência" >&2
        docker compose stop "$DEPLOY_APP_NAME" >/dev/null 2>&1
      fi
    else
      docker compose stop "$DEPLOY_APP_NAME" >/dev/null 2>&1
    fi
  fi
  exit "$status"
}
trap emergency_recover_on_exit EXIT

echo "==> Construindo a nova imagem enquanto a versão atual permanece ativa..."
docker compose build --pull "$DEPLOY_APP_NAME"
CANDIDATE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$APP_IMAGE")"
docker image tag "$CANDIDATE_IMAGE_ID" "$CANDIDATE_IMAGE"
echo "==> Validando a imagem candidata sem rede e sem montar dados reais..."
docker run --rm --network none --read-only --tmpfs /tmp:size=64m \
  --entrypoint node "$CANDIDATE_IMAGE" --check server.js
docker run --rm --network none --read-only --tmpfs /tmp:size=64m \
  --entrypoint node "$CANDIDATE_IMAGE" -e \
  "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.pragma('integrity_check'); db.close();"
docker run --rm --network none --read-only --tmpfs /tmp:size=64m \
  --entrypoint node "$CANDIDATE_IMAGE" -e \
  "const { spawnSync } = require('node:child_process'); const result = spawnSync('/usr/bin/ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }); if (result.status !== 0 || !/libopus/.test(result.stdout)) process.exit(1);"
# O teste de sintaxe acima não prova que o principal processo externo do
# produto consegue nascer sob as restrições reais do Compose. Chromium pode
# funcionar no build e falhar apenas quando sandbox, seccomp, usuário não-root,
# rootfs somente-leitura e capabilities se encontram. Valide isso antes de
# parar a versão saudável e sem abrir rede nem montar autenticação/dados reais.
docker run --rm --network none --read-only --tmpfs /tmp:size=256m \
  --shm-size 256m \
  --user "$APP_UID:$APP_GID" \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=./seccomp/chromium.json \
  -e HOME=/tmp \
  -e XDG_CONFIG_HOME=/tmp/chrome-config \
  -e XDG_CACHE_HOME=/tmp/chrome-cache \
  --entrypoint /usr/bin/chromium "$CANDIDATE_IMAGE" \
  --headless --disable-gpu --no-first-run --dump-dom about:blank >/dev/null

if [[ "$CURRENT_WAS_RUNNING" == "true" ]]; then
  echo "==> Parando a versão atual graciosamente para o snapshot global..."
  POST_STOP_UNVALIDATED=true
  if ! docker compose stop --timeout "$DEPLOY_STOP_TIMEOUT" "$DEPLOY_APP_NAME"; then
    rollback "falha ao solicitar a parada graciosa do container atual"
  fi
  [[ "$(docker inspect --format '{{.State.Running}}' "$CURRENT_CONTAINER_ID")" == "false" ]] \
    || rollback "o container atual nao concluiu a parada graciosa"
fi

echo "==> Criando backup global com dados, midias e autenticacao quiescentes..."
if ! BACKUP_RESULT="$(
  BACKUP_SOURCE_ROOT="$ROOT_DIR" \
  BACKUP_DIR="$ROOT_DIR/backups" \
  BACKUP_QUIESCED=true \
  BACKUP_REQUIRE_QUIESCED=true \
  BACKUP_REQUIRE_NO_LIVE_LEASE=true \
  BACKUP_REQUIRE_GLOBAL_CONSISTENCY=true \
  BACKUP_FREE_MARGIN_MB="$BACKUP_FREE_MARGIN_MB" \
  npm run --silent backup 2>&1
)"; then
  echo "$BACKUP_RESULT" >&2
  rollback "backup global quiescente falhou; a imagem anterior sera religada"
fi
echo "$BACKUP_RESULT"
BACKUP_NAME="$(printf '%s\n' "$BACKUP_RESULT" | sed -n 's/^Backup criado: \([^ ]*\).*/\1/p')"
if [[ ! "$BACKUP_NAME" =~ ^backup-[0-9]{8}T[0-9]+Z-[a-f0-9]+$ ]]; then
  rollback "nao foi possivel identificar o backup recem-criado"
fi
if ! npm run --silent backup:verify -- "$ROOT_DIR/backups/$BACKUP_NAME"; then
  rollback "verificacao independente do backup falhou"
fi

echo "==> Aplicando a nova imagem e aguardando /health/ready..."
if ! docker compose up -d --force-recreate --wait --wait-timeout "$DEPLOY_WAIT_TIMEOUT" --remove-orphans "$DEPLOY_APP_NAME"; then
  rollback "a nova versão não ficou pronta dentro do prazo"
fi

smoke_test "${LOCAL_SMOKE_URL:-http://127.0.0.1:3100/health/ready}" "readiness local" \
  || rollback "smoke test local falhou"
smoke_test "${PUBLIC_SMOKE_URL:-${APP_URL%/}/health/ready}" "readiness pública" \
  || rollback "smoke test público falhou"

echo "==> Auditando integridade e isolamento dos dados após as migrações..."
docker compose exec -T "$DEPLOY_APP_NAME" npm run --silent integrity:audit \
  || rollback "auditoria de integridade dos dados falhou"
POST_STOP_UNVALIDATED=false

if [[ -n "$PREVIOUS_IMAGE_ID" ]]; then
  docker image tag "$PREVIOUS_IMAGE_ID" "$PREVIOUS_STABLE_IMAGE"
  docker image rm "$ROLLBACK_IMAGE" >/dev/null 2>&1 || true
fi
docker image rm "$CANDIDATE_IMAGE" >/dev/null 2>&1 || true
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true

echo "==> Deploy concluído: ${APP_URL%/}"
