# Security Operations Runbook

Data: 2026-07-13.

Este runbook cobre os controles de produção que complementam a aplicação: configuração obrigatória, deploy, readiness, backup e restore, WAF, SIEM, EDR, DNS/e-mail, segredos e supply chain.

## Checklist antes de produção

- Copiar `.env.example` para `.env`, substituir todos os placeholders e manter `.env` somente no secret manager/VPS, com permissão `0600`.
- Definir obrigatoriamente `DOMAIN`, `APP_URL`, `CORS_ORIGIN`, `JWT_SECRET` com pelo menos 32 caracteres aleatórios, `ADMIN_USERNAME`, `ADMIN_PASSWORD` com pelo menos 12 caracteres, `STRIPE_SECRET_KEY` live, `STRIPE_WEBHOOK_SECRET`, `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`. Restrinja o widget Turnstile exatamente ao `DOMAIN`; chaves de teste são recusadas em produção.
- Para os preços Stripe, configurar `STRIPE_PRICE_ID` como fallback único **ou** configurar simultaneamente `STRIPE_PRICE_ID_BASIC` e `STRIPE_PRICE_ID_PRO`. Os dois preços por plano são recomendados para diferenciar as ofertas de 5 e 10 usuários. Todo ID preenchido deve começar com `price_`.
- No webhook live, habilitar todos os eventos que a aplicação reconcilia: `checkout.session.completed`; `customer.subscription.created`, `updated`, `deleted`, `paused` e `resumed`; `invoice.paid` e `invoice.payment_failed`. O endpoint deve ser exatamente `https://DOMAIN/api/webhooks/stripe`.
- Confirmar os invariantes: trial de exatamente 3 dias, `BILLING_REQUIRED=true`, `WA_BROWSER_MODE=isolated`, `WA_NO_SANDBOX=false` e cookies seguros.
- Cadastro público: o backend valida cada token Turnstile como uso único, com ação `signup` e hostname exato. O primeiro Checkout reserva capacidade por 30 minutos (`STRIPE_CHECKOUT_RESERVATION_MINUTES`); expirado o prazo, a aplicação consulta/expira a sessão na Stripe antes de remover a conta abandonada. Erro ou disputa com Checkout concluído preserva a conta e a vaga (fail closed). Nunca aumente o prazo acima de 24 horas.
- WAF/CDN: publicar atrás de Cloudflare, AWS WAF ou equivalente, com regras OWASP, bot management, proteção DDoS e rate limit por IP/ASN/país quando necessário.
- Origin: manter o Compose preso em `127.0.0.1`; somente o proxy reverso deve alcançar a aplicação.
- TLS: terminar HTTPS no proxy, redirecionar HTTP para HTTPS, ativar HSTS e desabilitar TLS antigo.
- Chromium: manter o seccomp padrão do Docker e user namespaces habilitados no host. Não usar `seccomp=unconfined` nem `WA_NO_SANDBOX=true` como solução permanente.
- Malware scanning: instalar ClamAV ou serviço equivalente em imagem/sidecar compatível, manter `freshclam` ativo e definir `CLAMSCAN_PATH` apenas quando o binário existir dentro do container.
- SIEM: enviar stdout/stderr do container e logs do proxy para SIEM com retenção imutável.
- EDR: manter EDR no VPS/host, com alertas de processo suspeito, mineração, shell reverso e escrita incomum em `data/`, `media/`, `backups/` e `.wwebjs_auth/`.
- Segredos: guardar JWT, Stripe, SMTP e credenciais administrativas em secret manager; rotacionar após incidente ou troca de operador.
- Supply chain: CI deve executar `npm audit --audit-level=high`, gerar SBOM a cada release e revisar dependências novas.
- Host: usar um usuário de serviço não-root, manter `.env` como arquivo regular `0600` pertencente a esse usuário e definir `APP_UID`/`APP_GID` com seus IDs numéricos. O arquivo é carregado pelo shell do deploy: deve conter somente atribuições confiáveis, nunca comandos.
- Disco: manter ao menos 4 GiB livres antes do deploy e alertar em 75%, 85% e 95% de utilização. O gate inicial é configurável por `MIN_FREE_DISK_MB`; antes do snapshot, o backup também exige espaço para todos os bancos, mídias e sessões mais `BACKUP_FREE_MARGIN_MB` (2 GiB por padrão).

