# Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir ou mitigar, com rastreabilidade por ameaca, os gaps encontrados na matriz `docs/security-threat-coverage.md`.

**Architecture:** O plano usa pacotes de controle reutilizaveis: hardening de aplicacao, sessao, uploads, container, rede, monitoramento, backup, supply chain e processos operacionais. Cada ameaca aponta para um ou mais pacotes, com prioridade e criterio de aceite.

**Tech Stack:** Node.js/Express, Socket.IO, SQLite/better-sqlite3, Docker, Nginx, npm audit/SCA, ClamAV ou servico equivalente, WAF/CDN, SIEM/EDR, backup imutavel.

---

## Prioridades

- P0: corrigir antes de expor a producao para clientes reais ou dados sensiveis.
- P1: corrigir no primeiro ciclo de hardening apos P0.
- P2: controle operacional/infra que pode entrar em roadmap de 30-90 dias.
- Fora de escopo do app: ainda precisa dono operacional, mas nao vira codigo neste repositorio.

## Pacotes de Correcao

| Codigo | Pacote | Entrega objetiva |
|---|---|---|
| SEC-01 | Security headers e CSP | Adicionar `helmet`, CSP restritiva, `frame-ancestors 'none'`, HSTS, Referrer-Policy, Permissions-Policy, COOP/CORP quando compativel. |
| SEC-02 | Sessao, cookies, CSRF e MFA | Tornar cookie `auth_token` `httpOnly`, `secure` em producao, remover dependencia de JWT em `localStorage`, adicionar CSRF token para mutacoes e MFA para admins. |
| SEC-03 | Upload, anexos e malware scanning | Validar allowlist de MIME/extensao por magic bytes, bloquear HTML/SVG executavel, escanear anexos com ClamAV/servico AV, quarentena e Content-Disposition seguro. |
| SEC-04 | Container e host hardening | Rodar container como usuario nao-root, remover capabilities, `no-new-privileges`, seccomp/AppArmor, filesystem read-only onde possivel, revisar Chromium sandbox. |
| SEC-05 | WAF, bot e DDoS | Colocar Cloudflare/AWS Shield/Nginx rate limits na frente, regras WAF OWASP, rate limits por usuario/tenant/IP e desafios para abuso. |
| SEC-06 | Logs, SIEM, EDR e alertas | Enviar logs/auditoria para SIEM, tornar logs imutaveis, alertas para login anomalo, exportacao em massa, erros 5xx, QR/reconnect suspeito. |
| SEC-07 | Backup, DR e anti-ransomware | Backup criptografado, imutavel/offline, teste de restore, RPO/RTO documentado e snapshot antes de deploy. |
| SEC-08 | Segredos e supply chain | Secret manager, rotacao de segredos, `npm audit`/SCA no CI, Dependabot/Renovate, SBOM, pin de imagem Docker por digest. |
| SEC-09 | TLS, DNS e e-mail security | HSTS no Nginx/CDN, TLS forte, DNSSEC quando possivel, SPF/DKIM/DMARC para dominio de e-mail. |
| SEC-10 | Cloud/IAM/egress | IAM minimo, bloquear metadata service quando aplicavel, firewall/egress allowlist, storage privado, alertas de IAM. |
| SEC-11 | Endpoint/fisico/Wi-Fi | EDR/MDM, patching de endpoints, VPN/WPA3, politicas anti-USB, treinamento fisico. |
| SEC-12 | Processo anti-engenharia social | Treinamento, playbooks de verificacao, aprovacao dupla para acoes sensiveis, simulados phishing. |
| SEC-13 | AD/Kerberos | So aplicar se houver AD: tiering, hardening Kerberos, desabilitar RC4, gMSA, auditoria DCSync/DCShadow. |
| SEC-14 | IA/LLM | So aplicar se houver IA: isolamento de contexto, filtros de prompt injection, avaliacao adversarial, logs e controle de dados de treino. |
| SEC-15 | Blockchain/cripto | So aplicar se houver cripto: auditoria smart contract, multisig, monitoramento on-chain, controles de wallet. |
| SEC-16 | IoT/mobile | So aplicar se houver app/dispositivo: MDM, attestation, pinning, hardening firmware/mobile. |

## Tarefas de Implementacao no Repositorio

### Task 1: Security headers e CSP basica

**Files:**
- Modify: `package.json`
- Modify: `server.js`
- Test: `serverStructure.test.js`

- [x] **Step 1: Write failing tests**

Adicionar em `serverStructure.test.js`:

```js
test('server applies core browser security headers', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.ok(pkg.dependencies.helmet, 'helmet dependency is required');
  assert.match(source, /helmet\(/);
  assert.match(source, /contentSecurityPolicy/);
  assert.match(source, /frameAncestors/);
  assert.match(source, /hsts/);
});
```

- [x] **Step 2: Verify RED**

Run: `node --test serverStructure.test.js`

Expected: FAIL because `helmet` and CSP are not configured.

- [x] **Step 3: Implement minimal code**

Install: `npm install helmet`

In `server.js`, before static files:

```js
const helmet = require('helmet');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://api.qrserver.com'],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  hsts: process.env.NODE_ENV === 'production'
}));
```

- [x] **Step 4: Verify GREEN**

Run: `node --test serverStructure.test.js && npm run lint`

Expected: PASS.

### Task 2: Sessao segura, CSRF e retirada gradual de localStorage

**Files:**
- Modify: `server.js`
- Modify: `frontend/login.html`
- Modify: `frontend/admin.html`
- Modify: `frontend/vendor.html`
- Modify: `frontend/superadmin.html`
- Create: `csrf.js`
- Test: `serverStructure.test.js`, `frontendHtml.test.js`

