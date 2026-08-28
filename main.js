const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)
let DATA_DIR
let aiManager

// ── Aponta Playwright pro Chromium bundlado no instalador ─────────────────────
// Em prod: ms-playwright fica em resources/ms-playwright (extraResources)
// Em dev:  usa o ms-playwright copiado pra raiz do projeto (ou %LOCALAPPDATA%)
function setupPlaywrightPath() {
  const candidates = [
    app.isPackaged
      ? path.join(process.resourcesPath, 'ms-playwright')
      : path.join(__dirname, 'ms-playwright'),
    path.join(app.getPath('appData'), '..', 'Local', 'ms-playwright'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = dir
      console.log('[Playwright] BROWSERS_PATH =', dir)
      return
    }
  }
  console.warn('[Playwright] nenhum chromium encontrado nos paths candidatos')
}
setupPlaywrightPath()

// ── Single instance lock ─────────────────────────────────────────────────────
// Garante que apenas UMA instancia do PostMaster esta rodando.
// Se o usuario abrir o app de novo enquanto ja esta aberto, a janela existente
// ganha foco e a 2a instancia fecha imediatamente (sem disparar jobs em paralelo).
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// ── Garantir pastas de dados ──────────────────────────────────────────────────
function ensureDataDir() {
  DATA_DIR = path.join(app.getPath('userData'), 'postmaster-data')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true })
  ensureFaceModel()
}

// Copia o modelo de face detection do bundle pra dataDir (uma vez).
// Modelo: Ultra-Light-Face-Detector RFB-640 (~1.5MB).
function ensureFaceModel() {
  const dest = path.join(DATA_DIR, 'face-detector.onnx')
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) return
  const candidates = [
    app.isPackaged
      ? path.join(process.resourcesPath, 'models', 'face-detector.onnx')
      : path.join(__dirname, 'models', 'face-detector.onnx'),
    path.join(__dirname, 'models', 'face-detector.onnx'),
  ]
  for (const src of candidates) {
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest)
        console.log(`[face-model] copiado de ${src} → ${dest}`)
        return
      }
    } catch (e) { console.warn(`[face-model] erro copiando ${src}:`, e.message) }
  }
  console.warn('[face-model] arquivo não encontrado nas candidates — edição automática vai falhar até baixar manualmente')
}

// ── DB simples em JSON ────────────────────────────────────────────────────────
function readDB(file) {
  const p = path.join(DATA_DIR, file)
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return [] }
}
function writeDB(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2))
}

// ── Estado dos jobs em execução ───────────────────────────────────────────────
const runningJobs = new Map() // jobId → { timer, lastRun, status }

// ── Workers importados dinamicamente ─────────────────────────────────────────
let jobRunner, loginIG, loginTK

let lastWorkerError = null
async function loadWorkers() {
  // v1.6.3: carrega cada worker ISOLADO. Antes um único import quebrado (ex.:
  // antivírus bloqueando um componente nativo numa instalação nova) derrubava
  // TODOS e deixava jobRunner=undefined -> cliente via "jobRunner is not a function"
  // sem pista nenhuma. Agora guardamos o erro REAL pra mostrar/registrar depois.
  const tryImport = async (label, spec, pick) => {
    try { return pick(await import(spec)) }
    catch (e) {
      lastWorkerError = `${label}: ${e?.message || e}`
      console.error(`[loadWorkers] FALHOU ${label}:`, e?.stack || e?.message)
      return null
    }
  }
  jobRunner = await tryImport('jobRunner', './src/jobRunner.mjs', m => m.default)
  loginIG   = await tryImport('loginIG',   './src/loginIG.mjs',   m => m.default)
  loginTK   = await tryImport('loginTK',   './src/loginTK.mjs',   m => m.default)
  aiManager = await tryImport('aiManager', './src/aiManager.mjs', m => m)
  // Aponta o caminho onde o modelo .gguf vai morar (userData persistente)
  if (aiManager) { try { aiManager.setModelPath(path.join(DATA_DIR, 'model.gguf')) } catch {} }
}

