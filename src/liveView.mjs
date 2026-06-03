/**
 * Live View — captura screenshots dos browsers Playwright em tempo real
 * para mostrar no dashboard do PostMaster (estilo HC Box).
 */

const sessions = new Map() // jobId -> { page, account, platform, status, lastFrame, lastFrameTime }
let mainWindow = null
let captureInterval = null
let enabled = true // controla se faz screenshots ou não
const FRAME_INTERVAL_MS = 1500
const SCREENSHOT_QUALITY = 60 // JPEG quality (0-100)
const SCREENSHOT_MAX_WIDTH = 480

export function setMainWindow(win) {
  mainWindow = win
  if (!captureInterval) startCaptureLoop()
}

export function setEnabled(v) {
  enabled = !!v
  if (!enabled) {
    // Limpa frames cacheados pra liberar memória
    for (const s of sessions.values()) s.lastFrame = null
  }
  emitSessionsUpdate() // notifica renderer do estado atual
}

export function isEnabled() { return enabled }

// page pode ser null — registra a sessao sem captura de tela ainda (fase de busca/download)
export function register(jobId, page, { account, platform, status = 'iniciando', sourceLabel = null, sourceType = null }) {
  // Preserva lastFrame anterior se ja existia (pra continuar mostrando ultima tela)
  const prev = sessions.get(jobId)
  sessions.set(jobId, {
    page, account, platform, status, sourceLabel, sourceType,
    lastFrame: prev?.lastFrame || null,
    lastFrameTime: prev?.lastFrameTime || 0,
    completed: null, // reseta estado completo
  })
  emitSessionsUpdate()
}

// Atualiza apenas o page (quando o Chromium abre e a captura passa a fazer sentido)
export function attachPage(jobId, page) {
  const s = sessions.get(jobId)
  if (!s) return
  s.page = page
}

export function updateStatus(jobId, status) {
  const s = sessions.get(jobId)
  if (!s) return
  s.status = status
  emitSessionsUpdate()
}

export function unregister(jobId) {
  sessions.delete(jobId)
  emitSessionsUpdate()
}

// Marca como completo (sucesso/falha). NAO remove o card — mantém o último frame
// visível como se a tela ainda estivesse aberta. Card só some quando a automação
// é parada (jobs:stop) ou quando um novo ciclo registra over the same jobId.
export function markCompleted(jobId, { success, message }) {
  const s = sessions.get(jobId)
  if (!s) return
  s.status = success ? '✅ Postado!' : `❌ ${message || 'Falhou'}`
  s.completed = success ? 'success' : 'failed'
  s.page = null // para de capturar (page ja fechou) — lastFrame fica preservado
  emitSessionsUpdate()
}

function emitSessionsUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const list = [...sessions.entries()].map(([jobId, s]) => ({
    jobId,
    account: s.account,
    platform: s.platform,
    status: s.status,
    sourceLabel: s.sourceLabel,
    sourceType: s.sourceType,
    completed: s.completed,
  }))
  mainWindow.webContents.send('live:sessions', list)
}

async function captureFrame(jobId, session) {
  try {
    if (!session.page || session.page.isClosed?.()) return
    const buf = await session.page.screenshot({
      type: 'jpeg',
      quality: SCREENSHOT_QUALITY,
      timeout: 1000,
    })
    // Redimensiona via base64 inline (browser-side) — basta enviar base64 e setar width
    session.lastFrame = buf.toString('base64')
    session.lastFrameTime = Date.now()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('live:frame', {
        jobId,
        account: session.account,
        platform: session.platform,
        status: session.status,
        frame: session.lastFrame,
        timestamp: session.lastFrameTime,
      })
    }
  } catch {
    // Página fechada ou navegando — ignora frame
  }
}

function startCaptureLoop() {
  captureInterval = setInterval(async () => {
    if (!enabled) return // OFF — não captura nada (economiza CPU/RAM)
    if (sessions.size === 0) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    // Captura todas em paralelo
    await Promise.all([...sessions.entries()].map(([id, s]) => captureFrame(id, s)))
  }, FRAME_INTERVAL_MS)
}

export function getSessionsSnapshot() {
  return [...sessions.entries()].map(([jobId, s]) => ({
    jobId, account: s.account, platform: s.platform, status: s.status,
    frame: s.lastFrame, timestamp: s.lastFrameTime,
  }))
}
