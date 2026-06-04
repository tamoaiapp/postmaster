/**
 * Cliente do bridge HTTP de suporte (VPS do iaempresa.app).
 * Coleta os ultimos logs do app + jobs configurados + info do sistema
 * e manda pra TamoIA Suporte, que tem acesso ao Claude Code no VPS.
 */
import { readFileSync, existsSync, statSync } from 'fs'
import path from 'path'
import os from 'os'

const DEFAULT_URL = 'http://76.13.125.78:8901/support'
const DEFAULT_NOTIFY_URL = 'http://76.13.125.78:8901/notify'
const DEFAULT_TOKEN = 'a2eBwScxoKbr6Ilni1XxAfMF1iejQR1WAXMH99JL'
const TIMEOUT_MS = 90_000

/** Pega o app version do package.json embarcado. */
function readAppVersion(appDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf-8'))
    return pkg.version || 'unknown'
  } catch { return 'unknown' }
}

/** Snapshot dos jobs configurados (jobs.json). */
function readJobs(dataDir) {
  try {
    const file = path.join(dataDir, 'jobs.json')
    if (!existsSync(file)) return []
    const arr = JSON.parse(readFileSync(file, 'utf-8'))
    // Resume cada job (sem expor sourceFolder cheio nem coisa enorme)
    return arr.slice(0, 20).map(j => ({
      id: j.id,
      platform: j.platform,
      source: j.source,
      account: j.account,
      intervalMin: j.intervalMin,
      lastStatus: j.lastStatus,
      lastRun: j.lastRun,
      postCount: j.postCount,
      autoStart: j.autoStart,
      cutType: j.cutType,
      editMode: j.editMode,
      // soureUrls pode ser longa, primeiro item soh
      sourceFirst: typeof j.sourceUrls === 'string' ? j.sourceUrls.split(',')[0].slice(0, 80)
                  : typeof j.sourceFolder === 'string' ? j.sourceFolder.slice(0, 120)
                  : undefined,
    }))
  } catch (e) { return [{ error: 'jobs_read_failed: ' + (e?.message || '') }] }
}

/** Coleta as ultimas N entradas do log do app.
 *  PostMaster nao tem log centralizado — ele emite via win.webContents.send('job:log').
 *  Mantemos um buffer em memoria no main.js (ver lib/inMemoryLog.mjs).
 *  Aqui aceitamos um array vindo do main.js.
 */
function buildContext({ appDir, dataDir, recentLogs, appUptime }) {
  return {
    appInfo: {
      version: readAppVersion(appDir),
      os: `${os.type()} ${os.release()}`,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      totalMemoryMB: Math.round(os.totalmem() / 1e6),
      freeMemoryMB: Math.round(os.freemem() / 1e6),
      appUptime: appUptime,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
    },
    jobs: readJobs(dataDir),
    recentLogs: Array.isArray(recentLogs) ? recentLogs.slice(-150) : [],
  }
}

/** Manda mensagem + historico pro bridge e devolve resposta da TamoIA. */
export async function chatWithSupport({ messages, appDir, dataDir, recentLogs, appUptime }) {
  const url = (process.env.SUPPORT_BRIDGE_URL || DEFAULT_URL).trim()
  const token = (process.env.SUPPORT_BRIDGE_TOKEN || DEFAULT_TOKEN).trim()
  const ctx = buildContext({ appDir, dataDir, recentLogs, appUptime })
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages, context: ctx }),
      signal: ctl.signal,
    })
    clearTimeout(t)
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200)
      throw new Error(`bridge_${res.status}: ${errText}`)
    }
    return await res.json()
  } catch (e) {
    clearTimeout(t)
    return {
      role: 'assistant',
      content: `Tô sem conseguir falar com o time agora (${e.message?.slice(0, 80) || 'erro'}).\n\nSe for urgente, manda WhatsApp pra **+55 11 96724-5795** que respondemos direto.`,
      error: true,
    }
  }
}

/**
 * Registra erro classificado no servidor VPS — apenas log estruturado
 * pra TamoIA poder consultar "quais erros aconteceram esse mês" quando o
 * Tiago abrir o chat admin. NÃO envia WhatsApp.
 *
 * kind:    string curto identificador ('ig_rejected_video', 'tt_chrome_headless_missing', etc.)
 * summary: 1 frase explicando o erro
 * context: { appVersion, account, platform, lastError }
 */
export async function registerError({ kind, summary, context = {} }) {
  const url = (process.env.SUPPORT_NOTIFY_URL || DEFAULT_NOTIFY_URL).trim()
  const token = (process.env.SUPPORT_BRIDGE_TOKEN || DEFAULT_TOKEN).trim()
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 15_000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, summary, context }),
      signal: ctl.signal,
    })
    clearTimeout(t)
    return await res.json()
  } catch (e) {
    return { error: e?.message || String(e), skipped: true }
  }
}

