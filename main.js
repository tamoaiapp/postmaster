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

async function loadWorkers() {
  jobRunner  = (await import('./src/jobRunner.mjs')).default
  loginIG    = (await import('./src/loginIG.mjs')).default
  loginTK    = (await import('./src/loginTK.mjs')).default
  aiManager  = await import('./src/aiManager.mjs')
  // Aponta o caminho onde o modelo .gguf vai morar (userData persistente)
  aiManager.setModelPath(path.join(DATA_DIR, 'model.gguf'))
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
    setInterval(() => autoUpdater.checkForUpdates(), 60 * 60 * 1000) // checa a cada 1h
  } catch (e) {
    console.error('[update] setup falhou:', e?.message)
  }
}

ipcMain.handle('update:install', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall() } catch {}
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  ensureDataDir()
  createWindow()
  try { await loadWorkers() } catch (e) { console.error('loadWorkers falhou:', e.message) }
  resumeJobs()
  win.webContents.once('did-finish-load', async () => {
    startEmbeddedAI()
    setupAutoUpdate()
    // Live View — pluga main window pro tracker de screenshots
    try {
      const liveView = await import('./src/liveView.mjs')
      liveView.setMainWindow(win)
      const s = readSettings()
      liveView.setEnabled(s.liveViewEnabled !== false)
    } catch (e) { console.error('liveView init falhou:', e?.message) }
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

// ── IA embarcada ─────────────────────────────────────────────────────────────
async function startEmbeddedAI() {
  const sendAI  = (event, data) => { if (win) win.webContents.send(event, data) }
  const onLog   = msg => sendAI('ai:log', msg)

  try {
    const modelPath = path.join(DATA_DIR, 'model.gguf')
    aiManager.setModelPath(modelPath)

    // 1. Baixar modelo se necessário
    if (!await aiManager.modelIsValid()) {
      sendAI('ai:status', { ok: false, modelReady: false, downloading: true })
      onLog('Primeira execução — configurando IA embarcada (pode demorar alguns minutos)...')
      await aiManager.downloadModel(onLog)
    }

    // 2. Carregar modelo
    sendAI('ai:status', { ok: false, modelReady: false, downloading: false })
    await aiManager.loadModel(onLog)
    sendAI('ai:status', { ok: true, modelReady: true })
  } catch (e) {
    sendAI('ai:status', { ok: false, modelReady: false, error: e.message })
    console.error('Erro ao iniciar IA embarcada:', e)
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
  // Abre login: IG/TT via janela Electron, YouTube via Playwright (Google bloqueia Electron)
  try {
    if (platform === 'youtube') {
      const { loginYouTubeViaPlaywright } = await import('./src/loginYouTube.mjs')
      await loginYouTubeViaPlaywright({ username, dataDir: DATA_DIR })
    } else {
      const { loginViaElectron } = await import('./src/loginElectron.mjs')
      await loginViaElectron({ platform, username, dataDir: DATA_DIR })
    }
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
  runJobNow(job)
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
function startJob(job) {
  if (runningJobs.has(job.id)) return
  sendJobStatus(job.id, 'aguardando')
  sendLog(job.id, `▶️ Job iniciado — intervalo: ${job.intervalMin}min`)

  const run = () => runJobNow(job)
  run() // Executa imediatamente
  const timer = setInterval(run, (job.intervalMin || 10) * 60 * 1000)
  runningJobs.set(job.id, { timer, status: 'aguardando' })
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
    sendJobStatus(job.id, result.posted ? '✅ postado' : 'aguardando')
    sendLog(job.id, result.posted ? `✅ Postado com sucesso!` : `⏭️ Nada novo para postar`)
  } catch (e) {
    if (state) state.status = 'aguardando'
    sendJobStatus(job.id, 'erro')
    sendLog(job.id, `❌ Erro: ${e.message}`)
    // Erro classificado é REGISTRADO no servidor VPS (errors.jsonl) — sem
    // notificação por WhatsApp. O cliente conversa com a TamoIA pelo botão
    // "Pedir ajuda" e ela já lê os logs e responde direto.
    try {
      const { classifyError, registerError } = await import('./src/supportAgent.mjs')
      const cls = classifyError(e.message || '')
      if (cls) {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'))
        registerError({
          kind: cls.kind,
          summary: cls.summary,
          context: {
            appVersion: pkg.version,
            account: job.account || '?',
            platform: job.platform || '?',
            lastError: e.message?.slice(0, 200),
          },
        }).catch(() => {})
      }
    } catch {}
  }
}

function resumeJobs() {
  const jobs = readDB('jobs.json')
  jobs.filter(j => j.autoStart).forEach(j => startJob(j))
}
