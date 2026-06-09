/**
 * Posta vídeo no TikTok via Playwright.
 */

import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import * as liveView from '../liveView.mjs'

const delay = ms => new Promise(r => setTimeout(r, ms))

export async function postVideoTikTok({ account, videoPath, caption, dataDir, log, jobId }) {
  const sessionFile = path.join(dataDir, 'sessions', `tk-${account}.json`)
  if (!fs.existsSync(sessionFile)) throw new Error(`Sessão não encontrada para @${account}. Faça login primeiro.`)

  // NAO passa executablePath — quando passamos explicitamente, Playwright
  // trata como "Chrome do user" e PARA de aplicar os args internos de
  // bypass de detecao automatica (que sao DIFERENTES do --disable-blink-features
  // que passamos manualmente). Sem esses args internos, TikTok detecta bot e
  // bloqueia o upload silenciosamente — provado isolando em teste local.
  // main.js seta PLAYWRIGHT_BROWSERS_PATH apontando pro chromium-XXXX bundlado.
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const ctx = await browser.newContext({
    storageState: sessionFile,
    viewport: { width: 1280, height: 900 },
    // UA sem "Headless" no nome (Playwright default expoe "HeadlessChrome").
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    locale: 'pt-BR',
  })

  // Stealth — mascara sinais que TikTok usa pra detectar bot.
  // Versao validada localmente que funciona em headless: sem
  // permissions.query override (causava algum bug que quebrava upload).
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }] })
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()

  const liveJobId = jobId || `${account}-${Date.now()}`
  if (jobId) {
    liveView.attachPage(liveJobId, page)
  } else {
    liveView.register(liveJobId, page, { account, platform: 'tiktok', status: 'iniciando' })
  }

  // Injeta CSS persistente que neutraliza tours/overlays MESMO se o React re-renderizar.
  // react-joyride eh componente React: se a gente so faz el.remove(), o React re-cria o
  // overlay milissegundos depois (foi exatamente o que travou o post do cliente: o overlay
  // voltava entre o dispensar e o click da legenda). CSS aplica antes da pintura e sobrevive.
  const installAntiOverlayCss = async () => {
    // Restrito a IDs especificos do react-joyride. NAO usar [data-test-id="overlay"]
    // — TikTok Studio usa isso em componentes nativos (modal de publicacao!) e
    // esconder bloqueava o fluxo todo. Removido em v1.0.51.
    await page.addStyleTag({ content: `
      #react-joyride-portal, #react-joyride__portal {
        display: none !important;
        pointer-events: none !important;
        visibility: hidden !important;
      }
    ` }).catch(() => {})
  }

  // Helper: remove overlays que interceptam cliques (tour onboarding, modais, etc)
  const dispensarOverlays = async () => {
    // Garante que o CSS anti-overlay esta instalado (idempotente).
    await installAntiOverlayCss()
    await page.evaluate(() => {
      // 1. Modal "Tem certeza..." / "Are you sure..." — clica no botao que MANTEM
      // o usuario na pagina (Nao / Cancel), nunca no que aborta (Sim / Exit).
      // Esse modal apareceu pro user5924... durante a publicacao em ingles e travou
      // o post por 90s ate timeout.
      const allButtons = [...document.querySelectorAll('button, [role="button"]')]
      const dialogText = document.body.innerText.toLowerCase()
      const isExitDialog =
        // PT: "Tem certeza de que deseja cancelar o carregamento?"
        (dialogText.includes('tem certeza') && (dialogText.includes('cancelar') || dialogText.includes('sair'))) ||
        // EN: "Are you sure you want to exit?" (com "Your progress... will not be saved")
        (dialogText.includes('are you sure') && (dialogText.includes('exit') || dialogText.includes('leave') || dialogText.includes('saved'))) ||
        (dialogText.includes('progress') && dialogText.includes('not be saved'))
      if (isExitDialog) {
        // Procura botao "ficar/cancelar/nao" (mantem upload). NUNCA clica Exit/Sim.
        const stayLabels = ['não', 'nao', 'cancelar', 'cancel', 'ficar', 'stay', 'continue', 'continuar']
        const exitLabels = ['exit', 'sair', 'sim', 'yes', 'leave', 'abandonar', 'descartar', 'discard']
        const stayBtn = allButtons.find(b => {
          const t = (b.textContent || '').trim().toLowerCase()
          return stayLabels.includes(t) && !exitLabels.includes(t)
        })
        if (stayBtn) { try { stayBtn.click(); return } catch {} }
      }
      // 2. Modal "Ativar verificacoes automaticas de conteudo" — clica Cancelar
      const skipTexts = ['cancelar', 'cancel', 'pular', 'skip', 'got it', 'entendi', 'agora não', 'not now', 'fechar', 'close', 'fechar tour', 'close tour']
      for (const el of allButtons) {
        const t = (el.textContent || '').trim().toLowerCase()
        if (skipTexts.some(x => t === x)) { try { el.click() } catch {} }
      }
      // 3. Remove overlays de tour visualmente (cobre 1 hyphen E 2 underscores — TikTok mistura)
      document.querySelectorAll('#react-joyride-portal, #react-joyride__portal, .react-joyride__overlay, [data-test-id="overlay"]').forEach(el => { try { el.remove() } catch {} })
      // 4. SO remove portals que NAO contem o botao Post (pra nao quebrar upload em andamento)
      document.querySelectorAll('[data-floating-ui-portal]').forEach(el => {
        const text = (el.innerText || '').toLowerCase()
        // Se tem botao Post/Publicar dentro, NAO remove (eh o modal de publicacao!)
        if (text.includes('post') || text.includes('publicar') || text.includes('agendar')) return
        try { el.remove() } catch {}
      })
    }).catch(() => {})
  }

  try {
    log('🌐 Abrindo TikTok Studio...')
    liveView.updateStatus(liveJobId, 'Abrindo TikTok')
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 40000 })
    await delay(3000)
    // NAO faz dispensarOverlays() aqui — o CSS injetado anti-joyride esconde
    // [data-test-id="overlay"] que tambem eh usado pelo componente de upload
    // do TikTok. Isso bloqueava o setInputFiles silenciosamente. O joyride
    // que aparece apos o upload eh removido pelo dispensarOverlays() chamado
    // mais abaixo (linha ~155), entao nao tem prejuizo.

    // Upload file — v1.3.4: TikTok mudou a UI, input agora vive num IFRAME
    // (creator#/upload), nao mais no DOM principal. page.waitForSelector
    // procurava so na pagina principal -> achava 0 inputs -> bot reportava
    // "postado" sem postar.
    // Fix: itera por TODOS os frames (page.frames()) ate achar input[type=file]
    liveView.updateStatus(liveJobId, 'Enviando vídeo')

    let fileInput = null
    let frameComInput = null
    const inputDeadline = Date.now() + 90000  // 90s total
    while (Date.now() < inputDeadline && !fileInput) {
      // Procura em todos os frames (incluindo o iframe do creator)
      for (const f of page.frames()) {
        try {
          const inp = await f.$('input[type="file"]')
          if (inp) { fileInput = inp; frameComInput = f; break }
        } catch {}
      }
      if (fileInput) break
      await delay(2000)
    }
    if (!fileInput) {
      log('   ⚠️ Frames vistos:')
      page.frames().forEach(f => log('     - ' + f.url().slice(0, 80)))
      throw new Error('input[type=file] nao achado em nenhum frame (TikTok pode estar bloqueando bot)')
    }
    log(`   📎 input achado no frame: ${frameComInput.url().slice(0, 80)}`)
    await fileInput.setInputFiles(videoPath)
    log('📎 Arquivo selecionado')

    // v1.3.4: usa o frame onde o input vive pra TODAS as operacoes seguintes
    // (legenda, botao Publicar, overlays). Antes usava page (DOM principal) e
    // nao achava elementos que vivem dentro do iframe creator#/upload.
    const tikPage = frameComInput
    await delay(3000)

    // ROOT CAUSE (descoberto pelo user em 2026-06-05): o upload terminar de
    // enviar nao significa que pode publicar. TikTok ainda processa server-side
    // (capa "Carregando...", transcoding, validacao) por 30-180s. Durante esse
    // tempo o botao Publicar NAO EXISTE no DOM — se a gente tentar clicar agora
    // o TikTok mostra "Algo deu errado / Tentar novamente". Era o que aparecia
    // em todos os fails. Agora aguarda o data-e2e=post_video_button aparecer
    // visivel + enabled, com timeout de 3min (vale ate pra video grande).
    // v1.0.63: timeout dinamico baseado no tamanho do video.
    // User reportou videos de 100MB+ subindo a 0.15MB/s (TikTok rate-limit).
    // Calculo: 3min base + 1min por 10MB. Cap 15min.
    let timeoutMs = 180000
    try {
      const sizeMB = fs.statSync(videoPath).size / 1024 / 1024
      timeoutMs = Math.min(900000, 180000 + (sizeMB * 6000)) // 3min + 6s/MB, max 15min
    } catch {}
    log(`⏳ Aguardando TikTok processar (timeout ${Math.round(timeoutMs/60000)}min)...`)
    liveView.updateStatus(liveJobId, 'TikTok processando')
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-e2e="post_video_button"], [data-e2e="publish-button"], [data-e2e*="post_video"]')
        if (!el) return false
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
        const r = el.getBoundingClientRect()
        return r.width > 30 && r.height > 16
      }, { timeout: timeoutMs, polling: 2000 })
      log('✅ TikTok terminou de processar')
    } catch (e) {
      log(`⚠️ TikTok demorou >${Math.round(timeoutMs/60000)}min processando. Video grande ou rede lenta.`)
    }
    await delay(2000)

    // FIX v1.0.56 #2: dois modals especificos aparecem JUNTO com o botao Publicar
    // que precisam ser fechados ANTES de qualquer click. User identificou:
    //   1. "Novos recursos de edicao adicionados" (centro-direita) → botao "Entendi"
    //   2. "Ativar verificacoes automaticas de conteudo" (centro) → botao "Cancelar"
    //      (NAO clicar "Ativar" — usuario pode nao querer)
    // Se nao fechar, o click no Publicar passa por cima desses overlays e TikTok
    // mostra "Algo deu errado". Era o erro mais frequente.
    await page.evaluate(() => {
      const norm = s => (s || '').trim().toLowerCase()
      const allButtons = [...document.querySelectorAll('button, [role="button"]')]
      // Modal 1: "Novos recursos..." → Entendi
      // Modal 2: "Ativar verificacoes..." → Cancelar (NUNCA "Ativar")
      const bodyText = norm(document.body.innerText)
      const hasNovosRecursos = bodyText.includes('novos recursos') || bodyText.includes('new features') || bodyText.includes('recursos de edição')
      const hasVerificacoes = bodyText.includes('verificações automáticas') || bodyText.includes('automatic checks') || bodyText.includes('content checks')
      if (hasNovosRecursos) {
        const entendi = allButtons.find(b => ['entendi', 'got it', 'ok', 'continuar'].includes(norm(b.textContent)))
        if (entendi) try { entendi.click() } catch {}
      }
      if (hasVerificacoes) {
        const cancelar = allButtons.find(b => ['cancelar', 'cancel', 'agora não', 'agora nao', 'not now'].includes(norm(b.textContent)))
        if (cancelar) try { cancelar.click() } catch {}
      }
    }).catch(() => {})
    await delay(1500)

    // DISPENSA popups que aparecem após upload (analise IA, AI tools, tour, etc)
    // Esses modals interceptam clicks e impedem o botao Post de funcionar.
    log('Dispensando popups e overlays...')
    await page.evaluate(() => {
      // 1. Procura botoes de fechar/cancelar/nao em modais (analise IA, etc)
      const closeTexts = ['não obrigado', 'no thanks', 'cancelar', 'cancel', 'fechar', 'close', 'agora não', 'not now', 'pular', 'skip']
      for (const el of document.querySelectorAll('button, [role="button"], [aria-label]')) {
        const t = (el.textContent || '').trim().toLowerCase()
        const lbl = (el.getAttribute('aria-label') || '').toLowerCase()
        if (closeTexts.some(x => t === x || lbl === x || lbl.includes('close'))) {
          try { el.click() } catch {}
        }
      }
      // 2. Remove overlays TUXModal direto
      document.querySelectorAll('[data-floating-ui-portal]').forEach(el => {
        try { el.remove() } catch {}
      })
      // 3. Remove tour onboarding react-joyride (overlay transparente que intercepta clicks)
      document.querySelectorAll('#react-joyride-portal, .react-joyride__overlay, [data-test-id="overlay"]').forEach(el => {
        try { el.remove() } catch {}
      })
      // 4. Remove qualquer overlay generico fixo
      document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]').forEach(el => {
        const z = parseInt(window.getComputedStyle(el).zIndex || '0')
        if (z > 5000 && el.getBoundingClientRect().width > 500) {
          try { el.remove() } catch {}
        }
      })
    }).catch(() => {})
    await delay(1500)

    // Caption — usa locator com force pra ignorar overlays que tenham re-aparecido
    // (o joyride do TikTok volta via re-render do React mesmo apos el.remove())
    await dispensarOverlays()
    const captionLoc = page.locator('[data-text="true"], [contenteditable="true"], textarea[placeholder]').first()
    if (await captionLoc.count() > 0) {
      try {
        await captionLoc.click({ force: true, timeout: 10000 })
        await captionLoc.fill('')
        await captionLoc.type(caption.substring(0, 2200))
        log('✏️ Legenda preenchida')
      } catch (e) {
        log(`⚠️ Legenda nao preenchida: ${e.message.split('\n')[0].slice(0, 60)} — postando sem legenda`)
      }
      await delay(1000)
    }

    // Post button — v1.0.48: usa Playwright locator direto com data-e2e
    // (testado e validado contra TikTok Studio real). Versoes anteriores
    // serializavam o Element via page.evaluate (perdia handle) ou usavam
    // texto exato (nao casava com TikTok que empacota o texto com SVG).
    // O data-e2e="post_video_button" eh estavel ha anos no TikTok Studio.
    const POST_SELECTORS = [
      '[data-e2e="post_video_button"]',
      '[data-e2e="publish-button"]',
      '[data-e2e="post-button"]',
      '[data-e2e*="post_video"]',
      '[data-e2e*="publish"]',
    ]
    let posted = false
    const MAX_ATTEMPTS = 5
    for (let tentativa = 1; tentativa <= MAX_ATTEMPTS && !posted; tentativa++) {
      try {
        // 1. Limpa overlays + scroll pro fim (botao fica em y~1145, fora da viewport 900)
        await page.evaluate(() => {
          document.querySelectorAll('[data-floating-ui-portal], #react-joyride-portal, #react-joyride__portal').forEach(el => {
            try { el.remove() } catch {}
          })
          const main = document.querySelector('main, [class*="ContentForm"], [class*="UploadCard"]')
          if (main) main.scrollTop = main.scrollHeight
          window.scrollTo(0, document.body.scrollHeight)
        }).catch(() => {})
        await delay(1200)

        // 2. Aguarda upload terminar — detecta progresso visivel
        const uploadInProgress = await page.evaluate(() => {
          const text = (document.body.innerText || '').toLowerCase()
          if (/uploading.*\d+%|carregando.*\d+%|loading\s*\d+%/.test(text)) return true
          if (/\b(uploading|carregando|fazendo upload)\b/.test(text) && !/upload(ed|ado|ou)/.test(text)) return true
          return false
        })
        if (uploadInProgress) {
          log(`   tentativa ${tentativa}: upload ainda em andamento, aguardando 5s...`)
          await delay(5000)
          continue
        }

        // 3. Tenta cada seletor data-e2e via Playwright locator (handle robusto)
        let btn = null
        let usedSelector = null
        for (const sel of POST_SELECTORS) {
          const loc = page.locator(sel).first()
          if (await loc.count() > 0) {
            // Confere se nao esta disabled (botao pode existir mas estar inativo)
            const disabled = await loc.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false)
            if (!disabled) {
              btn = loc
              usedSelector = sel
              break
            }
          }
        }
        if (!btn) throw new Error('Botão Post não encontrado (data-e2e ausente — TikTok pode ter mudado)')

        // 4. Scroll + click
        log(`   tentativa ${tentativa}: achei via ${usedSelector}`)
        await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
        await delay(500)
        try {
          await btn.click({ force: true, timeout: 8000 })
          posted = true
          log(`📤 Publicando... (tentativa ${tentativa})`)
        } catch (clickErr) {
          // Fallback: JS click direto via dispatchEvent
          await btn.evaluate(el => el.click()).catch(() => {})
          await delay(1500)
          const stillOnUpload = await page.evaluate(() => {
            return /\/upload|\/creator-center\/upload/.test(location.pathname) &&
                   !!document.querySelector('[data-e2e="post_video_button"], input[type="file"]')
          })
          if (!stillOnUpload) {
            posted = true
            log(`📤 Publicando... (tentativa ${tentativa}, via JS click)`)
          } else {
            throw new Error(`click falhou: ${clickErr.message.split('\n')[0].slice(0, 60)}`)
          }
        }
      } catch (e) {
        log(`   tentativa ${tentativa}/${MAX_ATTEMPTS} falhou: ${e.message.split('\n')[0].slice(0, 80)}`)
        await delay(1500)
      }
    }

    if (!posted) {
      // Salva debug pra TamoIA inspecionar offline
      try {
        const debugDir = path.join(dataDir, 'debug')
        fs.mkdirSync(debugDir, { recursive: true })
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const pngPath = path.join(debugDir, `tt-post-fail-${ts}.png`)
        const jsonPath = path.join(debugDir, `tt-post-fail-${ts}.json`)
        await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {})
        const dom = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('button, [role="button"]'))
          return {
            url: location.href,
            buttonsCount: all.length,
            firstButtons: all.slice(0, 30).map(el => {
              const r = el.getBoundingClientRect()
              return {
                tag: el.tagName,
                text: (el.innerText || el.textContent || '').trim().slice(0, 40),
                ariaLabel: el.getAttribute('aria-label'),
                dataE2e: el.getAttribute('data-e2e'),
                disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              }
            }),
          }
        }).catch(() => null)
        fs.writeFileSync(jsonPath, JSON.stringify({ ts, dom }, null, 2))
        log(`   debug salvo: ${pngPath}`)
      } catch (debugErr) {
        log(`   nao salvou debug: ${debugErr.message.slice(0, 60)}`)
      }
      throw new Error('tt_post_button_failed: TikTok mudou o layout do botao Post ou upload travou. App vai detectar e arrumar em update.')
    }
    liveView.updateStatus(liveJobId, 'Publicando')

    // Aguarda confirmação — TikTok redireciona pra /tiktokstudio/content e mostra "Vídeo publicado"
    const deadline = Date.now() + 90000 // 90s eh suficiente
    let ok = false
    while (Date.now() < deadline) {
      await delay(2000)
      // TikTok as vezes mostra "Are you sure you want to exit?" durante a publicacao
      // (e em PT "Tem certeza que deseja sair?"). Dispensa proativamente em todo ciclo.
      await dispensarOverlays()
      const url = page.url()
      // URL muda quando publica
      if (url.includes('/tiktokstudio/content') || url.includes('/profile') || url.includes('/manage')) { ok = true; break }
      // Texto de sucesso (PT/EN)
      const success = await page.evaluate(() => {
        const texts = ['vídeo publicado', 'video publicado', 'video published', 'video uploaded', 'video is being uploaded', 'seu vídeo está sendo carregado', 'publicado com sucesso']
        for (const el of document.querySelectorAll('span, div, p, h1, h2, h3')) {
          const t = (el.textContent || '').trim().toLowerCase()
          if (texts.some(x => t === x || t.startsWith(x))) return true
        }
        return false
      }).catch(() => false)
      if (success) { ok = true; break }
    }

    if (!ok) { log('❌ Timeout no upload TikTok'); return false }
    log('✅ Vídeo postado no TikTok!')
    liveView.updateStatus(liveJobId, 'Postado!')
    return true
  } finally {
    if (!jobId) liveView.unregister(liveJobId)
    await browser.close()
  }
}