- [x] **Step 1: Write failing tests**

Adicionar testes que exijam `httpOnly`, `secure` condicional e CSRF em rotas mutantes:

```js
test('auth cookie is httpOnly and mutation routes use csrf protection', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  assert.match(source, /httpOnly:\s*true/);
  assert.match(source, /csrfMiddleware/);
  assert.match(source, /app\.use\('\/api',\s*csrfMiddleware\)/);
});
```

- [x] **Step 2: Verify RED**

Run: `node --test serverStructure.test.js`

Expected: FAIL because cookie is not `httpOnly` and there is no CSRF middleware.

- [x] **Step 3: Implement minimal code**

Create `csrf.js`:

```js
const crypto = require('crypto');

function createCsrfTokenStore() {
  const tokens = new Map();
  return {
    issue(sessionId) {
      const token = crypto.randomBytes(32).toString('hex');
      tokens.set(sessionId, token);
      return token;
    },
    verify(sessionId, token) {
      return Boolean(sessionId && token && tokens.get(sessionId) === token);
    },
    revoke(sessionId) {
      tokens.delete(sessionId);
    }
  };
}

module.exports = { createCsrfTokenStore };
```

In `server.js`, set `httpOnly: true` and add a CSRF endpoint/header check for `POST`, `PUT`, `PATCH`, `DELETE` routes except login/register/forgot/reset/webhook.

- [x] **Step 4: Verify GREEN**

Run: `node --test serverStructure.test.js frontendHtml.test.js && npm run lint`

Expected: PASS.

### Task 3: Upload scanning e allowlist real

**Files:**
- Modify: `mediaStorage.js`
- Modify: `messageSender.js`
- Modify: `historyImporter.js`
- Create: `mediaSecurity.js`
- Test: `mediaStorage.test.js`, `messageSender.test.js`, `historyImporter.test.js`

- [x] **Step 1: Write failing tests**

Adicionar teste que bloqueia HTML disfarçado de imagem:

```js
test('rejects executable html uploaded as media', async () => {
  assert.throws(
    () => validateMediaForStorage({
      mimetype: 'text/html',
      filename: 'x.html',
      data: Buffer.from('<script>alert(1)</script>').toString('base64')
    }),
    /Tipo de arquivo nao permitido/
  );
});
```

- [x] **Step 2: Verify RED**

Run: `node --test mediaStorage.test.js`

Expected: FAIL because `validateMediaForStorage` does not exist.

- [x] **Step 3: Implement minimal code**

Create `mediaSecurity.js` with allowed MIME list, magic-byte checks for PNG/JPEG/GIF/PDF/OGG/MP4, and optional ClamAV command configured by `CLAMSCAN_PATH`.

- [x] **Step 4: Verify GREEN**

Run: `node --test mediaStorage.test.js messageSender.test.js historyImporter.test.js`

Expected: PASS.

### Task 4: Container hardening

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Test: `deployment.test.js`

- [x] **Step 1: Write failing tests**

Adicionar em `deployment.test.js`:

```js
test('container runs as non-root with reduced privileges', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  assert.match(dockerfile, /USER node/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
});
```

- [x] **Step 2: Verify RED**

Run: `node --test deployment.test.js`

Expected: FAIL because container currently runs as root.

- [x] **Step 3: Implement minimal code**

Use `USER node`, `chown` writable dirs, `security_opt`, `cap_drop`, and only add capabilities if a dependency proves necessary.

- [x] **Step 4: Verify GREEN**

Run: `node --test deployment.test.js && npm run lint`

Expected: PASS.

### Task 5: Monitoring, backups e infra

**Files:**
- Create: `docs/operations/security-runbook.md`
- Modify: `docker-compose.yml`
- Test: `deployment.test.js`

- [x] **Step 1: Write runbook checks**

Documentar comandos de backup/restore, SIEM/EDR/WAF obrigatorios e alertas minimos.

- [x] **Step 2: Verify**

Run: `node --test deployment.test.js`

Expected: PASS and runbook exists with sections `Backup`, `Restore`, `WAF`, `SIEM`, `Incident Response`.

## Matriz de Correcao por Ameaca

