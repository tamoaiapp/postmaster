/**
 * Resolve o caminho do chrome.exe REAL (Chromium full) bundlado em
 * ms-playwright/chromium-XXXX/. Em Electron empacotado, fica em
 * resources/ms-playwright (extraResources). Em dev, fica na raiz do projeto.
 *
 * Uso:
 *   chromium.launch({ headless: true, executablePath: getChromiumExe(), ... })
 *
 * IMPORTANTE: precisa ser o Chromium FULL (`chromium-XXXX/chrome-win64/chrome.exe`),
 * NAO o `chromium_headless_shell-XXXX/...`. O headless shell eh um binario
 * separado, menor, mas o TikTok detecta sinais especificos dele e bloqueia o
 * upload silenciosamente — era ROOT CAUSE do tt_post_button_failed mesmo
 * com stealth aplicado.
 *
 * O CI builda com `chromium-1223` e `chromium-1217` historico fica como fallback.
 * Versoes mais novas sao priorizadas (Chrome moderno = menos sinais de bot).
 */
import path from 'path'
import fs from 'fs'

// Ordem de preferencia: mais nova primeiro. Quando o Playwright bumpar versao,
// adiciona aqui no topo (ou usa o fallback "qualquer chromium-XXXX que existir").
const KNOWN_VERSIONS = ['1223', '1217']

let cached
export function getChromiumExe() {
  if (cached) return cached
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'ms-playwright') : null,
    path.join(process.cwd(), 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
  ].filter(Boolean)

  // 1. Tenta as versoes conhecidas em ordem (cobre 99% dos casos)
  for (const root of roots) {
    for (const ver of KNOWN_VERSIONS) {
      const p = path.join(root, `chromium-${ver}`, 'chrome-win64', 'chrome.exe')
      if (fs.existsSync(p)) { cached = p; return p }
    }
  }
  // 2. Fallback: lista qualquer "chromium-NNNN" (sem _headless_shell)
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    try {
      const dirs = fs.readdirSync(root).filter(n => /^chromium-\d+$/.test(n))
      // Mais nova primeiro
      dirs.sort((a, b) => parseInt(b.split('-')[1]) - parseInt(a.split('-')[1]))
      for (const d of dirs) {
        const p = path.join(root, d, 'chrome-win64', 'chrome.exe')
        if (fs.existsSync(p)) { cached = p; return p }
      }
    } catch {}
  }
  console.warn('[playwrightExe] chrome.exe não encontrado — Playwright vai cair no chrome-headless-shell (TikTok detecta)')
  return null
}