## Escopo e limites da topologia

Este pacote operacional torna a instalação **single-node** mais segura e recuperável; ele não transforma SQLite, arquivos locais e sessões locais do Chromium em alta disponibilidade. Não execute duas réplicas apontando para os mesmos diretórios `data/` e `.wwebjs_auth/`: SQLite, o perfil do WhatsApp Web e o processamento em memória exigem um único dono. Em produção, o processo adquire no `master.db` um lease single-writer com relógio SQLite, heartbeat de 20 segundos e TTL de 90 segundos. Uma segunda instância falha no boot com erro explícito; um desligamento gracioso libera o lease imediatamente e, após `SIGKILL`, o takeover só é permitido depois da expiração. Essa é uma barreira contra split-brain, não uma implementação de escala horizontal. Não reduza o TTL abaixo de 60 segundos; mantenha `SINGLE_WRITER_LEASE_HEARTBEAT_MS` menor que metade de `SINGLE_WRITER_LEASE_TTL_MS`.

Para alta disponibilidade/horizontalização real são necessários, no mínimo, banco transacional externo (por exemplo PostgreSQL), object storage para mídia, fila durável, adapter distribuído do Socket.IO, locks/leases de sessão e uma estratégia de WhatsApp com propriedade exclusiva por número. A API oficial WhatsApp Cloud elimina parte do risco operacional do navegador. `whatsapp-web.js` automatiza o WhatsApp Web, não oferece SLA oficial e pode sofrer mudanças, desconexões ou bloqueios fora do controle da aplicação; nenhum runbook pode prometer disponibilidade absoluta desse componente.

Com `MEMORY_LIMIT=6g`, comece com `WA_MAX_CONCURRENT_SESSIONS=5`. Esse valor é uma quota rígida de navegadores ativos; sessões adicionais entram em fila FIFO observável até surgir capacidade. Monitore RSS, PIDs, tamanho/idade da fila e reinícios. Eleve somente após teste de carga com todos os números conectados, importação de histórico e envio de mídia. A reconexão de falhas transitórias é contínua, com jitter e teto de 60 segundos. `WA_RECONNECT_MAX_ATTEMPTS` mantém o nome legado, mas hoje limita apenas quantos degraus exponenciais o backoff usa; estados terminais como banimento ou autenticação inválida exigem intervenção manual.

## Sincronização e reconciliação do WhatsApp

A entrada em tempo real continua sendo o caminho de menor latência. A mensagem é persistida antes dos trabalhos mais lentos de perfil, mídia, citação e participante; esses enriquecimentos passam por uma fila limitada e separada por tenant. Em paralelo, a reconciliação automática corrige eventos perdidos durante queda de rede, reinício ou indisponibilidade temporária do WhatsApp Web. Edições, revogações e estados de entrega também são reconciliados quando o evento em tempo real não chega.

O comportamento padrão tem quatro camadas:

1. eventos em tempo real gravam mensagens novas imediatamente;
2. a cada 10 segundos, a reconciliação recente examina até 35 conversas, começando com 50 mensagens por conversa e ampliando a janela, quando necessário, até 500;
3. a cada 15 minutos, a reconciliação completa percorre o histórico com busca adaptativa de até 2.000 mensagens por conversa;
4. ao abrir ou pedir mensagens antigas de uma conversa, uma sincronização direcionada atualiza esse chat e pode buscar até 20.000 mensagens, sem misturar dados entre tenants.

As janelas são limites por execução, não promessa de que o histórico inteiro cabe em uma única rodada. Quando uma lacuna ultrapassa o teto, o cursor fica persistido e a rodada seguinte continua a partir dele. A mídia não bloqueia a reconciliação recente: texto e metadados entram primeiro e anexos são enriquecidos depois. Isso reduz latência, mas a miniatura ou arquivo pode aparecer alguns instantes após a mensagem.

Variáveis operacionais principais:

