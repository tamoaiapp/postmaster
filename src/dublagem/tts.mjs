/**
 * TTS local via Piper. Vozes BR pré-treinadas (homem + mulher) baked no installer.
 * Output: WAV concatenado de cada segmento, com timing sincronizado.
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import ffmpegStaticLib from 'ffmpeg-static'

const execAsync = promisify(exec)
const ffmpegPath = (ffmpegStaticLib || 'ffmpeg').replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/')

const VOICES = {
  homem: { model: 'pt_BR-faber-medium.onnx', config: 'pt_BR-faber-medium.onnx.json' },
  mulher: { model: 'pt_BR-cadu-medium.onnx', config: 'pt_BR-cadu-medium.onnx.json' },
}

function findPiper() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'piper') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null,
    path.join(process.cwd(), 'bin', 'piper'),
    path.join(process.cwd(), 'bin'),
  ].filter(Boolean)
  for (const dir of candidates) {
    const e = path.join(dir, process.platform === 'win32' ? 'piper.exe' : 'piper')
    if (fs.existsSync(e)) return { exe: e, dir: path.dirname(e) }
  }
  return { exe: null, dir: null }
}

function findVoice(voiceKey) {
  const v = VOICES[voiceKey] || VOICES.homem
  const { dir } = findPiper()
  if (!dir) return null
  // Procura model + config na pasta do piper OU em subpasta voices/
  const candidates = [dir, path.join(dir, 'voices'), path.join(dir, '..', 'piper-voices')]
  for (const d of candidates) {
    const m = path.join(d, v.model)
    const c = path.join(d, v.config)
    if (fs.existsSync(m) && fs.existsSync(c)) return { model: m, config: c }
  }
  return null
}

/**
 * Gera audio TTS pra cada segmento e concatena no timing original.
 * @param {Array<{start,end,text,textPtBr}>} segments
 * @param {Object} opts
 * @param {'homem'|'mulher'} [opts.voice='homem']
 * @param {number} opts.duration - duracao total do video em segundos
 * @param {string} opts.outputWav - caminho do WAV final
 * @param {function} [opts.log]
 */
export async function gerarAudioDublado(segments, { voice = 'homem', duration, outputWav, log = () => {} }) {
  const { exe } = findPiper()
  if (!exe) throw new Error('Piper TTS nao encontrado em bin/piper/')
  const voiceFiles = findVoice(voice)
  if (!voiceFiles) throw new Error(`Voz ${voice} nao encontrada em bin/piper/`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tts-'))
  log(`   🎤 Piper TTS (${voice}) gerando ${segments.length} segmentos...`)

  // Gera 1 WAV por segmento
  const wavs = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const txt = (seg.textPtBr || seg.text || '').replace(/"/g, '\\"').trim()
    if (!txt) continue
    const out = path.join(tmpDir, `s${String(i).padStart(4, '0')}.wav`)
    const cmd = `echo "${txt}" | "${exe}" --model "${voiceFiles.model}" --config "${voiceFiles.config}" --output_file "${out}" 2>nul`
    try {
      await execAsync(cmd, { timeout: 60000, windowsHide: true, shell: true })
      if (fs.existsSync(out) && fs.statSync(out).size > 100) {
        wavs.push({ path: out, start: seg.start, end: seg.end })
      }
    } catch (e) {
      // Pula segmento que falhou
    }
  }

  if (wavs.length === 0) throw new Error('Piper TTS nao gerou nenhum segmento')

  // Monta filtro complex: cria silencio base e cola cada WAV no offset correto
  log('   🔗 Montando track de audio dublado...')
  const inputs = wavs.map(w => `-i "${w.path}"`).join(' ')
  // Cria base de silencio com duracao total
  const baseInput = `-f lavfi -t ${Math.ceil(duration)} -i "anullsrc=channel_layout=stereo:sample_rate=22050"`

  // Filtro: pra cada wav, adelay pelo timestamp, mistura no base
  let filter = '[0]asplit=1[base];'
  let mix = 'base'
  for (let i = 0; i < wavs.length; i++) {
    const offsetMs = Math.round(wavs[i].start * 1000)
    filter += `[${i + 1}:a]adelay=${offsetMs}|${offsetMs}[d${i}];`
    mix += `[d${i}]`
  }
  filter += `${mix}amix=inputs=${wavs.length + 1}:duration=longest:normalize=0[out]`

  const cmd = `"${ffmpegPath}" -y ${baseInput} ${inputs} -filter_complex "${filter}" -map "[out]" -c:a pcm_s16le -ar 22050 -ac 2 "${outputWav}"`
  await execAsync(cmd, { timeout: 600000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 })

  // Limpa
  for (const w of wavs) try { fs.unlinkSync(w.path) } catch {}
  try { fs.rmdirSync(tmpDir) } catch {}
  return outputWav
}

export function listarVozes() {
  return Object.keys(VOICES)
}
