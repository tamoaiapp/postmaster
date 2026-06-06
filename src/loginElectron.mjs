/**
 * Login via janela nativa do Electron (sem Playwright).
 * Mais estavel pra usuario final — Chromium da pra Electron e nao depende
 * do binario externo do Playwright para abrir.
 *
 * Estrategia:
 * 1. Abre BrowserWindow com URL de login
 * 2. Usuario loga normalmente
 * 3. Detecta sucesso quando URL muda pra fora de /login
 * 4. Pega cookies via session.cookies.get(...)
 * 5. Salva no formato Playwright storageState (compativel com poster.mjs)
 */

import path from 'path'
import fs from 'fs'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // 5 min

// Trava: nao permite 2 logins simultaneos pra mesma conta
const activeLogins = new Set()

export async function loginViaElectron({ platform, username, dataDir }) {
  const lockKey = `${platform}:${username}`
  if (activeLogins.has(lockKey)) {
    throw new Error(`Login para @${username} já está em andamento — feche a janela existente primeiro.`)
  }
  activeLogins.add(lockKey)
  try {
    return await doLogin({ platform, username, dataDir })
  } finally {
    activeLogins.delete(lockKey)
  }
}

async function doLogin({ platform, username, dataDir }) {
  const { BrowserWindow, session } = await import('electron')

  const sessionPrefix = platform === 'instagram' ? 'ig'
                      : platform === 'tiktok'    ? 'tk'
                      : platform === 'youtube'   ? 'yt'
                      : 'session'
  const isInsta = platform === 'instagram'
  const isYt    = platform === 'youtube'
  const sessionFile = path.join(dataDir, 'sessions', `${sessionPrefix}-${username}.json`)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })

  // Particao isolada por conta — cookies nao misturam entre logins
  const partition = `persist:${sessionPrefix}-${username}`
  const ses = session.fromPartition(partition)
  // Limpa cookies antigos dessa conta antes de logar (evita tela "trocar de usuario")
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'serviceworkers', 'cachestorage', 'shadercache', 'websql', 'indexdb'] })

  // YouTube: vai direto na home e o user clica "Fazer login" no proprio site.
  // Google bloqueia accounts.google.com em browser embedded (Erro 400).
  // Abrir youtube.com e clicar Sign In direto contorna a deteccao.
  const loginUrl = isInsta ? 'https://www.instagram.com/accounts/login/'
                 : isYt    ? 'https://www.youtube.com/'
                           : 'https://www.tiktok.com/login'

  const platformName = isInsta ? 'Instagram' : isYt ? 'Google/YouTube' : 'TikTok'

  // User-Agent de Chrome real — Google detecta Electron e bloqueia login (Erro 400).
  // Mesmo que loadURL passe direto pra youtube.com, qualquer redirect pra accounts.google.com
  // precisa de UA de Chrome legit pra nao bloquear.
  // v1.0.69: UA Chrome 132 (Google ja bloqueia 130 por ser "antigo"). Tambem
  // aplicamos Client Hints (sec-ch-ua) via webRequest pra parecer Chrome 100%.
  const REAL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
  const SEC_CH_UA = '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"'

  const win = new BrowserWindow({
    width: 1080,
    height: 800,
    title: `Login ${platformName} — @${username}`,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Override do User-Agent ANTES de qualquer load
  win.webContents.setUserAgent(REAL_CHROME_UA)
  ses.setUserAgent(REAL_CHROME_UA)

  // v1.0.69: Sobrescreve headers pra adicionar sec-ch-ua* (Client Hints) que
  // Google verifica pra detectar Electron/headless. Sem isso, mesmo com UA
  // Chrome, o login dá "Esse navegador ou app pode nao ser seguro".
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = { ...details.requestHeaders }
    h['sec-ch-ua'] = SEC_CH_UA
    h['sec-ch-ua-mobile'] = '?0'
    h['sec-ch-ua-platform'] = '"Windows"'
    // Remove header que delata Electron
    delete h['Electron']
    delete h['electron']
    cb({ requestHeaders: h })
  })

  // v1.0.69: stealth JS — Google checa navigator.webdriver e propriedades
  // que Chromium puro nao tem. Sobrescreve antes de qualquer script da pagina.
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(`
      (() => {
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) } catch {}
        try { Object.defineProperty(navigator, 'plugins', { get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' }] }) } catch {}
        try { Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] }) } catch {}
        try { window.chrome = window.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => ({}) } } catch {}
      })();
    `).catch(() => {})
  })

  await win.loadURL(loginUrl)

  // Promise que resolve quando o login eh detectado ou rejeita por timeout/cancelamento
  return new Promise((resolve, reject) => {
    let settled = false
    let poll = null

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Tempo esgotado — login nao concluido em 5 minutos.'))
    }, LOGIN_TIMEOUT_MS)

    const onClosed = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      reject(new Error('Janela de login fechada antes de concluir.'))
    }

    function cleanup() {
      clearInterval(poll)
      win.removeListener('closed', onClosed)
      try { if (!win.isDestroyed()) win.close() } catch {}
    }

    win.on('closed', onClosed)

    // A cada navegacao, checa se logou de verdade.
    win.webContents.on('did-navigate', (_e, url) => checkLogin(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => checkLogin(url))

    // Poll de seguranca: alguns passos (2FA, "salvar login") trocam de tela via
    // SPA sem disparar evento de navegacao confiavel. Repolla a URL atual ate logar.
    poll = setInterval(() => {
      if (settled) return
      try { checkLogin(win.webContents.getURL()) } catch {}
    }, 2500)

    async function checkLogin(currentUrl) {
      if (settled) return
      try {
        const u = new URL(currentUrl)

        if (isYt) {
          // Para YT: nao basta sair da pagina de login — precisa estar de verdade logado.
          // Detecta via presenca de cookies de auth do Google (SAPISID + LOGIN_INFO da YT).
          // Se ainda esta em accounts.google.com, claramente nao logou ainda.
          if (u.hostname.includes('accounts.google.com') || u.pathname.includes('/signin')) return
          await new Promise(r => setTimeout(r, 1500))
          const cookies = await ses.cookies.get({})
          const hasAuth = cookies.some(c =>
            (c.domain.includes('youtube.com') && c.name === 'LOGIN_INFO') ||
            (c.domain.includes('google.com') && c.name === 'SAPISID')
          )
          if (!hasAuth) return // ainda nao logou (so esta navegando youtube anonimo)
          await saveStorageState(cookies, sessionFile, false)
          const netscapePath = path.join(dataDir, 'sessions', `yt-cookies-${username}.txt`)
          await saveCookiesNetscape(cookies, netscapePath)
          settled = true
          clearTimeout(timer)
          cleanup()
          resolve({ ok: true, sessionFile })
          return
        }

        // ── IG / TikTok ────────────────────────────────────────────────────────
        // NAO confiar na URL: IG/TT gravam cookies anonimos (csrftoken, mid, ttwid,
        // msToken...) ANTES do login, e durante o codigo de verificacao / 2FA o site
        // navega pra paginas fora de /login. Se confiarmos so na URL, fechamos a janela
        // no meio da verificacao. So consideramos logado quando o cookie de SESSAO real
        // (`sessionid`) existe — ele so eh emitido APOS concluir o codigo de verificacao.
        await new Promise(r => setTimeout(r, 800))
        const cookies = await ses.cookies.get({})
        const authDomain = isInsta ? 'instagram.com' : 'tiktok.com'
        const hasSession = cookies.some(c =>
          c.name === 'sessionid' &&
          c.value && c.value.length >= 8 &&
          (c.domain || '').includes(authDomain)
        )
        if (!hasSession) return // ainda logando (credenciais / 2FA / captcha) — mantem janela aberta

        await saveStorageState(cookies, sessionFile, isInsta)

        settled = true
        clearTimeout(timer)
        cleanup()
        resolve({ ok: true, sessionFile })
      } catch (err) {
        // Continua esperando — pode ser navegacao parcial
      }
    }
  })
}

