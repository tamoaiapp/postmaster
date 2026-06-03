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

    // Post button — usa force:true pra ignorar overlay caso ainda exista
    let posted = false
    for (let tentativa = 1; tentativa <= 3 && !posted; tentativa++) {
      try {
        // Re-dispensa popups antes de cada tentativa
        if (tentativa > 1) {
          await page.evaluate(() => {
            document.querySelectorAll('[data-floating-ui-portal]').forEach(el => {
              try { el.remove() } catch {}
            })
          }).catch(() => {})
          await delay(1000)
        }
        // Tenta clicar via locator com force
        const btn = page.locator('button:has-text("Post"), button:has-text("Publicar"), div[data-e2e="post_video_button"]').first()
        if (await btn.count() > 0) {
          await btn.click({ force: true, timeout: 10000 })
          posted = true
          log(`📤 Publicando... (tentativa ${tentativa})`)
        } else throw new Error('Botão Post não encontrado')
      } catch (e) {
        log(`   tentativa ${tentativa} falhou: ${e.message.split('\n')[0].slice(0, 80)}`)
      }
    }
    if (!posted) throw new Error('Botão Post não conseguiu ser clicado mesmo com force após 3 tentativas')
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