// ── Janela principal ──────────────────────────────────────────────────────────
let win

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    show: true,
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile('renderer/index.html')
  win.webContents.once('did-finish-load', () => win.maximize())
  if (process.argv.includes('--dev')) win.webContents.openDevTools()
}

// ── Auto-update via GitHub Releases ───────────────────────────────────────────
function setupAutoUpdate() {
  if (!app.isPackaged) return // só roda em build de produção
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    // v1.3.1: canal beta exclusivo pro dev (Tiago).
    // Se existir o arquivo flag em userData/.postmaster-beta, o app passa a aceitar
    // pre-releases — assim o Tiago testa antes de promover pra clientes.
    // Clientes nao tem esse arquivo, entao so atualizam quando uma release sai como
    // "latest" no GitHub (manual via "Set as latest" na UI do GH Releases).
    try {
      const fs = require('fs')
      const flagPath = require('path').join(app.getPath('userData'), '.postmaster-beta')
      if (fs.existsSync(flagPath)) {
        autoUpdater.allowPrerelease = true
        autoUpdater.channel = 'beta'
        console.log('[update] modo BETA ativado (flag local presente) - aceita pre-releases')
      } else {
        autoUpdater.allowPrerelease = false
        console.log('[update] modo stable - so atualiza quando release vira "latest"')
      }
    } catch (e) {
      console.error('[update] erro lendo flag beta:', e?.message)
    }

    autoUpdater.on('checking-for-update', () => console.log('[update] verificando...'))
    autoUpdater.on('update-available', (info) => {
      console.log('[update] nova versao disponivel:', info.version)
      win?.webContents.send('update:status', { state: 'downloading', version: info.version })
    })
    autoUpdater.on('update-not-available', () => console.log('[update] ja na ultima versao'))
    autoUpdater.on('error', (err) => console.error('[update] erro:', err?.message))
    autoUpdater.on('download-progress', (p) => {
      win?.webContents.send('update:status', { state: 'downloading', percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[update] baixado, sera instalado ao fechar')
      win?.webContents.send('update:status', { state: 'ready', version: info.version })
    })

    autoUpdater.checkForUpdatesAndNotify()
    // Antes era 1h. v1.0.54: 15min — user reportou que app demorava demais
    // pra notar update novo. Mais agressivo pega update na sessao mesmo.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 15 * 60 * 1000)
  } catch (e) {
    console.error('[update] setup falhou:', e?.message)
  }
}

ipcMain.handle('update:install', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall() } catch {}
})

