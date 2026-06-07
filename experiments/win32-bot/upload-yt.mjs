// Orchestrator de upload YT via Chrome real + Win32 + OCR.
// Node faz controle, PowerShell faz Win32 calls, Tesseract.js faz OCR.
//
// Uso: node upload-yt.mjs <video.mp4> <"Titulo"> [<"Descricao">]

import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { findText, listAll, terminate as ocrTerminate } from './ocr.mjs'

const HELPERS = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'winhelpers.ps1')
const OUT_DIR = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'out')
fs.mkdirSync(OUT_DIR, { recursive: true })

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const sleep = ms => new Promise(r => setTimeout(r, ms))

function ps(action, args = {}) {
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPERS, '-Action', action]
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) {
      psArgs.push('-' + k.charAt(0).toUpperCase() + k.slice(1))
      psArgs.push(String(v))
    }
  }
  const r = spawnSync('powershell.exe', psArgs, { encoding: 'utf8', timeout: 30000 })
  if (r.status !== 0) throw new Error(`PS ${action} failed: ${r.stderr || r.stdout}`)
  const out = (r.stdout || '').trim()
  try { return JSON.parse(out) } catch { return out }
}

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

async function snap(label, hwnd) {
  const file = path.join(OUT_DIR, `${ts}-${label}.png`)
  const info = ps('screenshot', { hwnd, out: file })
  log(`  📸 ${label}  ${info.w}x${info.h}  ${file}`)
  return { file, ...info }
}

async function clickAbsolute(x, y, label) {
  log(`  🖱️ click ${label} em (${x}, ${y})`)
  ps('click', { x, y })
}

// Acha texto na screenshot e clica nele
async function clickByText(imgInfo, text, opts = {}) {
  const m = await findText(imgInfo.file, text, opts)
  if (!m) throw new Error(`Texto '${text}' nao encontrado na screenshot`)
  const screenX = imgInfo.x + m.cx
  const screenY = imgInfo.y + m.cy
  log(`  🖱️ "${text}" achado em img(${m.cx}, ${m.cy}) → tela(${screenX}, ${screenY})  conf=${Math.round(m.conf)}`)
  ps('click', { x: screenX, y: screenY })
  return m
}

