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

// v1.0.68: Detecta bloqueio que precisa human action
// (verificacao identidade, captcha, 2FA, login expirado).
async function detectHumanRequired(page) {
  const url = page.url()
  if (/accounts\.google\.com|\/signin|ServiceLogin|challenge\/recaptcha|two-step/i.test(url)) {
    return { required: true, kind: 'login_or_2fa', url }
  }
  const flag = await page.evaluate(() => {
    const txt = (document.body.innerText || '').toLowerCase()
    if (/confirme sua identidade|verify your identity|verifique sua identidade/.test(txt)) return 'identity_check'
    if (/verifica[çc][aã]o em (duas|2) etapas|2-step verification/.test(txt)) return '2fa'
    if (/captcha|recaptcha|sou um humano|i'm not a robot/.test(txt)) return 'captcha'
    if (/senha incorreta|wrong password/.test(txt)) return 'wrong_password'
    return null
  }).catch(() => null)
  if (flag) return { required: true, kind: flag, url }
  return { required: false }
}

// Pede ao main process pra abrir BrowserWindow Electron pro user resolver.
// Retorna true se user terminou (e cookies foram atualizados no sessionFile).
async function requestHumanIntervention({ sessionFile, url, username, message, log }) {
  log(`👤 Intervencao humana necessaria: ${message}`)
  try {
    // Comunica com main via ipcRenderer NAO funciona aqui (estamos em main no jobRunner).
    // Acessa direto: a funcao roda no main process, mesmo processo que registra ipcMain.handle.
    // Importamos o handler em si.
    const { ipcMain } = await import('electron')
    // Hack: invoke o handler internamente. Como nao temos sender, chamamos o codigo direto via wrap.
    // Vou usar app.whenReady() + BrowserWindow direto aqui em vez de IPC.
    const electron = await import('electron')
    const result = await new Promise(async (resolve) => {
      const { BrowserWindow, session: ses } = electron
      // Carrega state atual
      let initialState = { cookies: [], origins: [] }
      try { initialState = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) } catch {}
      const partition = `persist:hi-yt-${username}-${Date.now()}`
      const electronSes = ses.fromPartition(partition)
      await electronSes.clearStorageData({ storages: ['cookies', 'localstorage'] }).catch(() => {})
      for (const c of (initialState.cookies || [])) {
        try {
          const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
          const cookie = {
            url: `${c.secure ? 'https' : 'http'}://${domain}${c.path || '/'}`,
            name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
            secure: !!c.secure, httpOnly: !!c.httpOnly,
          }
          if (c.sameSite) cookie.sameSite = String(c.sameSite).toLowerCase()
          if (c.expires && c.expires > 0) cookie.expirationDate = c.expires
          await electronSes.cookies.set(cookie).catch(() => {})
        } catch {}
      }
      const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      const win = new BrowserWindow({
        width: 1100, height: 800,
        title: `Verificação necessária — YouTube @${username}`,
        autoHideMenuBar: true,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
      })
      win.webContents.setUserAgent(REAL_UA)
      let done = false
      const finish = async () => {
        if (done) return; done = true
        try {
          const cookies = await electronSes.cookies.get({})
          const newState = {
            cookies: cookies.map(c => ({
              name: c.name, value: c.value, domain: c.domain, path: c.path,
              expires: c.expirationDate || -1,
              httpOnly: !!c.httpOnly, secure: !!c.secure,
              sameSite: (c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : 'None'),
            })),
            origins: [],
          }
          fs.writeFileSync(sessionFile, JSON.stringify(newState, null, 2))
          resolve(true)
        } catch (e) { resolve(false) }
        try { win.destroy() } catch {}
      }
      win.on('closed', finish)
      win.webContents.on('did-finish-load', () => {
        const msg = message.replace(/'/g, "\\'").replace(/\n/g, ' ')
        win.webContents.executeJavaScript(`
          (function(){
            if (document.getElementById('pm-hi-banner')) return;
            const b = document.createElement('div');
            b.id = 'pm-hi-banner';
            b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:14px 20px;font-family:Segoe UI,sans-serif;font-size:14px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 12px rgba(0,0,0,.3)';
            b.innerHTML = '<span style="font-size:24px">⚠️</span><div style="flex:1"><strong>PostMaster: ${msg}</strong><br><span style="opacity:.9;font-size:12px">Complete a etapa abaixo e <strong>FECHE ESTA JANELA</strong> quando terminar — o app vai retomar a postagem automaticamente.</span></div>';
            document.body.insertBefore(b, document.body.firstChild);
            document.body.style.paddingTop = '80px';
          })();
        `).catch(() => {})
      })
      await win.loadURL(url, { userAgent: REAL_UA }).catch(() => {})
    })
    return result
  } catch (e) {
    log(`⚠️ Falha ao abrir janela de intervencao: ${e.message.slice(0,80)}`)
    return false
  }
}

const delay = ms => new Promise(r => setTimeout(r, ms))

export async function postVideoYouTube(opts) {
  // v1.0.68: wrapper que tenta postar e em caso de bloqueio (verif identidade,
  // 2FA, etc), abre janela Electron pro user resolver, depois TENTA DE NOVO
  // do zero com sessao renovada. Max 1 retry.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await postVideoYouTubeInternal(opts)
    } catch (e) {
      const msg = e.message || ''
      const isHumanError = /yt_session_expired|yt_human_required|requires_human/.test(msg)
      if (!isHumanError || attempt === 2) throw e
      opts.log(`🔁 Tentando de novo apos intervencao humana (tentativa ${attempt + 1}/2)...`)
    }
  }
}

