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

    // Post button — v1.0.47: 5 estrategias em fallback (data-e2e, aria-label,
    // texto contains, type=submit, ultimo botao do form) + captura de debug
    // (screenshot+HTML) quando todas falham. Antes era so texto EXATO, mas o
    // TikTok empacota o texto com SVG/spinner e nao bateu.
    let posted = false
    const MAX_ATTEMPTS = 5
    let lastDebug = null
    for (let tentativa = 1; tentativa <= MAX_ATTEMPTS && !posted; tentativa++) {
      try {
        // 1. Dispensa popups + scroll pro footer do modal de publicacao
        await page.evaluate(() => {
          document.querySelectorAll('[data-floating-ui-portal], #react-joyride-portal, #react-joyride__portal').forEach(el => {
            try { el.remove() } catch {}
          })
          const main = document.querySelector('main, [class*="ContentForm"], [class*="UploadCard"]')
          if (main) main.scrollTop = main.scrollHeight
          window.scrollTo(0, document.body.scrollHeight)
        }).catch(() => {})
        await delay(1200)

        // 2. Aguarda upload terminar (detecta porcentagem ou texto de progresso)
        const uploadInProgress = await page.evaluate(() => {
          const text = (document.body.innerText || '').toLowerCase()
          // Indicadores de upload em andamento
          if (/uploading.*\d+%|carregando.*\d+%|loading\s*\d+%/.test(text)) return true
          if (/\b(uploading|carregando|fazendo upload)\b/.test(text) && !/upload(ed|ado|ou)/.test(text)) return true
          return false
        })
        if (uploadInProgress) {
          log(`   tentativa ${tentativa}: upload ainda em andamento, aguardando 5s...`)
          await delay(5000)
          continue
        }

        // 3. Multipla estrategia de detecao do botao Post — em ordem de confianca
        const found = await page.evaluate(() => {
          const isVisible = (el) => {
            if (!el) return false
            const r = el.getBoundingClientRect()
            if (r.width < 30 || r.height < 16) return false
            const s = getComputedStyle(el)
            if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) return false
            return true
          }
          const isClickable = (el) => {
            if (el.disabled) return false
            if (el.getAttribute('aria-disabled') === 'true') return false
            return true
          }
          // ── Estrategia 1: data-e2e contendo "post"/"publish"/"submit"
          const e2eSelectors = [
            '[data-e2e="post_video_button"]', '[data-e2e="publish-button"]', '[data-e2e="post-button"]',
            '[data-e2e*="post_video"]', '[data-e2e*="publish"]', '[data-e2e*="submit"]',
          ]
          for (const sel of e2eSelectors) {
            const el = document.querySelector(sel)
            if (el && isVisible(el) && isClickable(el)) return { el, strategy: `e2e:${sel}` }
          }
          // ── Estrategia 2: aria-label = post/publish/publicar/postar (case-insensitive)
          const aria = Array.from(document.querySelectorAll('[aria-label]')).filter(el => {
            const a = (el.getAttribute('aria-label') || '').trim().toLowerCase()
            if (!/^(post|publish|publicar|postar)( now| agora)?$/.test(a)) return false
            return isVisible(el) && isClickable(el)
          })
          if (aria.length > 0) {
            aria.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
            return { el: aria[0], strategy: 'aria-label' }
          }
          // ── Estrategia 3: texto innerText/textContent CONTAINS palavras-chave
          // (mais permissivo — TikTok pode ter "Post agora", "Publish now", etc)
          const all = Array.from(document.querySelectorAll('button, [role="button"], div[class*="Button"], div[tabindex]'))
          const textCandidates = all.filter(el => {
            const inner = (el.innerText || '').trim().toLowerCase().replace(/\s+/g, ' ')
            const tc = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ')
            const t = inner || tc
            // Match: exato, "post now", "publicar agora", "postar", "publish"
            const matches = /^(post|publish|publicar|postar)( (now|agora))?$/.test(t)
            if (!matches) return false
            return isVisible(el) && isClickable(el)
          })
          if (textCandidates.length > 0) {
            // Prioriza o que esta MAIS A BAIXO + MAIS A DIREITA (rodape do form)
            textCandidates.sort((a, b) => {
              const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
              if (Math.abs(ra.top - rb.top) > 50) return rb.top - ra.top
              return rb.left - ra.left
            })
            return { el: textCandidates[0], strategy: 'text-contains' }
          }
          // ── Estrategia 4: button[type=submit] dentro de form com input file
          const forms = Array.from(document.querySelectorAll('form')).filter(f => f.querySelector('input[type="file"], video'))
          for (const f of forms) {
            const submit = f.querySelector('button[type="submit"]:not([disabled])')
            if (submit && isVisible(submit) && isClickable(submit)) return { el: submit, strategy: 'form-submit' }
          }
          // ── Estrategia 5: botao "primario" mais a baixo (heuristica visual)
          // Procura buttons com background colorido (vermelho TikTok #FE2C55, ou solido)
          const primaryBtns = all.filter(el => {
            if (!isVisible(el) || !isClickable(el)) return false
            const s = getComputedStyle(el)
            const bg = s.backgroundColor
            // Vermelho TikTok ou rosa magenta ou qualquer cor RGB nao-transparente
            if (bg.includes('254, 44, 85') || bg.includes('254,44,85')) return true // FE2C55
            if (/rgb\((25[0-5]|2[0-4]\d|1\d\d), \d+, \d+\)/.test(bg)) return true // vermelho-ish
            return false
          })
          if (primaryBtns.length > 0) {
            primaryBtns.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
            return { el: primaryBtns[0], strategy: 'primary-color' }
          }
          return null
        })

        if (!found) {
          // Captura debug pra inspecao offline
          lastDebug = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('button, [role="button"]'))
            return {
              url: location.href,
              buttonsCount: all.length,
              firstButtons: all.slice(0, 30).map(el => ({
                tag: el.tagName,
                text: (el.innerText || el.textContent || '').trim().slice(0, 40),
                ariaLabel: el.getAttribute('aria-label'),
                dataE2e: el.getAttribute('data-e2e'),
                disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
              })),
            }
          }).catch(() => null)
          throw new Error('Botão Post não encontrado (5 estrategias falharam)')
        }

        const handle = await page.evaluateHandle(({ strategy }) => {
          // Re-acha pelo strategy retornado (evita serializar el)
          // Usa MutationObserver-friendly: refaz a busca completa
          const sels = {
            'e2e:[data-e2e="post_video_button"]': () => document.querySelector('[data-e2e="post_video_button"]'),
          }
          if (sels[strategy]) return sels[strategy]()
          // Fallback: pega o ultimo botao visivel com texto que match
          const all = Array.from(document.querySelectorAll('button, [role="button"], div[class*="Button"], div[tabindex]'))
          const match = all.filter(el => {
            const t = (el.innerText || el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ')
            return /^(post|publish|publicar|postar)( (now|agora))?$/.test(t) ||
                   /^(post|publish|publicar|postar)$/i.test((el.getAttribute('aria-label') || '').trim())
          })
          match.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
          return match[0] || null
        }, { strategy: found.strategy })

        const el = handle.asElement()
        if (!el) throw new Error('handle perdido entre evaluate e click')

        log(`   tentativa ${tentativa}: achei via ${found.strategy}`)
        await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
        await delay(500)
        try {
          await el.click({ force: true, timeout: 8000 })
          posted = true
          log(`📤 Publicando... (tentativa ${tentativa})`)
        } catch (clickErr) {
          // Fallback: JS click direto
          await page.evaluate((node) => node.click(), el).catch(() => {})
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
        await el.dispose?.()
      } catch (e) {
        log(`   tentativa ${tentativa}/${MAX_ATTEMPTS} falhou: ${e.message.split('\n')[0].slice(0, 80)}`)
        await delay(1500)
      }
    }

    if (!posted) {
      // Salva debug pra cliente compartilhar com TamoIA
      try {
        const debugDir = path.join(dataDir, 'debug')
        fs.mkdirSync(debugDir, { recursive: true })
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const pngPath = path.join(debugDir, `tt-post-fail-${ts}.png`)
        const jsonPath = path.join(debugDir, `tt-post-fail-${ts}.json`)
        await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {})
        fs.writeFileSync(jsonPath, JSON.stringify({ ts, url: page.url(), debug: lastDebug }, null, 2))
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