async function main() {
  const [videoPath, title, description = ''] = process.argv.slice(2)
  if (!videoPath || !title) {
    console.error('Uso: node upload-yt.mjs <video.mp4> <"Titulo"> [<"Descricao">]')
    process.exit(1)
  }
  if (!fs.existsSync(videoPath)) throw new Error(`Video nao existe: ${videoPath}`)
  const videoFull = path.resolve(videoPath)
  log(`video: ${videoFull}`)
  log(`titulo: ${title}`)

  // === STEP 1: abre Chrome em studio.youtube.com com viewport forcado 1400x900 ===
  // Em monitor pequeno (1536x864) o YT esconde botao Criar. --window-size=1400,900 + zoom out
  // resolve. Janela pode vazar pra fora da tela mas DOM continua completo.
  log('[1] Abrindo Chrome em studio.youtube.com (--window-size=1400x900)...')
  const chromePath = process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe'
  spawn(chromePath, ['--new-window', '--window-size=1400,900', '--window-position=0,0', 'https://studio.youtube.com/'], { detached: true, stdio: 'ignore' }).unref()
  log('  aguardando 14s pra Studio carregar...')
  await sleep(14000)

  // === STEP 2: achar janela (pattern flexivel — "YouTube" cobre Studio + /upload page) ===
  log('[2] Achando janela...')
  let win = ps('find-window', { pattern: 'YouTube' })
  if (!win || win === 'null') {
    log('  YouTube nao encontrado — tentando "Studio"...')
    win = ps('find-window', { pattern: 'Studio' })
  }
  if (!win || win === 'null') {
    log('  nenhuma janela achada. Aguardando +6s e tentando de novo...')
    await sleep(6000)
    win = ps('find-window', { pattern: 'YouTube' })
  }
  if (!win || win === 'null') throw new Error('Janela Studio nao encontrada apos 24s')
  log(`  HWND=${win.hwnd}  ${win.title}`)

  // === STEP 3: foco (sem maximize - mantem 1400x900 vazando se preciso) + zoom out ===
  log('[3] Foco + zoom out 2x (Ctrl+-) pra encaixar mais conteudo...')
  ps('focus', { hwnd: win.hwnd })
  await sleep(800)
  ps('sendkeys', { keys: '^-' })
  await sleep(400)
  ps('sendkeys', { keys: '^-' })
  await sleep(800)
  // Pega dimensoes atualizadas via find-window com mesma palavra-chave do titulo achado
  const titleKeyword = win.title.split(' - ')[0]  // "YouTube Creator Studio" / "Painel do canal" etc
  const winRect = ps('find-window', { pattern: titleKeyword })
  if (!winRect || winRect === 'null') {
    log(`  WARN: re-find falhou com '${titleKeyword}', usando dimensoes iniciais`)
    var rect = win
  } else {
    var rect = winRect
  }
  log(`  janela: ${rect.w}x${rect.h} @ (${rect.x}, ${rect.y})`)

  // === STEP 4: screenshot + OCR ===
  log('[4] Screenshot + OCR Studio...')
  const s1 = await snap('01-studio-ready', rect.hwnd)
  s1.x = rect.x; s1.y = rect.y

  // === STEP 5: achar "Criar" via OCR (com zoom out 2x deve aparecer) ===
  log('[5] Procurando botao Criar via OCR (apos zoom out)...')
  let criar = await findText(s1.file, 'CRIAR', { minConf: 40 })
  if (!criar) criar = await findText(s1.file, 'Criar', { minConf: 40 })
  if (!criar) {
    log(`  Criar nao achado — listando palavras (top 50):`)
    const all = await listAll(s1.file, { minConf: 30 })
    all.slice(0, 50).forEach(w => log(`    "${w.text}" @ (${w.x},${w.y}) conf=${w.conf}`))
    throw new Error('Botao "Criar" nao achado mesmo apos zoom out')
  }
  log(`  Criar @ img(${criar.cx},${criar.cy}) conf=${Math.round(criar.conf)}`)
  await clickAbsolute(s1.x + criar.cx, s1.y + criar.cy, 'Criar')
  await sleep(2500)

  // === STEP 6: menu Criar aberto, achar "Enviar" via OCR ===
  const s2 = await snap('02-after-criar', rect.hwnd)
  s2.x = rect.x; s2.y = rect.y
  log('[6] Achando "Enviar" no menu Criar via OCR...')
  let enviar = await findText(s2.file, 'Enviar', { minConf: 40 })
  if (!enviar) enviar = await findText(s2.file, 'ENVIAR', { minConf: 40 })
  if (!enviar) {
    log(`  Enviar nao achado — debug palavras:`)
    const all = await listAll(s2.file, { minConf: 30 })
    all.slice(0, 30).forEach(w => log(`    "${w.text}" @ (${w.x},${w.y}) conf=${w.conf}`))
    throw new Error('Item "Enviar" do menu Criar nao achado')
  }
  await clickAbsolute(s2.x + enviar.cx, s2.y + enviar.cy, 'Enviar videos')
  await sleep(4000)

  // === STEP 7: file dialog OS abre — cola path + Enter ===
  log('[7] Colando path no file dialog OS...')
  await snap('03-file-dialog-os', rect.hwnd)
  ps('setclip', { text: videoFull })
  await sleep(400)
  ps('sendkeys', { keys: '^a' })  // seleciona qualquer texto existente no input
  await sleep(200)
  ps('sendkeys', { keys: '^v' })
  await sleep(500)
  ps('sendkeys', { keys: '{ENTER}' })
  log(`  path: ${videoFull}`)
  await sleep(6000)

  // === STEP 8: dialog de detalhes ===
  log('[8] Aguardando dialog de detalhes (8s)...')
  await sleep(8000)
  const s3 = await snap('04-details', rect.hwnd)
  s3.x = rect.x; s3.y = rect.y

  log('[9] (parando aqui na POC — verifique 04-details.png pra ver se chegou ao dialog de upload)')

  await ocrTerminate()
  log('=== POC parou no STEP 8 (dialog de detalhes) ===')
  log(`Screenshots em ${OUT_DIR}`)
}

main().catch(async e => {
  console.error('ERRO:', e.message)
  console.error(e.stack)
  await ocrTerminate().catch(() => {})
  process.exit(1)
})
