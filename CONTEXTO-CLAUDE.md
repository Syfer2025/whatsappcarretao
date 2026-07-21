# Contexto para o Claude Code — WhatsCarretao

> Documento de handoff. Ao abrir o Claude Code no PC Windows, diga: **"leia o CONTEXTO-CLAUDE.md"** que eu retomo daqui.
> Última atualização: 2026-07-21 (sessão feita no Mac).

---

## 1. O que é este projeto

- **WhatsCarretao** = sistema interno de atendimento via WhatsApp da **Auto Peças Carretão**.
- É um **fork** do produto comercial "WhatsApp AI" (original local em `/Users/alexmeiradossantos/whatsa-ai-comercial`; produção do comercial roda em **cloudbird.com.br**). O fork foi feito pelo GPT.
- Roda em **modo edição interna** (`APP_MODE=internal` no `.env`): páginas de SaaS (`index/register/forgot-password/settings/superadmin`) retornam 404; só valem `login.html`, `admin.html`, `vendor.html`.
- Stack: **Node.js (>=22 <25)** + Express + Socket.IO + **better-sqlite3** (banco embutido, sem servidor de BD) + **whatsapp-web.js 1.34.7** (via puppeteer/Chrome headless) + FFmpeg (áudio).
- Porta padrão: **3100**. Escuta em todas as interfaces (`*:3100`).

## 2. Estado atual (no Mac)

- Servidor rodando (PID observado 47944) na porta 3100, **preso a um terminal** (por isso "cai" quando fecha o terminal / o Mac dorme).
- Chrome headless conectado, sessão WhatsApp `tenant_1` em `READY`.
- **NÃO é um app de janela** — usa-se pelo navegador (`http://localhost:3100`). O **QR aparece na tela** admin → aba **Conexão**.

## 3. Trabalho já concluído nesta sessão — Logomarcas ✅

Corrigidas logos mal aplicadas. Assets em `frontend/assets/`:
- `carretao-logo.svg` — lockup completo p/ **fundo claro** (cavalo escuro + wordmark vermelho + AUTO PEÇAS). Usado no login (tema claro).
- `carretao-logo-dark.svg` — lockup completo p/ **fundo escuro** (cavalo branco). Login (tema escuro).
- `carretao-wordmark.svg` — só o wordmark "carretão" vermelho. Sidebars de admin/vendor.
- `carretao-mark.svg` — emblema do cavalo vermelho, quadrado. **Favicon** de todas as páginas.
- `login.html` troca logo claro/escuro conforme o tema; `admin.html`/`vendor.html` usam o wordmark no sidebar.
- Original do logo: `brand/logo-original.pdf`.

## 4. PROBLEMA EM ABERTO — Sincronização de conversas 🔴

**Sintoma:** conversas pararam de sincronizar; mensagens não aparecem.

**Causa raiz (confirmada):** o `whatsapp-web.js 1.34.7` (já é a versão mais nova que existe) carregou a versão **`2.3000.1043545460`** do WhatsApp Web — nova demais, quebra o parsing. Toda mensagem recebida chega como `type: 'revoked'` e o importador grava como **"Mensagem apagada"** (`historyImporter.js:525`) em vez do conteúdo real.

**Provas:**
- `data/data_1.db`: 19 de 19 mensagens de cliente estão como `revoked`; nenhuma mensagem real de entrada foi salva.
- `conversation_sync_state` mostra buscar 48–50 msgs por conversa e importar ~0.
- `WA_WEB_VERSION` **não está fixada** (nem aqui, nem no comercial).
- Arquivos de sync (`whatsappManager.js`, `historyImporter.js`, `whatsappUtils.js`, `messageQueries.js`, `messageActions.js`) são **byte a byte idênticos** ao comercial → não é bug do fork, é a versão do WhatsApp Web.
- `whatsappManager.js:441` documenta exatamente esse cenário e a solução (pinar `WA_WEB_VERSION`).