// ── Intervencao humana pra YouTube/etc (v1.0.68) ──────────────────────────────
// Quando Playwright cai num bloqueio que precisa user (verificacao identidade,
// captcha, 2FA), abre BrowserWindow Electron com a MESMA sessao pra user
// resolver. Depois salva cookies atualizados de volta no arquivo de sessao.
//
// Args: { sessionFile, url, platform, username, message }
// Returns: { ok, savedTo, reason? }
ipcMain.handle('human-intervention:open', async (_, args) => {
  const { BrowserWindow, session: ses } = require('electron')
  const { sessionFile, url, platform = 'youtube', username = '', message = '' } = args

  return new Promise(async (resolve) => {
    // 1. Le storageState atual e injeta na session do Electron
    let initialState = { cookies: [], origins: [] }
    try {
      if (fs.existsSync(sessionFile)) {
        initialState = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
      }
    } catch {}

    const partition = `persist:hi-${platform}-${username}-${Date.now()}`
    const electronSes = ses.fromPartition(partition)
    await electronSes.clearStorageData({ storages: ['cookies', 'localstorage'] }).catch(() => {})

    // Injeta cookies do Playwright na session
    for (const c of (initialState.cookies || [])) {
      try {
        const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
        const cookieUrl = `${c.secure ? 'https' : 'http'}://${domain}${c.path || '/'}`
        const cookie = {
          url: cookieUrl,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        }
        if (c.sameSite) cookie.sameSite = String(c.sameSite).toLowerCase()
        if (c.expires && c.expires > 0) cookie.expirationDate = c.expires
        await electronSes.cookies.set(cookie).catch(() => {})
      } catch {}
    }

    // UA real (Google bloqueia Electron default) — v1.0.69 Chrome 132
    const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
    const SEC_CH_UA = '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"'
    // Client Hints + stealth headers
    electronSes.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = { ...details.requestHeaders }
      h['sec-ch-ua'] = SEC_CH_UA
      h['sec-ch-ua-mobile'] = '?0'
      h['sec-ch-ua-platform'] = '"Windows"'
      delete h['Electron']; delete h['electron']
      cb({ requestHeaders: h })
    })

    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: `Verificação necessária — ${platform}`,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.webContents.setUserAgent(REAL_UA)

    // Stealth JS antes de cada carregamento — Google detecta navigator.webdriver
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

    let closed = false
    const finish = async (reason) => {
      if (closed) return
      closed = true
      // Exporta cookies novos pro storageState format
      try {
        const cookies = await electronSes.cookies.get({})
        const newState = {
          cookies: cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expirationDate || -1,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: (c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : 'None'),
          })),
          origins: [],
        }
        fs.writeFileSync(sessionFile, JSON.stringify(newState, null, 2))
        resolve({ ok: true, savedTo: sessionFile, reason })
      } catch (e) {
        resolve({ ok: false, reason: `falha ao salvar: ${e.message}` })
      }
      try { win.destroy() } catch {}
      // Limpa partition pra nao acumular
      try { await electronSes.clearStorageData({ storages: ['cookies'] }).catch(() => {}) } catch {}
    }

    win.on('closed', () => finish('user-closed'))

    // Banner via injeção de CSS+HTML
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`
        (function(){
          if (document.getElementById('pm-hi-banner')) return;
          const b = document.createElement('div');
          b.id = 'pm-hi-banner';
          b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:12px 18px;font-family:Segoe UI,sans-serif;font-size:13px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 12px rgba(0,0,0,0.3)';
          b.innerHTML = '<span style="font-size:20px">⚠️</span><div style="flex:1"><strong>${(message||'O YouTube pediu uma verificação').replace(/'/g,"\\'")}</strong><br><span style="opacity:.9;font-size:12px">Complete a etapa abaixo e <strong>feche esta janela</strong> quando terminar — o app vai retomar a postagem automaticamente.</span></div>';
          document.body.insertBefore(b, document.body.firstChild);
          document.body.style.paddingTop = '70px';
        })();
      `).catch(() => {})
    })

    await win.loadURL(url, { userAgent: REAL_UA }).catch(() => {})
  })
})

