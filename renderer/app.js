// ── State ─────────────────────────────────────────────────────────────────────
let currentPage = 'dashboard'
let selectedPlatform = 'instagram'
let logLines = []
let unreadLogs = 0
let logPanelOpen = false

// Wizard state
let wizardStep = 0
const wizardSteps = ['Fonte', 'Conta', 'Legenda', 'Agendamento', 'Revisar']
let wizardData = {}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupNav()
  setupEvents()
  await checkDeps()
  // Pre-carrega settings pra wizard checar feature flags
  try { window.__pmSettings = await window.api.settings.get() } catch {}
  await refreshAll()
  setInterval(refreshAll, 5000)
})

function setupNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.page))
  })
}

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'))
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active')
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'))
  document.getElementById(`page-${page}`)?.classList.add('active')
  currentPage = page

  if (page === 'jobs' || page === 'dashboard') refreshAll()
  if (page === 'accounts') loadAccounts()
}

function setupEvents() {
  window.api.on('job:log', ({ jobId, msg, time }) => {
    addLog(jobId, msg, time)
  })
  window.api.on('job:status', ({ jobId, status }) => {
    updateJobStatus(jobId, status)
  })
  window.api.on('job:update', (job) => {
    if (job) updateJobCard(job)
  })
}

// ── Deps check ────────────────────────────────────────────────────────────────
async function checkDeps() {
  const chipAI = document.getElementById('chip-ai')
  if (!chipAI) return
  chipAI.classList.add('ok')
  chipAI.classList.remove('err')
  chipAI.querySelector('span').textContent = 'IA pronta'
}

// Atualiza chip de IA via evento em tempo real
window.api.on('ai:status', (status) => {
  const chip = document.getElementById('chip-ai')
  if (!chip) return
  if (status.ok && status.modelReady) {
    chip.classList.add('ok')
    chip.classList.remove('err')
    chip.querySelector('span').textContent = 'IA pronta'
  }
})

// ── Live View — mini-telas ao vivo das automacoes ───────────────────────────
const liveSessions = new Map() // jobId -> { account, platform, status, frame }


window.api.on('live:sessions', (list) => {
  // Reconcilia: remove sessões que não estão mais na lista
  const ids = new Set(list.map(s => s.jobId))
  for (const id of liveSessions.keys()) {
    if (!ids.has(id)) liveSessions.delete(id)
  }
  // Adiciona/atualiza
  for (const s of list) {
    const cur = liveSessions.get(s.jobId) || {}
    liveSessions.set(s.jobId, { ...cur, ...s })
  }
  renderLiveGrid()
  updateLiveBadge()
})

window.api.on('live:frame', (data) => {
  const cur = liveSessions.get(data.jobId) || {}
  liveSessions.set(data.jobId, { ...cur, ...data })
  renderLiveGrid()
  updateLiveBadge()
})

// Cache de jobs ativos (atualizado periodicamente) — pra mostrar cards permanentes
let liveAllJobs = []

async function refreshLiveJobs() {
  try {
    const jobs = await window.api.jobs.list()
    liveAllJobs = jobs.filter(j => j.running)
    renderLiveGrid()
  } catch {}
}

function renderLiveGrid() {
  const grid = document.getElementById('live-grid')
  const empty = document.getElementById('live-empty')
  const count = document.getElementById('live-count')
  if (!grid) return

  // Combina jobs em execucao (cards permanentes) + sessoes ativas (com screenshot)
  // Sessoes ativas tem prioridade: substituem o placeholder do job correspondente
  const cardData = new Map()
  for (const job of liveAllJobs) {
    cardData.set(job.id, {
      jobId: job.id,
      account: job.account,
      platform: job.platform,
      status: 'Aguardando próximo ciclo',
      sourceLabel: extractJobSourceLabel(job),
      sourceType: job.source,
      idle: true,
    })
  }
  // Sessoes do liveView SEMPRE substituem (tem dados mais frescos: status atual, lastFrame, etc)
  for (const [id, s] of liveSessions) {
    const base = cardData.get(id) || {}
    cardData.set(id, {
      ...base, ...s,
      // Idle se nao tem page ativa AND nao esta completed
      idle: !s.page && !s.completed && (s.status?.includes('Aguardando') || base.idle),
    })
  }

  count.textContent = `— ${cardData.size} ${cardData.size === 1 ? 'automação' : 'automações'}`

  if (cardData.size === 0) {
    grid.innerHTML = ''
    if (empty) empty.style.display = 'block'
    return
  }
  if (empty) empty.style.display = 'none'

  const cards = []
  for (const [jobId, s] of cardData) {
    const platformIcon = s.platform === 'instagram' ? '📷' : s.platform === 'tiktok' ? '🎵' : '🌐'
    const platformColor = s.platform === 'instagram' ? '#e1306c' : '#00f2ea'

    // Visual da fonte (canal YT / TT / pasta) quando ainda nao tem frame do Chromium
    let visual
    if (s.frame) {
      visual = `<img src="data:image/jpeg;base64,${s.frame}" style="width:100%;height:auto;display:block" alt="preview" />`
    } else {
      const sourceIcon = sourceIconFor(s.sourceType)
      const sourceColor = sourceColorFor(s.sourceType)
      visual = `
        <div style="
          aspect-ratio:16/10;
          display:flex;flex-direction:column;
          align-items:center;justify-content:center;gap:8px;
          background:linear-gradient(135deg, ${sourceColor}22, ${sourceColor}08);
          border-top:3px solid ${sourceColor};
        ">
          <div style="font-size:42px;line-height:1">${sourceIcon}</div>
          <div style="font-size:13px;font-weight:700;color:#eef2f9">${esc(s.sourceLabel || s.sourceType || 'fonte')}</div>
          <div style="font-size:11px;color:var(--text-dim);max-width:90%;text-align:center;text-overflow:ellipsis;overflow:hidden;white-space:nowrap">${esc(s.status || '')}</div>
        </div>
      `
    }

    // Visual diferente quando completou (sucesso/falha) ou idle
    const isSuccess = s.completed === 'success'
    const isFailed  = s.completed === 'failed'
    const isIdle    = s.idle && !s.completed
    const cardBorder = isSuccess ? '2px solid #3fb950'
                    : isFailed   ? '2px solid #ef4444'
                    : isIdle     ? '1px solid rgba(255,255,255,0.1)'
                    : '1px solid var(--border)'
    const dotColor = isSuccess ? '#3fb950'
                  : isFailed   ? '#ef4444'
                  : isIdle     ? '#8394b0'
                  : '#3fb950'
    const dotAnim = (isSuccess || isFailed || isIdle) ? '' : 'animation:pulse 1.5s ease-in-out infinite;'

    cards.push(`
      <div class="live-card" style="
        background:#0a0d14;
        border:${cardBorder};
        border-radius:var(--radius-lg);
        overflow:hidden;
        cursor:pointer;
      " onclick="openLiveFullscreen('${jobId}')">
        <div style="
          padding:10px 12px;
          display:flex;
          align-items:center;
          gap:8px;
          background:rgba(255,255,255,0.02);
          border-bottom:1px solid var(--border);
        ">
          <span style="color:${platformColor};font-size:18px">${platformIcon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">@${esc(s.account || '')}</div>
            <div style="font-size:11px;color:${isSuccess ? '#3fb950' : isFailed ? '#ef4444' : 'var(--text-dim)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:${(isSuccess||isFailed) ? 600 : 400}">${esc(s.status || '')}</div>
          </div>
          <span style="
            display:inline-block;width:8px;height:8px;border-radius:50%;
            background:${dotColor};box-shadow:0 0 8px ${dotColor};
            ${dotAnim}
          "></span>
        </div>
        <div style="background:#000">${visual}</div>
      </div>
    `)
  }

  grid.innerHTML = cards.join('')
}

// Extrai label da fonte direto do job (mesma logica do main jobRunner)
function extractJobSourceLabel(job) {
  if (!job) return 'fonte'
  if (job.source === 'youtube' && job.sourceUrls) {
    const first = job.sourceUrls.split(/[,\n]/)[0].trim()
    const m = first.match(/@([\w.-]+)/)
    return m ? `@${m[1]}` : first.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30)
  }
  if ((job.source === 'instagram' || job.source === 'tiktok') && job.sourceHandles) {
    const first = job.sourceHandles.split(/[,\n]/)[0].trim().replace(/^@/, '')
    return `@${first}`
  }
  if (job.source === 'manual' && job.sourceFolder) {
    const parts = job.sourceFolder.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || job.sourceFolder
  }
  return job.source || 'fonte'
}

