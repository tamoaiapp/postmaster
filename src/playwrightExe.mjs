/**
 * Resolve o caminho do chrome.exe bundlado em ms-playwright/chromium-1217/.
 * Em Electron empacotado, fica em resources/ms-playwright (extraResources).
 * Em dev, fica na raiz do projeto.
 *
 * Uso:
 *   chromium.launch({ headless: true, executablePath: getChromiumExe(), ... })
 *
 * Sem isso, Playwright procura por chrome-headless-shell.exe (binario separado
 * que NAO bundlamos pra economizar 266MB do instalador).
 */
import path from 'path'
import fs from 'fs'

let cached
export function getChromiumExe() {
  if (cached) return cached
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe')
      : null,
    path.join(process.cwd(), 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) { cached = p; return p }
  }
  console.warn('[playwrightExe] chrome.exe não encontrado em nenhum candidato')
  return null
}
