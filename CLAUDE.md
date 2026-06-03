# CLAUDE.md — PostMaster

> Instruções persistentes pra qualquer Claude (no PC do Tiago OU no VPS da Hostinger) trabalhando neste projeto.
> Leia isso antes de fazer qualquer mudança.

## O que é

**PostMaster** é um app desktop Electron (Windows 10/11) que automatiza postagens em **Instagram** e **TikTok** via **Playwright headless**. Cliente paga **R$ 197 pagamento único** (sem mensalidade) e recebe um instalador `.exe`.

- Marca/venda: **iaempresa.app** (site Next.js no Vercel, repo `tamoaiapp/iaempresa-app`)
- Source desktop: este repo (`tamoaiapp/postmaster`)
- Releases: GitHub Releases com Setup.exe ~700MB
- Auto-update: `electron-updater` (cliente pega o latest automaticamente)

## Stack

| Componente | Lib | Versão |
|---|---|---|
| Runtime | Electron | 32.x |
| Empacotador | electron-builder | 25.x |
| Browser headless | Playwright | 1.60 (Chromium 1223) |
| IA de legenda local | node-llama-cpp | 3.18 (Qwen 2.5 0.5B Q4) |
| Face tracking | onnxruntime-node | 1.26 (Ultra-Light RFB-640) |
| Conversão de vídeo | ffmpeg-static | 5.2 |
| Download fontes | yt-dlp + deno (n-challenge) | — |
| Imagem | sharp | 0.33 |

## Estrutura

```
postmaster/
├── main.js                     # Electron main process. IPC handlers.
├── preload.js                  # API segura exposta ao renderer.
├── renderer/                   # UI HTML+CSS+JS (sem framework).
│   ├── index.html              # 247 linhas, contém TamoIA suporte modal
│   ├── app.js                  # 59KB. Wizard, listagens, eventos.
│   └── style.css
├── src/
│   ├── jobRunner.mjs           # Core. Executa um ciclo de um job.
│   ├── aiManager.mjs           # Carrega node-llama-cpp + Qwen GGUF.
│   ├── liveView.mjs            # Sistema de "Ao vivo" (screenshots dos jobs).
│   ├── smartCut.mjs            # IA escolhe melhor trecho via VTT do YT.
│   ├── autoEditor.mjs          # Orquestra: silêncio + face track + karaokê + render.
│   ├── videoEditor.mjs         # FFmpeg: VTT, silêncio, karaokê ASS.
│   ├── faceTrack.mjs           # ONNX face detection (Ultra-Light RFB-640).
│   ├── supportAgent.mjs        # Cliente do Claude Code bridge no VPS. registerError + classifyError.
│   ├── loginElectron.mjs       # Login IG/TT via BrowserWindow nativo.
│   ├── playwrightExe.mjs       # Resolve path do chrome.exe bundlado.
│   ├── sources/                # Onde pega os vídeos
│   │   ├── youtube.mjs         # yt-dlp + deno + cookies
│   │   ├── instagram.mjs       # IG scrape + yt-dlp
│   │   └── tiktok.mjs
│   └── poster/                 # Onde sobe os vídeos
│       ├── instagram.mjs       # Playwright: Criar → Reel → upload → Avançar x2 → Compartilhar
│       └── tiktok.mjs          # Playwright: TikTok Studio + dispensar joyride
├── models/face-detector.onnx   # Modelo ONNX 1.5MB (bundle no installer).
├── bin/                        # extraResources
│   ├── yt-dlp.exe              # 17MB
│   └── deno.exe                # 122MB (resolve n-challenge do YT)
└── electron-builder.yml        # Config de build (GUID NSIS forçado em afe84ebd-…)
```

## Bugs já conhecidos (e fixes)