| Variável                             |   Padrão | Finalidade                                                          |
| ------------------------------------ | -------: | ------------------------------------------------------------------- |
| `RECENT_SYNC_INTERVAL_MS`            |  `10000` | Intervalo da reconciliação recente.                                 |
| `RECENT_SYNC_CHAT_LIMIT`             |     `35` | Máximo de chats recentes examinados por rodada.                     |
| `RECENT_SYNC_MESSAGE_LIMIT`          |     `50` | Janela inicial por chat.                                            |
| `RECENT_SYNC_MAX_FETCH_LIMIT`        |    `500` | Teto adaptativo da rodada recente.                                  |
| `FULL_RECONCILE_INTERVAL_MS`         | `900000` | Intervalo da reconciliação completa.                                |
| `FULL_SYNC_MAX_FETCH_LIMIT`          |   `2000` | Teto adaptativo da rodada completa.                                 |
| `FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT` |  `20000` | Teto duro para a progressão de lacunas entre rodadas completas.     |
| `GET_CHATS_TIMEOUT_MS`               |  `15000` | Prazo para listar chats antes de abortar a rodada.                  |
| `HISTORY_CHAT_FETCH_TIMEOUT_MS`      |  `60000` | Prazo por chat durante importações e backfill automáticos extensos. |
| `HISTORY_IMPORT_LOCK_WAIT_MS`        |  `30000` | Prazo para o import completo aguardar a rodada recente.             |
| `CONVERSATION_SYNC_TIMEOUT_MS`       |  `15000` | Prazo das operações direcionadas de um chat.                        |
| `CONVERSATION_SYNC_COOLDOWN_MS`      |   `5000` | Janela de deduplicação ao abrir repetidamente o mesmo chat.         |
| `OLDER_SYNC_MAX_FETCH_LIMIT`         |  `20000` | Teto para a busca manual de mensagens antigas.                      |
| `OLDER_SYNC_TIMEOUT_MS`              |  `60000` | Prazo da busca manual de mensagens antigas quando a janela cresce.  |
| `INCOMING_ENRICHMENT_CONCURRENCY`    |      `2` | Trabalhos lentos simultâneos por tenant.                            |
| `INCOMING_ENRICHMENT_MAX_PENDING`    |    `500` | Limite da fila de enriquecimento por tenant.                        |

Todos esses valores são inteiros positivos e o deploy os valida. Os tetos adaptativos não podem ser menores que suas janelas iniciais, e o limite da fila não pode ser menor que sua concorrência. Reduzir intervalos aumenta chamadas ao WhatsApp Web, CPU e contenção no SQLite; elevar concorrência aumenta RAM, downloads e risco de sobrecarregar o Chromium. Faça apenas uma mudança por vez, meça por pelo menos um ciclo completo e reverta se houver crescimento sustentado da fila ou de timeouts.

Na aba **Conexão** do administrador, acompanhe a última reconciliação, a última importação completa, mensagens verificadas/atualizadas, duração, falhas e fila de enriquecimento. O erro exibido pertence somente ao tenant autenticado. Alertas mínimos recomendados:

- conectado sem reconciliação recente concluída por mais de 60 segundos;
- qualquer item recusado na fila ou fila pendente crescendo por três coletas consecutivas;
- `failedChats` ou limite de lacuna atingido em rodadas consecutivas;
- timeout de `getChats`, erro de reconciliação completa ou carregamento sem progresso por mais de 120 segundos;
- divergência entre a contagem esperada no celular e no sistema após duas rodadas completas.

Para recuperação, confirme primeiro que a sessão está conectada e que há espaço em disco/RAM; depois use **Reimportar histórico** uma vez e acompanhe a aba Conexão. Não clique repetidamente: a aplicação deduplica parte das solicitações, mas uma importação completa ainda é custosa. Se duas rodadas completas não fecharem a lacuna, preserve logs, registre tenant/conversa/horário e trate como incidente. Evite apagar `.wwebjs_auth/`; isso força novo QR e não recupera mensagens por si só.

Mesmo com reconciliação, `whatsapp-web.js` não fornece consistência instantânea nem SLA. A disponibilidade depende do celular/conta, rede, Chromium e mudanças no WhatsApp Web. Para volume alto ou requisito contratual de entrega, planeje migração para a API oficial WhatsApp Cloud e uma arquitetura distribuída com fila e banco externos.

