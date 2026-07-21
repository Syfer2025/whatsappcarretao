# Matriz de Protecao por Ameaca

Data da analise: 2026-07-10.

Escopo analisado: codigo e configuracao presentes neste repositorio (`server.js`, `whatsappManager.js`, `messageSender.js`, `mediaStorage.js`, `audioTranscoder.js`, frontend HTML, Docker e Nginx de exemplo). Isto nao substitui pentest, hardening de VPS, WAF, EDR/antivirus, SIEM, backup offline ou revisao de configuracao real de producao.

Legenda:

- Sim: ha controle explicito e adequado no app para a ameaca.
- Parcial: ha algum controle, mas incompleto ou dependente de configuracao/infra.
- Nao: nao ha protecao explicita relevante no repositorio.
- Fora de escopo: ameaca nao se aplica diretamente a este app web/SaaS no estado atual; deve ser tratada na camada de endpoint, rede, cloud, AD, mobile, blockchain ou operacao.

Principais controles encontrados:

- Autenticacao JWT, bcrypt para senha, `token_version` para revogar tokens, rate limit de login/API/socket.
- `helmet` com CSP, `frame-ancestors`, HSTS em producao, `nosniff` e `Content-Disposition` seguro para midia.
- Cookie `auth_token` `httpOnly` e CSRF token em mutacoes `POST`/`PUT`/`PATCH`/`DELETE`.
- CORS restrito em producao por `CORS_ORIGIN`, `JWT_SECRET` obrigatorio em producao.
- Queries SQLite majoritariamente parametrizadas com `better-sqlite3`.
- Isolamento multi-tenant via diretorio global de usuarios, banco por tenant e `AsyncLocalStorage`.
- Acesso a midia exige autenticacao e autorizacao; rota usa `path.basename`.
- Upload/envio de midia tem limite de tamanho, nomes seguros, allowlist de MIME/extensao, magic-byte validation e scanning opcional por `CLAMSCAN_PATH`.
- Webhook Stripe valida assinatura.
- Docker Compose publica a aplicacao em `127.0.0.1` por padrao; container roda como usuario `node`, com `cap_drop: ALL`, `no-new-privileges`, rootfs read-only, seccomp padrao e limites de CPU/memoria/PIDs/logs.
- Backup local usa a API do SQLite para todos os bancos, copia midia/autenticacao WhatsApp, gera manifesto/checksums e aplica retencao; o deploy cria e verifica um snapshot quiescente depois do build e antes de iniciar a candidata.
- CI roda lint, testes e `npm audit --audit-level=high`; runbook operacional cobre WAF, SIEM, EDR, backup/restore, DNS/e-mail e incidentes.

Gaps importantes encontrados:

- JWT fica em cookie `httpOnly` com `SameSite=Strict`; ainda falta MFA/device binding para reduzir impacto de credenciais roubadas.
- Antivirus depende de `CLAMSCAN_PATH` configurado no ambiente; sem isso ficam a allowlist e magic-byte validation.
- Chromium fica com sandbox habilitado e seccomp padrao; o host ainda precisa permitir user namespaces nao privilegiados.
- WAF, IDS/IPS, DDoS protection, EDR, SIEM, DLP, copia de backup offsite/imutavel e egress filtering foram documentados no runbook, mas precisam ser implantados na infraestrutura real.

