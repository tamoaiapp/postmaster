/**
 * Posta vídeo no TikTok via Playwright.
 */

import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import * as liveView from '../liveView.mjs'
import { getChromiumExe } from '../playwrightExe.mjs'

const delay = ms => new Promise(r => setTimeout(r, ms))

export async function postVideoTikTok({ account, videoPath, caption, dataDir, log, jobId }) {
  const sessionFile = path.join(dataDir, 'sessions', `tk-${account}.json`)
  if (!fs.existsSync(sessionFile)) throw new Error(`Sessão não encontrada para @${account}. Faça login primeiro.`)

  const browser = await chromium.launch({
    headless: true,
    executablePath: getChromiumExe() || undefined,
    args: ['--no-sandbox'],
  })
  const ctx = await browser.newContext({
    storageState: sessionFile,
    viewport: { width: 1280, height: 900 },
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
    await page.addStyleTag({ content: `
      #react-joyride-portal, #react-joyride__portal,
      .react-joyride__overlay, [data-test-id="overlay"],
      .react-joyride__spotlight, .react-joyride__beacon,
      .react-joyride__tooltip {
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
    // Remove tour onboarding ANTES do upload (pode aparecer logo na primeira visita)
    await dispensarOverlays()

    // Upload file — TikTok esconde o input com display:none, mas Playwright
    // setInputFiles funciona em elementos hidden. waitForSelector default espera
    // visivel, entao usa state:'attached' pra aceitar hidden tambem.
    liveView.updateStatus(liveJobId, 'Enviando vídeo')
    // Timeout 60s — TikTok Studio as vezes demora muito quando ha varios uploads em paralelo
    const fileInput = await page.waitForSelector('input[type="file"]', {
      state: 'attached',
      timeout: 60000,
    })
    await fileInput.setInputFiles(videoPath)
    log('📎 Arquivo selecionado')
    await delay(5000)

    // Aguarda preview
    await page.waitForSelector('video', { timeout: 60000 }).catch(() => {})
    await delay(2000)

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

    // Post button — robusto contra: seletor errado pegando "Post a comment",
    // upload ainda em andamento (botao disabled), overlay re-renderizado, footer
    // fora da viewport. v1.0.46+: usa data-e2e estavel, texto EXATO, scroll, e
    // fallback de keyboard.
    let posted = false
    const MAX_ATTEMPTS = 5
    for (let tentativa = 1; tentativa <= MAX_ATTEMPTS && !posted; tentativa++) {
      try {
        // 1. Dispensa popups + scroll pro footer do modal de publicacao
        await page.evaluate(() => {
          document.querySelectorAll('[data-floating-ui-portal], #react-joyride-portal, #react-joyride__portal').forEach(el => {
            try { el.remove() } catch {}
          })
          // Scroll pro fim do form de publicacao (botao Post fica no rodape)
          const main = document.querySelector('main, [class*="ContentForm"], [class*="UploadCard"]')
          if (main) main.scrollTop = main.scrollHeight
          window.scrollTo(0, document.body.scrollHeight)
        }).catch(() => {})
        await delay(1200)

        // 2. Aguarda upload terminar (botao fica disabled durante upload)
        const uploadInProgress = await page.evaluate(() => {
          // Procura indicadores: "uploading", "carregando", "%", spinner ativo
          const text = (document.body.innerText || '').toLowerCase()
          if (/uploading|carregando|loading\s*\d+%/.test(text)) return true
          // Botao Post com aria-disabled
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
          const postBtn = btns.find(b => {
            const t = (b.innerText || '').trim().toLowerCase()
            return t === 'post' || t === 'publicar' || t === 'postar'
          })
          if (postBtn && (postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true')) return true
          return false
        })
        if (uploadInProgress) {
          log(`   tentativa ${tentativa}: upload ainda em andamento, aguardando 5s...`)
          await delay(5000)
          continue
        }

        // 3. Acha o botao Post REAL — texto EXATO + dentro de container de publicacao
        // (evita "Post a comment", "Posts", "Postagens" do menu lateral)
        const btnHandle = await page.evaluateHandle(() => {
          // Estrategia 1: data-e2e (mais estavel quando existe)
          const e2e = document.querySelector('[data-e2e="post_video_button"], [data-e2e="publish-button"], [data-e2e="post-button"]')
          if (e2e && !e2e.disabled && e2e.getAttribute('aria-disabled') !== 'true') return e2e
          // Estrategia 2: button com texto EXATO Post/Publicar (case-insensitive, trim)
          const all = Array.from(document.querySelectorAll('button, [role="button"], div[class*="Button"]'))
          // Filtra: precisa texto exato + estar visivel + nao disabled
          const candidates = all.filter(el => {
            const t = (el.innerText || '').trim().toLowerCase()
            if (t !== 'post' && t !== 'publicar' && t !== 'postar') return false
            const r = el.getBoundingClientRect()
            if (r.width < 40 || r.height < 20) return false // muito pequeno = nao eh botao real
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
            return true
          })
          // Prioriza o que ta no footer/rodape do form (mais a baixo na pagina)
          candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)
          return candidates[0] || null
        })
        const el = btnHandle.asElement()
        if (!el) {
          await btnHandle.dispose?.()
          throw new Error('Botão Post não encontrado (sem candidato com texto exato)')
        }

        // 4. Scroll ate o botao + click via JS (evita overlay)
        await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
        await delay(500)
        // Tenta click nativo do Playwright primeiro (force=true)
        try {
          await el.click({ force: true, timeout: 8000 })
          posted = true
          log(`📤 Publicando... (tentativa ${tentativa})`)
        } catch (clickErr) {
          // Fallback: dispatch JS click event direto (ignora qualquer overlay)
          await page.evaluate((node) => node.click(), el).catch(() => {})
          await delay(1500)
          // Confirma se de fato saiu da pagina de upload
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
        await el.dispose?.()
      } catch (e) {
        log(`   tentativa ${tentativa}/${MAX_ATTEMPTS} falhou: ${e.message.split('\n')[0].slice(0, 80)}`)
        await delay(1500)
      }
    }
    if (!posted) throw new Error('tt_post_button_failed: TikTok mudou o layout do botao Post ou upload travou. App vai detectar e arrumar em update.')
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