| Bug | Versão fix | Como detectar |
|---|---|---|
| ENOTDIR — cliente apontou .mp4 onde devia ser pasta | v1.0.32 | `m.includes('enotdir') && m.includes('scandir')` → kind `manual_source_notdir` |
| chrome-headless-shell.exe doesn't exist | v1.0.33 | `m.includes("chrome-headless-shell") && m.includes("doesn't exist")` → kind `tt_chrome_headless_missing` |
| react-joyride bloqueando click | v1.0.34 | `m.includes('react-joyride') && m.includes('intercepts')` → kind `tt_joyride_blocking` |
| deno.exe não empacotado (YT n-challenge) | v1.0.35 | `m.includes('Requested format') && m.includes('not available')` |
| "Are you sure exit?" em inglês | v1.0.36 | — |
| Joyride typo `__portal` IG | v1.0.37 | — |
| IG rejeita vídeo, ficava esperando Avançar | v1.0.40 | `m.includes('ig_rejected_video')` → kind `ig_rejected_video` |
| Botão Next/Avançar não encontrado | v1.0.40 | kind `ig_next_button_not_found` |

Lista canônica de classificações em [`src/supportAgent.mjs`](src/supportAgent.mjs) função `classifyError()`.

## Pra adicionar um novo fix

1. Adiciona o caso em `classifyError()` em `src/supportAgent.mjs` (assim erros novos viram alertas)
2. Edita o código que tava com bug
3. Adiciona linha nessa tabela "Bugs já conhecidos"
4. Bump `package.json` (`version`)
5. Commit + push pra `main`
6. GitHub Actions builda + publica release sozinho
7. Auto-update dos clientes pega em 1h

## TamoIA — Suporte

A **TamoIA** é a IA do chat dentro do app (botão "Pedir ajuda" no topo) E do site `iaempresa.app`.

- Backend: bridge HTTP no VPS Hostinger (`76.13.125.78:8901`)
  - Endpoints: `POST /chat`, `POST /support`, `POST /notify`, `GET /health`
  - Auth: header `Authorization: Bearer <CLAUDE_BRIDGE_TOKEN>`
- Modelo: **Claude Code CLI** (subscription Pro/Max do Tiago — **R$0 por token**)
- A TamoIA tem acesso a:
  - Os logs recentes do app
  - Os jobs configurados
  - A versão do app, SO, etc
  - O histórico da conversa

A TamoIA **resolve** — não passa pra humano. Só sugere o WhatsApp `+55 11 96724-5795` se o cliente pedir explicitamente.

## VPS Hostinger (onde Claude Code do servidor mora)

- IP: `76.13.125.78` · user `root` · AlmaLinux 10
- SSH alias: `ssh tamovps` (chave em `~/.ssh/tamowork_vps`)
- Bridge: `/opt/claude-bridge/{server.mjs, .env}` rodando via `systemctl status claude-bridge`
- Source clonado: `/opt/postmaster-source` (este repo)
- Erros classificados: `/opt/claude-bridge/errors.jsonl` (append-only JSONL)

## Convenção de versão

Patch: bug fix ou ajuste de UI → bump menor (1.0.X+1)
Minor: feature nova ou mudança visível → bump (1.X+1.0)
Major: breaking de UX ou arquitetura → bump (X+1.0.0)

Após mudar `package.json`, commit/push pra `main` dispara o workflow `release.yml`.

## Auto-fix policy

Quando Claude Code no VPS detecta erro classificado, ele pode:
1. Ler `/opt/claude-bridge/errors.jsonl` pra ver padrão recente
2. Ler `src/supportAgent.mjs` pra ver se já tem classificação
3. Identificar arquivo a ser editado
4. **Editar direto** (sem PR, conforme decisão do Tiago em 2026-06-03)
5. Bump versão
6. Commit + push (`git push origin main`)
7. Logar a mudança em `CHANGELOG-VPS.md`

A política do Tiago: **autonomia total** — `claude` pode fazer push sem revisão. Se o build do CI falhar, ele só não publica e o último release continua o latest.

## Memória compartilhada

Convenção: **tudo importante vira commit**. Quando Claude Code no VPS muda algo, o `git log` é a fonte da verdade. Quando Claude no PC (do Tiago) precisa entender o estado, ele dá `git pull` antes de mexer.

Há também `CHANGELOG-VPS.md` no root pra documentar mudanças feitas pelo VPS que mereçam destaque.
