/**
 * Anuncia ao cliente quando uma atualização aplicou um fix que ELE estava
 * tendo. Fluxo:
 *
 * 1. Quando classifyError() identifica um bug, marcamos no fix-history.json
 *    em userData: { kind, firstSeenAt, count, lastSeenAt, resolvedAt? }
 * 2. No boot do app, baixamos CHANGELOG.json do GitHub (cache 1h).
 * 3. Pega versão atual do app. Vê quais fixes essa versão entregou.
 * 4. Pra cada fix dessa versão, checa se o cliente teve esse kind nos
 *    últimos 30 dias E ainda não viu o aviso pra essa combinação (kind+version).
 * 5. Se sim, mostra toast: "🎉 Aquele problema X que você teve foi resolvido!".
 * 6. Marca como visto pra não mostrar de novo.
 *
 * Nada disso atrapalha jobs em andamento — roda 1x no boot, async.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'

const CHANGELOG_URL = 'https://raw.githubusercontent.com/tamoaiapp/postmaster/main/CHANGELOG.json'
const CACHE_MAX_AGE = 3600_000 // 1h

let _changelogCache = null
async function fetchChangelog() {
  const now = Date.now()
  if (_changelogCache && now - _changelogCache.ts < CACHE_MAX_AGE) return _changelogCache.data
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 10_000)
    const res = await fetch(CHANGELOG_URL, { signal: ctl.signal, cache: 'no-store' })
    clearTimeout(t)
    if (!res.ok) return null
    const data = await res.json()
    _changelogCache = { data, ts: now }
    return data
  } catch {
    return null
  }
}

function loadHistory(dataDir) {
  const file = path.join(dataDir, 'fix-history.json')
  try {
    if (!existsSync(file)) return { errors: {}, seenAnnouncements: {} }
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return { errors: {}, seenAnnouncements: {} }
  }
}

function saveHistory(dataDir, history) {
  try {
    writeFileSync(path.join(dataDir, 'fix-history.json'), JSON.stringify(history, null, 2))
  } catch {}
}

/** Marca que o cliente teve um erro do `kind`. Idempotente. */
export function recordErrorOccurrence(dataDir, kind) {
  if (!kind || !dataDir) return
  const h = loadHistory(dataDir)
  const now = new Date().toISOString()
  if (!h.errors[kind]) {
    h.errors[kind] = { firstSeenAt: now, count: 0 }
  }
  h.errors[kind].count = (h.errors[kind].count || 0) + 1
  h.errors[kind].lastSeenAt = now
  saveHistory(dataDir, h)
}

/**
 * Verifica se a versão ATUAL do app aplicou algum fix que o cliente teve
 * recentemente. Retorna array de avisos pra mostrar:
 *   [{ kind, message, fixedInVersion }]
 *
 * Cada aviso só aparece UMA vez por cliente (marca em seenAnnouncements).
 */
export async function getPendingFixAnnouncements({ appDir, dataDir, maxDaysSinceError = 30 }) {
  const changelog = await fetchChangelog()
  if (!changelog?.versions) return []

  // Versão atual do app
  let currentVersion
  try {
    currentVersion = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf-8')).version
  } catch { return [] }

  const history = loadHistory(dataDir)
  const announcements = []
  const cutoff = Date.now() - maxDaysSinceError * 86400_000

  // Olha apenas a versão ATUAL (queremos mostrar logo após o update)
  const versionEntry = changelog.versions.find(v => v.version === currentVersion)
  if (!versionEntry?.fixed?.length) return []

  for (const fix of versionEntry.fixed) {
    const seenKey = `${fix.kind}@${currentVersion}`
    if (history.seenAnnouncements?.[seenKey]) continue

    const errorRecord = history.errors?.[fix.kind]
    if (!errorRecord) continue
    const lastSeen = errorRecord.lastSeenAt ? new Date(errorRecord.lastSeenAt).getTime() : 0
    if (lastSeen < cutoff) continue

    announcements.push({
      kind: fix.kind,
      message: fix.message,
      fixedInVersion: currentVersion,
      hadErrorCount: errorRecord.count,
    })
  }

  return announcements
}

/** Marca os avisos como mostrados pra não aparecer de novo. */
export function markAnnouncementsAsShown(dataDir, announcements) {
  if (!announcements?.length) return
  const h = loadHistory(dataDir)
  if (!h.seenAnnouncements) h.seenAnnouncements = {}
  const now = new Date().toISOString()
  for (const a of announcements) {
    h.seenAnnouncements[`${a.kind}@${a.fixedInVersion}`] = now
  }
  saveHistory(dataDir, h)
}
