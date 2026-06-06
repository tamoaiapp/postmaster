/**
 * Loga no YouTube via Playwright (com stealth) em vez de Electron BrowserWindow.
 * Google bloqueia Electron mas aceita Playwright/Chromium puro.
 *
 * Uso: node scripts/login-yt-playwright.mjs [nome-conta]
 *
 * 1. Abre janela visivel
 * 2. User faz login normalmente
 * 3. Quando detectar studio.youtube.com (logado), salva storageState
 * 4. Pronto pra usar pelo app
 */
import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const account = process.argv[2] || 'fute vai youtube'
const sessionFile = path.join(process.env.APPDATA, 'postmaster', 'postmaster-data', 'sessions', `yt-${account}.json`)

console.log(`Login YouTube — conta: ${account}`)
console.log(`Vai salvar em: ${sessionFile}`)
console.log('')

// Usa o CHROME REAL do sistema (channel: 'chrome'). Google nao bloqueia
// porque eh literalmente o Chrome instalado, com fingerprint legitimo
// (WebGL, Canvas, plugins reais, etc).
const userDataDir = path.join(process.env.TEMP, 'pm-yt-login-' + Date.now())
console.log('Abrindo Chrome real do PC com perfil temporario...')

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome', // usa Chrome instalado
  headless: false,
  viewport: { width: 1280, height: 900 },
  locale: 'pt-BR',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
})

const browser = ctx.browser()
const page = await ctx.newPage()
console.log('Abrindo studio.youtube.com... Faça login na janela. Quando ver o painel do canal, FECHE A JANELA.')
await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })

// Detector: a cada 3s checa se URL é studio.youtube.com/channel/... = logado
let lastUrl = page.url()
let loggedInTime = null
const startTime = Date.now()
const MAX_WAIT = 10 * 60 * 1000 // 10min pra logar
while (Date.now() - startTime < MAX_WAIT) {
  await new Promise(r => setTimeout(r, 3000))
  if (page.isClosed()) break
  const url = page.url()
  if (url !== lastUrl) {
    console.log(`[nav] ${url.slice(0, 80)}...`)
    lastUrl = url
  }
  if (/studio\.youtube\.com\/channel\//.test(url) && !loggedInTime) {
    loggedInTime = Date.now()
    console.log('\n✅ LOGADO! Aguardando 10s antes de salvar (caso esteja terminando algo)...')
  }
  // Se logado E user fechou a janela = sucesso
  if (loggedInTime && (Date.now() - loggedInTime > 10000)) {
    console.log('Salvando sessao...')
    await ctx.storageState({ path: sessionFile })
    const sz = Math.round(fs.statSync(sessionFile).size / 1024)
    console.log(`✓ Sessao salva: ${sessionFile} (${sz}KB)`)
    break
  }
}
if (!loggedInTime) console.log('\n⚠️ Timeout — nao detectou login. Verifique se chegou no painel do canal.')

console.log('\nFechando browser...')
await browser.close()
