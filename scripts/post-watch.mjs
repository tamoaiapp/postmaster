/**
 * Roda postagem TikTok com JANELA VISIVEL pra user assistir.
 * Aplica v1.0.56 completo: stealth + waitForFunction processamento + dispensa
 * modals "Novos recursos" e "Verificacoes automaticas" + click Publicar.
 */
import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const SESSION = path.join(process.env.APPDATA, 'postmaster', 'postmaster-data', 'sessions', 'tk-fute.json')
const DOWNLOADS = path.join(process.env.APPDATA, 'postmaster', 'postmaster-data', 'downloads')
const reels = fs.readdirSync(DOWNLOADS)
  .filter(f => f.endsWith('_reel.mp4'))
  .map(f => path.join(DOWNLOADS, f))
  .filter(p => fs.statSync(p).size > 5 * 1024 * 1024)
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
const VIDEO = reels[0]
const SIZE = Math.round(fs.statSync(VIDEO).size / 1024 / 1024)

const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`)
log(`Video: ${path.basename(VIDEO)} (${SIZE}MB)`)

const browser = await chromium.launch({
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
})
const ctx = await browser.newContext({
  storageState: SESSION,
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  locale: 'pt-BR',
})
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  Object.defineProperty(navigator, 'plugins', { get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }] })
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] })
  window.chrome = { runtime: {} }
})
const page = await ctx.newPage()

try {
  log('Abrindo TikTok Studio...')
  await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 3000))

  log('Subindo o video...')
  const fi = await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 60000 })
  await fi.setInputFiles(VIDEO)
  await new Promise(r => setTimeout(r, 3000))

  log('⏳ Aguardando TikTok processar (pode demorar ate 3min)...')
  const t0 = Date.now()
  let ready = false
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-e2e="post_video_button"], [data-e2e="publish-button"], [data-e2e*="post_video"]')
      if (!el) return false
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
      const r = el.getBoundingClientRect()
      return r.width > 30 && r.height > 16
    }, { timeout: 180000, polling: 1500 })
    ready = true
    log(`✅ Botao Publicar pronto em ${Math.round((Date.now()-t0)/1000)}s`)
  } catch {
    log('❌ Botao nao apareceu em 3min')
  }
  await new Promise(r => setTimeout(r, 2000))

  // Dispensa modals "Novos recursos" e "Verificacoes"
  log('Dispensando modals que podem bloquear o click...')
  const dispensed = await page.evaluate(() => {
    const norm = s => (s || '').trim().toLowerCase()
    const all = [...document.querySelectorAll('button, [role="button"]')]
    const body = norm(document.body.innerText)
    const out = []
    if (body.includes('novos recursos') || body.includes('recursos de edição') || body.includes('new features')) {
      const ent = all.find(b => ['entendi', 'got it', 'ok', 'continuar'].includes(norm(b.textContent)))
      if (ent) { try { ent.click(); out.push('Entendi') } catch {} }
    }
    if (body.includes('verificações automáticas') || body.includes('verificações de conteúdo') || body.includes('automatic checks')) {
      const can = all.find(b => ['cancelar', 'cancel', 'agora não', 'agora nao', 'not now'].includes(norm(b.textContent)))
      if (can) { try { can.click(); out.push('Cancelar verificacoes') } catch {} }
    }
    return out
  })
  log(`Modals dispensados: [${dispensed.join(', ') || 'nenhum'}]`)
  await new Promise(r => setTimeout(r, 2000))

  if (!ready) {
    log('Janela fica aberta 30s pra inspecao')
    await new Promise(r => setTimeout(r, 30000))
    await browser.close()
    process.exit(1)
  }

  // Scroll ate o botao + click
  log('Click no Publicar (force=true)...')
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="post_video_button"]')
    if (!el) return false
    el.scrollIntoView({ behavior: 'instant', block: 'center' })
    try { el.click(); return true } catch { return false }
  })
  log(`Click ok: ${clicked}`)

  // Aguarda redirect ou erro
  log('⏳ Aguardando confirmacao (90s)...')
  const tStart = Date.now()
  let outcome = 'timeout'
  while (Date.now() - tStart < 90000) {
    await new Promise(r => setTimeout(r, 2000))
    const url = page.url()
    if (/\/tiktokstudio\/content|\/profile|\/manage/.test(url)) {
      outcome = 'sucesso (redirect pra ' + url + ')'
      break
    }
    const erro = await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase()
      if (t.includes('algo deu errado') || t.includes('tente novamente') || t.includes('something went wrong')) return true
      return false
    })
    if (erro) { outcome = '❌ "Algo deu errado"'; break }
    const sucesso = await page.evaluate(() => {
      const texts = ['vídeo publicado', 'video publicado', 'video published', 'publicado com sucesso', 'seu vídeo está sendo carregado']
      for (const el of document.querySelectorAll('span, div, p, h1, h2, h3')) {
        const t = (el.textContent || '').trim().toLowerCase()
        if (texts.some(x => t.startsWith(x) || t === x)) return true
      }
      return false
    })
    if (sucesso) { outcome = '✅ Texto de sucesso detectado'; break }
  }
  log(`Resultado: ${outcome}`)

  log('Janela aberta por 30s pra inspecao final')
  await new Promise(r => setTimeout(r, 30000))
} catch (e) {
  log(`Erro: ${e.message}`)
} finally {
  await browser.close()
}
