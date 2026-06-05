/**
 * Roda os jobs configurados num loop infinito, respeitando interval por job.
 * Substitui o app PostMaster pra essa sessao (user disse pode fechar o app).
 *
 * Espera intervalMin minutos entre tentativas do MESMO job, mas alterna entre
 * jobs pra nao bombardear TikTok com 2 posts da mesma conta em <5min.
 */
import fs from 'fs'
import path from 'path'
import jobRunner from '../src/jobRunner.mjs'

const dataDir = path.join(process.env.APPDATA, 'postmaster', 'postmaster-data')
const jobsFile = path.join(dataDir, 'jobs.json')
const lastRun = {} // jobId -> ts ms

const stamp = () => new Date().toLocaleTimeString('pt-BR', { hour12: false })
const log = (msg) => console.log(`[${stamp()}] ${msg}`)

log('== run-jobs-loop iniciado ==')
log(`dataDir: ${dataDir}`)

while (true) {
  let jobs
  try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')) } catch (e) {
    log(`erro ao ler jobs: ${e.message}`)
    await new Promise(r => setTimeout(r, 30000))
    continue
  }

  for (const job of jobs) {
    const now = Date.now()
    const intervalMs = (job.intervalMin || 10) * 60000
    const since = lastRun[job.id] ? (now - lastRun[job.id]) : Infinity
    if (since < intervalMs) {
      const wait = Math.round((intervalMs - since) / 60000 * 10) / 10
      log(`[skip] ${job.name}: faltam ${wait}min`)
      continue
    }
    log(`\n────── ${job.name} (${job.platform}/${job.account}) ──────`)
    lastRun[job.id] = now
    try {
      const r = await jobRunner(job, dataDir, (m) => log(`  ${m}`))
      log(`[fim] ${job.name}: posted=${r?.posted}`)
    } catch (e) {
      log(`[erro] ${job.name}: ${e.message.split('\n')[0]}`)
    }
    // Espera 90s entre jobs pra TikTok nao detectar 2 uploads consecutivos
    log('aguardando 90s antes do proximo job...')
    await new Promise(r => setTimeout(r, 90000))
  }

  // Aguarda 60s antes do proximo scan completo
  await new Promise(r => setTimeout(r, 60000))
}