**Correção planejada (o usuário quer reescanear o QR e ver as mensagens sincronizando):**
1. Backup do `data/` primeiro.
2. Fixar no `.env`: `WA_WEB_VERSION=2.3000.1043545460` → **trocar por uma versão boa**, ex.: `2.3000.1043191242` (última que o comercial rodava bem, 15/jul).
3. Copiar o HTML dessa versão de `whatsa-ai-comercial/.wwebjs_cache/2.3000.1043191242.html` para `.wwebjs_cache/` deste projeto (senão, com `strict:false`, o wwebjs cai de novo na versão quebrada). **Só copiar do comercial — não modificar nada lá.**
4. Limpar a sessão (`.wwebjs_auth/tenant_1`) → gera QR novo; limpar as 19 mensagens "apagada" + o `conversation_sync_state` → reimporta o conteúdo real.
5. Reiniciar → abrir admin → Conexão → **escanear QR** → histórico entra correto.
6. **Verificar depois do restart** qual versão o wwebjs realmente carregou (com `strict:false` ele pode cair silenciosamente na versão quebrada) e se mensagens novas param de vir como "revoked".

> Obs.: a mesma correção (pinar `WA_WEB_VERSION`) deve ser aplicada no **cloudbird** também, senão o problema volta lá quando o WhatsApp atualizar.

## 5. Migração para o servidor Windows (onde já roda o ERP SIGE)

**Instalar no Windows:**
1. **Node.js 22 LTS** (64-bit) — inclui npm. (Não usar 25+.)
2. **Google Chrome** (64-bit) → `.env`: `CHROME_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`
   (o auto-detect do Windows em `whatsappManager.js:502` está com o caminho errado.)
3. **FFmpeg** (build Windows) → `.env`: `FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe` (necessário p/ áudio/voz).
4. Para ficar 24/7: rodar como **Serviço do Windows** via **NSSM** (ou **PM2** com `pm2 startup`/`pm2 save`) + máquina configurada p/ **não dormir**.
5. **Só se `npm install` falhar** no `better-sqlite3` (módulo nativo): Visual Studio Build Tools (C++) + Python 3.

**Ao copiar o projeto pro Windows:**
- **NÃO copiar `node_modules`** (binários nativos do Mac — better-sqlite3/Chromium). Rodar **`npm ci`** no Windows.
- **NÃO copiar `.wwebjs_auth`** → reescaneia o QR no Windows (é o que se quer).
- `data/`: se quiser manter histórico, copiar — mas está com mensagens corrompidas (ver seção 4).
- `.env`: ajustar caminhos pro Windows (Chrome, FFmpeg) e manter `APP_MODE=internal`, `PORT=3100`.

**Acesso de vendedores em outros estados (precisa internet):**
- IP interno só funciona na LAN. Para acesso remoto → **Cloudflare Tunnel** + subdomínio do domínio que já possuem (`autopecascarretao.com.br`), ex.: `atendimento.autopecascarretao.com.br`. HTTPS automático, sem abrir porta no roteador, sem IP fixo. É o padrão que o cloudbird usa.
- Alternativa sem domínio: **Tailscale** (cada vendedor instala um app; rede privada).
- `.com` vs `.com.br`: tanto faz tecnicamente; usar subdomínio do `.com.br` que já têm.

## 6. Pendências / próximas decisões

- [ ] Aplicar a correção do sync (seção 4) — no Mac agora, ou já direto no Windows.
- [ ] Confirmar qual `WA_WEB_VERSION` o cloudbird usa (para pinar a mesma versão de produção que funciona).
- [ ] Montar `.env` de Windows + serviço NSSM + Cloudflare Tunnel.
- [ ] Recuperar as 19 mensagens corrompidas (limpar linhas "revoked" + reimportar).

## 7. Como me dar contexto + acesso no Windows

1. Instalar o **Claude Code** no PC Windows (CLI via instalador oficial / `npm i -g @anthropic-ai/claude-code`, ou extensão do **VS Code**, ou app desktop) e logar com a mesma conta Anthropic.
2. Copiar a **pasta do projeto** pro Windows (ver seção 5 sobre o que não copiar).
3. Abrir o Claude Code **dentro da pasta do projeto** → eu passo a ler/editar os arquivos daquela pasta automaticamente.
4. Dizer: **"leia o CONTEXTO-CLAUDE.md"** → eu retomo exatamente deste ponto.