// v1.3.20: cron pra drenar rascunhos do YT a cada 15min.
// Pra cada YT account em accounts.json, roda publish-drafts.ps1.
// Lock pra nao conflitar com upload-yt.ps1 em curso (PS detecta sozinho via lockfile).
let ytDraftsBusy = false
function setupYtDraftsDrain() {
  const tick = async () => {
    if (ytDraftsBusy) return
    ytDraftsBusy = true
    try {
      const accountsFile = path.join(DATA_DIR, 'accounts.json')
      if (!fs.existsSync(accountsFile)) return
      const accs = JSON.parse(fs.readFileSync(accountsFile, 'utf-8') || '[]')
      const ytAccs = accs.filter(a => a.platform === 'youtube' && a.username)
      if (!ytAccs.length) return
      const { publishDraftsForAccount } = await import('./src/poster/youtube-publish-drafts.mjs')
      for (const acc of ytAccs) {
        await publishDraftsForAccount({
          account: acc.username,
          dataDir: DATA_DIR,
          maxToPublish: 5,
          visibility: 'public',
          log: (m) => console.log(`[yt-drafts-cron] ${m}`),
        })
      }
    } catch (e) {
      console.error('[yt-drafts-cron] erro:', e?.message)
    } finally {
      ytDraftsBusy = false
    }
  }
  // 1a execucao em 5min (deixa o app estabilizar e dar tempo pro 1o upload rolar)
  setTimeout(tick, 5 * 60 * 1000)
  // Depois a cada 15min
  setInterval(tick, 15 * 60 * 1000)
  console.log('[yt-drafts-cron] agendado: 1x em 5min, depois a cada 15min')
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  ensureDataDir()
  createWindow()
  try { await loadWorkers() } catch (e) { console.error('loadWorkers falhou:', e.message) }
  resumeJobs()
  win.webContents.once('did-finish-load', async () => {
    startEmbeddedAI()
    setupAutoUpdate()
    setupYtDraftsDrain()
    // Live View — pluga main window pro tracker de screenshots
    try {
      const liveView = await import('./src/liveView.mjs')
      liveView.setMainWindow(win)
      const s = readSettings()
      liveView.setEnabled(s.liveViewEnabled !== false)
    } catch (e) { console.error('liveView init falhou:', e?.message) }
    // Aviso de fix aplicado — depois de 4s pra deixar o app estabilizar.
    setTimeout(async () => {
      try {
        const { getPendingFixAnnouncements, markAnnouncementsAsShown } = await import('./src/fixAnnouncer.mjs')
        const announcements = await getPendingFixAnnouncements({ appDir: __dirname, dataDir: DATA_DIR })
        if (announcements.length > 0 && win) {
          win.webContents.send('fix:announcements', announcements)
          markAnnouncementsAsShown(DATA_DIR, announcements)
        }
      } catch (e) { console.error('fix announcer falhou:', e?.message) }
    }, 4000)
  })
})

// IPC: snapshot atual de sessões (renderer pode pedir ao abrir a aba "Ao vivo")
ipcMain.handle('live:sessions', async () => {
  try {
    const liveView = await import('./src/liveView.mjs')
    return liveView.getSessionsSnapshot()
  } catch { return [] }
})

// ── Settings persistentes ────────────────────────────────────────────────────
function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf-8')) }
  catch { return { liveViewEnabled: true } }
}
function writeSettings(obj) {
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(obj, null, 2))
}

ipcMain.handle('settings:get', () => readSettings())
ipcMain.handle('settings:set', async (_, patch) => {
  const cur = readSettings()
  const next = { ...cur, ...patch }
  writeSettings(next)
  // Aplica no liveView se mudou
  if ('liveViewEnabled' in patch) {
    try {
      const liveView = await import('./src/liveView.mjs')
      liveView.setEnabled(next.liveViewEnabled)
    } catch {}
  }
  return next
})