function sourceIconFor(type) {
  return type === 'youtube' ? '▶️'
       : type === 'instagram' ? '📷'
       : type === 'tiktok' ? '🎵'
       : type === 'manual' ? '📁'
       : '🌐'
}

function sourceColorFor(type) {
  return type === 'youtube' ? '#ff0000'
       : type === 'instagram' ? '#e1306c'
       : type === 'tiktok' ? '#00f2ea'
       : type === 'manual' ? '#a78bfa'
       : '#6366f1'
}

function updateLiveBadge() {
  const badge = document.getElementById('live-badge')
  if (!badge) return
  if (liveSessions.size > 0) {
    badge.style.display = 'inline-flex'
    badge.textContent = liveSessions.size
  } else {
    badge.style.display = 'none'
  }
}

function openLiveFullscreen(jobId) {
  const s = liveSessions.get(jobId)
  if (!s || !s.frame) return
  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:9998;
    display:flex;align-items:center;justify-content:center;cursor:pointer;
  `
  overlay.onclick = () => overlay.remove()
  overlay.innerHTML = `
    <div style="position:absolute;top:20px;right:30px;color:white;font-size:30px;cursor:pointer">×</div>
    <div style="text-align:center;color:white;max-width:90vw;max-height:90vh">
      <div style="margin-bottom:12px;font-weight:700">@${esc(s.account)} — ${esc(s.status)}</div>
      <img src="data:image/jpeg;base64,${s.frame}" style="max-width:100%;max-height:80vh;border-radius:12px" />
    </div>
  `
  document.body.appendChild(overlay)
}

async function refreshLiveSessions() {
  try {
    const list = await window.api.live.sessions()
    liveSessions.clear()
    for (const s of list) liveSessions.set(s.jobId, s)
    await refreshLiveJobs() // pega tambem jobs em execucao pra mostrar cards permanentes
  } catch {}
}

// Polling: a cada 5s atualiza lista de jobs ativos (pra cards permanentes)
let liveJobsInterval = null
function startLiveJobsPolling() {
  if (liveJobsInterval) return
  refreshLiveJobs()
  liveJobsInterval = setInterval(refreshLiveJobs, 5000)
}
function stopLiveJobsPolling() {
  if (liveJobsInterval) { clearInterval(liveJobsInterval); liveJobsInterval = null }
}

// Pulse animation pra "ao vivo"
const liveStyle = document.createElement('style')
liveStyle.textContent = `
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
  .nav-badge {
    background: var(--brand);
    color: white;
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 10px;
    margin-left: auto;
  }
  .live-card { transition: transform 0.15s, border-color 0.15s }
  .live-card:hover { transform: translateY(-2px); border-color: var(--brand-purple) }

  /* iOS-style switch */
  .switch input:checked + .slider {
    background: linear-gradient(135deg, #6366f1, #8b5cf6) !important;
  }
  .switch .slider::before {
    content: '';
    position: absolute;
    height: 22px; width: 22px;
    left: 3px; top: 3px;
    background: white;
    border-radius: 50%;
    transition: .2s;
    box-shadow: 0 2px 4px rgba(0,0,0,0.3);
  }
  .switch input:checked + .slider::before {
    transform: translateX(22px);
  }
`
document.head.appendChild(liveStyle)

// ── Toggle on/off do Live View ───────────────────────────────────────────────
async function initLiveToggle() {
  const toggle = document.getElementById('live-toggle')
  const desc = document.getElementById('live-toggle-desc')
  const empty = document.getElementById('live-empty')
  const grid = document.getElementById('live-grid')
  if (!toggle) return

  // Carrega config salva
  try {
    const settings = await window.api.settings.get()
    toggle.checked = settings.liveViewEnabled !== false
  } catch {}

  applyToggleState(toggle.checked)

  toggle.addEventListener('change', async () => {
    const on = toggle.checked
    try { await window.api.settings.set({ liveViewEnabled: on }) } catch {}
    applyToggleState(on)
    if (!on) {
      // Limpa frames cacheados e reseta o grid
      for (const s of liveSessions.values()) s.frame = null
      renderLiveGrid()
    }
  })

  function applyToggleState(on) {
    if (on) {
      desc.innerHTML = 'Visualiza em tempo real o que cada automação está fazendo. <strong style="color:#a78bfa">+30 MB de RAM por sessão ativa</strong>.'
      grid.style.display = 'grid'
      // Reseta o empty state pra mensagem padrão (caso tenha vindo de "modo leve")
      if (empty) {
        empty.innerHTML = `
          <div class="empty-icon" style="font-size:48px">📺</div>
          <p style="margin-top:12px;color:var(--text-dim)">Nenhuma automação rodando agora.<br><small>Quando uma automação iniciar, ela aparece aqui ao vivo.</small></p>
        `
      }
      renderLiveGrid() // re-renderiza pra mostrar/esconder empty corretamente
    } else {
      desc.innerHTML = '<strong style="color:#3fb950">Modo leve ativo</strong> — automações rodam em background sem capturar telas. Economia de ~30 MB por sessão.'
      grid.style.display = 'none'
      if (empty) {
        empty.style.display = 'block'
        empty.innerHTML = `
          <div class="empty-icon" style="font-size:48px">⚡</div>
          <p style="margin-top:12px;color:var(--text-dim)">
            <strong style="color:#3fb950">Modo leve ativo</strong><br>
            <small>Suas automações continuam rodando normalmente — só a visualização ao vivo está desligada.</small>
          </p>
        `
      }
    }
  }
}

// Inicializa quando o app carregar
window.addEventListener('DOMContentLoaded', () => setTimeout(initLiveToggle, 100))

// Quando entrar na aba live, faz refresh + ativa polling
document.addEventListener('click', (e) => {
  const navItem = e.target.closest('[data-page="live"]')
  if (navItem) {
    refreshLiveSessions()
    startLiveJobsPolling()
  }
  // Quando sair da aba live, para o polling pra economizar recursos
  const otherNav = e.target.closest('.nav-item:not([data-page="live"])')
  if (otherNav) stopLiveJobsPolling()
})

// Inicia ja se a aba aovivo estiver ativa no boot
if (document.querySelector('[data-page="live"].active')) {
  startLiveJobsPolling()
}

// ── Auto-update: notificacoes ────────────────────────────────────────────────
window.api.on('update:status', (data) => {
  if (data.state === 'downloading') {
    if (typeof data.percent === 'number') {
      toast(`Baixando atualizacao... ${data.percent}%`)
    } else if (data.version) {
      toast(`Nova versao ${data.version} disponivel — baixando em segundo plano`, 'info')
    }
  } else if (data.state === 'ready') {
    showUpdateReadyBanner(data.version)
  }
})

function showUpdateReadyBanner(version) {
  // Remove popup anterior se houver
  document.getElementById('update-popup')?.remove()
  const popup = document.createElement('div')
  popup.id = 'update-popup'
  popup.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 9999;
    width: 320px; max-width: calc(100vw - 48px);
    background: linear-gradient(135deg, #1a1830, #2a1f4d);
    border: 1px solid rgba(139,92,246,0.4);
    border-radius: 14px;
    padding: 18px 20px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(139,92,246,0.15);
    color: white;
    font-family: inherit;
    animation: slideUpFade 0.3s ease-out;
  `
  popup.innerHTML = `
    <style>
      @keyframes slideUpFade {
        from { opacity: 0; transform: translateY(20px) }
        to { opacity: 1; transform: translateY(0) }
      }
    </style>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="font-size:24px">🎉</div>
      <div style="font-weight:800;font-size:15px;flex:1">Nova versão disponível</div>
      <button id="update-close-btn" style="
        background:none;border:none;color:rgba(255,255,255,0.5);
        font-size:20px;cursor:pointer;padding:0 4px;line-height:1;
      ">×</button>
    </div>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-bottom:14px">
      A versão <strong style="color:#a78bfa">${version}</strong> foi baixada e está pronta para instalar.
    </div>
    <div style="display:flex;gap:8px">
      <button id="update-now-btn" style="
        flex:1;
        background: linear-gradient(135deg,#6366f1,#8b5cf6);
        color: white; border: none;
        padding: 8px 12px; border-radius: 8px;
        cursor: pointer; font-weight: 700; font-size: 13px;
      ">Reiniciar e atualizar</button>
      <button id="update-later-btn" style="
        background: rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.85);
        border: 1px solid rgba(255,255,255,0.12);
        padding: 8px 14px; border-radius: 8px;
        cursor: pointer; font-size: 13px;
      ">Depois</button>
    </div>
  `
  document.body.appendChild(popup)
  document.getElementById('update-now-btn').onclick = () => window.api.update.install()
  document.getElementById('update-later-btn').onclick = () => popup.remove()
  document.getElementById('update-close-btn').onclick = () => popup.remove()
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refreshAll() {
  const [jobs, accounts] = await Promise.all([
    window.api.jobs.list(),
    window.api.accounts.list(),
  ])
  renderJobs(jobs)
  renderDashboard(jobs, accounts)
  renderAccountGrid(accounts)
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard(jobs, accounts) {
  const running = jobs.filter(j => j.running || (j.lastStatus && j.lastStatus !== 'parado' && j.lastStatus !== 'erro')).length
  const posts   = jobs.reduce((s, j) => s + (j.postsHoje || 0), 0)
  document.getElementById('stat-running').textContent  = running
  document.getElementById('stat-posts').textContent    = posts
  document.getElementById('stat-accounts').textContent = accounts.length

  const el = document.getElementById('dashboard-jobs')
  if (!jobs.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">⚙</div><p>Nenhuma automação criada ainda.</p></div>`
    return
  }
  el.innerHTML = jobs.map(j => buildJobCard(j, true)).join('')
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
function renderJobs(jobs) {
  const el = document.getElementById('jobs-list')
  if (!jobs.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">⚙</div><p>Nenhuma automação criada.</p><p class="text-sm text-muted mt-8">Clique em "+ Nova automação" para começar.</p></div>`
    return
  }
  el.innerHTML = jobs.map(j => buildJobCard(j, false)).join('')
}

function buildJobCard(job, compact) {
  const platBadge = job.platform === 'tiktok' ? 'badge-tk' : 'badge-ig'
  const platLabel = job.platform === 'tiktok' ? '🎵 TikTok' : '📸 Instagram'
  const statusCls = getStatusClass(job.status || job.lastStatus)
  const statusTxt = job.status || job.lastStatus || 'parado'
  const lastRun   = job.lastRun ? `Último: ${new Date(job.lastRun).toLocaleString('pt-BR')}` : 'Nunca executado'
  const interval  = job.intervalMin ? `${job.intervalMin}min` : '—'
  const source    = sourceLabel(job.source)
  return `
  <div class="job-card" id="job-${job.id}">
    <div class="job-header">
      <div class="job-title">${esc(job.name || 'Sem nome')}</div>
      <span class="job-badge ${platBadge}">${platLabel}</span>
      <div class="job-status ${statusCls}">● ${esc(statusTxt)}</div>
    </div>
    <div class="job-meta">
      <span>📡 ${source}</span>
      <span>👤 @${esc(job.account || '?')}</span>
      <span>⏱ ${interval}</span>
      <span>${lastRun}</span>
      ${job.postCount ? `<span>✅ ${job.postCount} posts</span>` : ''}
    </div>
    ${compact ? '' : `
    <div class="job-actions">
      ${job.running
        ? `<button class="btn btn-ghost btn-sm" onclick="stopJob('${job.id}')">⏹ Parar</button>`
        : `<button class="btn btn-primary btn-sm" onclick="startJob('${job.id}')">▶ Iniciar</button>`}
      <button class="btn btn-ghost btn-sm" onclick="runNow('${job.id}')">⚡ Executar agora</button>
      <button class="btn btn-ghost btn-sm" onclick="editJob('${job.id}')">✏️ Editar</button>
      <button class="btn btn-ghost btn-sm" onclick="openLogs('${job.id}')">📋 Logs</button>
      <button class="btn btn-danger btn-sm" onclick="deleteJob('${job.id}')">🗑</button>
    </div>`}
  </div>`
}

function getStatusClass(status) {
  if (!status || status === 'parado') return 'stopped'
  if (status.includes('erro') || status.includes('❌')) return 'error'
  if (status.includes('postando') || status.includes('aguardando')) return 'waiting'
  if (status.includes('✅') || status === 'rodando') return 'running'
  return 'stopped'
}

function sourceLabel(src) {
  const map = { youtube: '▶ YouTube', instagram: '📸 Instagram', tiktok: '🎵 TikTok', manual: '📂 Manual', whatsapp: '💬 WhatsApp' }
  return map[src] || src || '—'
}

function updateJobStatus(jobId, status) {
  const el = document.querySelector(`#job-${jobId} .job-status`)
  if (!el) return
  el.textContent = `● ${status}`
  el.className = `job-status ${getStatusClass(status)}`
}

function updateJobCard(job) {
  const el = document.getElementById(`job-${job.id}`)
  if (!el) return
  const meta = el.querySelector('.job-meta')
  if (!meta) return
  const lastRun = job.lastRun ? `Último: ${new Date(job.lastRun).toLocaleString('pt-BR')}` : 'Nunca executado'
  // Update last run and post count
  const spans = meta.querySelectorAll('span')
  if (spans[3]) spans[3].textContent = lastRun
  if (job.postCount && spans[4]) spans[4].textContent = `✅ ${job.postCount} posts`
}

async function startJob(id) {
  await window.api.jobs.start(id)
  toast('Automação iniciada', 'ok')
  setTimeout(refreshAll, 500)
}

async function stopJob(id) {
  await window.api.jobs.stop(id)
  toast('Automação pausada', 'ok')
  setTimeout(refreshAll, 500)
}

async function runNow(id) {
  await window.api.jobs.runNow(id)
  toast('Executando agora...', 'ok')
}

async function deleteJob(id) {
  // confirm() nativo bagunça o foco do renderer (input nao recebe teclado depois)
  // Usar modal customizado em vez disso
  const ok = await customConfirm('Excluir esta automação?')
  if (!ok) return
  await window.api.jobs.delete(id)
  toast('Automação excluída')
  refreshAll()
}

// Modal de confirmação que NAO usa o confirm() nativo (que quebra foco)
function customConfirm(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;
      display:flex;align-items:center;justify-content:center;
    `
    overlay.innerHTML = `
      <div style="
        background:#1a1830;
        border:1px solid rgba(139,92,246,0.3);
        border-radius:14px;padding:24px 28px;
        max-width:380px;width:90%;
        box-shadow:0 20px 60px rgba(0,0,0,0.6);
      ">
        <div style="font-size:15px;color:#eef2f9;margin-bottom:20px;line-height:1.5">${esc(message)}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="cc-cancel" style="
            background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
            color:rgba(255,255,255,0.85);padding:8px 18px;border-radius:8px;cursor:pointer;
          ">Cancelar</button>
          <button id="cc-ok" style="
            background:linear-gradient(135deg,#ef4444,#dc2626);border:none;
            color:white;padding:8px 18px;border-radius:8px;cursor:pointer;font-weight:700;
          ">Excluir</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    const close = (v) => { overlay.remove(); resolve(v) }
    overlay.querySelector('#cc-ok').onclick = () => close(true)
    overlay.querySelector('#cc-cancel').onclick = () => close(false)
    overlay.onclick = (e) => { if (e.target === overlay) close(false) }
  })
}

function openLogs(jobId) {
  navigateTo('logs')
  setTimeout(() => {
    const el = document.getElementById('logs-page-output')
    const lines = logLines.filter(l => l.jobId === jobId)
    el.innerHTML = lines.length
      ? lines.map(buildLogLine).join('')
      : `<span style="color:var(--dim)">Nenhum log para este job ainda.</span>`
    el.scrollTop = el.scrollHeight
  }, 100)
}

// ── Accounts ──────────────────────────────────────────────────────────────────
async function loadAccounts() {
  const accounts = await window.api.accounts.list()
  renderAccountGrid(accounts)
}

function renderAccountGrid(accounts) {
  const el = document.getElementById('account-grid')
  if (!accounts.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">👤</div><p>Nenhuma conta adicionada.</p></div>`
    return
  }
  const icon = (p) => p === 'tiktok' ? '🎵' : p === 'youtube' ? '▶️' : '📸'
  const label = (p) => p === 'tiktok' ? 'TikTok' : p === 'youtube' ? 'YouTube (cookies)' : 'Instagram'
  el.innerHTML = accounts.map(a => `
    <div class="account-card">
      <div class="account-avatar ${a.platform}">
        ${icon(a.platform)}
      </div>
      <div class="account-info">
        <div class="name">@${esc(a.username)}</div>
        <div class="platform">${label(a.platform)}</div>
        <div class="account-status"><span class="dot-connected"></span> Conectado</div>
      </div>
      <button class="account-remove" title="Remover" onclick="removeAccount('${a.id}')">✕</button>
    </div>`).join('')
}

function toggleAddAccount() {
  const el = document.getElementById('add-account-form')
  el.classList.toggle('hidden')
  if (!el.classList.contains('hidden')) {
    document.getElementById('input-username').focus()
    document.getElementById('add-account-status').style.display = 'none'
  }
}

function selectPlatform(el) {
  document.querySelectorAll('.platform-btn').forEach(b => b.classList.remove('selected'))
  el.classList.add('selected')
  selectedPlatform = el.dataset.plat
}

async function addAccount() {
  const username = document.getElementById('input-username').value.trim().replace('@', '')
  if (!username) { toast('Digite o nome de usuário', 'err'); return }
  const statusEl = document.getElementById('add-account-status')
  statusEl.style.display = 'block'
  statusEl.textContent = '🔐 Abrindo janela de login... Faça login normalmente.'
  statusEl.style.color = 'var(--yellow)'
  const res = await window.api.accounts.add({ platform: selectedPlatform, username })
  if (res.ok) {
    statusEl.textContent = '✅ Conta adicionada!'
    statusEl.style.color = 'var(--green)'
    document.getElementById('input-username').value = ''
    toast('Conta adicionada com sucesso!', 'ok')
    setTimeout(() => toggleAddAccount(), 1500)
    await loadAccounts()
  } else {
    statusEl.textContent = `❌ ${res.error}`
    statusEl.style.color = 'var(--red)'
  }
}

async function removeAccount(id) {
  const ok = await customConfirm('Remover esta conta?')
  if (!ok) return
  await window.api.accounts.remove(id)
  toast('Conta removida')
  loadAccounts()
}

// ── Wizard ────────────────────────────────────────────────────────────────────
let wizardEditingId = null

async function editJob(id) {
  const jobs = await window.api.jobs.list()
  const job = jobs.find(j => j.id === id)
  if (!job) { toast('Automação não encontrada', 'err'); return }
  if (job.running) {
    const ok = await customConfirm('Esta automação está rodando. Parar antes de editar?')
    if (!ok) return
    await window.api.jobs.stop(id)
  }
  wizardEditingId = id
  wizardStep = 0
  // Pre-preenche com TUDO do job (defaults mesclados pra campos novos que job antigo nao tinha)
  wizardData = {
    name: '', platform: 'instagram', account: '',
    source: 'youtube', sourceUrls: '', sourceHandles: '',
    filterMinDur: 10, filterMaxDur: 3600,
    filterKeywordInclude: '', filterKeywordExclude: '',
    filterOnlyNew: true, filterMaxVideos: 20,
    cutType: 'smart', editMode: 'auto',
    watermarkType: 'none', watermarkText: '', watermarkImagePath: '', watermarkPosition: 'br',
    outroType: 'none', outroPath: '', outroDurationSec: 3,
    ytMode: 'original', ytTargetMin: 10, ytVoz: 'homem', ytLegenda: false,
    ytLangOrigem: 'auto', ytVisibility: 'private', ytCategory: 'Entretenimento', ytMadeForKids: false,
    captionType: 'ai', captionTemplate: '', captionNiche: '',
    scheduleType: 'interval', intervalMin: 60, timeWindows: '08:00-22:00',
    autoStart: true,
    ...job,
  }
  document.getElementById('wizard-overlay').classList.add('open')
  document.getElementById('wizard-title').textContent = 'Editar Automação'
  renderWizardStep()
  setTimeout(() => {
    window.focus()
    const firstInput = document.querySelector('#wizard-body input, #wizard-body textarea, #wizard-body select')
    if (firstInput) firstInput.focus()
  }, 80)
}

function openWizard() {
  wizardEditingId = null
  wizardStep = 0
  wizardData = {
    name: '', platform: 'instagram', account: '',
    source: 'youtube', sourceUrls: '', sourceHandles: '',
    // Filtros de fonte. Duração: defaults amplos = sem filtro efetivo.
    // Filtro de duração removido do UI em v1.0.44 — o cliente nao via o
    // campo, mas o default antigo (60-300s) descartava videos do canal
    // silenciosamente. Agora 10-3600s é so sanity check (ignora live de 4h).
    filterMinDur: 10, filterMaxDur: 3600,
    filterKeywordInclude: '', filterKeywordExclude: '',
    filterOnlyNew: true, filterMaxVideos: 20,
    cutType: 'smart', // 'smart' | 'full'
    editMode: 'auto', // 'auto' (edição IA estilo TikTok) | 'original' (vídeo + thumb)
    watermarkType: 'none', watermarkText: '', watermarkImagePath: '', watermarkPosition: 'br',
    // Anexo no final (divulgar produto/servico): cola foto/video no fim do reel
    outroType: 'none', outroPath: '', outroDurationSec: 3,
    // YouTube (atras de feature flag)
    ytMode: 'original', // 'original' | 'corteDenso' | 'dublado' | 'corteDensoDublado'
    ytTargetMin: 10,
    ytVoz: 'homem', // 'homem' | 'mulher'
    ytLegenda: false, // queimar legenda no video
    ytLangOrigem: 'auto',
    ytVisibility: 'private', // 'public' | 'unlisted' | 'private'
    ytCategory: 'Entretenimento',
    ytMadeForKids: false,
    // Legenda
    captionType: 'ai', captionTemplate: '', captionNiche: '',
    // Agendamento
    scheduleType: 'interval', intervalMin: 60, timeWindows: '08:00-22:00',
    autoStart: true,
  }
  document.getElementById('wizard-overlay').classList.add('open')
  document.getElementById('wizard-title').textContent = 'Nova Automação'
  renderWizardStep()
  // Garante que a janela e o primeiro input recebem foco (corrige bug pos-confirm nativo)
  setTimeout(() => {
    window.focus()
    const firstInput = document.querySelector('#wizard-body input, #wizard-body textarea, #wizard-body select')
    if (firstInput) firstInput.focus()
  }, 80)
}

function closeWizard() {
  wizardEditingId = null
  document.getElementById('wizard-overlay').classList.remove('open')
}

// Captura o que tá no DOM nos campos wiz-* e salva no wizardData.
// Chamado antes de re-renderizar pra não perder o que o user digitou.
function syncDOMToWizard() {
  const map = {
    'wiz-name': ['name', 'text'],
    'wiz-urls': ['sourceUrls', 'text'],
    'wiz-handles': ['sourceHandles', 'text'],
    'wiz-folder': ['sourceFolder', 'text'],
    'wiz-max-videos': ['filterMaxVideos', 'int'],
    'wiz-kw-include': ['filterKeywordInclude', 'text'],
    'wiz-kw-exclude': ['filterKeywordExclude', 'text'],
    'wiz-only-new': ['filterOnlyNew', 'check'],
    'wiz-wm-text': ['watermarkText', 'text'],
    'wiz-wm-image': ['watermarkImagePath', 'text'],
    'wiz-outro-path': ['outroPath', 'text'],
    'wiz-outro-dur': ['outroDurationSec', 'int'],
    'wiz-caption-niche': ['captionNiche', 'text'],
    'wiz-caption-template': ['captionTemplate', 'text'],
    'wiz-interval': ['intervalMin', 'int'],
    'wiz-time-windows': ['timeWindows', 'text'],
  }
  for (const [id, [key, kind]] of Object.entries(map)) {
    const el = document.getElementById(id)
    if (!el) continue
    if (kind === 'check') wizardData[key] = el.checked
    else if (kind === 'int') wizardData[key] = parseInt(el.value || '0') || 0
    else wizardData[key] = el.value
  }
}

function renderWizardStep() {
  syncDOMToWizard()
  const stepsEl = document.getElementById('wizard-steps')
  stepsEl.innerHTML = wizardSteps.map((s, i) => `
    <div class="wizard-step ${i === wizardStep ? 'active' : i < wizardStep ? 'done' : ''}">${s}</div>`
  ).join('')
  document.getElementById('wizard-back').style.display = wizardStep === 0 ? 'none' : ''
  document.getElementById('wizard-next').textContent = wizardStep === wizardSteps.length - 1
    ? (wizardEditingId ? '💾 Salvar' : '✅ Criar')
    : 'Próximo →'
  document.getElementById('wizard-body').innerHTML = getWizardBody(wizardStep)
}

function getWizardBody(step) {
  switch (step) {
    case 0: return `
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label>Nome da automação</label>
          <input type="text" id="wiz-name" value="${esc(wizardData.name)}" placeholder="ex: Reels de Negócios">
        </div>
        <div class="form-group" style="flex:1">
          <label>Postar para</label>
          <div class="platform-select">
            <div class="platform-btn ${wizardData.platform==='instagram'?'selected':''}" data-plat="instagram" onclick="wizSelectPlatform(this)">📸 IG</div>
            <div class="platform-btn ${wizardData.platform==='tiktok'?'selected':''}" data-plat="tiktok" onclick="wizSelectPlatform(this)">🎵 TK</div>
            ${window.__pmSettings?.youtubeBeta ? `<div class="platform-btn ${wizardData.platform==='youtube'?'selected':''}" data-plat="youtube" onclick="wizSelectPlatform(this)" title="YouTube (beta)">▶ YT</div>` : ''}
          </div>
        </div>
      </div>

      <div class="form-group">
        <label>Onde buscar o conteúdo</label>
        <div class="source-grid">
          ${[
            ['youtube',   '▶',  'YouTube', 'Canais / URLs'],
            ['instagram', '📸', 'Instagram', 'Perfis públicos'],
            ['tiktok',    '🎵', 'TikTok', 'Perfis públicos'],
            ['manual',    '📂', 'Pasta local', 'Seus próprios vídeos'],
          ].map(([v,i,l,d]) => `
            <div class="source-card ${wizardData.source===v?'selected':''}" onclick="wizSelectSource('${v}',this)">
              <div class="icon">${i}</div>
              <div class="label">${l}</div>
              <div class="desc">${d}</div>
            </div>`).join('')}
        </div>
      </div>

      ${wizardData.source === 'youtube' ? `
        <div class="form-group">
          <label>Canais do YouTube <span class="text-muted">(um por linha)</span></label>
          <textarea id="wiz-urls" rows="3" placeholder="https://www.youtube.com/@canal1/videos&#10;https://www.youtube.com/@canal2/videos">${esc(wizardData.sourceUrls)}</textarea>
        </div>` : ''}

      ${['instagram','tiktok'].includes(wizardData.source) ? `
        <div class="form-group">
          <label>Perfis para copiar <span class="text-muted">(sem @, um por linha)</span></label>
          <textarea id="wiz-handles" rows="3" placeholder="perfil1&#10;perfil2">${esc(wizardData.sourceHandles)}</textarea>
        </div>` : ''}

      ${wizardData.source === 'manual' ? `
        <div class="form-group">
          <label>Pasta com os vídeos</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="wiz-folder" value="${esc(wizardData.sourceFolder||'')}" placeholder="C:\\Videos\\meus-reels" style="flex:1">
            <button class="btn btn-ghost btn-sm" onclick="pickFolder()">📂 Escolher</button>
          </div>
        </div>` : ''}

      ${wizardData.source !== 'manual' && wizardData.platform !== 'youtube' ? `
        <div class="filter-section">
          <div class="filter-section-title">✂ Tipo de corte</div>
          <div class="form-group" style="margin-bottom:14px">
            <div style="display:flex;flex-direction:column;gap:8px">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:10px;${wizardData.cutType === 'smart' ? 'background:rgba(99,102,241,0.08);border-color:rgba(99,102,241,0.4)' : ''}">
                <input type="radio" name="cutType" value="smart" ${wizardData.cutType === 'smart' || !wizardData.cutType ? 'checked' : ''} onchange="wizardData.cutType='smart';renderWizardStep()" style="margin:0">
                <div style="flex:1">
                  <div style="font-weight:700;font-size:13.5px">🧠 Corte inteligente com IA <span style="color:#a78bfa;font-size:11px;font-weight:600">RECOMENDADO</span></div>
                  <div style="font-size:12px;color:var(--text-dim);margin-top:2px">A IA lê as legendas do vídeo e corta o trecho com gancho viral mais forte (60s)</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:10px;${wizardData.cutType === 'full' ? 'background:rgba(99,102,241,0.08);border-color:rgba(99,102,241,0.4)' : ''}">
                <input type="radio" name="cutType" value="full" ${wizardData.cutType === 'full' ? 'checked' : ''} onchange="wizardData.cutType='full';renderWizardStep()" style="margin:0">
                <div style="flex:1">
                  <div style="font-weight:700;font-size:13.5px">📹 Vídeo inteiro</div>
                  <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Posta o vídeo completo. Se passar do limite (IG 90s, TT 600s), corta automaticamente do início.</div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div class="filter-section">
          <div class="filter-section-title">🎬 Modo de edição</div>
          <div class="form-group" style="margin-bottom:14px">
            <div style="display:flex;flex-direction:column;gap:8px">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:10px;${(wizardData.editMode || 'auto') === 'auto' ? 'background:rgba(99,102,241,0.08);border-color:rgba(99,102,241,0.4)' : ''}">
                <input type="radio" name="editMode" value="auto" ${(wizardData.editMode || 'auto') === 'auto' ? 'checked' : ''} onchange="wizardData.editMode='auto';renderWizardStep()" style="margin:0">
                <div style="flex:1">
                  <div style="font-weight:700;font-size:13.5px">🎬 Edição automática com IA <span style="color:#a78bfa;font-size:11px;font-weight:600">RECOMENDADO</span></div>
                  <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Corte de silêncio, legenda karaokê estilo TikTok, e câmera que segue quem está falando — tudo automático.</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:10px;${wizardData.editMode === 'original' ? 'background:rgba(99,102,241,0.08);border-color:rgba(99,102,241,0.4)' : ''}">
                <input type="radio" name="editMode" value="original" ${wizardData.editMode === 'original' ? 'checked' : ''} onchange="wizardData.editMode='original';renderWizardStep()" style="margin:0">
                <div style="flex:1">
                  <div style="font-weight:700;font-size:13.5px">📹 Vídeo original</div>
                  <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Mantém o vídeo 16:9 com thumbnail no topo e marca d'água — modo clássico, sem edição.</div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div class="filter-section">
          <label class="form-check">
            <input type="checkbox" id="wiz-only-new" ${wizardData.filterOnlyNew?'checked':''}>
            Pular vídeos já postados anteriormente
          </label>
        </div>` : ''}

      <div class="filter-section">
        <div class="filter-section-title">💧 Marca d'água (opcional)</div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Tipo</label>
          <select id="wiz-wm-type" onchange="wizardData.watermarkType=this.value;renderWizardStep()">
            <option value="none" ${(!wizardData.watermarkType||wizardData.watermarkType==='none')?'selected':''}>Nenhuma</option>
            <option value="text" ${wizardData.watermarkType==='text'?'selected':''}>📝 Texto (ex: @suaconta)</option>
            <option value="image" ${wizardData.watermarkType==='image'?'selected':''}>🖼️ Imagem (logo PNG)</option>
          </select>
        </div>
        ${wizardData.watermarkType === 'text' ? `
          <div class="form-group">
            <label>Texto da marca</label>
            <input type="text" id="wiz-wm-text" value="${esc(wizardData.watermarkText||'')}" placeholder="@suaconta" maxlength="40">
            <span class="text-sm text-muted">Geralmente o @ da sua conta. Aparece com sombra preta pra ficar legível em qualquer fundo.</span>
          </div>
        ` : ''}
        ${wizardData.watermarkType === 'image' ? `
          <div class="form-group">
            <label>Imagem (PNG transparente recomendado)</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="wiz-wm-image" value="${esc(wizardData.watermarkImagePath||'')}" placeholder="C:\\caminho\\logo.png" style="flex:1">
              <button class="btn btn-ghost btn-sm" onclick="pickWatermarkImage()">📂 Escolher</button>
            </div>
            <span class="text-sm text-muted">Será redimensionada pra 162px de largura no vídeo 9:16</span>
          </div>
        ` : ''}
        ${wizardData.watermarkType && wizardData.watermarkType !== 'none' ? `
          <div class="form-group">
            <label>Posição no vídeo <span class="text-muted">— evita rodapé (botões IG/TikTok cobrem)</span></label>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:300px">
              ${[
                ['tl','↖ Topo-Esq'], ['tc','▲ Topo'], ['tr','↗ Topo-Dir'],
                ['', ''],            ['c','● Centro'], ['', ''],
              ].map(([val,label]) => val ? `
                <label style="cursor:pointer;padding:8px;text-align:center;border:1px solid var(--border);border-radius:8px;font-size:12px;${(wizardData.watermarkPosition||'tr')===val?'background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.5);color:#a78bfa;font-weight:600':''}">
                  <input type="radio" name="wmPos" value="${val}" ${(wizardData.watermarkPosition||'tr')===val?'checked':''} onchange="wizardData.watermarkPosition='${val}';renderWizardStep()" style="display:none">
                  ${label}
                </label>` : '<div></div>').join('')}
            </div>
            <div style="margin-top:8px;padding:8px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:8px;font-size:11.5px;color:#f59e0b">
              ⚠️ Não use rodapé — Instagram e TikTok cobrem com botões de curtir/comentar/perfil
            </div>
          </div>
        ` : ''}
      </div>

      <div class="filter-section">
        <div class="filter-section-title">📢 Anexar no final (opcional)</div>
        <div class="text-sm text-muted" style="margin-bottom:10px">
          Cola uma foto ou vídeo curto no final de cada postagem — pra divulgar produto, oferta, link da bio, etc.
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Tipo</label>
          <select id="wiz-outro-type" onchange="wizardData.outroType=this.value;renderWizardStep()">
            <option value="none" ${(!wizardData.outroType||wizardData.outroType==='none')?'selected':''}>Nenhum</option>
            <option value="image" ${wizardData.outroType==='image'?'selected':''}>🖼️ Foto (X segundos)</option>
            <option value="video" ${wizardData.outroType==='video'?'selected':''}>🎬 Vídeo curto</option>
          </select>
        </div>
        ${wizardData.outroType === 'image' ? `
          <div class="form-group">
            <label>Imagem (JPG ou PNG)</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="wiz-outro-path" value="${esc(wizardData.outroPath||'')}" placeholder="C:\\caminho\\divulgacao.jpg" style="flex:1">
              <button class="btn btn-ghost btn-sm" onclick="pickOutroImage()">📂 Escolher</button>
            </div>
            <span class="text-sm text-muted">Será centralizada em fundo preto no formato 9:16 (1080×1920)</span>
          </div>
          <div class="form-group">
            <label>Duração</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="number" id="wiz-outro-dur" value="${wizardData.outroDurationSec || 3}" min="1" max="15" style="width:80px">
              <span class="text-muted text-sm">segundos (1–15)</span>
            </div>
          </div>
        ` : ''}
        ${wizardData.outroType === 'video' ? `
          <div class="form-group">
            <label>Vídeo (MP4)</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="wiz-outro-path" value="${esc(wizardData.outroPath||'')}" placeholder="C:\\caminho\\divulgacao.mp4" style="flex:1">
              <button class="btn btn-ghost btn-sm" onclick="pickOutroVideo()">📂 Escolher</button>
            </div>
            <span class="text-sm text-muted">Será convertido pra 9:16 (1080×1920) e concatenado no final</span>
          </div>
        ` : ''}
      </div>

      ${wizardData.platform === 'youtube' ? `
      <div class="filter-section" style="border-color:rgba(239,68,68,0.25);background:rgba(239,68,68,0.04)">
        <div class="filter-section-title">▶️ Configuração YouTube</div>

        <div class="form-group">
          <label>Modo de processamento</label>
          <select onchange="wizardData.ytMode=this.value;renderWizardStep()">
            <option value="original" ${wizardData.ytMode==='original'?'selected':''}>📼 Original — só re-encoda 16:9 + watermark (rápido)</option>
            <option value="corteDenso" ${wizardData.ytMode==='corteDenso'?'selected':''}>✂️ Corte inteligente — pega 8-12min de vídeo longo</option>
            <option value="dublado" ${wizardData.ytMode==='dublado'?'selected':''}>🎤 Dublado PT-BR — Whisper + Qwen + Piper TTS local</option>
            <option value="corteDensoDublado" ${wizardData.ytMode==='corteDensoDublado'?'selected':''}>✂️🎤 Corte + Dublado (mais lento)</option>
          </select>
          <span class="text-sm text-muted">Tempo: original ~3min · corte ~8min · dublado ~25min · combo ~35min (vídeo de 15min)</span>
        </div>

        ${wizardData.ytMode === 'corteDenso' || wizardData.ytMode === 'corteDensoDublado' ? `
          <div class="form-group">
            <label>Duração alvo do corte (min)</label>
            <input type="number" min="3" max="20" value="${wizardData.ytTargetMin || 10}" onchange="wizardData.ytTargetMin=parseInt(this.value)||10">
          </div>
        ` : ''}

        ${wizardData.ytMode === 'dublado' || wizardData.ytMode === 'corteDensoDublado' ? `
          <div class="form-group">
            <label>Voz da narração</label>
            <div style="display:flex;gap:8px">
              <label style="flex:1;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:8px;${wizardData.ytVoz==='homem'?'background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.5)':''}">
                <input type="radio" name="ytVoz" value="homem" ${wizardData.ytVoz==='homem'?'checked':''} onchange="wizardData.ytVoz='homem'" style="margin-right:6px">
                👨 Homem (Faber BR)
              </label>
              <label style="flex:1;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:8px;${wizardData.ytVoz==='mulher'?'background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.5)':''}">
                <input type="radio" name="ytVoz" value="mulher" ${wizardData.ytVoz==='mulher'?'checked':''} onchange="wizardData.ytVoz='mulher'" style="margin-right:6px">
                👩 Mulher (Cadu BR)
              </label>
            </div>
          </div>
          <div class="form-group">
            <label>Idioma do vídeo original</label>
            <select onchange="wizardData.ytLangOrigem=this.value">
              <option value="auto" ${wizardData.ytLangOrigem==='auto'?'selected':''}>🔍 Detectar automaticamente</option>
              <option value="en" ${wizardData.ytLangOrigem==='en'?'selected':''}>🇺🇸 Inglês</option>
              <option value="es" ${wizardData.ytLangOrigem==='es'?'selected':''}>🇪🇸 Espanhol</option>
              <option value="ja" ${wizardData.ytLangOrigem==='ja'?'selected':''}>🇯🇵 Japonês</option>
              <option value="ko" ${wizardData.ytLangOrigem==='ko'?'selected':''}>🇰🇷 Coreano</option>
              <option value="pt" ${wizardData.ytLangOrigem==='pt'?'selected':''}>🇧🇷 Português (re-narração)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-check">
              <input type="checkbox" ${wizardData.ytLegenda?'checked':''} onchange="wizardData.ytLegenda=this.checked">
              Queimar legenda PT-BR no vídeo
            </label>
          </div>
        ` : ''}

        <div class="form-row">
          <div class="form-group" style="flex:1">
            <label>Visibilidade</label>
            <select onchange="wizardData.ytVisibility=this.value">
              <option value="private" ${wizardData.ytVisibility==='private'?'selected':''}>🔒 Privado</option>
              <option value="unlisted" ${wizardData.ytVisibility==='unlisted'?'selected':''}>🔗 Não listado</option>
              <option value="public" ${wizardData.ytVisibility==='public'?'selected':''}>🌎 Público</option>
            </select>
          </div>
          <div class="form-group" style="flex:1">
            <label>Categoria</label>
            <select onchange="wizardData.ytCategory=this.value">
              ${['Filmes e Animação','Carros e Veículos','Música','Animais','Esportes','Viagens e Eventos','Jogos','Pessoas e Blogs','Comédia','Entretenimento','Notícias e Política','Estilo e Beleza','Educação','Ciência e Tecnologia','Sem Fins Lucrativos'].map(c=>`<option value="${c}" ${wizardData.ytCategory===c?'selected':''}>${c}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label>Audiência (lei COPPA)</label>
          <select onchange="wizardData.ytMadeForKids=this.value==='yes'">
            <option value="no" ${!wizardData.ytMadeForKids?'selected':''}>Não, não é feito pra crianças</option>
            <option value="yes" ${wizardData.ytMadeForKids?'selected':''}>Sim, é feito pra crianças</option>
          </select>
        </div>
      </div>
      ` : ''}
    `
    case 1: return `
      <div id="wiz-account-loading" style="color:var(--muted);text-align:center;padding:20px">
        Carregando contas...
      </div>
      <div id="wiz-account-body" class="hidden">
        <div class="form-group">
          <label>Conta de destino</label>
          <select id="wiz-account"></select>
        </div>
        <p class="text-sm text-muted mt-8">
          Não encontrou a conta? Vá em <strong>Contas</strong> e faça login primeiro.
        </p>
      </div>
    `
    case 2: return `
      <div class="caption-grid">
        <div class="caption-card ${wizardData.captionType==='ai'?'selected':''}" onclick="wizCaptionType('ai',this)">
          <div class="ctitle">IA embarcada <span style="color:#a78bfa;font-size:10px;font-weight:600">SEO</span></div>
          <div class="cdesc">IA local reescreve o título focando em SEO de pesquisa (nomes de artistas, lugares, temas). Sem citar veículos de imprensa. Sem internet, sem mensalidade.</div>
        </div>
        <div class="caption-card ${wizardData.captionType==='template'?'selected':''}" onclick="wizCaptionType('template',this)">
          <div class="ctitle">✏️ Modelo fixo</div>
          <div class="cdesc">Use um modelo com variáveis como {titulo}.</div>
        </div>
        <div class="caption-card ${wizardData.captionType==='video'?'selected':''}" onclick="wizCaptionType('video',this)">
          <div class="ctitle">🎬 Do vídeo</div>
          <div class="cdesc">Usa o título do vídeo como legenda.</div>
        </div>
        <div class="caption-card ${wizardData.captionType==='none'?'selected':''}" onclick="wizCaptionType('none',this)">
          <div class="ctitle">🚫 Sem legenda</div>
          <div class="cdesc">Posta sem nenhum texto.</div>
        </div>
      </div>
      ${wizardData.captionType === 'ai' ? `
        <div class="form-group">
          <label>Nicho (para o prompt da IA)</label>
          <input type="text" id="wiz-niche" value="${esc(wizardData.captionNiche||'')}" placeholder="ex: empreendedorismo, notícias, saúde">
        </div>` : ''}
      ${wizardData.captionType === 'template' ? `
        <div class="form-group">
          <label>Modelo de legenda</label>
          <textarea id="wiz-template" rows="4" placeholder="🔥 {titulo}&#10;&#10;Siga para mais conteúdo! &#10;&#10;#empreendedorismo #negócios">${esc(wizardData.captionTemplate)}</textarea>
          <span class="text-sm text-muted">Use {titulo} para o título do vídeo.</span>
        </div>` : ''}
    `
    case 3: return `
      <div class="schedule-tabs">
        <button class="schedule-tab ${wizardData.scheduleType==='interval'?'active':''}" onclick="wizScheduleType('interval',this)">⏱ Intervalo fixo</button>
        <button class="schedule-tab ${wizardData.scheduleType==='window'?'active':''}" onclick="wizScheduleType('window',this)">🕐 Janela de horário</button>
      </div>
      ${wizardData.scheduleType === 'interval' ? `
        <div class="form-group">
          <label>Intervalo entre posts (minutos)</label>
          <input type="number" id="wiz-interval" value="${wizardData.intervalMin}" min="5" max="1440">
          <span class="text-sm text-muted">Mínimo: 5 minutos</span>
        </div>` : `
        <div class="form-group">
          <label>Horário de funcionamento (HH:MM-HH:MM)</label>
          <input type="text" id="wiz-window" value="${esc(wizardData.timeWindows)}" placeholder="08:00-22:00">
          <span class="text-sm text-muted">Fora deste horário a automação não posta.</span>
        </div>
        <div class="form-group">
          <label>Intervalo dentro da janela (minutos)</label>
          <input type="number" id="wiz-interval-w" value="${wizardData.intervalMin}" min="5" max="720">
        </div>`}
      <label class="form-check mt-8">
        <input type="checkbox" id="wiz-autostart" ${wizardData.autoStart?'checked':''}>
        Iniciar automaticamente ao abrir o PostMaster
      </label>
    `
    case 4: return `
      <div class="card" style="margin-bottom:0">
        <div class="form-group">
          <label>Nome</label>
          <div>${esc(wizardData.name)}</div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Plataforma</label>
            <div>${wizardData.platform === 'tiktok' ? '🎵 TikTok' : '📸 Instagram'}</div>
          </div>
          <div class="form-group">
            <label>Conta</label>
            <div>@${esc(wizardData.account)}</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Fonte</label>
            <div>${sourceLabel(wizardData.source)}</div>
          </div>
          <div class="form-group">
            <label>Legenda</label>
            <div>${{ ai:'🤖 IA local', template:'✏️ Modelo fixo', video:'🎬 Do vídeo', none:'🚫 Sem legenda' }[wizardData.captionType]}</div>
          </div>
        </div>
        ${wizardData.source !== 'manual' ? `
        <div class="form-row">
          <div class="form-group">
            <label>Verificar últimos</label>
            <div>${wizardData.filterMaxVideos} vídeos do canal</div>
          </div>
          <div class="form-group">
            <label>Só novos</label>
            <div>${wizardData.filterOnlyNew ? '✅ Sim' : '❌ Não'}</div>
          </div>
        </div>
        ${wizardData.filterKeywordInclude ? `<div class="form-group"><label>Incluir palavras</label><div>${esc(wizardData.filterKeywordInclude)}</div></div>` : ''}
        ${wizardData.filterKeywordExclude ? `<div class="form-group"><label>Bloquear palavras</label><div>${esc(wizardData.filterKeywordExclude)}</div></div>` : ''}
        ` : ''}
        <div class="form-group">
          <label>Agendamento</label>
          <div>${wizardData.scheduleType === 'interval' ? `A cada ${wizardData.intervalMin} min` : `Das ${wizardData.timeWindows}, a cada ${wizardData.intervalMin} min`}</div>
        </div>
        <div class="form-group">
          <label>Auto-iniciar</label>
          <div>${wizardData.autoStart ? '✅ Sim' : '❌ Não'}</div>
        </div>
      </div>
    `
  }
}

function wizSelectPlatform(el) {
  document.querySelectorAll('#wizard-body .platform-btn').forEach(b => b.classList.remove('selected'))
  el.classList.add('selected')
  wizardData.platform = el.dataset.plat
}

function wizSelectSource(val, el) {
  document.querySelectorAll('.source-card').forEach(b => b.classList.remove('selected'))
  el.classList.add('selected')
  wizardData.source = val
  renderWizardStep()
}

function wizCaptionType(val, el) {
  document.querySelectorAll('.caption-card').forEach(b => b.classList.remove('selected'))
  el.classList.add('selected')
  wizardData.captionType = val
  renderWizardStep()
}

function wizScheduleType(val, el) {
  document.querySelectorAll('.schedule-tab').forEach(b => b.classList.remove('active'))
  el.classList.add('active')
  wizardData.scheduleType = val
  renderWizardStep()
}

async function pickFolder() {
  const p = await window.api.dialog.openFile([{ name: 'Pasta', extensions: ['*'] }])
  if (p) {
    wizardData.sourceFolder = p
    const el = document.getElementById('wiz-folder')
    if (el) el.value = p
  }
}

async function pickWatermarkImage() {
  const p = await window.api.dialog.openFile([{ name: 'Imagem', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }])
  if (p) {
    wizardData.watermarkImagePath = p
    const el = document.getElementById('wiz-wm-image')
    if (el) el.value = p
  }
}

async function pickOutroImage() {
  const p = await window.api.dialog.openFile([{ name: 'Imagem', extensions: ['png', 'jpg', 'jpeg', 'webp'] }])
  if (p) {
    wizardData.outroPath = p
    const el = document.getElementById('wiz-outro-path')
    if (el) el.value = p
  }
}

async function pickOutroVideo() {
  const p = await window.api.dialog.openFile([{ name: 'Vídeo', extensions: ['mp4', 'mov', 'webm', 'mkv'] }])
  if (p) {
    wizardData.outroPath = p
    const el = document.getElementById('wiz-outro-path')
    if (el) el.value = p
  }
}

async function loadWizardAccounts() {
  const accounts = await window.api.accounts.list()
  const filtered = accounts.filter(a => a.platform === wizardData.platform)
  const loadingEl = document.getElementById('wiz-account-loading')
  const bodyEl    = document.getElementById('wiz-account-body')
  const sel       = document.getElementById('wiz-account')
  if (!loadingEl || !bodyEl || !sel) return
  loadingEl.classList.add('hidden')
  bodyEl.classList.remove('hidden')
  if (!filtered.length) {
    bodyEl.innerHTML = `<p class="text-muted text-sm">Nenhuma conta ${wizardData.platform} adicionada. Vá em "Contas" e faça login primeiro.</p>`
    return
  }
  sel.innerHTML = filtered.map(a => `<option value="${esc(a.username)}">@${esc(a.username)}</option>`).join('')
  wizardData.account = filtered[0].username
  sel.addEventListener('change', () => { wizardData.account = sel.value })
}

function collectWizardStep(step) {
  switch (step) {
    case 0:
      wizardData.name = document.getElementById('wiz-name')?.value.trim() || ''
      if (!wizardData.name) { toast('Digite o nome da automação', 'err'); return false }
      wizardData.sourceUrls    = document.getElementById('wiz-urls')?.value.trim() || ''
      wizardData.sourceHandles = document.getElementById('wiz-handles')?.value.trim() || ''
      wizardData.sourceFolder  = document.getElementById('wiz-folder')?.value.trim() || ''
      if (wizardData.source === 'youtube' && !wizardData.sourceUrls) { toast('Adicione pelo menos uma URL de canal', 'err'); return false }
      if (['instagram','tiktok'].includes(wizardData.source) && !wizardData.sourceHandles) { toast('Adicione pelo menos um perfil', 'err'); return false }
      // Filtros — duração tem defaults amplos (sem filtro efetivo); sem UI.
      wizardData.filterMinDur         = wizardData.filterMinDur || 10
      wizardData.filterMaxDur         = wizardData.filterMaxDur || 3600
      wizardData.filterMaxVideos      = parseInt(document.getElementById('wiz-max-videos')?.value || '20')
      wizardData.filterKeywordInclude = document.getElementById('wiz-kw-include')?.value.trim() || ''
      wizardData.filterKeywordExclude = document.getElementById('wiz-kw-exclude')?.value.trim() || ''
      wizardData.filterOnlyNew        = document.getElementById('wiz-only-new')?.checked ?? true
      // cutType, editMode e watermarkType ja sao atualizados via onchange do radio/select
      wizardData.cutType              = wizardData.cutType || 'smart'
      wizardData.editMode             = wizardData.editMode || 'auto'
      wizardData.watermarkText        = document.getElementById('wiz-wm-text')?.value || ''
      wizardData.watermarkImagePath   = document.getElementById('wiz-wm-image')?.value || ''
      // Outro (anexo no final)
      wizardData.outroPath            = document.getElementById('wiz-outro-path')?.value.trim() || ''
      wizardData.outroDurationSec     = parseInt(document.getElementById('wiz-outro-dur')?.value || '3') || 3
      if (wizardData.outroType && wizardData.outroType !== 'none' && !wizardData.outroPath) {
        toast('Escolha um arquivo pra anexar no final, ou troca pra "Nenhum"', 'err'); return false
      }
      return true
    case 1:
      wizardData.account = document.getElementById('wiz-account')?.value || ''
      if (!wizardData.account) { toast('Selecione uma conta', 'err'); return false }
      return true
    case 2:
      wizardData.captionNiche    = document.getElementById('wiz-niche')?.value.trim() || ''
      wizardData.captionTemplate = document.getElementById('wiz-template')?.value.trim() || ''
      return true
    case 3:
      wizardData.intervalMin  = parseInt(document.getElementById('wiz-interval')?.value || document.getElementById('wiz-interval-w')?.value || '60')
      wizardData.timeWindows  = document.getElementById('wiz-window')?.value || '08:00-22:00'
      wizardData.autoStart    = document.getElementById('wiz-autostart')?.checked ?? true
      if (wizardData.intervalMin < 5) { toast('Intervalo mínimo: 5 minutos', 'err'); return false }
      return true
    default:
      return true
  }
}

async function wizardNext() {
  if (!collectWizardStep(wizardStep)) return

  // Saindo do passo Fonte com YouTube selecionado: pergunta se quer conectar conta YT
  if (wizardStep === 0 && wizardData.source === 'youtube') {
    const accounts = await window.api.accounts.list()
    const hasYt = accounts.some(a => a.platform === 'youtube')
    if (!hasYt) {
      const escolha = await askYoutubeAccount()
      if (escolha === 'cancel') return
      if (escolha === 'connect') {
        // Abre o flow de adicionar conta YouTube
        navigateTo('accounts')
        toggleAddAccount()
        // Pre-seleciona YouTube
        setTimeout(() => {
          document.querySelectorAll('.platform-btn').forEach(b => b.classList.remove('selected'))
          const ytBtn = document.querySelector('[data-plat="youtube"]')
          if (ytBtn) { ytBtn.classList.add('selected'); selectedPlatform = 'youtube' }
          document.getElementById('input-username')?.focus()
        }, 100)
        closeWizard()
        toast('Faça login na conta Google e depois crie a automação novamente', 'info')
        return
      }
      // 'skip' — segue sem conta YT (pode falhar)
    }
  }

  if (wizardStep === wizardSteps.length - 1) {
    if (wizardEditingId) {
      const res = await window.api.jobs.update({ id: wizardEditingId, ...wizardData })
      if (res?.ok !== false) {
        toast('Automação atualizada!', 'ok')
        const id = wizardEditingId
        closeWizard()
        refreshAll()
        navigateTo('jobs')
        // Re-inicia se autoStart marcado (parou no inicio do edit)
        if (wizardData.autoStart) await window.api.jobs.start(id)
      } else {
        toast('Erro ao salvar', 'err')
      }
    } else {
      const res = await window.api.jobs.create(wizardData)
      if (res.ok) {
        toast('Automação criada!', 'ok')
        closeWizard()
        if (wizardData.autoStart) await window.api.jobs.start(res.job.id)
        refreshAll()
        navigateTo('jobs')
      } else {
        toast('Erro ao criar automação', 'err')
      }
    }
    return
  }
  wizardStep++
  renderWizardStep()
  if (wizardStep === 1) loadWizardAccounts()
}

// Modal customizado: pergunta se quer conectar conta Google p/ baixar do YouTube
function askYoutubeAccount() {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10000;
      display:flex;align-items:center;justify-content:center;padding:20px;
    `
    overlay.innerHTML = `
      <div style="
        background:#1a1830;
        border:1px solid rgba(139,92,246,0.3);
        border-radius:16px;padding:28px;
        max-width:480px;width:100%;
        box-shadow:0 20px 60px rgba(0,0,0,0.6);
      ">
        <div style="font-size:36px;text-align:center;margin-bottom:12px">▶️</div>
        <div style="font-size:18px;font-weight:800;text-align:center;color:#eef2f9;margin-bottom:8px">
          Conectar conta do YouTube?
        </div>
        <p style="color:#8394b0;font-size:14px;line-height:1.6;margin-bottom:20px;text-align:center">
          O YouTube tem um sistema anti-bot que <strong style="color:#eef2f9">bloqueia downloads sem login</strong>.
          <br><br>
          Para evitar isso, conecte uma conta Google qualquer.
          <br>
          <span style="color:#a78bfa;font-size:13px">⚠️ Usado APENAS para baixar vídeos — não posta nem mexe na sua conta YouTube.</span>
        </p>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button id="yt-connect" style="
            background:linear-gradient(135deg,#6366f1,#8b5cf6);
            color:white;border:none;
            padding:12px;border-radius:10px;
            cursor:pointer;font-weight:700;font-size:14px;
          ">Conectar agora (recomendado)</button>
          <button id="yt-skip" style="
            background:rgba(255,255,255,0.06);
            border:1px solid rgba(255,255,255,0.12);
            color:rgba(255,255,255,0.85);
            padding:10px;border-radius:10px;cursor:pointer;font-size:13px;
          ">Pular (download pode falhar)</button>
          <button id="yt-cancel" style="
            background:none;border:none;
            color:rgba(255,255,255,0.5);
            padding:8px;cursor:pointer;font-size:13px;
          ">Cancelar</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    const close = (v) => { overlay.remove(); resolve(v) }
    overlay.querySelector('#yt-connect').onclick = () => close('connect')
    overlay.querySelector('#yt-skip').onclick = () => close('skip')
    overlay.querySelector('#yt-cancel').onclick = () => close('cancel')
  })
}

function wizardBack() {
  if (wizardStep === 0) return
  wizardStep--
  renderWizardStep()
  if (wizardStep === 1) loadWizardAccounts()
}

// ── Logs ──────────────────────────────────────────────────────────────────────
function addLog(jobId, msg, time) {
  const entry = { jobId, msg, time }
  logLines.push(entry)
  if (logLines.length > 500) logLines.shift()

  const line = buildLogLine(entry)

  // Floating panel
  const panelEl = document.getElementById('log-output')
  panelEl.insertAdjacentHTML('beforeend', line)
  panelEl.scrollTop = panelEl.scrollHeight

  // Logs page
  if (currentPage === 'logs') {
    const pageEl = document.getElementById('logs-page-output')
    pageEl.insertAdjacentHTML('beforeend', line)
    pageEl.scrollTop = pageEl.scrollHeight
  }

  // Badge
  if (!logPanelOpen) {
    unreadLogs++
    const badge = document.getElementById('log-badge')
    badge.textContent = unreadLogs > 9 ? '9+' : unreadLogs
    badge.classList.add('show')
  }
}

function buildLogLine(entry) {
  const cls = entry.msg.includes('❌') ? 'err' : entry.msg.includes('✅') ? 'ok' : ''
  return `<div class="log-line ${cls}"><span class="time">${entry.time}</span><span class="msg">${esc(entry.msg)}</span></div>`
}

function clearLogs() {
  logLines = []
  document.getElementById('log-output').innerHTML = ''
  document.getElementById('logs-page-output').innerHTML = ''
}

function toggleLogPanel() {
  logPanelOpen = !logPanelOpen
  document.getElementById('log-panel').classList.toggle('open', logPanelOpen)
  if (logPanelOpen) {
    unreadLogs = 0
    document.getElementById('log-badge').classList.remove('show')
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = msg
  document.getElementById('toast-container').appendChild(el)
  setTimeout(() => el.remove(), 3000)
}

// ── Utils ──────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
