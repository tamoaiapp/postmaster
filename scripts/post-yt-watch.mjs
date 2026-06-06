/**
 * Roda postVideoYouTube com JANELA VISIVEL no PC do user.
 * Usa _yt.mp4 ja gerado + sessao yt-Youtube.json existente.
 * Aplica codigo v1.0.65 (com screenshots por step).
 */
import path from 'path'
import fs from 'fs'
import { postVideoYouTube } from '../src/poster/youtube.mjs'

const dataDir = path.join(process.env.APPDATA, 'postmaster', 'postmaster-data')
const DOWNLOADS = path.join(dataDir, 'downloads')

const ytFiles = fs.readdirSync(DOWNLOADS)
  .filter(f => f.endsWith('_yt.mp4'))
  .map(f => path.join(DOWNLOADS, f))
  .filter(p => { try { return fs.statSync(p).size > 1024 * 1024 } catch { return false } })
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)

if (!ytFiles.length) { console.error('Sem _yt.mp4 valido'); process.exit(1) }

const videoPath = ytFiles[0]
const sizeMB = Math.round(fs.statSync(videoPath).size / 1024 / 1024)
console.log(`[start] video: ${path.basename(videoPath)} (${sizeMB}MB)`)

// MODIFICA postVideoYouTube pra rodar headless: false. Hack: override chromium.launch
const { chromium: origChromium } = await import('playwright')
const origLaunch = origChromium.launch.bind(origChromium)
origChromium.launch = (opts = {}) => origLaunch({ ...opts, headless: false, slowMo: 100 })

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`)

try {
  const ok = await postVideoYouTube({
    account: 'Youtube',
    videoPath,
    title: `TESTE LOCAL ${new Date().toISOString().slice(0,16)}`,
    description: 'Teste de upload pelo PostMaster — script local.',
    tags: ['teste', 'postmaster'],
    visibility: 'private', // PRIVADO pra nao publicar de fato
    category: 'Esportes',
    madeForKids: false,
    dataDir,
    log,
    jobId: `test-${Date.now()}`,
  })
  console.log(`\n=== RESULTADO: ${ok ? 'SUCESSO' : 'FALHOU'} ===`)
} catch (e) {
  console.error(`\n=== ERRO: ${e.message} ===`)
  console.error(e.stack)
}
console.log('\nScreenshots em:', path.join(dataDir, 'debug'))