/**
 * Classifica uma mensagem de erro do jobRunner.
 *
 * category indica o tipo do erro:
 *  - 'bug_app'         → bug do PostMaster. Cliente nao causou. A TamoIA registra e
 *                        avisa que vai ser corrigido em update (auto-update pega).
 *  - 'cliente_config'  → cliente configurou algo errado. TamoIA explica e ajuda
 *                        a corrigir. Nao precisa update do app, e so ajustar.
 *  - 'cliente_externo' → algo fora do controle do app E do cliente (conta deslogou,
 *                        plataforma fora do ar, internet caiu). TamoIA orienta.
 *
 * Retorna { kind, category, summary, fix } ou null se nao classificavel.
 */
export function classifyError(errMsg) {
  const m = String(errMsg || '').toLowerCase()

  // ── Erros de configuracao do cliente (TamoIA ajuda a corrigir) ──────────
  if (m.includes('config_youtube_url_is_video')) {
    return {
      kind: 'config_youtube_url_is_video',
      category: 'cliente_config',
      summary: 'Cliente colou link de video especifico no campo de canal',
      fix: 'Trocar pelo link do CANAL (ex: youtube.com/@nomedocanal — sem o /watch?v=...). Edita a automacao em "Automacoes" e cola a URL do canal todo.',
    }
  }
  if (m.includes('nenhuma url de canal configurada')) {
    return {
      kind: 'config_no_source_url',
      category: 'cliente_config',
      summary: 'Job sem URL de fonte (canal/perfil) configurada',
      fix: 'Vai em "Automacoes", edita o job e cola pelo menos uma URL no campo de fonte.',
    }
  }
  if (m.includes('enotdir') && m.includes('scandir')) {
    return {
      kind: 'manual_source_notdir',
      category: 'cliente_config',
      summary: 'Cliente apontou arquivo .mp4 onde devia ser pasta',
      fix: 'Edita o job e seleciona a PASTA que contem os videos, nao um arquivo especifico. (A partir da v1.0.32 o app aceita os dois — se ainda da esse erro, atualize.)',
    }
  }
  if (m.includes('sessao nao encontrada') || m.includes('sessão não encontrada')) {
    return {
      kind: 'session_expired',
      category: 'cliente_externo',
      summary: 'Sessao da conta IG/TikTok expirou ou foi derrubada',
      fix: 'Vai em "Contas" e clica em "Fazer login de novo" naquela conta. As vezes o IG/TT pede um codigo de verificacao por email/SMS — confirma quando aparecer.',
    }
  }
  if (m.includes('pasta de vídeos não configurada') || m.includes('pasta de videos nao configurada')) {
    return {
      kind: 'config_no_source_folder',
      category: 'cliente_config',
      summary: 'Job tipo "Pasta" sem pasta apontada',
      fix: 'Edita o job e clica em "Selecionar pasta" — aponta pra onde os videos estao no PC.',
    }
  }

  // ── Bugs do app (precisam fix em codigo + nova release) ─────────────────
  if (m.includes('ig_rejected_video') || m.includes('este arquivo de v') || m.includes('could not be played')) {
    return {
      kind: 'ig_rejected_video',
      category: 'bug_app',
      summary: 'Instagram rejeitou o video (codec/container incompativel)',
      fix: null,
    }
  }
  if (m.includes("chrome-headless-shell") && m.includes("doesn't exist")) {
    return {
      kind: 'tt_chrome_headless_missing',
      category: 'bug_app',
      summary: 'chrome-headless-shell.exe nao foi empacotado no installer',
      fix: null,
    }
  }
  if (m.includes('botão next/avançar não encontrado') || m.includes('botao next/avancar nao encontrado')) {
    return {
      kind: 'ig_next_button_not_found',
      category: 'bug_app',
      summary: 'IG nao apresentou botao Avancar (provavel rejeicao de video silenciosa)',
      fix: null,
    }
  }
  if (m.includes('react-joyride') && m.includes('intercepts')) {
    return {
      kind: 'tt_joyride_blocking',
      category: 'bug_app',
      summary: 'Tour onboarding TikTok bloqueando clicks',
      fix: null,
    }
  }
  if (m.includes('executable doesn\'t exist') && m.includes('chrome')) {
    return {
      kind: 'playwright_chrome_missing',
      category: 'bug_app',
      summary: 'Playwright nao acha chrome no installer',
      fix: null,
    }
  }
  if ((m.includes('requested format') && m.includes('not available')) ||
      (m.includes('challenge solving failed') && m.includes('javascript'))) {
    return {
      kind: 'yt_n_challenge_failed',
      category: 'bug_app',
      summary: 'yt-dlp falhou no n-challenge do YouTube (deno.exe ausente?)',
      fix: null,
    }
  }
  return null
}

/** Buffer simples em memoria pros logs recentes. main.js empurra aqui. */
export class LogBuffer {
  constructor(maxEntries = 300) {
    this.entries = []
    this.max = maxEntries
  }
  push(line) {
    const ts = new Date().toISOString().slice(11, 19)
    this.entries.push(`${ts} ${line}`)
    if (this.entries.length > this.max) this.entries.shift()
  }
  pushJob(jobId, msg) {
    const short = String(jobId).slice(-6)
    this.push(`[job:${short}] ${msg}`)
  }
  snapshot() { return [...this.entries] }
  clear() { this.entries = [] }
}