## Deploy seguro

Pré-requisitos no host: Docker com Compose v2, Node.js 22, npm e domínio já apontado para o proxy HTTPS. Execute como o usuário de serviço dono dos diretórios persistentes, não como `root`.

```sh
cp .env.example .env
chmod 600 .env
# editar .env e remover todos os CHANGE_ME
# ajustar APP_UID/APP_GID: id -u; id -g
./deploy.sh
```

O `deploy.sh`:

1. valida permissões/owner do `.env`, UID/GID não-root, espaço livre, domínio, origens HTTPS, força de senha/JWT, chave Stripe live, fallback ou par de preços e invariantes sem imprimir segredos;
2. executa `npm ci`, lint e testes;
3. valida o Compose e preserva a imagem atual com uma tag de rollback;
4. constrói e testa a imagem candidata sem rede e sem montar dados reais, enquanto o container atual continua atendendo;
5. faz uma única parada graciosa e confirma que o processo anterior realmente terminou;
6. cria e verifica um snapshot global quiescente de bancos, mídias e autenticação WhatsApp, recusando lease de writer vivo ou divergência entre tenants;
7. usa `docker compose up -d --force-recreate --wait`, sem `down`, e aguarda `/health/ready`;
8. executa auditoria pós-migração e smoke tests local e público;
9. restaura a imagem anterior automaticamente se qualquer etapa após a parada falhar e mantém a última imagem estável na tag `whatsa-ai:previous`.

O rollback automático é **somente da imagem**. Ele deliberadamente não sobrescreve bancos ou arquivos durante um incidente. Migrações de schema de uma release devem ser retrocompatíveis com a imagem anterior; quando não forem, o plano da release precisa trazer migração reversa testada ou restore manual do snapshot pré-deploy.

Rollback manual da última imagem, após criar/validar um novo snapshot de segurança:

```sh
docker image tag whatsa-ai:previous "${APP_IMAGE:-whatsa-ai:local}"
docker compose up -d --force-recreate --wait --wait-timeout 180 whatsa-ai
curl --fail --silent https://SEU_DOMINIO/health/ready
```

Compose não oferece troca totalmente sem downtime para um único container SQLite/WhatsApp. O procedimento minimiza a janela: a imagem é construída antes da substituição e o desligamento recebe 120 segundos para drenar HTTP, filas, bancos e sessões.

Endpoints operacionais:

- `/health/live`: processo vivo; adequado para detectar crash.
- `/health/ready`: banco, armazenamento, cobrança e gerenciador WhatsApp prontos; usado por Docker e pelo deploy.

Limites padrão do container são 6 GiB de memória, 3 CPUs, 1024 PIDs, 65.536 descritores e 1 GiB de `/dev/shm`. O filesystem raiz é somente leitura, todas as capabilities são removidas e o processo usa o UID/GID não-root do operador. Ajuste `MEMORY_LIMIT`, `CPU_LIMIT` e `PIDS_LIMIT` com medição real; não remova os limites. Logs `json-file` giram em 10 MiB, mantendo cinco arquivos por padrão.

O proxy HTTPS deve suportar upgrade WebSocket e timeouts longos para o Socket.IO, manter o origin inacessível externamente (`HOST_BIND=127.0.0.1`) e limitar o corpo de requisição de forma compatível com `MAX_OUTBOUND_MEDIA_BYTES`. No firewall do host, exponha apenas SSH restrito e 80/443; a porta 3000 não deve estar aberta à Internet.

## Backup consistente

O comando oficial é:

```sh
npm run backup
# ou, com o container ativo:
docker compose exec -T whatsa-ai npm run backup
```

Cada execução cria `backups/backup-<timestamp>-<id>/` contendo:

- todos os arquivos `.db` da raiz legada e de `data/`, copiados pela API online `.backup()` do `better-sqlite3`; isso produz snapshots SQLite consistentes mesmo com WAL ativo;
- snapshot arquivo a arquivo de `media/` e `.wwebjs_auth/`;
- `manifest.json` v2 com data, checksums SHA-256 dos bancos e das árvores de assets, contagens/tamanhos, resultado do `integrity_check` e política de retenção.

