# PostMaster

App desktop Windows que automatiza postagens em Instagram e TikTok.

- Vendido em: [iaempresa.app/postmaster](https://iaempresa.app/postmaster) — R$ 197 pagamento único.
- Stack: Electron 32 + Playwright + node-llama-cpp + onnxruntime-node + ffmpeg-static.
- Releases: ver [Releases](../../releases) — auto-update via `electron-updater`.

> **Contribuindo / corrigindo bugs**: leia [`CLAUDE.md`](CLAUDE.md) primeiro.

## Build local

```powershell
git clone https://github.com/tamoaiapp/postmaster.git
cd postmaster
npm install
npx playwright install chromium chromium-headless-shell ffmpeg
# Cria junctions ms-playwright/chromium-1223 -> %LOCALAPPDATA%\ms-playwright\chromium-1223 (idem headless_shell e ffmpeg)
npm run dist
```

Build leva ~5 min, gera `dist/PostMaster-Setup.exe` (~700MB).

## Auto-publish

Push em `main` que toque qualquer source/pkg/builder dispara o workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) — builda no runner Windows e publica release com a versão do `package.json`. Se a release já existir, pula.

## Suporte

A TamoIA dentro do app (botão "Pedir ajuda") atende dúvidas e lê os logs do cliente. Backend: bridge HTTP no VPS rodando Claude Code (`76.13.125.78:8901`). Detalhes em `CLAUDE.md`.
