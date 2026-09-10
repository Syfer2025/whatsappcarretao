#!/usr/bin/env bash
#
# Backup agendado do WhatsCarretão: executa o snapshot e VERIFICA o resultado.
#
# Por que existe: a auditoria de 09/09/2026 encontrou quatro backups, todos do
# dia 04/09, e nenhum agendamento em cron/systemd. O runbook trazia uma linha de
# cron herdada do produto original, apontando para o serviço `whatsa-ai` e para
# /opt/whatsa-ai-comercial — nomes que não existem neste fork. Quem copiasse
# aquela linha instalaria um agendamento que falha em silêncio.
#
# Um backup que não foi verificado não conta como backup: por isso o script
# encadeia `npm run backup` com `npm run backup:verify` no snapshot recém-criado
# e só sai com 0 se os dois passarem. O systemd/cron enxerga a falha pelo código
# de saída.
#
# Uso:
#   scripts/scheduled-backup.sh
#
# Variáveis (todas opcionais):
#   PROJECT_DIR     diretório do docker-compose  (padrão: raiz deste repositório)
#   COMPOSE_SERVICE nome do serviço no compose   (padrão: whatscarretao)

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-whatscarretao}"

log() { printf '%s %s\n' "$(date --iso-8601=seconds)" "$*"; }
fail() { log "ERRO: $*"; exit 1; }

cd "$PROJECT_DIR" || fail "diretório do projeto não encontrado: $PROJECT_DIR"

command -v docker >/dev/null 2>&1 || fail "docker não encontrado no PATH"

# `docker compose ps -q` devolve vazio quando o serviço está parado. Sem esta
# checagem o `exec` falharia com uma mensagem obscura no log do systemd.
if [ -z "$(docker compose ps -q "$COMPOSE_SERVICE" 2>/dev/null)" ]; then
  fail "serviço '$COMPOSE_SERVICE' não está em execução; backup não foi feito"
fi

log "iniciando backup do serviço '$COMPOSE_SERVICE'"
docker compose exec -T "$COMPOSE_SERVICE" npm run backup \
  || fail "npm run backup falhou"

# O snapshot mais novo é o que acabou de ser criado. A listagem é feita DENTRO do
# container para não depender de como os volumes estão montados no host.
NEWEST="$(docker compose exec -T "$COMPOSE_SERVICE" \
  node -e 'const fs=require("fs");const d=process.env.BACKUP_DIR||"/app/backups";const n=fs.readdirSync(d).filter(x=>x.startsWith("backup-")).sort().pop();if(!n){process.exit(3)}process.stdout.write(n)' \
  2>/dev/null | tr -d '\r')"

[ -n "$NEWEST" ] || fail "backup terminou mas nenhum snapshot foi encontrado para verificar"

log "verificando snapshot $NEWEST"
docker compose exec -T "$COMPOSE_SERVICE" npm run backup:verify -- "backups/${NEWEST}" \
  || fail "o snapshot $NEWEST NÃO passou na verificação"

log "backup verificado com sucesso: $NEWEST"

# ---------------------------------------------------------------------------
# FALTA A CÓPIA OFFSITE.
#
# Tudo acima continua dentro da mesma VPS: perder o servidor é perder também os
# backups. O snapshot inclui `.wwebjs_auth/`, ou seja, as credenciais da sessão
# do WhatsApp — precisa ir criptografado e para um destino com imutabilidade
# (object lock), sem permissão de apagar para a credencial do servidor.
#
# Quando o destino existir, o envio entra aqui. Exemplo com restic:
#   restic backup "backups/${NEWEST}" && restic check
# ---------------------------------------------------------------------------