O backup não copia `.env`, cache do Chromium nem sidecars `-wal`/`-shm`, e o manifesto não contém valores de segredo. Porém `.wwebjs_auth/` contém credenciais de sessão WhatsApp e torna o snapshot inteiro altamente sensível: criptografe antes de enviar para fora do host, restrinja acesso e use object lock/imutabilidade.

Os bancos usam a API online de backup do SQLite e são transacionalmente consistentes. `media/` tende a ser imutável, mas `media/` e `.wwebjs_auth/` são snapshots arquivo a arquivo, não transações de filesystem. Para uma cópia estritamente quiescente das credenciais WhatsApp, pare o serviço durante essa cópia; em um restore de snapshot online, esteja preparado para reler o QR se o perfil do navegador não for recuperável.

Links/sockets efêmeros do Chromium dentro de `.wwebjs_auth/` (por exemplo locks de processo) são registrados no manifesto e não são restaurados. Links simbólicos ou arquivos especiais em `media/` fazem o backup falhar, pois não são esperados nesse diretório.

`BACKUP_RETENTION` controla quantos snapshots locais completos são mantidos; o padrão é 4 e a validação aceita de 2 a 7, pois cada snapshot inclui mídia e autenticação. Antes de copiar, a rotina remove apenas excedentes antigos e sempre preserva ao menos o último snapshot bom. O destino deve ficar, preferencialmente, em volume dedicado com capacidade monitorada. Essa retenção local não substitui cópia offsite, criptografada e imutável. O lock `.backup.lock` impede duas execuções simultâneas e só é considerado abandonado após 24 horas (`BACKUP_LOCK_STALE_MS`), evitando concorrência e bloqueio permanente após crash.

No deploy, a imagem nova é construída e testada enquanto a versão atual permanece online. Em seguida ocorre uma única parada graciosa planejada; o backup estrito recusa qualquer lease de runtime vivo, valida as relações entre `master.db`, `data_N.db`, diretório global, suporte e mídias e só então permite iniciar a imagem nova. Falha no backup religa a imagem anterior; falha de readiness, smoke test ou auditoria da imagem nova aciona rollback.

Verifique qualquer snapshot antes de copiar, restaurar ou contar como RPO válido:

```sh
npm run backup:verify -- backups/backup-AAAAMMDDTHHMMSSmmmZ-ID
```

Essa verificação detecta corrupção acidental e divergência do manifesto; não é assinatura contra um invasor capaz de alterar ao mesmo tempo snapshot e manifesto. Para autenticidade, use repositório offsite criptografado/assinado e imutável.

Agendamento mínimo sugerido, a cada quatro horas:

```cron
17 */4 * * * cd /opt/whatsa-ai-comercial && docker compose exec -T whatsa-ai npm run backup >> /var/log/whatsa-backup.log 2>&1
```

Política mínima:

- RPO: 4 horas para bancos SQLite e anexos.
- RTO: 4 horas para restaurar um tenant prioritário.
- Retenção offsite: horários por 48 horas, diários por 30 dias e mensais por 12 meses.
- Cópia offsite e imutável: restic/borg ou object storage com criptografia e object lock, sem permissão de deleção para a credencial do servidor.
- Teste de restore: mensal em ambiente isolado, registrando duração e resultado.

Exemplo de envio do snapshot já criado para restic:

```sh
restic backup ./backups
restic snapshots
restic check
```

## Restore

Nunca restaure diretamente sobre produção antes de validar o snapshot em um ambiente isolado.

1. Selecionar um diretório `backup-*` e executar `npm run backup:verify -- <diretório>`; qualquer falha torna o snapshot inelegível.
2. Preparar uma cópia declarativa em staging com o comando abaixo. Ele copia somente os bancos declarados no manifesto (inclusive `.db` legados da raiz), `media/` e `.wwebjs_auth/`, executa `fsync`, recusa sobrescrita e repete hashes, `integrity_check`, `foreign_key_check` e consistência global no destino:

   ```sh
   npm run restore:prepare -- \
     backups/backup-AAAAMMDDTHHMMSSmmmZ-ID \
     /srv/whatsa-restore-ready
   ```

   Nunca use `cp -R snapshot/* destino/`: ele omite dotfiles como `.wwebjs_auth`, pode aninhar diretórios por engano e não comprova a transferência.

