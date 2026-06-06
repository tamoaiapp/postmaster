/**
 * Posta video no YouTube via Playwright em studio.youtube.com.
 * Reusa stealth e padrao do tiktok.mjs + instagram.mjs.
 *
 * Inputs:
 *   - account: nome do canal (matches sessions/yt-account-{account}.json)
 *   - videoPath: caminho do MP4 16:9 ja renderizado
 *   - title, description, tags
 *   - visibility: 'public' | 'unlisted' | 'private'
 *   - category: nome PT-BR (ex: "Entretenimento", "Noticias e Politica")
 *   - madeForKids: boolean (default false)
 *   - dataDir, log, jobId
 */
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import * as liveView from '../liveView.mjs'

const delay = ms => new Promise(r => setTimeout(r, ms))

export async function postVideoYouTube({
  account, videoPath, title, description, tags = [],
  visibility = 'private', category = 'Entretenimento', madeForKids = false,
  dataDir, log, jobId,
}) {
  const sessionFile = path.join(dataDir, 'sessions', `yt-${account}.json`)
  if (!fs.existsSync(sessionFile)) throw new Error(`Sessao YouTube nao encontrada pra @${account}. Faca login primeiro.`)
  if (!fs.existsSync(videoPath)) throw new Error(`Video nao encontrado: ${videoPath}`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const ctx = await browser.newContext({
    storageState: sessionFile,
    viewport: { width: 1366, height: 900 },
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
  const liveJobId = jobId || `${account}-yt-${Date.now()}`
  if (jobId) liveView.attachPage(liveJobId, page)
  else liveView.register(liveJobId, page, { account, platform: 'youtube', status: 'iniciando' })

  // v1.0.65: debug verboso pra rastrear onde upload YT trava
  const debugDir = path.join(dataDir, 'debug')
  fs.mkdirSync(debugDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const snap = async (label) => {
    try {
      await page.screenshot({ path: path.join(debugDir, `yt-${ts}-${label}.png`), fullPage: true })
      log(`📸 [${label}] URL: ${page.url()}`)
    } catch (e) { log(`📸 [${label}] screenshot falhou: ${e.message.slice(0,60)}`) }
  }

  try {
    log('🌐 Abrindo YouTube Studio...')
    liveView.updateStatus(liveJobId, 'Abrindo YouTube Studio')
    // Vai DIRETO no upload (mais confiavel que clicar no botao)
    await page.goto('https://studio.youtube.com/channel/UC/videos/upload', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await delay(3000)
    await snap('01-after-goto')

    // SetInputFiles no <input type=file>
    log('📎 Aguardando input file...')
    liveView.updateStatus(liveJobId, 'Aguardando input')
    const fileInput = await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 60000 })
    log(`📎 Input file encontrado, enviando arquivo (${Math.round(fs.statSync(videoPath).size/1024/1024)}MB)...`)
    await fileInput.setInputFiles(videoPath)
    await delay(3000)
    await snap('02-after-setInputFiles')

    // Aguarda dialogo de detalhes abrir (input de titulo aparece)
    log('⏳ Aguardando dialogo de detalhes abrir (ate 3min)...')
    try {
      await page.waitForSelector('ytcp-mention-textbox, [id="title-textarea"], #title-textarea', { timeout: 180000 })
    } catch (e) {
      await snap('03-textbox-timeout')
      throw new Error(`Dialogo de detalhes nao abriu em 3min: ${e.message.slice(0,80)}`)
    }
    await delay(2000)
    await snap('03-dialog-opened')

    // ── Titulo ─────────────────────────────────────────────────
    log('📝 Preenchendo titulo...')
    const titleField = page.locator('ytcp-mention-textbox#title-textarea [id="textbox"], #title-textarea [id="textbox"], [id="textbox"]').first()
    await titleField.click({ force: true })
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    await titleField.type(title.slice(0, 100), { delay: 5 })
    await delay(1000)

    // ── Descricao ──────────────────────────────────────────────
    if (description) {
      log('📝 Preenchendo descricao...')
      const descField = page.locator('ytcp-mention-textbox#description-textarea [id="textbox"], #description-textarea [id="textbox"]').first()
      if (await descField.count() > 0) {
        await descField.click({ force: true })
        await descField.type(description.slice(0, 5000), { delay: 3 })
        await delay(1000)
      }
    }

    // ── Audience (made for kids) ───────────────────────────────
    log('👶 Marcando audiencia (kids)...')
    const kidsRadioName = madeForKids
      ? /Sim.*feito.*crianças|made for kids/i
      : /Não.*não.*feito.*crianças|not made for kids/i
    const kidsRadio = page.locator(`tp-yt-paper-radio-button[name*="${madeForKids ? 'MADE_FOR_KIDS' : 'NOT_MADE_FOR_KIDS'}"]`).first()
    if (await kidsRadio.count() > 0) {
      await kidsRadio.click({ force: true }).catch(() => {})
    } else {
      // Fallback por texto
      const byText = page.locator('text=' + (madeForKids ? '/Sim, é feito/i' : '/Não, não é feito/i')).first()
      if (await byText.count() > 0) await byText.click({ force: true }).catch(() => {})
    }
    await delay(1000)

    // ── Tags (em "Mostrar mais") ───────────────────────────────
    if (tags.length > 0) {
      log('🏷️  Adicionando tags...')
      const showMore = page.locator('#toggle-button, ytcp-button:has-text("Mostrar mais"), ytcp-button:has-text("Show more")').first()
      if (await showMore.count() > 0) {
        await showMore.click({ force: true }).catch(() => {})
        await delay(1500)
      }
      const tagsField = page.locator('#tags-input, ytcp-form-input-container[id*="tags"] input').first()
      if (await tagsField.count() > 0) {
        await tagsField.click({ force: true })
        for (const tag of tags.slice(0, 15)) {
          await tagsField.type(tag.slice(0, 50))
          await page.keyboard.press('Enter')
          await delay(200)
        }
        await delay(800)
      }
    }

    // ── Categoria ──────────────────────────────────────────────
    if (category) {
      log(`📂 Categoria: ${category}`)
      const catSelect = page.locator('ytcp-form-select[id*="category"], #category, [aria-label*="ategoria"]').first()
      if (await catSelect.count() > 0) {
        await catSelect.click({ force: true }).catch(() => {})
        await delay(800)
        const opt = page.locator(`tp-yt-paper-item:has-text("${category}")`).first()
        if (await opt.count() > 0) await opt.click({ force: true }).catch(() => {})
        await delay(800)
      }
    }

    // ── Avancar pra etapa 4 (Visibilidade) ─────────────────────
    log('▶ Avancando ate visibilidade...')
    for (let i = 0; i < 3; i++) {
      const next = page.locator('#next-button, ytcp-button:has-text("Próximo"), ytcp-button:has-text("Next")').first()
      if (await next.count() > 0) {
        await next.click({ force: true }).catch(() => {})
        await delay(1500)
      }
    }

    // ── Visibilidade ───────────────────────────────────────────
    log(`👁️  Visibilidade: ${visibility}`)
    const visMap = { public: 'PUBLIC', unlisted: 'UNLISTED', private: 'PRIVATE' }
    const visText = { public: 'Público', unlisted: 'Não listado', private: 'Privado' }
    const visRadio = page.locator(`tp-yt-paper-radio-button[name="${visMap[visibility]}"]`).first()
    if (await visRadio.count() > 0) {
      await visRadio.click({ force: true }).catch(() => {})
    } else {
      const byText = page.locator(`text=${visText[visibility]}`).first()
      if (await byText.count() > 0) await byText.click({ force: true }).catch(() => {})
    }
    await delay(1500)

    // ── Aguarda upload finalizar (mostra progresso na lateral) ─
    log('⏳ Aguardando upload terminar...')
    await page.waitForFunction(() => {
      const txt = (document.body.innerText || '').toLowerCase()
      // Sinais de upload concluido: porcentagem some, ou aparece "verificacoes concluidas"
      if (/verificações concluídas|verificações em andamento|processando|checks complete/.test(txt)) return true
      if (/100%/.test(txt)) return true
      return false
    }, { timeout: 600000, polling: 3000 }).catch(() => log('⚠️ Status do upload nao confirmado, tentando publicar mesmo assim'))
    await delay(2000)

    // ── Botao "Publicar" / "Salvar" (depende da visibility) ────
    log('📤 Clicando Publicar/Salvar...')
    const pubBtn = page.locator('#done-button, ytcp-button:has-text("Publicar"), ytcp-button:has-text("Salvar"), ytcp-button:has-text("Publish"), ytcp-button:has-text("Save")').first()
    if (await pubBtn.count() === 0) throw new Error('Botao Publicar/Salvar nao encontrado')
    await pubBtn.click({ force: true, timeout: 10000 })

    // Aguarda confirmacao de publicado (dialog "Video publicado")
    await page.waitForSelector('text=/Vídeo publicado|Video published|Salvo|Saved/i', { timeout: 60000 }).catch(() => {})
    log('✅ YouTube: postado!')
    liveView.updateStatus(liveJobId, 'Postado!')
    return true
  } catch (e) {
    log(`❌ Erro YouTube: ${e.message}`)
    liveView.updateStatus(liveJobId, 'Erro')
    await snap('99-error').catch(() => {})
    throw e
  } finally {
    try { liveView.unregister(liveJobId) } catch {}
    await browser.close().catch(() => {})
  }
}