async function postVideoYouTubeInternal({
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
    // v1.0.72: se temos channelId salvo do login, vai DIRETO no canal certo
    // (evita cair no canal padrao da conta Google se tem multiplos canais).
    const channelIdFile = sessionFile.replace(/\.json$/, '.channelId')
    let targetUrl = 'https://studio.youtube.com/'
    try {
      if (fs.existsSync(channelIdFile)) {
        const chId = fs.readFileSync(channelIdFile, 'utf-8').trim()
        if (/^UC[\w-]+$/.test(chId)) {
          targetUrl = `https://studio.youtube.com/channel/${chId}/`
          log(`   📺 Forcando canal ${chId}`)
        }
      }
    } catch {}
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await delay(3000)
    await snap('01-after-goto')

    // v1.0.68: deteccao de bloqueio que precisa human action
    const block = await detectHumanRequired(page)
    if (block.required) {
      log(`⚠️ Bloqueio detectado: ${block.kind} (${block.url.slice(0,80)})`)
      const userResolved = await requestHumanIntervention({
        sessionFile, url: block.url, username: account,
        message: block.kind === 'identity_check' ? 'O YouTube pediu pra confirmar sua identidade'
              : block.kind === '2fa' ? 'Verificação em duas etapas necessária'
              : block.kind === 'captcha' ? 'Captcha necessário'
              : block.kind === 'login_or_2fa' ? 'Sessão expirou — faça login novamente'
              : 'Verificação necessária',
        log,
      })
      if (!userResolved) {
        throw new Error('yt_human_required: usuario fechou janela sem completar verificacao')
      }
      log('✅ Verificacao concluida pelo usuario. Reiniciando upload...')
      // Fecha browser atual e sinaliza retry
      await browser.close().catch(() => {})
      throw new Error('yt_human_required: sessao renovada, retry')
    }

    // Fecha qualquer modal/dialog de boas-vindas aberto
    await page.evaluate(() => {
      const closers = document.querySelectorAll('button, [role="button"]')
      for (const b of closers) {
        const t = (b.textContent || '').trim().toLowerCase()
        if (['fechar', 'close', 'got it', 'entendi', 'ok', 'descartar', 'dismiss'].includes(t)) {
          try { b.click() } catch {}
        }
      }
    }).catch(() => {})
    await delay(1500)

    // Clica no botao "Criar" (icone camera+ no topo direito)
    log('🎬 Clicando em "Criar"...')
    const createBtn = page.locator('ytcp-button#upload-icon, #create-icon, [aria-label*="Criar"], [aria-label*="Create"], button:has-text("Criar"):visible').first()
    if (await createBtn.count() === 0) {
      await snap('02-no-create-btn')
      throw new Error('Botao "Criar" nao encontrado no YT Studio')
    }
    await createBtn.click({ force: true, timeout: 10000 })
    await delay(2000)
    await snap('02-after-create-click')

    // Clica em "Enviar videos" no submenu
    log('📤 Clicando em "Enviar vídeos"...')
    const enviarBtn = page.getByText(/Enviar v.?deos?|Upload videos?/i).first()
    if (await enviarBtn.count() === 0) {
      await snap('02b-no-enviar-btn')
      throw new Error('Item "Enviar vídeos" do menu nao encontrado')
    }
    await enviarBtn.click({ force: true, timeout: 10000 })
    await delay(2000)
    await snap('03-after-enviar-click')

    // SetInputFiles no <input type=file>
    log('📎 Aguardando input file...')
    liveView.updateStatus(liveJobId, 'Aguardando input')
    const fileInput = await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 60000 })
    log(`📎 Input file encontrado, enviando arquivo (${Math.round(fs.statSync(videoPath).size/1024/1024)}MB)...`)
    await fileInput.setInputFiles(videoPath)
    await delay(3000)
    await snap('04-after-setInputFiles')

    // Aguarda dialogo de detalhes abrir (input de titulo aparece)
    log('⏳ Aguardando dialogo de detalhes abrir (ate 3min)...')
    try {
      await page.waitForSelector('ytcp-mention-textbox, [id="title-textarea"], #title-textarea', { timeout: 180000 })
    } catch (e) {
      await snap('03-textbox-timeout')
      // v1.0.68: pode ser modal de identidade aqui tambem
      const block = await detectHumanRequired(page)
      if (block.required) {
        log(`⚠️ Bloqueio mid-upload: ${block.kind}`)
        const ok = await requestHumanIntervention({
          sessionFile, url: page.url(), username: account,
          message: 'O YouTube pediu confirmação durante o upload',
          log,
        })
        if (ok) { await browser.close().catch(() => {}); throw new Error('yt_human_required: retry') }
      }
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
    // v1.0.65: YouTube agora usa "Sim, é conteúdo para crianças" / "Não é conteúdo para crianças"
    // O seletor tp-yt-paper-radio-button[name=MADE_FOR_KIDS] parou de funcionar.
    log('👶 Marcando audiencia (kids)...')
    const kidsText = madeForKids ? 'Sim, é conteúdo para crianças' : 'Não é conteúdo para crianças'
    const clickedKids = await page.evaluate((label) => {
      // Procura label ou span com o texto e clica no radio mais proximo
      const all = [...document.querySelectorAll('tp-yt-paper-radio-button, label, [role="radio"]')]
      for (const el of all) {
        const t = (el.innerText || el.textContent || '').trim()
        if (t === label || t.startsWith(label)) {
          try { el.click(); return true } catch {}
        }
      }
      // Fallback: procura por aria-label
      const ariaMatch = document.querySelector(`tp-yt-paper-radio-button[name*="${label.includes('Sim') ? 'MADE_FOR_KIDS' : 'NOT_MADE_FOR_KIDS'}"]`)
      if (ariaMatch) { try { ariaMatch.click(); return true } catch {} }
      return false
    }, kidsText)
    if (!clickedKids) log(`   ⚠️ Nao consegui marcar "${kidsText}" — videos com erro nao publicam`)
    else log(`   ✓ Marcou "${kidsText}"`)
    await delay(1500)
    await snap('04b-after-kids')

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

    // ── Aguarda upload finalizar — esperando #done-button ficar enabled+visible
    // v1.0.65: a v anterior usava texto da pagina (frágil) e desistia em 30s,
    // entao tentava clicar #done-button com disabled hidden -> falhava.
    // Agora espera ate o botao realmente estar pronto pra clicar.
    log('⏳ Aguardando upload terminar + botao Publicar ficar enabled (ate 15min)...')
    // Polling manual — waitForFunction ignorava o timeout customizado.
    const maxMs = 15 * 60 * 1000
    const t0 = Date.now()
    let ready = false
    let lastPct = -1
    // v1.0.78: detecta modal "Confirme sua identidade" que aparece DURANTE upload
    // (depois do upload concluir, antes do botao Publicar ficar enabled).
    // Tenta clicar "Avancar" pra prosseguir — se aparecer SMS/2FA depois,
    // o post falha e user precisa fazer manual via intervencao humana
    // v1.0.79: click do modal "Confirme sua identidade" via Playwright locator
    // (simula mouse real). Antes era el.click() em page.evaluate (JS direto) e
    // YT detectava como bot, o Avancar nao validava, modal voltava infinitamente
    let modalAvancarTries = 0
    while (Date.now() - t0 < maxMs) {
      const state = await page.evaluate(() => {
        const txt = (document.body.innerText || '').toLowerCase()
        const hasIdentityModal = /confirme sua identidade|verify your identity/.test(txt)
        const btn = document.querySelector('#done-button')
        if (!btn) return { ready: false, pct: null, hasIdentityModal }
        const disabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('hidden')
        const allText = document.body.innerText || ''
        const pctMatch = allText.match(/(\d{1,3})%/)
        return { ready: !disabled, pct: pctMatch ? parseInt(pctMatch[1]) : null, hasIdentityModal }
      })
      if (state.hasIdentityModal) {
        modalAvancarTries++
        if (modalAvancarTries === 1) {
          // v1.0.80: anti-bot do YT desabilita o botao Avancar no modal de
          // identidade quando detecta automation. Click via Playwright falha
          // ('button is disabled'). Unica saida: pausa script ate user clicar
          // manualmente no Chrome aberto (janela ja eh headless: false).
          log(`⚠️ Modal "Confirme sua identidade" detectado — botoes disabled pela anti-bot do YT`)
          log(`👉 CLICA EM "AVANCAR" NO CHROME ABERTO COM O MOUSE — script aguarda 5min`)
          await snap('05a-identity-await-human')
          try {
            await page.waitForFunction(() => {
              const txt = (document.body.innerText || '').toLowerCase()
              return !/confirme sua identidade|verify your identity/.test(txt)
            }, { timeout: 5 * 60 * 1000, polling: 2000 })
            log(`✅ Modal fechado — continuando upload`)
            await snap('05b-identity-passed')
          } catch (e) {
            log(`❌ Modal nao foi fechado em 5min — abortando`)
            await snap('05c-identity-timeout')
            throw new Error('yt_identity_manual_timeout: user nao clicou Avancar no modal em 5min')
          }
        }
      }
      if (state.ready) { ready = true; break }
      if (state.pct !== null && state.pct !== lastPct) {
        log(`   📊 Upload: ${state.pct}%`)
        lastPct = state.pct
      }
      await delay(5000)
    }
    if (!ready) {
      await snap('05-publish-button-not-ready')
      throw new Error('Upload demorou >15min e botao Publicar nao ficou pronto')
    }
    log('✅ Upload terminou, botao Publicar pronto')
    await delay(2000)
    await snap('06-before-publish')

    // ── Botao "Publicar" / "Salvar" (depende da visibility) ────
    log('📤 Clicando Publicar/Salvar...')
    const pubBtn = page.locator('#done-button').first()
    if (await pubBtn.count() === 0) throw new Error('Botao Publicar/Salvar nao encontrado')
    await pubBtn.click({ force: true, timeout: 10000 })
    await snap('07-after-publish-click')

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