3. Subir a imagem em rede isolada com segredos exclusivos de staging e validar `/health/ready`, login, tenants, conversas, mídia e conexão WhatsApp.
4. Para o restore real, criar um backup final, colocar o origin em manutenção e executar `docker compose stop whatsa-ai`.
5. Mover `data/`, `media/` e `.wwebjs_auth/` atuais para uma pasta de quarentena; nunca apagá-los antes da validação final.
6. A partir do payload já preparado, copiar `data/`, `media/`, `.wwebjs_auth/` e cada banco `.db` legado listado no manifesto na raiz. Corrigir proprietário/permissões e não restaurar `.env` — os segredos vêm do secret manager. Se ainda existirem bancos legados na raiz, não os descarte até confirmar pela aplicação/migração que deixaram de ser fonte de dados.
7. Executar `docker compose up -d --wait --wait-timeout 180 whatsa-ai` e validar os smoke tests local e público em `/health/ready`.
8. Monitorar erros, WAL, sessões WhatsApp e Stripe por pelo menos 24 horas. Manter a quarentena até o encerramento formal.

## Alertas mínimos

- SIEM deve alertar em picos de 401/403, falhas CSRF, 5xx, login por IP novo, muitas tentativas de login, logout/reconnect de WhatsApp incomum, reset/exclusão de tenant, falha de backup e importação fora de janela.
- WAF deve alertar em SQLi/XSS/SSRF, HTTP flood, paths administrativos, user agents automatizados e anomalia geográfica.
- EDR deve alertar em execução de shell, `curl|wget` inesperado, alteração de `node_modules`, tentativa de acesso ao Docker socket e consumo sustentado de CPU/memória/PIDs.
- Monitorar status `unhealthy`, reinícios do container, uso de disco, crescimento de `data/`/`media/`, idade do último manifesto e falhas no smoke test.

## Gate de liberação

Não declare a VPS pronta enquanto algum item estiver pendente:

- `./deploy.sh` conclui sem bypass, e `/health/ready` responde 200 local e publicamente;
- webhook Stripe live está cadastrado para a URL exata, com eventos de assinatura/fatura testados em uma conta real controlada;
- snapshot local passa em `backup:verify`, cópia offsite criptografada foi comprovada e um restore isolado foi cronometrado;
- alertas externos cobrem indisponibilidade, reinício, disco, memória/PIDs, falha/idade de backup, 5xx, webhook Stripe e desconexão WhatsApp;
- cada número WhatsApp foi validado após restart real do container, e a capacidade simultânea ficou dentro da RAM medida;
- proxy, TLS, firewall, atualizações do host, SIEM/EDR e rotação de segredos foram verificados por quem administra a VPS.

## DNS e e-mail

- DNSSEC: ativar quando o provedor do domínio suportar.
- SPF: restringir remetentes autorizados.
- DKIM: assinar e-mails transacionais.
- DMARC: iniciar em `p=none`, revisar relatórios e evoluir para `quarantine`/`reject`.
- Monitorar mudanças de DNS e expiração de domínio/certificado.

## Resposta a incidente

1. Isolar: bloquear tráfego no WAF, colocar origin em allowlist ou manutenção.
2. Preservar evidência: copiar logs do SIEM, proxy, Docker e snapshots dos volumes antes de limpar.
3. Conter credenciais: rotacionar `JWT_SECRET`, Stripe, SMTP, senha admin e sessões de fornecedores.
4. Erradicar: atualizar imagem, aplicar patch, executar `npm run check`, `npm audit`, revisar IOC no EDR e SIEM.
5. Recuperar: restaurar backup limpo, validar RPO/RTO e monitorar em modo reforçado por 24 horas.
6. Pós-mortem: registrar causa, impacto, clientes afetados, controles faltantes e prazo de correção.