| Categoria | Ameaca | Estamos protegidos? | Evidencia / observacao |
|---|---|---:|---|
| Malware | Malware | Parcial | App limita upload, valida MIME/extensao/magic bytes e suporta ClamAV via `CLAMSCAN_PATH`; EDR/sandbox dependem da infra. |
| Malware | Virus | Parcial | Scanning de anexos existe via `CLAMSCAN_PATH`, mas precisa ClamAV/servico AV configurado. |
| Malware | Worm | Fora de escopo | Depende de host/rede/endpoint; app nao tem controle especifico. |
| Malware | Trojan (Cavalo de Troia) | Parcial | Anexos sao validados e podem ser escaneados; EDR/analise de comportamento dependem da operacao. |
| Malware | Backdoor | Parcial | Auth/roles reduzem abuso, mas sem EDR, integridade de binarios ou monitoramento. |
| Malware | Rootkit | Fora de escopo | Camada de sistema operacional/EDR. |
| Malware | Bootkit | Fora de escopo | Camada de firmware/endpoint. |
| Malware | Ransomware | Parcial | Ha snapshot consistente local e pre-deploy; copia offsite imutavel, EDR e protecao de escrita dependem da operacao. |
| Malware | Wiper | Parcial | Ha backup/manifesto/retencao local; imutabilidade offsite e monitoramento de destruicao dependem da infraestrutura. |
| Malware | Spyware | Nao | Sem protecao endpoint/browser contra spyware. |
| Malware | Adware | Fora de escopo | Endpoint/navegador do usuario. |
| Malware | Keylogger | Fora de escopo | Endpoint do usuario/servidor. |
| Malware | Infostealer | Parcial | Segredos via env, log redaction e cookie `httpOnly`; ainda falta secret manager e DLP/EDR. |
| Malware | Banker Trojan | Fora de escopo | Endpoint/usuario. |
| Malware | RAT (Remote Access Trojan) | Fora de escopo | Endpoint/servidor; nao ha EDR. |
| Malware | Bot | Parcial | Rate limits reduzem automacao contra API/login; sem bot management/WAF. |
| Malware | Botnet malware | Parcial | Rate limits e bind local no Compose ajudam; sem DDoS/bot protection real. |
| Malware | Cryptominer (Cryptojacking malware) | Nao | Sem CSP forte, EDR ou resource monitoring especifico. |
| Malware | Logic Bomb | Fora de escopo | Requer controle de integridade, revisao e CI/CD; nao evidente no repo. |
| Malware | Fileless Malware | Fora de escopo | Host/EDR. |
| Malware | Dropper | Parcial | Uploads perigosos sao bloqueados por allowlist/magic bytes e podem passar por AV; egress filtering segue operacional. |
| Malware | Downloader | Parcial | Scanning de anexos foi adicionado; egress filtering segue operacional. |
| Malware | Scareware | Fora de escopo | Conteudo/social engineering. |
| Malware | Mobile Malware | Fora de escopo | App nao e mobile nativo. |
| Engenharia Social | Phishing | Nao | Sem anti-phishing, DMARC ou treinamento no repo. |
| Engenharia Social | Spear Phishing | Nao | Controle operacional/e-mail, nao implementado aqui. |
| Engenharia Social | Whaling | Nao | Controle operacional. |
| Engenharia Social | Clone Phishing | Nao | Controle de e-mail/dominio. |
| Engenharia Social | Smishing (SMS) | Fora de escopo | Canal SMS nao existe no app. |
| Engenharia Social | Vishing (voz) | Fora de escopo | Processo humano/telefone. |
| Engenharia Social | Quishing (QR Code) | Parcial | QR de WhatsApp fica atras de auth admin, mas nao ha educacao/validacao anti-fraude. |
| Engenharia Social | Angler Phishing | Nao | Processo de atendimento/redes sociais. |
| Engenharia Social | Business Email Compromise (BEC) | Nao | Sem controles de e-mail. |
| Engenharia Social | CEO Fraud | Nao | Sem workflow de aprovacao/validacao de ordens. |
| Engenharia Social | Pretexting | Nao | Processo humano. |
| Engenharia Social | Baiting | Nao | Processo humano/endpoint. |
| Engenharia Social | Quid Pro Quo | Nao | Processo humano. |
| Engenharia Social | Tailgating | Fora de escopo | Fisico. |
| Engenharia Social | Piggybacking | Fora de escopo | Fisico. |
| Engenharia Social | Shoulder Surfing | Fora de escopo | Fisico/usuario. |
| Engenharia Social | Dumpster Diving | Fora de escopo | Fisico/operacional. |
| Engenharia Social | Honey Trap | Fora de escopo | Processo humano. |
| Engenharia Social | Watering Hole | Parcial | TLS/CORS/CSP ajudam, mas ainda faltam SRI e monitoramento completo de supply chain. |
| Ataques de Senhas | Brute Force | Parcial | `loginLimiter` limita tentativas; sem MFA/CAPTCHA/bloqueio por conta. |
| Ataques de Senhas | Dictionary Attack | Parcial | Rate limit e bcrypt; politica de senha e minima, sem lista de senhas vazadas. |
| Ataques de Senhas | Password Spraying | Parcial | Rate limit por IP; sem detecao por conta/tenant/MFA. |
| Ataques de Senhas | Credential Stuffing | Parcial | Rate limit; sem MFA, device fingerprint ou deteccao de credenciais vazadas. |
| Ataques de Senhas | Credential Cracking | Parcial | Bcrypt protege hashes; custo fixo e sem Argon2id/auditoria de custo. |
| Ataques de Senhas | Rainbow Table Attack | Sim | Bcrypt com salt por hash. |
| Ataques de Senhas | Password Guessing | Parcial | Rate limit e bcrypt; senha minima de 6 caracteres e fraca. |
| Ataques de Senhas | Pass-the-Hash | Fora de escopo | Nao usa NTLM/AD. |
| Ataques de Senhas | Pass-the-Ticket | Fora de escopo | Nao usa Kerberos. |
| Ataques de Senhas | Kerberoasting | Fora de escopo | Nao usa Kerberos/AD. |
| Ataques de Senhas | AS-REP Roasting | Fora de escopo | Nao usa Kerberos/AD. |
| Ataques Web | SQL Injection (SQLi) | Sim | Uso amplo de prepared statements (`db.prepare(...).get/run/all`). |
| Ataques Web | Blind SQL Injection | Sim | Mesma mitigacao de SQLi parametrizado. |
| Ataques Web | Time-based SQLi | Sim | Mesma mitigacao de SQLi parametrizado. |
| Ataques Web | Error-based SQLi | Sim | Mesma mitigacao de SQLi parametrizado; ainda revisar mensagens de erro. |
| Ataques Web | NoSQL Injection | Fora de escopo | Nao ha banco NoSQL. |
| Ataques Web | LDAP Injection | Fora de escopo | Nao ha LDAP. |
| Ataques Web | XPath Injection | Fora de escopo | Nao ha XPath/XML query. |
| Ataques Web | Command Injection | Parcial | `execFile` com argumentos fixos no ffmpeg; sem shell, mas `FFMPEG_PATH` e binario devem ser confiaveis. |
| Ataques Web | Code Injection | Parcial | Sem `eval`/templates server-side, mas XSS e dependencias ainda importam. |
| Ataques Web | OS Command Injection | Parcial | `execFile` reduz risco; sem shell. |
| Ataques Web | Server-Side Template Injection (SSTI) | Fora de escopo | Nao ha template engine server-side. |
| Ataques Web | XML Injection | Fora de escopo | Nao processa XML. |
| Ataques Web | XXE (XML External Entity) | Fora de escopo | Nao processa XML. |
| Ataques Web | Cross-Site Scripting (XSS) | Parcial | Frontend usa `escapeHtml` em muitos pontos e CSP reduz impacto, mas ainda ha muito `innerHTML` e sem sanitizacao central. |
| Ataques Web | Stored XSS | Parcial | Mensagens/nomes escapados em muitos renders e CSP ativo; ainda falta sanitizacao central no backend. |
| Ataques Web | Reflected XSS | Parcial | Pouco reflexo direto; security headers/CSP foram adicionados. |
| Ataques Web | DOM-based XSS | Parcial | Uso intenso de `innerHTML`; ha escaping manual e CSP, mas nao ha DOMPurify. |
| Ataques Web | Cross-Site Request Forgery (CSRF) | Sim | Mutacoes `/api` exigem double-submit CSRF token; login/register/reset/webhook sao excecoes intencionais. |
| Ataques Web | Cross-Site Leak (XS-Leaks) | Parcial | CORS restrito e headers/CSP ajudam; COOP/CORP completo ainda deve ser validado com Socket.IO/media. |
| Ataques Web | Cross-Origin Attacks | Parcial | CORS restrito em producao e headers modernos foram adicionados. |
| Ataques Web | HTTP Parameter Pollution | Parcial | Uso simples de query/body; sem normalizacao explicita de arrays/parametros duplicados. |
| Ataques Web | HTTP Request Smuggling | Fora de escopo | Depende de proxy/HTTP stack; nao mitigado explicitamente. |
| Ataques Web | HTTP Response Splitting | Parcial | Express reduz risco; revisar valores refletidos em headers/redirects. |
| Ataques Web | Host Header Injection | Parcial | `APP_URL` existe, mas fallback usa `req.get('host')` para Stripe URLs; depende de proxy confiavel. |
| Ataques Web | CRLF Injection | Parcial | Pouca manipulacao manual de headers; sem validacao central. |
| Ataques Web | Clickjacking | Sim | `helmet` e CSP `frame-ancestors 'none'` bloqueiam framing. |
| Ataques Web | Open Redirect | Parcial | Nao ha redirect generico; URLs Stripe externas sao retornadas por API. Revisar qualquer URL dinamica futura. |
| Ataques Web | Local File Inclusion (LFI) | Sim | Midia usa `path.basename` e `sendFile` em diretorio fixo. |
| Ataques Web | Remote File Inclusion (RFI) | Fora de escopo | Nao inclui arquivos remotos. |
| Ataques Web | Directory Traversal | Sim | Rota `/media/:filename` rejeita path com barras e usa basename. |
| Ataques Web | Path Traversal | Sim | Mesmo controle de basename/diretorio fixo. |
| Ataques Web | Arbitrary File Upload | Parcial | Limite de tamanho, nome seguro, allowlist MIME/extensao e magic-byte validation; antivirus depende de `CLAMSCAN_PATH`. |
| Ataques Web | File Inclusion | Sim | Nao ha inclusao dinamica baseada em usuario; midia limitada. |
| Ataques Web | Session Fixation | Parcial | JWT novo no login, revogacao por `token_version` e cookie `httpOnly`; ainda falta MFA. |
| Ataques Web | Session Hijacking | Parcial | JWT assinado, SameSite, cookie `httpOnly` e CSRF; risco residual sem MFA/device binding. |
| Ataques Web | Cookie Poisoning | Parcial | JWT assinado impede adulteracao valida; cookie agora e `httpOnly`. |
| Ataques Web | Insecure Deserialization | Parcial | JSON padrao; sem desserializacao de classes, mas entradas JSON nao tem schema validation forte. |
| Ataques Web | Prototype Pollution | Parcial | Sem merge profundo evidente, mas objetos de `req.body` entram em alguns fluxos; sem sanitizacao de `__proto__`. |
| Ataques Web | Mass Assignment | Parcial | Muitas rotas selecionam campos manualmente; revisar `settings` e updates dinamicos. |
| Ataques Web | Race Condition | Parcial | SQLite transacoes em alguns pontos; sem locks/idempotencia completa para todos fluxos. |
| Ataques Web | Business Logic Abuse | Parcial | Ha roles, tenant scoping e billing block; regras de negocio ainda precisam testes/pentest. |
| Ataques Web | API Abuse | Parcial | Auth, roles e rate limit global; sem quotas por tenant/usuario em todas rotas. |
| Ataques Web | GraphQL Injection | Fora de escopo | Nao ha GraphQL. |
| Ataques Web | SSRF (Server-Side Request Forgery) | Parcial | Nao ha fetch arbitrario do usuario; dependencias WhatsApp/Stripe fazem chamadas externas. Sem egress policy. |
| Ataques de Rede | DoS | Parcial | Rate limit e limites de body; sem protecao de infra. |
| Ataques de Rede | DDoS | Nao | Requer CDN/WAF/scrubbing; nao presente. |
| Ataques de Rede | SYN Flood | Fora de escopo | Camada TCP/kernel/provedor. |
| Ataques de Rede | UDP Flood | Fora de escopo | Camada rede/provedor. |
| Ataques de Rede | ICMP Flood | Fora de escopo | Camada rede/provedor. |
| Ataques de Rede | HTTP Flood | Parcial | `apiLimiter`/`loginLimiter`; sem WAF/CDN. |
| Ataques de Rede | Slowloris | Parcial | Node/proxy podem sofrer; Nginx exemplo tem timeouts, mas sem config especifica anti-Slowloris. |
| Ataques de Rede | Ping Flood | Fora de escopo | Rede/provedor. |
| Ataques de Rede | Ping of Death | Fora de escopo | Kernel/rede. |
| Ataques de Rede | Smurf Attack | Fora de escopo | Rede/provedor. |
| Ataques de Rede | Fraggle Attack | Fora de escopo | Rede/provedor. |
| Ataques de Rede | Teardrop Attack | Fora de escopo | Kernel/rede. |
| Ataques de Rede | LAND Attack | Fora de escopo | Kernel/rede. |
| Ataques de Rede | Amplification Attack | Fora de escopo | Rede/provedor. |
| Ataques de Rede | Reflection Attack | Fora de escopo | Rede/provedor. |
| Ataques de Rede | DNS Amplification | Fora de escopo | DNS/provedor. |
| Ataques de Rede | NTP Amplification | Fora de escopo | NTP/provedor. |
| Ataques de Rede | Memcached Amplification | Fora de escopo | Infra; app nao expõe memcached. |
| Ataques de Rede | ARP Spoofing | Fora de escopo | LAN. |
| Ataques de Rede | ARP Poisoning | Fora de escopo | LAN. |
| Ataques de Rede | IP Spoofing | Fora de escopo | Rede/provedor. |
| Ataques de Rede | DNS Spoofing | Parcial | TLS no Nginx exemplo ajuda detectar spoofing; sem DNSSEC/HSTS. |
| Ataques de Rede | DNS Cache Poisoning | Parcial | TLS ajuda; DNSSEC/HSTS nao configurados no repo. |
| Ataques de Rede | DHCP Spoofing | Fora de escopo | LAN. |
| Ataques de Rede | MAC Flooding | Fora de escopo | Switch/LAN. |
| Ataques de Rede | CAM Table Overflow | Fora de escopo | Switch/LAN. |
| Ataques de Rede | VLAN Hopping | Fora de escopo | Switch/LAN. |
| Ataques de Rede | STP Attack | Fora de escopo | Switch/LAN. |
| Ataques de Rede | Routing Attack | Fora de escopo | Roteamento/infra. |
| Ataques de Rede | BGP Hijacking | Fora de escopo | Provedor/rede. |
| Ataques de Rede | Route Injection | Fora de escopo | Rede/provedor. |
| Interceptacao | Interceptacao | Parcial | Nginx exemplo usa HTTPS; app depende de deploy correto. |
| Interceptacao | Man-in-the-Middle (MitM) | Parcial | TLS no Nginx exemplo e HSTS via `helmet` em producao; depende do deploy correto. |
| Interceptacao | Man-in-the-Browser (MitB) | Nao | Endpoint/browser do usuario. |
| Interceptacao | Evil Twin | Fora de escopo | Wi-Fi/usuario. |
| Interceptacao | Rogue Access Point | Fora de escopo | Wi-Fi/usuario. |
| Interceptacao | SSL Stripping | Parcial | Redirect HTTP para HTTPS no Nginx e HSTS via app em producao; depende do proxy/CDN. |
| Interceptacao | HTTPS Downgrade | Parcial | TLS 1.2/1.3 no Nginx e HSTS via app em producao; depende do deploy. |
| Interceptacao | TLS Downgrade | Parcial | Nginx restringe TLS 1.2/1.3; depende do deploy. |
| Interceptacao | Packet Sniffing | Parcial | HTTPS protege trafego externo; nao cobre host/LAN sem TLS. |
| Interceptacao | Session Replay | Parcial | JWT tem expiracao e revogacao por versao; sem nonce/replay detection. |
| Interceptacao | Replay Attack | Parcial | Idempotencia limitada; webhook Stripe valida assinatura, demais APIs nao tem nonce. |
| Wi-Fi | Deauthentication Attack | Fora de escopo | Wi-Fi. |
| Wi-Fi | Beacon Flood | Fora de escopo | Wi-Fi. |
| Wi-Fi | Evil Twin Wi-Fi | Fora de escopo | Wi-Fi/usuario. |
| Wi-Fi | Rogue AP | Fora de escopo | Wi-Fi/usuario. |
| Wi-Fi | WPA Handshake Capture | Fora de escopo | Wi-Fi. |
| Wi-Fi | PMKID Attack | Fora de escopo | Wi-Fi. |
| Wi-Fi | WPS PIN Attack | Fora de escopo | Wi-Fi. |
| Wi-Fi | KRACK | Fora de escopo | Wi-Fi/cliente. |
| Wi-Fi | Wi-Fi Jamming | Fora de escopo | Wi-Fi. |
| DNS | DNS Hijacking | Parcial | HTTPS ajuda; sem DNSSEC/monitoramento de dominio. |
| DNS | DNS Tunneling | Fora de escopo | Rede/egress filtering. |
| DNS | DNS Poisoning | Parcial | HTTPS ajuda; sem DNSSEC/HSTS. |
| DNS | NXDOMAIN Attack | Fora de escopo | DNS/provedor. |
| DNS | Domain Shadowing | Fora de escopo | Gestao de DNS/dominio. |
| DNS | Fast Flux | Fora de escopo | DNS/reputacao. |
| E-mail | Email Spoofing | Nao | Repo nao configura SPF/DKIM/DMARC. |
| E-mail | Email Bombing | Parcial | Rate limit HTTP; sem rate/abuse control especifico para envio de e-mail. |
| E-mail | Attachment Malware | Parcial | Anexos sao validados por allowlist/magic bytes e podem ser escaneados via `CLAMSCAN_PATH`. |
| E-mail | Malicious Macro | Parcial | Arquivos Office macro-enabled nao estao na allowlist e `vbaProject.bin` e bloqueado; AV ainda depende de configuracao. |
| E-mail | Thread Hijacking | Fora de escopo | E-mail/operacao. |
| Sistemas | Privilege Escalation | Parcial | Roles no app, container nao-root, capabilities removidas e Chromium sandbox habilitado por padrao. |
| Sistemas | Local Privilege Escalation | Parcial | Container roda como `node`, `cap_drop: ALL`, `no-new-privileges` e rootfs read-only; host/EDR ainda operacional. |
| Sistemas | Remote Privilege Escalation | Parcial | Auth e validações reduzem superficie; sem WAF/patch policy evidenciada. |
| Sistemas | Zero-Day Exploit | Parcial | Lockfile e dependencias; sem WAF/EDR/virtual patching. |
| Sistemas | N-Day Exploit | Parcial | `package-lock`, `npm ci` e `npm audit --audit-level=high` no CI; ainda falta SCA/Dependabot/Renovate formal. |
| Sistemas | Buffer Overflow | Parcial | JS reduz risco no codigo proprio; Chromium/ffmpeg/native deps ainda expostos. |
| Sistemas | Heap Overflow | Parcial | Mesmo caso de dependencias nativas. |
| Sistemas | Stack Overflow | Parcial | Mesmo caso de dependencias nativas. |
| Sistemas | Integer Overflow | Parcial | Mesmo caso de dependencias nativas. |
| Sistemas | Format String Attack | Fora de escopo | JS app; dependencias nativas podem ter risco. |
| Sistemas | Memory Corruption | Parcial | Possivel em Chromium/ffmpeg/native deps; mitigado por sandbox do Chromium e container, mas exige atualizacao continua. |
| Sistemas | Use-After-Free | Parcial | Risco em Chromium/native deps; mitigado por sandbox do Chromium e container, mas exige atualizacao continua. |
| Sistemas | Double Free | Parcial | Risco em native deps; mitigado por sandbox do Chromium e container, mas exige atualizacao continua. |
| Sistemas | Race Condition Exploit | Parcial | Algumas transacoes; sem revisao formal de concorrencia. |
| Aplicacoes | Reverse Shell | Parcial | Sem endpoint de comando; se RCE ocorrer, container nao-root/cap-drop reduzem impacto. |
| Aplicacoes | Web Shell | Parcial | Upload nao executa arquivos e anexos sao validados/escaneaveis; container nao-root reduz impacto. |
| Aplicacoes | Remote Code Execution (RCE) | Parcial | Sem eval/SSTI; ffmpeg/Chromium/deps ainda sao superficie, mitigada por container hardening. |
| Aplicacoes | Local Code Execution | Parcial | Container hardening aplicado; host/EDR/seccomp/AppArmor continuam operacionais. |
| Aplicacoes | Sandbox Escape | Parcial | Chromium sandbox habilitado por padrao; ainda exige atualizacoes de Chromium e monitoramento de CVEs. |
| Aplicacoes | Container Escape | Parcial | Dockerfile usa `USER node`; Compose tem `cap_drop: ALL`, `no-new-privileges`, rootfs read-only e o seccomp padrao. O deploy testa o Chromium com essas mesmas restricoes antes da parada; o host ainda precisa permitir o sandbox por user namespace. |
| Aplicacoes | VM Escape | Fora de escopo | Virtualizador/cloud. |
| Active Directory | Golden Ticket | Fora de escopo | Nao usa AD/Kerberos. |
| Active Directory | Silver Ticket | Fora de escopo | Nao usa AD/Kerberos. |
| Active Directory | DCShadow | Fora de escopo | Nao usa AD. |
| Active Directory | DCSync | Fora de escopo | Nao usa AD. |
| Active Directory | Skeleton Key | Fora de escopo | Nao usa AD. |
| Active Directory | Kerberoasting | Fora de escopo | Nao usa Kerberos. |
| Active Directory | AS-REP Roasting | Fora de escopo | Nao usa Kerberos. |
| Active Directory | NTLM Relay | Fora de escopo | Nao usa NTLM. |
| Active Directory | LDAP Relay | Fora de escopo | Nao usa LDAP. |
| Nuvem | Cloud Misconfiguration Abuse | Fora de escopo | Repo local/Docker; depende do provedor. |
| Nuvem | Metadata Service Attack | Fora de escopo | Nao ha cloud metadata no repo; precisa firewall/IMDSv2 se em cloud. |
| Nuvem | IAM Abuse | Fora de escopo | Sem IAM cloud no repo. |
| Nuvem | Token Theft | Parcial | JWT em cookie `httpOnly` e env secrets existem; sem secret manager/egress monitoring. |
| Nuvem | Bucket Takeover | Fora de escopo | Sem bucket no repo. |
| Nuvem | Serverless Abuse | Fora de escopo | Nao serverless. |
| Nuvem | Container Breakout | Nao | Sem hardening de container. |
| Blockchain/Cripto | 51% Attack | Fora de escopo | Nao usa blockchain. |
| Blockchain/Cripto | Double Spending | Fora de escopo | Nao usa blockchain. |
| Blockchain/Cripto | Rug Pull | Fora de escopo | Nao usa token/cripto. |
| Blockchain/Cripto | Smart Contract Exploit | Fora de escopo | Nao usa smart contracts. |
| Blockchain/Cripto | Flash Loan Attack | Fora de escopo | Nao usa DeFi. |
| Blockchain/Cripto | Wallet Drainer | Fora de escopo | Nao usa carteiras. |
| Blockchain/Cripto | Clipboard Hijacking | Fora de escopo | Endpoint/usuario. |
| IoT | IoT Botnet | Fora de escopo | Nao e IoT. |
| IoT | Firmware Exploit | Fora de escopo | Nao e firmware. |
| IoT | Default Credential Attack | Parcial | Admin default exige `ADMIN_PASSWORD` em producao, mas `ADMIN_USERNAME` default e `admin`. |
| IoT | Device Takeover | Fora de escopo | Nao e dispositivo IoT. |
| Cadeia de Suprimentos | Supply Chain Attack | Parcial | `package-lock`/`npm ci`; sem SCA, assinatura de artefatos ou pinning de imagem por digest. |
| Cadeia de Suprimentos | Dependency Confusion | Parcial | Usa npm publico e lockfile; sem registry privado/scopes travados. |
| Cadeia de Suprimentos | Typosquatting | Parcial | Lockfile reduz mudanca acidental; sem ferramenta de deteccao. |
| Cadeia de Suprimentos | Package Poisoning | Parcial | Lockfile ajuda; sem audit/assinatura/provenance. |
| Cadeia de Suprimentos | Malicious Update | Parcial | Lockfile segura versoes instaladas; updates futuros precisam SCA/review. |
| Cadeia de Suprimentos | Library Hijacking | Parcial | Node resolution padrao; sem integridade runtime alem de lockfile. |
| Persistencia/Evasao | Living off the Land (LotL) | Nao | Sem EDR, allowlisting ou restricao de binarios; ffmpeg/chromium presentes. |
| Persistencia/Evasao | Process Injection | Fora de escopo | Host/EDR. |
| Persistencia/Evasao | DLL Hijacking | Fora de escopo | Principalmente Windows/host. |
| Persistencia/Evasao | DLL Side-Loading | Fora de escopo | Principalmente Windows/host. |
| Persistencia/Evasao | Reflective DLL Injection | Fora de escopo | Windows/host. |
| Persistencia/Evasao | Process Hollowing | Fora de escopo | Host/EDR. |
| Persistencia/Evasao | Thread Injection | Fora de escopo | Host/EDR. |
| Persistencia/Evasao | Code Cave Injection | Fora de escopo | Host/EDR. |
| Persistencia/Evasao | AMSI Bypass | Fora de escopo | Windows/PowerShell. |
| Persistencia/Evasao | UAC Bypass | Fora de escopo | Windows endpoint. |
| Persistencia/Evasao | Defense Evasion | Nao | Sem EDR/SIEM/hardening. |
| Persistencia/Evasao | Log Tampering | Parcial | Logs estruturados, mas sem envio imutavel/SIEM/WORM. |
| Coleta de Dados | Data Exfiltration | Parcial | Auth/tenant scoping; sem DLP, egress filtering ou alertas de volume. |
| Coleta de Dados | Screen Capture Malware | Fora de escopo | Endpoint. |
| Coleta de Dados | Clipboard Theft | Fora de escopo | Endpoint/browser. |
| Coleta de Dados | Browser Credential Theft | Parcial | Senhas nao ficam no app e cookie e `httpOnly`; ainda falta MFA/device binding. |
| Coleta de Dados | Cookie Theft | Parcial | Cookie `httpOnly`, SameSite e CSP reduzem roubo; risco residual via endpoint comprometido ou session riding. |
| Coleta de Dados | Token Theft | Parcial | JWT em cookie `httpOnly`; sem MFA ou device binding. |
| Coleta de Dados | Session Token Hijacking | Parcial | Token assinado e revogavel; armazenamento no browser e XSS seguem risco. |
| Mobile | SIM Swapping | Fora de escopo | Nao usa SMS como fator. |
| Mobile | Mobile RAT | Fora de escopo | Dispositivo do usuario. |
| Mobile | Overlay Attack | Fora de escopo | App mobile. |
| Mobile | SMS Interception | Fora de escopo | Sem SMS. |
| Mobile | Accessibility Abuse | Fora de escopo | App mobile/Android. |
| Mobile | NFC Relay Attack | Fora de escopo | Sem NFC. |
| Fisicos | BadUSB | Fora de escopo | Fisico/endpoint. |
| Fisicos | Rubber Ducky Attack | Fora de escopo | Fisico/endpoint. |
| Fisicos | Hardware Keylogger | Fora de escopo | Fisico/endpoint. |
| Fisicos | Cold Boot Attack | Fora de escopo | Fisico/host. |
| Fisicos | DMA Attack | Fora de escopo | Fisico/host. |
| Fisicos | USB Drop Attack | Fora de escopo | Fisico/endpoint. |
| IA | Deepfake Phishing | Nao | Processo humano; sem verificacao de identidade. |
| IA | Voice Cloning Attack | Nao | Processo humano/atendimento. |
| IA | AI-assisted Phishing | Nao | Processo humano/e-mail. |
| IA | Prompt Injection (contra sistemas de IA) | Fora de escopo | Nao ha LLM/agent no app atual. |
| IA | Indirect Prompt Injection | Fora de escopo | Nao ha LLM/agent no app atual. |
| IA | Model Poisoning | Fora de escopo | Sem modelo treinado/serving. |
| IA | Data Poisoning | Fora de escopo | Sem pipeline de treino de IA. |
| IA | Model Extraction | Fora de escopo | Sem modelo proprio exposto. |
| IA | Membership Inference | Fora de escopo | Sem modelo proprio exposto. |
| IA | Adversarial Examples | Fora de escopo | Sem modelo ML/IA no fluxo. |
| Tecnicas Gerais | Reconnaissance | Parcial | Rotas exigem auth; `/health` publico revela uptime/status basico. |
| Tecnicas Gerais | Footprinting | Parcial | Headers de Express podem revelar stack se nao removidos; sem hardening de headers. |
| Tecnicas Gerais | Fingerprinting | Parcial | Security headers foram adicionados, mas Express/Socket.IO seguem identificaveis e sem camada WAF/bot. |
| Tecnicas Gerais | Enumeration | Parcial | Login usa erro generico; reset nao revela usuario. Algumas rotas admin listam dados com auth. |
| Tecnicas Gerais | Vulnerability Scanning | Nao | Nao ha WAF/IDS para bloquear scanners; deve existir SCA/DAST no CI. |
| Tecnicas Gerais | Exploitation | Parcial | Controles basicos existem; gaps de headers, container e XSS/CSRF permanecem. |
| Tecnicas Gerais | Lateral Movement | Parcial | Isolamento por tenant no app; container/host sem hardening suficiente. |
| Tecnicas Gerais | Persistence | Nao | Sem EDR, integridade, deteccao de persistencia no host/container. |
| Tecnicas Gerais | Defense Evasion | Nao | Sem EDR/SIEM. |
| Tecnicas Gerais | Credential Access | Parcial | Bcrypt, JWT assinado e cookie `httpOnly`; ainda falta MFA/device binding. |
| Tecnicas Gerais | Discovery | Parcial | Auth limita dados internos; sem deteccao de varredura autenticada. |
| Tecnicas Gerais | Collection | Parcial | RBAC/tenant scoping; sem DLP/alertas de coleta em massa. |
| Tecnicas Gerais | Command and Control (C2) | Nao | Sem egress filtering, IDS ou deteccao C2. |
| Tecnicas Gerais | Exfiltration | Parcial | Auth/tenant scoping; sem DLP, egress filtering, anomalia ou rate por exportacao. |
| Tecnicas Gerais | Impact | Parcial | Auth/roles, limites de container e backup local existem; DR testado e backup imutavel/offsite dependem da operacao. |
