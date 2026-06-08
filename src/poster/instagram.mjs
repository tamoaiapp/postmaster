/**
 * Posta Reel no Instagram via Playwright.
 * Baseado no poster.js do master-agent (versão produção).
 */

import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import * as liveView from '../liveView.mjs'
import { getChromiumExe } from '../playwrightExe.mjs'

const delay = ms => new Promise(r => setTimeout(r, ms))

export async function postReelInstagram({ account, videoPath, caption, dataDir, log, jobId }) {
  const sessionFile = path.join(dataDir, 'sessions', `ig-${account}.json`)
  if (!fs.existsSync(sessionFile)) throw new Error(`Sessão não encontrada para @${account}. Faça login primeiro.`)

  const browser = await chromium.launch({
    headless: true,
    executablePath: getChromiumExe() || undefined,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const ctx = await browser.newContext({
    storageState: sessionFile,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    // Polyfill: substitui showOpenFilePicker por <input type="file"> padrao
    // pra que Playwright intercepte o filechooser event normalmente.
    // O Instagram novo usa showOpenFilePicker(), nao input[type=file] mais.
    window.showOpenFilePicker = (options) => new Promise((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'video/*,image/*'
      input.multiple = !!(options && options.multiple)
      input.style.cssText = 'position:fixed;top:-9999px;opacity:0'
      document.body.appendChild(input)
      input.addEventListener('change', () => {
        document.body.removeChild(input)
        resolve(Array.from(input.files).map(f => ({ kind: 'file', name: f.name, getFile: async () => f })))
      })
      input.addEventListener('cancel', () => {
        document.body.removeChild(input)
        reject(new DOMException('The user aborted a request.', 'AbortError'))
      })
      input.click()
    })
  })
  const page = await ctx.newPage()

  // Anexa o page ao card existente do Live View (jobRunner ja registrou)
  const liveJobId = jobId || `${account}-${Date.now()}`
  if (jobId) {
    liveView.attachPage(liveJobId, page)
  } else {
    liveView.register(liveJobId, page, { account, platform: 'instagram', status: 'iniciando' })
  }

  // Injeta CSS persistente que neutraliza overlays MESMO se o React re-renderizar.
  // Sem isso, basta o React re-criar o overlay milissegundos depois do el.remove() pra
  // travar o proximo click (problema observado no TikTok do cliente em 31/05).
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

  // Helper: remove overlays/tours que interceptam clicks (react-joyride, tooltips, popups)
  const dispensarOverlays = async () => {
    await installAntiOverlayCss()
    await page.evaluate(() => {
      document.querySelectorAll('#react-joyride-portal, #react-joyride__portal, .react-joyride__overlay, [data-test-id="overlay"]').forEach(el => { try { el.remove() } catch {} })
      document.querySelectorAll('[role="tooltip"]').forEach(el => { try { el.remove() } catch {} })
      // Botoes "Pular tour", "Got it", "Skip"
      const skipTexts = ['pular', 'skip', 'got it', 'entendi', 'ok, entendi', 'fechar tour']
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        const t = (el.textContent || '').trim().toLowerCase()
        if (skipTexts.some(x => t === x)) { try { el.click() } catch {} }
      }
      // Modal "Discard post?" / "Descartar publicacao?" / "Are you sure you want to leave?" —
      // IG mostra esse dialog se algo no fluxo dispara navegacao. Clica no botao SEGURO
      // (Cancelar / Cancel / Continue editing) e NUNCA no que descarta (Discard / Descartar).
      const dialogText = document.body.innerText.toLowerCase()
      const isDiscardDialog =
        (dialogText.includes('descartar') && (dialogText.includes('publicac') || dialogText.includes('post'))) ||
        (dialogText.includes('discard') && dialogText.includes('post')) ||
        (dialogText.includes('are you sure') && dialogText.includes('leave')) ||
        (dialogText.includes('tem certeza') && dialogText.includes('sair'))
      if (isDiscardDialog) {
        const stayLabels = ['cancelar', 'cancel', 'não', 'nao', 'continue editing', 'continuar editando', 'ficar', 'stay']
        const dangerLabels = ['descartar', 'discard', 'sair', 'leave', 'sim', 'yes']
        const stayBtn = [...document.querySelectorAll('button, [role="button"]')].find(b => {
          const t = (b.textContent || '').trim().toLowerCase()
          return stayLabels.includes(t) && !dangerLabels.includes(t)
        })
        if (stayBtn) { try { stayBtn.click() } catch {} }
      }
    }).catch(() => {})
  }

  // Intercept caption via API (função matcher — mais confiável que glob)
  const safeCaption = (caption || '').substring(0, 2200)
  await page.route(url => url.href.includes('/media/configure'), async route => {
    try {
      const params = new URLSearchParams(route.request().postData() || '')
      params.set('caption', safeCaption)
      const response = await route.fetch({
        postData: params.toString(),
        headers: { ...route.request().headers(), 'content-type': 'application/x-www-form-urlencoded' },
      })
      log('Caption injetada via intercept')
      await route.fulfill({ response })
    } catch { await route.continue() }
  })

  try {
    log('Abrindo Instagram...')
    liveView.updateStatus(liveJobId, 'Abrindo Instagram')
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(3000)

    // Dispensar popups (notificações, cookies)
    await dismissPopups(page)

    // Verificar conta logada
    liveView.updateStatus(liveJobId, 'Verificando conta')
    await verificarConta(page, account, log)

    // FLUXO DE UPLOAD — robusto contra mudanças da UI do IG
    // Estratégia: registra filechooser PROACTIVE + tenta múltiplas variantes de cliques
    liveView.updateStatus(liveJobId, 'Abrindo upload')
    const fcPromise = page.waitForEvent('filechooser', { timeout: 90000 }).catch(() => null)

    // Path do data dir pra screenshots de debug (so se sentry/debug habilitado)
    const debugDir = path.join(dataDir, 'debug')
    fs.mkdirSync(debugDir, { recursive: true })
    const dbgShot = async (tag) => {
      try { await page.screenshot({ path: path.join(debugDir, `ig-${account}-${tag}-${Date.now()}.png`) }) } catch {}
    }

    // Remove overlays do tour onboarding antes de qualquer click
    await dispensarOverlays()

    // 1. Clica em "Criar" / +
    log('Clicando "Criar"...')
    const criarLabels = ['New post', 'Novo post', 'Create', 'Criar']
    let criarClicado = false
    for (const lbl of criarLabels) {
      const el = page.locator(`[aria-label="${lbl}"]`).first()
      if (await el.count() > 0) {
        await el.click()
        log(`   → "${lbl}" clicado`)
        criarClicado = true
        break
      }
    }
    if (!criarClicado) {
      await dbgShot('no-criar-btn')
      throw new Error('Botão "Criar" não encontrado no sidebar')
    }
    await delay(2500)
    await dbgShot('after-criar')

    // 2. Tenta clicar em "Reel" ou "Postar" no dropdown que apareceu.
    // O dropdown nao eh um menu separado — sao itens que aparecem dentro do sidebar.
    // Estrategia: procura items recem-aparecidos no sidebar com textos especificos.
    log('Procurando item de upload no menu...')
    const itemClicado = await page.evaluate(() => {
      const targets = ['Reel', 'Postar', 'Post', 'Publicação', 'Publication']
      // Busca em ordem de prioridade: Reel > Postar > Post
      for (const target of targets) {
        const candidates = []
        // Procura todos os elementos com texto exato OU aria-label exato
        for (const el of document.querySelectorAll('a, button, div[role="button"], [role="menuitem"], [tabindex="0"], svg, span')) {
          const t = (el.textContent || '').trim()
          const lbl = el.getAttribute('aria-label') || ''
          if (t === target || lbl === target) candidates.push(el)
        }
        // Pula o "Reels" (plural) do sidebar — só queremos "Reel" singular
        const valid = candidates.filter(el => {
          const t = (el.textContent || '').trim()
          return t === target // texto EXATO (Reels nao bate com Reel)
        })
        if (valid.length > 0) {
          // Pega o primeiro clicavel
          for (const el of valid) {
            const clickable = el.closest('a, button, [role="button"], [role="menuitem"], [tabindex="0"]') || el
            try { clickable.click(); return target } catch {}
          }
        }
      }
      return null
    }).catch(() => null)

    if (itemClicado) {
      log(`   → "${itemClicado}" clicado`)
    } else {
      log('   ⚠️ Nenhum item ("Reel"/"Postar") encontrado — seguindo direto pro modal')
      await dbgShot('no-menu-item')
    }
    await delay(3500)
    await dbgShot('after-menu-item')

    // 3. Aguarda modal de upload aparecer
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 }).catch(() => {})
    await delay(1500)
    await dispensarOverlays() // remove tour de novo se reapareceu
    liveView.updateStatus(liveJobId, 'Enviando vídeo')

    // 4. Tenta clicar em "Selecionar do computador" se ainda existir
    // v1.2.2: el.click() sintetico nao dispara onClick React do IG. Usa Playwright
    // page.locator().click() que simula mouse real (down/up/event bubble) e o IG
    // entende como interacao humana, disparando o filechooser.
    log('Procurando "Selecionar do computador"...')
    let uploadBtn = null
    const variants = ['Selecionar do computador', 'Select from computer', 'Selecionar arquivos do computador', 'Select files from computer']
    for (const v of variants) {
      try {
        const loc = page.locator(`role=button[name="${v}"], button:has-text("${v}"), [role="button"]:has-text("${v}")`).first()
        if (await loc.count().catch(() => 0) > 0) {
          await loc.click({ timeout: 4000, force: true }).catch(async () => {
            // Fallback: pega o elemento e click via mouse coords
            const box = await loc.boundingBox()
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          })
          uploadBtn = v
          break
        }
      } catch {}
    }
    if (uploadBtn) log(`   → "${uploadBtn}" clicado via Playwright`)
    else log('   → botão não encontrado, esperando filechooser por outro caminho')

    // 5. Aguarda filechooser (disparado pelo showOpenFilePicker polyfilled OU input nativo)
    log('Aguardando filechooser (até 90s)...')
    const fc = await fcPromise
    let fileSelected = false
    if (fc) {
      await fc.setFiles(videoPath)
      log('✅ Arquivo selecionado (filechooser+polyfill)')
      fileSelected = true
    }

    // 6. Fallback final: input[type=file] direto (IG antigo)
    if (!fileSelected) {
      log('Filechooser timeout — tentando input[type=file] direto...')
      const inputs = await page.$$('input[type="file"]')
      for (const inp of inputs) {
        try {
          await inp.setInputFiles(videoPath)
          log('✅ Arquivo selecionado (input direto)')
          fileSelected = true
          break
        } catch {}
      }
    }

    if (!fileSelected) {
      await dbgShot('upload-failed')
      throw new Error('Upload falhou — IG não disparou filechooser nem expôs input[type=file]. Veja screenshots em ' + debugDir)
    }
    await delay(18000) // upload + processamento do video pelo IG

    // Detecta dialog de erro do IG ("Este arquivo de vídeo não pôde ser lido por esse navegador" /
    // "This file could not be played in this browser"). Quando o IG rejeita o codec/container,
    // ele NAO mostra o botao Avançar — antes a gente ficava girando o clickNext ate timeout
    // (40s+) e o cliente nao entendia. Agora deteta na hora e falha com msg clara,
    // marcando o video como problematico pra nao tentar de novo no proximo ciclo.
    const igRejection = await page.evaluate(() => {
      const text = (document.body.innerText || '').toLowerCase()
      const phrases = [
        'não foi possível carregar o vídeo',
        'nao foi possivel carregar o video',
        'este arquivo de vídeo não pôde ser lido',
        'este arquivo de video nao pode ser lido',
        'could not be played in this browser',
        "couldn't be played in this browser",
        'this video file could not be',
        'não foi possível processar',
        'video could not be processed',
        'selecionar outros arquivos',
        'select other files',
      ]
      const match = phrases.find(p => text.includes(p))
      return match ? { matched: match, fullText: text.slice(0, 800) } : null
    }).catch(() => null)
    if (igRejection) {
      await dbgShot('ig-rejected-codec')
      log(`❌ Instagram rejeitou o vídeo: "${igRejection.matched}"`)
      log(`   Provavelmente codec/container incompatível. O vídeo será marcado pra não tentar de novo.`)
      throw new Error('ig_rejected_video: ' + igRejection.matched)
    }

    // Dispensar popup "Agora os posts de vídeo são compartilhados como reels".
    // ATENCAO: usar locator+count, NAO page.click direto. page.click espera o
    // selector aparecer pelo timeout default (30s) — se o popup nao existe, atrasa
    // cada post em 30 segundos!
    const okBtn = page.locator('button:has-text("OK"), button:has-text("Ok")').first()
    if (await okBtn.count() > 0) {
      await okBtn.click({ timeout: 2000 }).catch(() => {})
    }
    await delay(1000)

    // Avançar: Crop → Filtros → Caption (2 cliques de Next)
    await clickNext(page, log, 20000)
    await delay(2500)
    await clickNext(page, log, 15000)
    await delay(2500)

    // Compartilhar (scoped no dialog)
    log('Compartilhando...')
    await dispensarOverlays()
    liveView.updateStatus(liveJobId, 'Publicando')
    let shared = false
    const shareDeadline = Date.now() + 15000
    while (Date.now() < shareDeadline && !shared) {
      for (const sel of [
        '[role="dialog"] div[role="button"]:has-text("Compartilhar")',
        '[role="dialog"] div[role="button"]:has-text("Share")',
        '[role="dialog"] button:has-text("Compartilhar")',
        '[role="dialog"] button:has-text("Share")',
      ]) {
        const loc = page.locator(sel).first()
        if (await loc.count() > 0) {
          await loc.click()
          shared = true
          break
        }
      }
      if (!shared) await delay(500)
    }
    if (!shared) throw new Error('Botão Compartilhar não encontrado')

    // Aguarda confirmação visual (até 60s para Reels)
    await page.waitForSelector(
      'span:has-text("Your post has been shared"), ' +
      'span:has-text("Seu post foi compartilhado"), ' +
      'span:has-text("Your reel has been shared"), ' +
      'span:has-text("Seu reel foi compartilhado"), ' +
      'h2:has-text("shared"), h2:has-text("compartilhado")',
      { timeout: 60000 }
    ).catch(async () => {
      // Sem confirmação visual — aguarda upload terminar e assume sucesso
      log('   → aguardando upload completar...')
      await delay(10000)
    })

    // Salva sessão atualizada
    await ctx.storageState({ path: sessionFile })
    log('Reel postado no Instagram!')
    liveView.updateStatus(liveJobId, 'Postado!')
    return true

  } finally {
    // unregister fica a cargo do jobRunner (ele registrou primeiro)
    if (!jobId) liveView.unregister(liveJobId)
    await browser.close()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function dismissPopups(page) {
  await page.evaluate(() => {
    const texts = ['Agora não', 'Not Now', 'Cancelar', 'Cancel', 'Fechar', 'Close', 'Depois', 'Later']
    for (const text of texts) {
      const el = [...document.querySelectorAll('button, [role="button"]')].find(e => e.textContent.trim() === text)
      if (el) { el.click(); return }
    }
  }).catch(() => {})
}

async function verificarConta(page, account, log) {
  const loggedUser = await page.evaluate(() => {
    const skip = new Set(['explore', 'reels', 'direct', 'stories', 'accounts', 'p', 'tv', 'reel'])
    for (const a of document.querySelectorAll('a[href]')) {
      const m = a.href.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?$/)
      if (m && m[1] && !skip.has(m[1]) && !m[1].startsWith('#')) return m[1]
    }
    return null
  }).catch(() => null)

  if (loggedUser && loggedUser.toLowerCase() !== account.toLowerCase()) {
    log(`Conta logada: @${loggedUser} (esperado: @${account})`)
  } else if (loggedUser) {
    log(`Conta: @${loggedUser}`)
  }
}

async function clickNext(page, log, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    // Remove overlays react-joyride antes de cada tentativa (cobre - e __ — TikTok usa um, IG usa outro)
    await page.evaluate(() => {
      document.querySelectorAll('#react-joyride-portal, #react-joyride__portal, .react-joyride__overlay, [data-test-id="overlay"]').forEach(el => { try { el.remove() } catch {} })
    }).catch(() => {})
    const clicked = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const scope = dialog || document
      for (const label of ['Avançar', 'Next', 'Próximo']) {
        const byLabel = scope.querySelector(`[aria-label="${label}"]`)
        if (byLabel) {
          ;(byLabel.closest('a,button,[role="button"]') || byLabel).click()
          return label
        }
        const byText = [...scope.querySelectorAll('button, [role="button"], div[tabindex]')]
          .find(el => el.children.length === 0 && el.textContent.trim() === label)
        if (byText) { byText.click(); return label }
      }
      return null
    }).catch(() => null)
    if (clicked) { log(`   → "${clicked}" clicado`); return }
    await delay(500)
  }
  throw new Error('Botão Next/Avançar não encontrado no dialog')
}