app.on('before-quit', () => { aiManager?.stopServer() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── IA embarcada (LAZY desde v1.6.2) ─────────────────────────────────────────
// Antes: o boot baixava (~400MB de rede) e carregava o Qwen na RAM (~400MB) SEMPRE,
// mesmo pra quem usa legenda template/vídeo/nenhuma — que nunca toca a IA. Isso
// inflava CPU/rede/RAM à toa. Agora o boot NÃO baixa nem carrega nada: o download+
// load acontece sob demanda na 1ª geração que precisar (aiManager.ensureReady,
// chamado por gerarCaption/gerarChyron/_complete). Aqui só reportamos o status.
async function startEmbeddedAI() {
  const sendAI = (event, data) => { if (win) win.webContents.send(event, data) }
  try {
    const modelPath = path.join(DATA_DIR, 'model.gguf')
    aiManager.setModelPath(modelPath)
    // Chip "IA pronta" se o modelo já foi baixado num run anterior (fica disponível
    // pra carregar sob demanda). Se não, fica neutro — carrega na 1ª legenda 'ai'.
    const jaBaixado = await aiManager.modelIsValid()
    sendAI('ai:status', { ok: true, modelReady: jaBaixado, lazy: true })
  } catch (e) {
    sendAI('ai:status', { ok: false, modelReady: false, error: e.message })
    console.error('Erro ao checar IA embarcada:', e)
  }
}

ipcMain.handle('ai:status', async () => {
  if (!aiManager) return { ok: false, modelReady: false }
  return aiManager.getStatus()
})

// ── IPC: Contas ───────────────────────────────────────────────────────────────
ipcMain.handle('accounts:list', () => readDB('accounts.json'))

ipcMain.handle('accounts:add', async (_, { platform, username }) => {
  const accounts = readDB('accounts.json')
  if (accounts.find(a => a.platform === platform && a.username === username))
    return { ok: false, error: 'Conta já adicionada' }
  // v1.0.76: unifica login YT — loginViaElectron ja roteia pra doLoginYouTubeViaChrome
  // (Chrome real + banner + captura .channelId). Antes main.js chamava loginYouTube.mjs
  // que usava Chromium do bundle e NAO salvava .channelId — quebrava o fix v1.0.75
  try {
    const { loginViaElectron } = await import('./src/loginElectron.mjs')
    await loginViaElectron({ platform, username, dataDir: DATA_DIR })
    const account = { id: Date.now().toString(), platform, username, addedAt: new Date().toISOString() }
    accounts.push(account)
    writeDB('accounts.json', accounts)
    return { ok: true, account }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('accounts:remove', (_, id) => {
  let accounts = readDB('accounts.json')
  const acc = accounts.find(a => a.id === id)
  accounts = accounts.filter(a => a.id !== id)
  writeDB('accounts.json', accounts)
  // Apaga session files associados
  if (acc) {
    const prefix = acc.platform === 'instagram' ? 'ig'
                 : acc.platform === 'tiktok'    ? 'tk'
                 : acc.platform === 'youtube'   ? 'yt'
                 : null
    if (prefix) {
      const sessionFile = path.join(DATA_DIR, 'sessions', `${prefix}-${acc.username}.json`)
      try { fs.unlinkSync(sessionFile) } catch {}
      // YouTube tem cookies.txt extra
      if (acc.platform === 'youtube') {
        const txtFile = path.join(DATA_DIR, 'sessions', `yt-cookies-${acc.username}.txt`)
        try { fs.unlinkSync(txtFile) } catch {}
      }
    }
  }
  return { ok: true }
})

// ── IPC: Jobs ─────────────────────────────────────────────────────────────────
ipcMain.handle('jobs:list', () => {
  const jobs = readDB('jobs.json')
  const hoje = new Date().toISOString().slice(0, 10)
  return jobs.map(j => {
    let postsHoje = 0
    if (j.lastPostDate === hoje) {
      // Tracking correto desde v1.0.23
      postsHoje = j.postsHoje || 0
    } else if (j.lastRun && j.lastRun.startsWith(hoje) && (j.postCount || 0) > 0) {
      // Fallback pra posts antigos sem lastPostDate: assume 1 post hoje
      postsHoje = 1
    }
    return {
      ...j,
      postsHoje,
      running: runningJobs.has(j.id),
      status: runningJobs.get(j.id)?.status || j.lastStatus || 'parado',
    }
  })
})

ipcMain.handle('jobs:create', (_, job) => {
  const jobs = readDB('jobs.json')
  const newJob = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    lastStatus: 'parado',
    lastRun: null,
    postCount: 0,
    ...job,
  }
  jobs.push(newJob)
  writeDB('jobs.json', jobs)
  return { ok: true, job: newJob }
})

ipcMain.handle('jobs:update', (_, { id, ...data }) => {
  const jobs = readDB('jobs.json')
  const idx = jobs.findIndex(j => j.id === id)
  if (idx === -1) return { ok: false }
  jobs[idx] = { ...jobs[idx], ...data }
  writeDB('jobs.json', jobs)
  return { ok: true }
})

ipcMain.handle('jobs:delete', (_, id) => {
  stopJob(id)
  let jobs = readDB('jobs.json')
  jobs = jobs.filter(j => j.id !== id)
  writeDB('jobs.json', jobs)
  return { ok: true }
})

ipcMain.handle('jobs:start', (_, id) => {
  const jobs = readDB('jobs.json')
  const job = jobs.find(j => j.id === id)
  if (!job) return { ok: false }
  startJob(job)
  return { ok: true }
})

ipcMain.handle('jobs:stop', (_, id) => {
  stopJob(id)
  return { ok: true }
})

ipcMain.handle('jobs:runNow', async (_, id) => {
  const jobs = readDB('jobs.json')
  const job = jobs.find(j => j.id === id)
  if (!job) return { ok: false }
  // v1.6.1: passa pela MESMA fila serial dos jobs agendados (não sobe um 2º
  // navegador em paralelo com um ciclo automático em andamento).
  enqueueJob(job, { oneShot: true })
  return { ok: true }
})

// ── IPC: Utilitários ──────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async (_, filters) => {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filters || [] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('shell:openFolder', (_, p) => shell.openPath(p))

ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:maximize', () => win?.isMaximized() ? win.unmaximize() : win.maximize())
ipcMain.on('win:close',    () => win?.close())

ipcMain.handle('ollama:check', async () => {
  if (!aiManager) return { ok: false, models: [] }
  const s = await aiManager.getStatus()
  return { ok: s.modelReady, models: s.modelReady ? ['embarcado'] : [] }
})

ipcMain.handle('ytdlp:check', async () => {
  try {
    const { stdout } = await execAsync('yt-dlp --version', { timeout: 5000, windowsHide: true })
    return { ok: true, version: stdout.trim() }
  } catch { return { ok: false } }
})

// ── Suporte TamoIA (chat com Claude Code no VPS) ─────────────────────────────
// Buffer em memoria com os ultimos N logs do app pra mandar de contexto pra IA
let supportLogBuffer = null
async function getSupportLogBuffer() {
  if (!supportLogBuffer) {
    const mod = await import('./src/supportAgent.mjs')
    supportLogBuffer = new mod.LogBuffer(300)
  }
  return supportLogBuffer
}
const APP_STARTED_AT = Date.now()

ipcMain.handle('support:chat', async (_, { messages }) => {
  try {
    const { chatWithSupport } = await import('./src/supportAgent.mjs')
    const buf = await getSupportLogBuffer()
    const uptime = Math.round((Date.now() - APP_STARTED_AT) / 1000)
    const uptimeStr = uptime > 3600 ? `${Math.round(uptime/3600)}h` : `${Math.round(uptime/60)}min`
    return await chatWithSupport({
      messages,
      appDir: __dirname,
      dataDir: DATA_DIR,
      recentLogs: buf.snapshot(),
      appUptime: uptimeStr,
    })
  } catch (e) {
    return {
      role: 'assistant',
      content: `Erro interno no suporte: ${e.message}.\n\nManda WhatsApp pra +55 11 96724-5795.`,
      error: true,
    }
  }
})

// ── Logs para o renderer ──────────────────────────────────────────────────────
function sendLog(jobId, msg) {
  if (win) win.webContents.send('job:log', { jobId, msg, time: new Date().toLocaleTimeString('pt-BR') })
  // Tambem alimenta o buffer de suporte (sem await — fire and forget)
  getSupportLogBuffer().then(buf => buf.pushJob(jobId, msg)).catch(() => {})
}

function sendJobStatus(jobId, status) {
  if (win) win.webContents.send('job:status', { jobId, status })
  // Persiste status
  const jobs = readDB('jobs.json')
  const idx = jobs.findIndex(j => j.id === jobId)
  if (idx !== -1) { jobs[idx].lastStatus = status; writeDB('jobs.json', jobs) }
}

// ── Scheduler ────────────────────────────────────────────────────────────────
// ── Serialização global de jobs (1 navegador por vez) ────────────────────────
// v1.6.1: rodar 2+ jobs em paralelo sobe vários Chromium ao mesmo tempo e estoura
// page.goto por contenção de CPU/rede — causa nº1 do "posta metade dos vídeos"
// (confirmado nos logs do cliente: 3 jobs -> 3 page.goto Timeout -> 3 FALHOU).
// Fila global FIFO: um job de cada vez, com um respiro entre eles.
const JOB_GAP_MS = 60_000        // pausa entre jobs (evita rajada + dá fôlego pro PC)
const jobQueue = []              // jobs aguardando execução
const queuedIds = new Set()      // ids já na fila (não empilha o mesmo job)
let activeJobId = null           // job rodando agora (null = ocioso)
let draining = false

function enqueueJob(job, { oneShot = false } = {}) {
  // Já rodando ou já enfileirado? ignora este disparo (o intervalo fura de novo)
  if (activeJobId === job.id || queuedIds.has(job.id)) {
    sendLog(job.id, '⏳ Ciclo anterior ainda na fila/rodando — pulando este disparo')
    return
  }
  jobQueue.push({ job, oneShot })
  queuedIds.add(job.id)
  const st = runningJobs.get(job.id)
  if (st) st.status = 'na fila'
  sendJobStatus(job.id, 'na fila')
  drainQueue()
}

async function drainQueue() {
  if (draining) return
  draining = true
  try {
    while (jobQueue.length) {
      const { job, oneShot } = jobQueue.shift()
      queuedIds.delete(job.id)
      // Job agendado que foi PARADO enquanto esperava: descarta. One-shot ("rodar
      // agora") sempre roda, mesmo sem estar no scheduler.
      if (!oneShot && !runningJobs.has(job.id)) continue
      activeJobId = job.id
      try { await runJobNow(job) } catch { /* runJobNow já trata os próprios erros */ }
      activeJobId = null
      if (jobQueue.length) await new Promise(r => setTimeout(r, JOB_GAP_MS))
    }
  } finally {
    draining = false
  }
}

// Registra erro classificado no VPS (errors.jsonl) — reutilizado pelo catch de
// runJobNow E pela falha devolvida no result (que não lança exceção).
async function registerClassifiedError(errMsg, job) {
  try {
    const { classifyError, registerError } = await import('./src/supportAgent.mjs')
    const cls = classifyError(errMsg || '')
    if (!cls) return
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'))
    try {
      const { recordErrorOccurrence } = await import('./src/fixAnnouncer.mjs')
      recordErrorOccurrence(DATA_DIR, cls.kind)
    } catch {}
    registerError({
      kind: cls.kind,
      summary: cls.summary,
      context: {
        appVersion: pkg.version,
        account: job.account || '?',
        platform: job.platform || '?',
        category: cls.category || 'unknown',
        lastError: (errMsg || '').slice(0, 200),
      },
    }).catch(() => {})
  } catch {}
}

function startJob(job) {
  if (runningJobs.has(job.id)) return
  sendJobStatus(job.id, 'aguardando')
  sendLog(job.id, `▶️ Job iniciado — intervalo: ${job.intervalMin}min`)

  const run = () => enqueueJob(job)
  const timer = setInterval(run, (job.intervalMin || 10) * 60 * 1000)
  runningJobs.set(job.id, { timer, status: 'aguardando' })
  run() // Enfileira o primeiro ciclo imediatamente (fila serial evita 2 navegadores juntos)
}

function stopJob(id) {
  const state = runningJobs.get(id)
  if (state) { clearInterval(state.timer); runningJobs.delete(id) }
  sendJobStatus(id, 'parado')
  // Remove o card do Live View apenas quando o usuario para a automacao
  import('./src/liveView.mjs').then(lv => lv.unregister(id)).catch(() => {})
}

async function runJobNow(job) {
  const state = runningJobs.get(job.id)
  if (state?.status === 'postando') return // Evita execução dupla

  // v1.6.3: se o motor não carregou no boot, tenta de novo AGORA e mostra o erro
  // REAL (antes o cliente só via "jobRunner is not a function" e nada era registrado).
  if (typeof jobRunner !== 'function') {
    try { jobRunner = (await import('./src/jobRunner.mjs')).default } catch (e) { lastWorkerError = `jobRunner: ${e?.message || e}` }
    if (typeof jobRunner !== 'function') {
      const real = lastWorkerError || 'falha ao carregar o motor de postagem'
      if (state) state.status = 'aguardando'
      sendJobStatus(job.id, 'erro')
      sendLog(job.id, `❌ App não carregou o motor de postagem: ${real}`)
      sendLog(job.id, `   Costuma ser o antivírus bloqueando um componente do PostMaster. Libere/whiteliste o app no antivírus e reinstale.`)
      await registerClassifiedError(`worker_load_failed: ${real}`, job)
      return
    }
  }

  if (state) state.status = 'postando'
  sendJobStatus(job.id, 'postando')
  sendLog(job.id, `🔄 Iniciando ciclo...`)

  try {
    const result = await jobRunner(job, DATA_DIR, (msg) => sendLog(job.id, msg))

    // Atualiza contagem e horário
    const jobs = readDB('jobs.json')
    const idx = jobs.findIndex(j => j.id === job.id)
    if (idx !== -1) {
      jobs[idx].lastRun = new Date().toISOString()
      if (result.posted) {
        jobs[idx].postCount = (jobs[idx].postCount || 0) + 1
        // Conta posts por dia: reseta se for novo dia, incrementa se for hoje
        const hoje = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
        if (jobs[idx].lastPostDate === hoje) {
          jobs[idx].postsHoje = (jobs[idx].postsHoje || 0) + 1
        } else {
          jobs[idx].postsHoje = 1
          jobs[idx].lastPostDate = hoje
        }
      }
      writeDB('jobs.json', jobs)
    }
    if (win) win.webContents.send('job:update', jobs[idx])

    if (state) state.status = 'aguardando'
    // v1.6.1: status HONESTO — antes toda falha de postagem virava "Nada novo para
    // postar" (idêntico a "não tinha vídeo novo"), então o cliente não sabia que
    // quebrou. Agora separa: postado / falha temporária (retenta) / pulado / nada novo.
    if (result.posted) {
      sendJobStatus(job.id, '✅ postado')
      sendLog(job.id, `✅ Postado com sucesso!`)
    } else if (result.transient) {
      sendJobStatus(job.id, 'retentar')
      sendLog(job.id, `⏳ Falha temporária ao postar (rede/plataforma) — vídeo preservado, tento de novo no próximo ciclo`)
    } else if (result.failedPermanent) {
      sendJobStatus(job.id, 'falhou')
      sendLog(job.id, `⚠️ Não consegui postar este vídeo — pulado após tentativas`)
      // Só registra na telemetria quando DESISTE do vídeo (não a cada retry, pra não spammar)
      await registerClassifiedError(result.errorMsg, job)
    } else {
      sendJobStatus(job.id, 'aguardando')
      sendLog(job.id, `⏭️ Nada novo para postar`)
    }
  } catch (e) {
    if (state) state.status = 'aguardando'
    sendJobStatus(job.id, 'erro')
    sendLog(job.id, `❌ Erro: ${e.message}`)
    // Erro classificado é REGISTRADO no servidor VPS (errors.jsonl) — sem
    // notificação por WhatsApp. O cliente conversa com a TamoIA pelo botão
    // "Pedir ajuda" e ela já lê os logs e responde direto.
    // Também é gravado localmente em fix-history.json pro app avisar
    // "esse problema foi resolvido" quando o auto-update aplicar o fix.
    await registerClassifiedError(e.message, job)
  }
}

function resumeJobs() {
  const jobs = readDB('jobs.json')
  jobs.filter(j => j.autoStart).forEach(j => startJob(j))
}
