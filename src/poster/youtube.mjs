// Upload de video no YouTube via Chrome real + UI Automation Windows.
// Substitui versao Playwright (que YT bloqueava via anti-bot).
// Versao Playwright preservada em youtube-playwright-backup.mjs.
//
// Como funciona:
//   1. Spawna chrome.exe normal (sem CDP/Playwright) pra studio.youtube.com
//   2. Win32 SetCursorPos+mouse_event simula mouse humano (isTrusted=true)
//   3. UI Automation Windows acha elementos por nome (Criar, Avancar, Privado)
//   4. UIA Invoke pra disparar React listeners (menu Enviar videos)
//   5. UIA SelectionItemPattern pra marcar radios (kids, visibilidade)
//
// Pre-requisitos no PC do cliente:
//   - Chrome instalado e LOGADO na conta Google do canal alvo
//   - Acesso a UIAutomationClient/UIAutomationTypes (built-in Windows)

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as liveView from '../liveView.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve diretorio dos scripts PS (extrai do asar pro TEMP se preciso)
function resolveScriptDir() {
  // Em dev: src/winControl/ ao lado deste arquivo
  // Em prod packaged (asar): nao da pra spawnar PS de dentro do asar — copia pro TEMP
  const devDir = path.join(__dirname, '..', 'winControl')
  const sourceFiles = ['win32.ps1', 'upload-yt.ps1']

  // Verifica se devDir tem os scripts
  const devOk = sourceFiles.every(f => fs.existsSync(path.join(devDir, f)))
  if (devOk && !devDir.includes('app.asar')) return devDir

  // Copia pra TEMP
  const tmpDir = path.join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', 'postmaster-winctl')
  fs.mkdirSync(tmpDir, { recursive: true })
  for (const f of sourceFiles) {
    const srcF = path.join(devDir, f)
    const dstF = path.join(tmpDir, f)
    try {
      // Re-extrai sempre (em caso de update do app)
      fs.copyFileSync(srcF, dstF)
    } catch (e) {
      throw new Error(`Falha ao extrair ${f} pra TEMP: ${e.message}`)
    }
  }
  return tmpDir
}

export async function postVideoYouTube(opts) {
  const {
    videoPath, title, description = '', tags = [],
    visibility = 'private', category = 'Entretenimento', madeForKids = false,
    log, jobId, account, dataDir,
  } = opts

  if (!fs.existsSync(videoPath)) throw new Error(`Video nao encontrado: ${videoPath}`)
  if (!title) throw new Error('Title obrigatorio')

  const scriptDir = resolveScriptDir()
  const psScript = path.join(scriptDir, 'upload-yt.ps1')
  if (!fs.existsSync(psScript)) throw new Error(`Script PS nao encontrado: ${psScript}`)

  // v1.1.2: le channelId salvo na conta pra forcar URL /channel/UCxxx/ - assim
  // independe de qual canal esta logado por padrao no Chrome do user
  let channelId = ''
  if (account && dataDir) {
    const chFile = path.join(dataDir, 'sessions', `yt-${account}.channelId`)
    try {
      if (fs.existsSync(chFile)) {
        const ch = fs.readFileSync(chFile, 'utf-8').trim()
        if (/^UC[\w-]+$/.test(ch)) channelId = ch
      }
    } catch {}
  }

  const liveJobId = jobId || `${account || 'yt'}-${Date.now()}`
  liveView.register(liveJobId, null, { account, platform: 'youtube', status: 'iniciando' })

  log(`🎬 Upload YouTube via Chrome real + Win32 + UIA`)
  log(`   video: ${path.basename(videoPath)} (${Math.round(fs.statSync(videoPath).size / 1024 / 1024)}MB)`)
  log(`   titulo: ${title}`)
  if (channelId) log(`   canal forcado: ${channelId}`)
  else log(`   ⚠️ channelId nao achado pra conta '${account}' - usa o canal logado por padrao no Chrome`)

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', psScript,
    '-VideoPath', videoPath,
    '-Title', title,
    '-Description', description,
    '-Visibility', visibility,
  ]
  if (madeForKids) args.push('-KidsContent')
  if (channelId) { args.push('-ChannelId'); args.push(channelId) }

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', args, { windowsHide: false })
    let output = ''
    let lastStatus = 'iniciando'

    const handleLine = (line) => {
      const trimmed = line.replace(/[\r\n]+$/, '')
      if (!trimmed) return
      output += trimmed + '\n'

      // Repassa pro log do app
      log(`   ${trimmed}`)

      // Atualiza status do liveView baseado em markers
      if (/Abrindo Chrome|carregar/i.test(trimmed)) lastStatus = 'abrindo Studio'
      else if (/Criar/i.test(trimmed) && /click/i.test(trimmed)) lastStatus = 'clicando Criar'
      else if (/Enviar/i.test(trimmed) && /click|Invoke/i.test(trimmed)) lastStatus = 'enviando arquivo'
      else if (/colando path|Nome do arquivo/i.test(trimmed)) lastStatus = 'colando path'
      else if (/dialog de detalhes/i.test(trimmed)) lastStatus = 'preenchendo detalhes'
      else if (/Titulo|titulo/i.test(trimmed) && /achei|setando/i.test(trimmed)) lastStatus = 'titulo preenchido'
      else if (/Avancar/i.test(trimmed) && /click/i.test(trimmed)) lastStatus = 'avancando etapas'
      else if (/PUBLICADO/i.test(trimmed)) lastStatus = 'publicado'
      liveView.updateStatus(liveJobId, lastStatus)
    }

    ps.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(handleLine))
    ps.stderr.on('data', d => log(`   ⚠️ ${d.toString().replace(/[\r\n]+/g, ' ')}`))

    ps.on('exit', code => {
      try { liveView.unregister(liveJobId) } catch {}
      if (code === 0 && /PUBLICADO!/.test(output)) {
        log(`✅ Video publicado no YouTube`)
        resolve(true)
      } else {
        const errMsg = `Upload YT via UIA falhou (exit ${code})`
        log(`❌ ${errMsg}`)
        reject(new Error(errMsg))
      }
    })
    ps.on('error', e => {
      try { liveView.unregister(liveJobId) } catch {}
      reject(new Error(`Falha ao spawnar PowerShell: ${e.message}`))
    })
  })
}