// Salva cookies em formato Netscape (cookies.txt) pra yt-dlp consumir.
// Formato: domain TAB flag TAB path TAB secure TAB expiration TAB name TAB value
async function saveCookiesNetscape(electronCookies, outFile) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by PostMaster', '']
  for (const c of electronCookies) {
    // Filtra so cookies relevantes pra YouTube/Google
    if (!c.domain.match(/google|youtube/i)) continue
    const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain.replace(/^www\./, '')}`
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const path = c.path || '/'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const expires = Math.floor(c.expirationDate || (Date.now()/1000 + 365*86400))
    lines.push(`${domain}\t${flag}\t${path}\t${secure}\t${expires}\t${c.name}\t${c.value}`)
  }
  fs.writeFileSync(outFile, lines.join('\n'), 'utf-8')
}

// Converte cookies do Electron pro formato storageState do Playwright
async function saveStorageState(electronCookies, outFile, isInsta) {
  const playwrightCookies = electronCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith('.') ? c.domain : `.${c.domain.replace(/^www\./, '')}`,
    path: c.path || '/',
    expires: c.expirationDate || -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ({ unspecified: 'Lax', no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[c.sameSite] || 'Lax'),
  }))

  const state = {
    cookies: playwrightCookies,
    origins: [], // Localstorage nao eh transferivel entre Electron e Playwright facilmente — IG/TT funcionam so com cookies
  }

  fs.writeFileSync(outFile, JSON.stringify(state, null, 2))
}