| Categoria | Ameaca | Prioridade | Pacotes | Plano de correcao |
|---|---|---:|---|---|
| Malware | Malware | P0 | SEC-03, SEC-04, SEC-06 | Escanear anexos, endurecer container/host e alertar execucao/comportamento suspeito. |
| Malware | Virus | P0 | SEC-03, SEC-06, SEC-11 | Adicionar AV em uploads e EDR nos hosts/endpoints. |
| Malware | Worm | P1 | SEC-04, SEC-05, SEC-11 | Segmentar rede, patching e EDR; app nao corrige worm sozinho. |
| Malware | Trojan (Cavalo de Troia) | P0 | SEC-03, SEC-08, SEC-11 | Scanning de anexos/dependencias, SCA e EDR. |
| Malware | Backdoor | P0 | SEC-04, SEC-06, SEC-08 | Integridade de build, logs imutaveis, secret rotation e EDR. |
| Malware | Rootkit | P2 | SEC-04, SEC-06, SEC-11 | EDR/kernel hardening e reinstalacao/forense em incidente. |
| Malware | Bootkit | P2 | SEC-11 | Secure Boot, MDM e controle fisico/endpoint. |
| Malware | Ransomware | P0 | SEC-07, SEC-04, SEC-06 | Backup imutavel, restore testado, EDR e minima permissao de escrita. |
| Malware | Wiper | P0 | SEC-07, SEC-06 | Backup imutavel e alerta de delecao/alteracao massiva. |
| Malware | Spyware | P1 | SEC-11, SEC-02 | EDR/MDM e reduzir roubo de token com cookie httpOnly/MFA. |
| Malware | Adware | P2 | SEC-11 | MDM/endpoint policy. |
| Malware | Keylogger | P1 | SEC-11, SEC-02 | MFA para admins e EDR nos endpoints. |
| Malware | Infostealer | P0 | SEC-02, SEC-08, SEC-11 | Remover JWT de localStorage, secret manager, MFA e EDR. |
| Malware | Banker Trojan | P2 | SEC-11, SEC-12 | Endpoint protection e treinamento. |
| Malware | RAT (Remote Access Trojan) | P1 | SEC-11, SEC-06 | EDR e alertas de login/localizacao anomala. |
| Malware | Bot | P0 | SEC-05 | WAF, rate limit por tenant/usuario/IP e CAPTCHA em abuso. |
| Malware | Botnet malware | P0 | SEC-05, SEC-06 | WAF/DDoS e monitoramento de padroes distribuidos. |
| Malware | Cryptominer (Cryptojacking malware) | P1 | SEC-01, SEC-04, SEC-06 | CSP, container hardening e alerta de CPU anomala. |
| Malware | Logic Bomb | P1 | SEC-08, SEC-06 | CI/CD com review, SCA, logs imutaveis e controle de mudancas. |
| Malware | Fileless Malware | P2 | SEC-11, SEC-06 | EDR comportamental e SIEM. |
| Malware | Dropper | P0 | SEC-03, SEC-11 | Scanning/quarentena de uploads e EDR. |
| Malware | Downloader | P1 | SEC-03, SEC-10, SEC-11 | Scanning e egress filtering no host/container. |
| Malware | Scareware | P2 | SEC-12 | Processo/treinamento e remocao de conteudo malicioso. |
| Malware | Mobile Malware | P2 | SEC-16 | MDM e controles mobile se app movel existir. |
| Engenharia Social | Phishing | P1 | SEC-09, SEC-12, SEC-02 | SPF/DKIM/DMARC, treinamento, MFA. |
| Engenharia Social | Spear Phishing | P1 | SEC-12, SEC-02 | MFA e processo de verificacao fora de banda. |
| Engenharia Social | Whaling | P1 | SEC-12, SEC-02 | Aprovacao dupla para admins/superadmin e MFA. |
| Engenharia Social | Clone Phishing | P1 | SEC-09, SEC-12 | DMARC e treinamento de verificacao de dominios. |
| Engenharia Social | Smishing (SMS) | P2 | SEC-12 | Treinamento; evitar SMS como fator unico. |
| Engenharia Social | Vishing (voz) | P2 | SEC-12 | Playbook de confirmacao por canal independente. |
| Engenharia Social | Quishing (QR Code) | P1 | SEC-12, SEC-02 | Educar admins sobre QR WhatsApp e exigir MFA para conexao/reset. |
| Engenharia Social | Angler Phishing | P2 | SEC-12 | Processo de atendimento oficial e comunicacao de canais validos. |
| Engenharia Social | Business Email Compromise (BEC) | P1 | SEC-09, SEC-12 | DMARC e aprovacao dupla para pagamentos/alteracoes sensiveis. |
| Engenharia Social | CEO Fraud | P1 | SEC-12 | Fluxo de aprovacao dupla e verificacao fora de banda. |
| Engenharia Social | Pretexting | P2 | SEC-12 | Treinamento e script de verificacao de identidade. |
| Engenharia Social | Baiting | P2 | SEC-11, SEC-12 | Politica anti-USB/anexo e treinamento. |
| Engenharia Social | Quid Pro Quo | P2 | SEC-12 | Treinamento e canal oficial de suporte. |
| Engenharia Social | Tailgating | P2 | SEC-11 | Controle fisico/portaria. |
| Engenharia Social | Piggybacking | P2 | SEC-11 | Controle fisico/portaria. |
| Engenharia Social | Shoulder Surfing | P2 | SEC-11, SEC-02 | Politica de tela, MFA e timeout de sessao. |
| Engenharia Social | Dumpster Diving | P2 | SEC-11 | Politica de descarte seguro. |
| Engenharia Social | Honey Trap | P2 | SEC-12 | Treinamento e politica de conflitos/social. |
| Engenharia Social | Watering Hole | P1 | SEC-01, SEC-08, SEC-11 | CSP/SRI quando aplicavel, SCA e EDR. |
| Ataques de Senhas | Brute Force | P0 | SEC-02, SEC-05 | MFA, rate limit por conta/IP/tenant, lockout progressivo. |
| Ataques de Senhas | Dictionary Attack | P0 | SEC-02, SEC-05 | Politica de senha forte, lista de senhas vazadas e rate limit. |
| Ataques de Senhas | Password Spraying | P0 | SEC-02, SEC-05, SEC-06 | MFA, deteccao por tenant e alertas de muitas contas por IP. |
| Ataques de Senhas | Credential Stuffing | P0 | SEC-02, SEC-05, SEC-06 | MFA, detecao de credenciais vazadas, WAF/bot rules. |
| Ataques de Senhas | Credential Cracking | P1 | SEC-02 | Aumentar custo bcrypt ou migrar para Argon2id; politica de senha. |
| Ataques de Senhas | Rainbow Table Attack | P2 | SEC-02 | Manter bcrypt/Argon2id com salt; revisar custo periodicamente. |
| Ataques de Senhas | Password Guessing | P0 | SEC-02, SEC-05 | MFA, senha forte e rate limit por conta. |
| Ataques de Senhas | Pass-the-Hash | P2 | SEC-13 | Se AD for usado, aplicar hardening NTLM/Kerberos. |
| Ataques de Senhas | Pass-the-Ticket | P2 | SEC-13 | Se AD for usado, hardening Kerberos e deteccao. |
| Ataques de Senhas | Kerberoasting | P2 | SEC-13 | Se AD for usado, gMSA, senhas fortes SPN, desabilitar RC4. |
| Ataques de Senhas | AS-REP Roasting | P2 | SEC-13 | Se AD for usado, exigir pre-auth Kerberos. |
| Ataques Web | SQL Injection (SQLi) | P1 | SEC-06 | Manter prepared statements e adicionar DAST/WAF para regressao. |
| Ataques Web | Blind SQL Injection | P1 | SEC-05, SEC-06 | WAF/DAST e manter queries parametrizadas. |
| Ataques Web | Time-based SQLi | P1 | SEC-05, SEC-06 | WAF/DAST e alertas de latencia anomala. |
| Ataques Web | Error-based SQLi | P1 | SEC-05, SEC-06 | WAF/DAST e padronizar erros sem detalhes internos. |
| Ataques Web | NoSQL Injection | P2 | SEC-08 | Se NoSQL entrar, usar schema validation e queries seguras. |
| Ataques Web | LDAP Injection | P2 | SEC-13 | Se LDAP entrar, usar bind parametrizado e escaping. |
| Ataques Web | XPath Injection | P2 | SEC-08 | Evitar XPath com input; validar se XML for adicionado. |
| Ataques Web | Command Injection | P0 | SEC-03, SEC-04 | Manter `execFile`, allowlist de binario ffmpeg e container nao-root. |
| Ataques Web | Code Injection | P0 | SEC-01, SEC-08 | CSP, SCA e banir `eval`/Function em lint. |
| Ataques Web | OS Command Injection | P0 | SEC-03, SEC-04 | `execFile`, argumentos fixos, path de ffmpeg confiavel e sandbox. |
| Ataques Web | Server-Side Template Injection (SSTI) | P2 | SEC-08 | Se template engine for adicionado, bloquear templates com input de usuario. |
| Ataques Web | XML Injection | P2 | SEC-08 | Se XML for adicionado, parser seguro e schema validation. |
| Ataques Web | XXE (XML External Entity) | P2 | SEC-08 | Desabilitar entidades externas se XML for adicionado. |
| Ataques Web | Cross-Site Scripting (XSS) | P0 | SEC-01, SEC-02 | CSP, remover JWT de localStorage, substituir `innerHTML` por DOM APIs onde possivel. |
| Ataques Web | Stored XSS | P0 | SEC-01, SEC-03 | CSP e sanitizacao/escape central para conteudo salvo/anexos. |
| Ataques Web | Reflected XSS | P0 | SEC-01 | CSP e escape consistente de mensagens de erro/queries. |
| Ataques Web | DOM-based XSS | P0 | SEC-01, SEC-02 | Reduzir `innerHTML`, DOMPurify se HTML for necessario, token httpOnly. |
| Ataques Web | Cross-Site Request Forgery (CSRF) | P0 | SEC-02 | CSRF token em mutacoes e cookie httpOnly/SameSite. |
| Ataques Web | Cross-Site Leak (XS-Leaks) | P1 | SEC-01, SEC-02 | COOP/CORP/CSP, SameSite e respostas uniformes. |
| Ataques Web | Cross-Origin Attacks | P1 | SEC-01, SEC-02 | CORS estrito, CSP e CSRF. |
| Ataques Web | HTTP Parameter Pollution | P1 | SEC-02 | Normalizar/rejeitar arrays em query/body onde campo espera escalar. |
| Ataques Web | HTTP Request Smuggling | P1 | SEC-05, SEC-09 | Proxy atualizado, WAF, Nginx hardening e testes de cabecalhos. |
| Ataques Web | HTTP Response Splitting | P1 | SEC-01 | Validar valores usados em headers e usar Helmet. |
| Ataques Web | Host Header Injection | P0 | SEC-09 | Remover fallback por `req.get('host')` em URLs sensiveis; exigir `APP_URL`. |
| Ataques Web | CRLF Injection | P1 | SEC-01 | Sanitizar qualquer valor usado em header/log e usar APIs Express. |
| Ataques Web | Clickjacking | P0 | SEC-01 | `frame-ancestors 'none'` e/ou `X-Frame-Options: DENY`. |
| Ataques Web | Open Redirect | P1 | SEC-02 | Allowlist de URLs externas e testes para redirects futuros. |
| Ataques Web | Local File Inclusion (LFI) | P1 | SEC-03 | Manter `basename`, testes de traversal e storage fora de rotas publicas. |
| Ataques Web | Remote File Inclusion (RFI) | P2 | SEC-08 | Nao adicionar inclusao remota; se necessario, allowlist estrita. |
| Ataques Web | Directory Traversal | P1 | SEC-03 | Testes de `../`, encoded traversal e nomes Unicode. |
| Ataques Web | Path Traversal | P1 | SEC-03 | Mesmo controle de traversal. |
| Ataques Web | Arbitrary File Upload | P0 | SEC-03 | Allowlist, magic bytes, AV, quarentena e tamanho por tipo. |
| Ataques Web | File Inclusion | P1 | SEC-03 | Garantir que arquivos servidos sejam somente midia autorizada. |
| Ataques Web | Session Fixation | P0 | SEC-02 | Regenerar token no login, cookie httpOnly, revogacao e CSRF. |
| Ataques Web | Session Hijacking | P0 | SEC-02, SEC-06 | Cookie httpOnly, MFA, alertas de login/anomalia e revogacao. |
| Ataques Web | Cookie Poisoning | P0 | SEC-02 | JWT assinado, cookie httpOnly/secure e validacao de token version. |
| Ataques Web | Insecure Deserialization | P1 | SEC-02 | Schema validation para JSON body e rejeicao de tipos inesperados. |
| Ataques Web | Prototype Pollution | P1 | SEC-02 | Sanitizar `__proto__`, `constructor`, `prototype`; usar schema validation. |
| Ataques Web | Mass Assignment | P1 | SEC-02 | DTOs/allowlist de campos por rota; testes contra campos extras. |
| Ataques Web | Race Condition | P1 | SEC-06 | Transacoes/idempotencia para rotas criticas e testes concorrentes. |
| Ataques Web | Business Logic Abuse | P1 | SEC-06 | Testes de regras por role/tenant/billing e alertas de abuso. |
| Ataques Web | API Abuse | P0 | SEC-05, SEC-06 | Quotas por usuario/tenant/IP e alertas de volume. |
| Ataques Web | GraphQL Injection | P2 | SEC-08 | Se GraphQL entrar, usar validation, depth limit e persisted queries. |
| Ataques Web | SSRF (Server-Side Request Forgery) | P1 | SEC-10 | Egress allowlist e bloqueio de IPs privados/metadata em chamadas futuras. |
| Ataques de Rede | DoS | P0 | SEC-05 | WAF/CDN, rate limit e limites de body/conexao. |
| Ataques de Rede | DDoS | P0 | SEC-05 | Protecao DDoS no provedor/CDN. |
| Ataques de Rede | SYN Flood | P2 | SEC-05 | Mitigacao no provedor/kernel/firewall. |
| Ataques de Rede | UDP Flood | P2 | SEC-05 | Mitigacao no provedor/firewall. |
| Ataques de Rede | ICMP Flood | P2 | SEC-05 | Rate limit ICMP/firewall/provedor. |
| Ataques de Rede | HTTP Flood | P0 | SEC-05 | WAF/CDN e rate limit por endpoint. |
| Ataques de Rede | Slowloris | P1 | SEC-05, SEC-09 | Nginx timeouts, limit_conn/limit_req e keepalive tuning. |
| Ataques de Rede | Ping Flood | P2 | SEC-05 | Firewall/provedor. |
| Ataques de Rede | Ping of Death | P2 | SEC-05 | Kernel atualizado/provedor. |
| Ataques de Rede | Smurf Attack | P2 | SEC-05 | Rede/provedor; desabilitar broadcast amplification. |
| Ataques de Rede | Fraggle Attack | P2 | SEC-05 | Rede/provedor. |
| Ataques de Rede | Teardrop Attack | P2 | SEC-05 | Kernel atualizado/provedor. |
| Ataques de Rede | LAND Attack | P2 | SEC-05 | Kernel atualizado/firewall. |
| Ataques de Rede | Amplification Attack | P2 | SEC-05 | Nao expor servicos amplificadores; provedor/CDN. |
| Ataques de Rede | Reflection Attack | P2 | SEC-05 | Provedor/CDN e firewall. |
| Ataques de Rede | DNS Amplification | P2 | SEC-09 | DNS gerenciado seguro; nao operar resolver aberto. |
| Ataques de Rede | NTP Amplification | P2 | SEC-05 | Nao expor NTP; provedor/firewall. |
| Ataques de Rede | Memcached Amplification | P2 | SEC-05 | Nao expor memcached; firewall. |
| Ataques de Rede | ARP Spoofing | P2 | SEC-11 | Switch security/VPN/rede gerenciada. |
| Ataques de Rede | ARP Poisoning | P2 | SEC-11 | Switch security/VPN/rede gerenciada. |
| Ataques de Rede | IP Spoofing | P2 | SEC-05 | Anti-spoofing no provedor/firewall. |
| Ataques de Rede | DNS Spoofing | P1 | SEC-09 | HSTS, DNSSEC quando possivel e monitoramento de DNS. |
| Ataques de Rede | DNS Cache Poisoning | P1 | SEC-09 | DNSSEC/HSTS e resolver confiavel. |
| Ataques de Rede | DHCP Spoofing | P2 | SEC-11 | DHCP snooping/rede corporativa. |
| Ataques de Rede | MAC Flooding | P2 | SEC-11 | Port security em switches. |
| Ataques de Rede | CAM Table Overflow | P2 | SEC-11 | Port security em switches. |
| Ataques de Rede | VLAN Hopping | P2 | SEC-11 | Hardening VLAN/switch. |
| Ataques de Rede | STP Attack | P2 | SEC-11 | BPDU guard/root guard. |
| Ataques de Rede | Routing Attack | P2 | SEC-05 | Provedor/rede com rotas autenticadas/monitoradas. |
| Ataques de Rede | BGP Hijacking | P2 | SEC-09 | RPKI/monitoramento BGP no provedor. |
| Ataques de Rede | Route Injection | P2 | SEC-05 | Controle de roteamento/provedor. |
| Interceptacao | Interceptacao | P0 | SEC-09 | HTTPS obrigatorio, HSTS e cookie secure. |
| Interceptacao | Man-in-the-Middle (MitM) | P0 | SEC-09, SEC-02 | TLS/HSTS e secure cookies. |
| Interceptacao | Man-in-the-Browser (MitB) | P1 | SEC-02, SEC-11 | MFA, token httpOnly e EDR endpoint. |
| Interceptacao | Evil Twin | P2 | SEC-11 | VPN/WPA3/treinamento. |
| Interceptacao | Rogue Access Point | P2 | SEC-11 | Wi-Fi corporativo gerenciado. |
| Interceptacao | SSL Stripping | P0 | SEC-09 | HSTS preload quando possivel. |
| Interceptacao | HTTPS Downgrade | P0 | SEC-09 | TLS 1.2/1.3 e HSTS. |
| Interceptacao | TLS Downgrade | P0 | SEC-09 | TLS moderno e cipher suite forte. |
| Interceptacao | Packet Sniffing | P0 | SEC-09 | TLS em todos os caminhos e VPN/admin. |
| Interceptacao | Session Replay | P1 | SEC-02 | CSRF, expiracao curta, rotacao e deteccao de reuso anomalo. |
| Interceptacao | Replay Attack | P1 | SEC-02, SEC-06 | Nonces/idempotency keys em acoes criticas e auditoria. |
| Wi-Fi | Deauthentication Attack | P2 | SEC-11 | WPA3/802.11w quando possivel. |
| Wi-Fi | Beacon Flood | P2 | SEC-11 | Wi-Fi gerenciado. |
| Wi-Fi | Evil Twin Wi-Fi | P2 | SEC-11 | VPN, WPA Enterprise e treinamento. |
| Wi-Fi | Rogue AP | P2 | SEC-11 | Deteccao de rogue AP. |
| Wi-Fi | WPA Handshake Capture | P2 | SEC-11 | WPA3/WPA Enterprise e senhas fortes. |
| Wi-Fi | PMKID Attack | P2 | SEC-11 | WPA3/WPA Enterprise. |
| Wi-Fi | WPS PIN Attack | P2 | SEC-11 | Desabilitar WPS. |
| Wi-Fi | KRACK | P2 | SEC-11 | Patching de clientes/APs. |
| Wi-Fi | Wi-Fi Jamming | P2 | SEC-11 | Plano operacional/rede alternativa. |
| DNS | DNS Hijacking | P1 | SEC-09 | Registrar lock, MFA no registrador, DNSSEC e monitoramento. |
| DNS | DNS Tunneling | P2 | SEC-10 | Egress DNS controlado e deteccao. |
| DNS | DNS Poisoning | P1 | SEC-09 | DNSSEC, HSTS e resolver confiavel. |
| DNS | NXDOMAIN Attack | P2 | SEC-09 | DNS provider com protecao DDoS. |
| DNS | Domain Shadowing | P2 | SEC-09 | Governanca de DNS e alertas de subdominios. |
| DNS | Fast Flux | P2 | SEC-09 | Monitoramento/reputacao de dominio. |
| E-mail | Email Spoofing | P1 | SEC-09 | SPF, DKIM e DMARC `p=quarantine/reject`. |
| E-mail | Email Bombing | P1 | SEC-05, SEC-09 | Rate limit de e-mail e provider com abuse controls. |
| E-mail | Attachment Malware | P0 | SEC-03 | Scanning/quarentena de anexos. |
| E-mail | Malicious Macro | P0 | SEC-03, SEC-11 | Bloquear/scan Office macros e EDR. |
| E-mail | Thread Hijacking | P2 | SEC-12, SEC-09 | DMARC e treinamento. |
| Sistemas | Privilege Escalation | P0 | SEC-04 | Container nao-root, cap-drop e host patching. |
| Sistemas | Local Privilege Escalation | P0 | SEC-04, SEC-11 | Non-root, patching e EDR. |
| Sistemas | Remote Privilege Escalation | P0 | SEC-04, SEC-05, SEC-08 | WAF, patching, SCA e container hardening. |
| Sistemas | Zero-Day Exploit | P1 | SEC-05, SEC-06, SEC-08 | WAF virtual patching, EDR e patch process. |
| Sistemas | N-Day Exploit | P0 | SEC-08 | SCA/Dependabot e janela de patch definida. |
| Sistemas | Buffer Overflow | P1 | SEC-04, SEC-08 | Atualizar deps nativas, sandbox e reduzir privileges. |
| Sistemas | Heap Overflow | P1 | SEC-04, SEC-08 | Mesmo pacote de native deps/sandbox. |
| Sistemas | Stack Overflow | P1 | SEC-04, SEC-08 | Mesmo pacote de native deps/sandbox. |
| Sistemas | Integer Overflow | P1 | SEC-04, SEC-08 | Mesmo pacote de native deps/sandbox. |
| Sistemas | Format String Attack | P2 | SEC-08 | SCA para bibliotecas nativas. |
| Sistemas | Memory Corruption | P1 | SEC-04, SEC-08 | Sandbox, patching e SCA. |
| Sistemas | Use-After-Free | P1 | SEC-04, SEC-08 | Chromium/ffmpeg atualizados e sandbox. |
| Sistemas | Double Free | P1 | SEC-04, SEC-08 | Native dependency patching. |
| Sistemas | Race Condition Exploit | P1 | SEC-06 | Transacoes, locks e testes concorrentes. |
| Aplicacoes | Reverse Shell | P0 | SEC-04, SEC-10, SEC-06 | Non-root, egress filtering e alerta de processos/conexoes. |
| Aplicacoes | Web Shell | P0 | SEC-03, SEC-04 | Upload nao executavel, AV e filesystem restrito. |
| Aplicacoes | Remote Code Execution (RCE) | P0 | SEC-01, SEC-03, SEC-04, SEC-08 | CSP, upload scanning, non-root e SCA. |
| Aplicacoes | Local Code Execution | P0 | SEC-04 | Container/host hardening. |
| Aplicacoes | Sandbox Escape | P0 | SEC-04 | Reavaliar Chromium `--no-sandbox`, seccomp/AppArmor e isolamento. |
| Aplicacoes | Container Escape | P0 | SEC-04 | Non-root, cap-drop, no-new-privileges, seccomp. |
| Aplicacoes | VM Escape | P2 | SEC-10 | Provedor/hipervisor atualizado. |
| Active Directory | Golden Ticket | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | Silver Ticket | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | DCShadow | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | DCSync | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | Skeleton Key | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | Kerberoasting | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | AS-REP Roasting | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | NTLM Relay | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Active Directory | LDAP Relay | P2 | SEC-13 | Aplicar se AD entrar no escopo. |
| Nuvem | Cloud Misconfiguration Abuse | P1 | SEC-10 | IaC review, least privilege, posture scanning. |
| Nuvem | Metadata Service Attack | P1 | SEC-10 | Bloquear metadata de containers ou exigir IMDSv2. |
| Nuvem | IAM Abuse | P1 | SEC-10 | IAM minimo, MFA, alertas e rotacao. |
| Nuvem | Token Theft | P0 | SEC-02, SEC-08, SEC-10 | Secret manager, token httpOnly, egress monitoring. |
| Nuvem | Bucket Takeover | P2 | SEC-10 | Se usar bucket, ownership controls e nomes reservados. |
| Nuvem | Serverless Abuse | P2 | SEC-10 | Se serverless entrar, quotas/IAM/logs. |
| Nuvem | Container Breakout | P0 | SEC-04 | Container hardening. |
| Blockchain/Cripto | 51% Attack | P2 | SEC-15 | Aplicar apenas se houver blockchain. |
| Blockchain/Cripto | Double Spending | P2 | SEC-15 | Aplicar apenas se houver cripto. |
| Blockchain/Cripto | Rug Pull | P2 | SEC-15 | Aplicar apenas se houver token/projeto cripto. |
| Blockchain/Cripto | Smart Contract Exploit | P2 | SEC-15 | Auditoria e formal verification se smart contract existir. |
| Blockchain/Cripto | Flash Loan Attack | P2 | SEC-15 | Aplicar se DeFi existir. |
| Blockchain/Cripto | Wallet Drainer | P2 | SEC-15 | Aplicar se wallet integrar. |
| Blockchain/Cripto | Clipboard Hijacking | P2 | SEC-11 | Endpoint/MDM se usuarios lidarem com cripto. |
| IoT | IoT Botnet | P2 | SEC-16 | Aplicar se houver IoT. |
| IoT | Firmware Exploit | P2 | SEC-16 | Aplicar se houver firmware. |
| IoT | Default Credential Attack | P1 | SEC-02 | Senhas iniciais fortes obrigatorias e bloqueio de defaults. |
| IoT | Device Takeover | P2 | SEC-16 | Aplicar se houver dispositivo. |
| Cadeia de Suprimentos | Supply Chain Attack | P0 | SEC-08 | SCA, SBOM, pin de imagem e review de updates. |
| Cadeia de Suprimentos | Dependency Confusion | P1 | SEC-08 | Registry policy, scopes privados e lockfile. |
| Cadeia de Suprimentos | Typosquatting | P1 | SEC-08 | SCA e revisao de novas dependencias. |
| Cadeia de Suprimentos | Package Poisoning | P0 | SEC-08 | Pinning, npm audit, provenance e CI protegido. |
| Cadeia de Suprimentos | Malicious Update | P0 | SEC-08 | Renovate com PR review, SCA e lockfile. |
| Cadeia de Suprimentos | Library Hijacking | P1 | SEC-08 | Integridade de dependencias e runtime minimo. |
| Persistencia/Evasao | Living off the Land (LotL) | P1 | SEC-04, SEC-06, SEC-10 | Egress filtering, EDR e reduzir ferramentas no container. |
| Persistencia/Evasao | Process Injection | P2 | SEC-11 | EDR/host controls. |
| Persistencia/Evasao | DLL Hijacking | P2 | SEC-11 | Endpoint Windows hardening. |
| Persistencia/Evasao | DLL Side-Loading | P2 | SEC-11 | Endpoint Windows hardening. |
| Persistencia/Evasao | Reflective DLL Injection | P2 | SEC-11 | EDR. |
| Persistencia/Evasao | Process Hollowing | P2 | SEC-11 | EDR. |
| Persistencia/Evasao | Thread Injection | P2 | SEC-11 | EDR. |
| Persistencia/Evasao | Code Cave Injection | P2 | SEC-11 | EDR. |
| Persistencia/Evasao | AMSI Bypass | P2 | SEC-11 | Windows endpoint controls. |
| Persistencia/Evasao | UAC Bypass | P2 | SEC-11 | Windows endpoint controls. |
| Persistencia/Evasao | Defense Evasion | P1 | SEC-06, SEC-11 | SIEM/EDR e log imutavel. |
| Persistencia/Evasao | Log Tampering | P1 | SEC-06 | Enviar logs para SIEM/WORM e alertar ausencia de logs. |
| Coleta de Dados | Data Exfiltration | P0 | SEC-06, SEC-10 | Egress filtering, DLP/alertas de volume e auditoria. |
| Coleta de Dados | Screen Capture Malware | P2 | SEC-11 | EDR/MDM. |
| Coleta de Dados | Clipboard Theft | P2 | SEC-11 | EDR/MDM. |
| Coleta de Dados | Browser Credential Theft | P0 | SEC-02, SEC-11 | Remover localStorage, MFA e EDR. |
| Coleta de Dados | Cookie Theft | P0 | SEC-01, SEC-02 | httpOnly, secure, CSP e MFA. |
| Coleta de Dados | Token Theft | P0 | SEC-02, SEC-08 | httpOnly, secret rotation e menor TTL. |
| Coleta de Dados | Session Token Hijacking | P0 | SEC-02, SEC-06 | MFA, alertas e revogacao rapida. |
| Mobile | SIM Swapping | P2 | SEC-16, SEC-02 | Nao usar SMS como MFA principal. |
| Mobile | Mobile RAT | P2 | SEC-16, SEC-11 | MDM/EDR mobile. |
| Mobile | Overlay Attack | P2 | SEC-16 | Se app mobile existir, anti-overlay/attestation. |
| Mobile | SMS Interception | P2 | SEC-16, SEC-02 | Evitar SMS como fator. |
| Mobile | Accessibility Abuse | P2 | SEC-16 | Hardening mobile se houver app. |
| Mobile | NFC Relay Attack | P2 | SEC-16 | Aplicar se NFC existir. |
| Fisicos | BadUSB | P2 | SEC-11 | Bloqueio USB/MDM. |
| Fisicos | Rubber Ducky Attack | P2 | SEC-11 | Bloqueio USB e treinamento. |
| Fisicos | Hardware Keylogger | P2 | SEC-11 | Inspecao fisica e MDM. |
| Fisicos | Cold Boot Attack | P2 | SEC-11 | Criptografia de disco e controle fisico. |
| Fisicos | DMA Attack | P2 | SEC-11 | Kernel DMA protection e controle fisico. |
| Fisicos | USB Drop Attack | P2 | SEC-11, SEC-12 | Bloqueio USB e treinamento. |
| IA | Deepfake Phishing | P2 | SEC-12 | Processo de verificacao fora de banda. |
| IA | Voice Cloning Attack | P2 | SEC-12 | Palavra-chave/processo de confirmacao. |
| IA | AI-assisted Phishing | P2 | SEC-12, SEC-09 | Treinamento e DMARC. |
| IA | Prompt Injection (contra sistemas de IA) | P2 | SEC-14 | Aplicar se LLM entrar no produto. |
| IA | Indirect Prompt Injection | P2 | SEC-14 | Aplicar se LLM consumir conteudo externo. |
| IA | Model Poisoning | P2 | SEC-14 | Aplicar se houver treino/fine-tuning. |
| IA | Data Poisoning | P2 | SEC-14 | Aplicar se houver pipeline de dados. |
| IA | Model Extraction | P2 | SEC-14 | Aplicar se houver modelo proprio exposto. |
| IA | Membership Inference | P2 | SEC-14 | Aplicar se houver modelo proprio/dados sensiveis. |
| IA | Adversarial Examples | P2 | SEC-14 | Aplicar se houver ML em decisoes. |
| Tecnicas Gerais | Reconnaissance | P1 | SEC-01, SEC-05 | Reduzir headers expostos, WAF e revisar `/health`. |
| Tecnicas Gerais | Footprinting | P1 | SEC-01 | Helmet e ocultar tecnologia quando possivel. |
| Tecnicas Gerais | Fingerprinting | P1 | SEC-01 | Security headers e configuracao de proxy. |
| Tecnicas Gerais | Enumeration | P1 | SEC-02, SEC-05 | Respostas uniformes, rate limit por conta e logs. |
| Tecnicas Gerais | Vulnerability Scanning | P1 | SEC-05, SEC-08 | WAF/DAST/SCA e alertas de scanning. |
| Tecnicas Gerais | Exploitation | P0 | SEC-01, SEC-03, SEC-04, SEC-08 | Corrigir hardening de app/uploads/container/deps. |
| Tecnicas Gerais | Lateral Movement | P1 | SEC-04, SEC-10 | Segmentacao, egress filtering e non-root. |
| Tecnicas Gerais | Persistence | P1 | SEC-04, SEC-06, SEC-11 | EDR, logs imutaveis e container efemero. |
| Tecnicas Gerais | Defense Evasion | P1 | SEC-06, SEC-11 | SIEM/EDR e alertas de log tampering. |
| Tecnicas Gerais | Credential Access | P0 | SEC-02, SEC-06 | MFA, httpOnly e alertas. |
| Tecnicas Gerais | Discovery | P1 | SEC-05, SEC-06 | Rate limit e alertas de varredura autenticada. |
| Tecnicas Gerais | Collection | P1 | SEC-06, SEC-10 | DLP/alertas de consulta/exportacao em massa. |
| Tecnicas Gerais | Command and Control (C2) | P1 | SEC-10, SEC-06 | Egress allowlist e deteccao de conexoes suspeitas. |
| Tecnicas Gerais | Exfiltration | P0 | SEC-06, SEC-10 | Egress filtering, DLP e alertas de volume. |
| Tecnicas Gerais | Impact | P0 | SEC-07, SEC-06 | Backup imutavel, restore testado e incident response. |

## Sequencia Recomendada

1. P0 app: SEC-01, SEC-02, SEC-03.
2. P0 runtime: SEC-04, SEC-07, SEC-08.
3. P0/P1 borda: SEC-05, SEC-09.
4. P1 operacao: SEC-06, SEC-10.
5. P2 escopos externos: SEC-11 a SEC-16 conforme ambiente real.

## Criterio de Aceite Global

- `npm test` passa.
- `npm run lint` passa.
- Security headers verificados em ambiente de staging.
- Login/admin/vendor funcionam sem JWT em `localStorage`.
- Upload malicioso de HTML/SVG/macro executavel e bloqueado ou quarantined.
- Container roda como nao-root com capabilities reduzidas.
- Backup restore testado em ambiente separado.
- WAF/monitoramento/alertas ativos antes de producao publica.
