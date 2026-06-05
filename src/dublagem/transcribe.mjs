/**
 * Transcreve audio de video via whisper.cpp (binary local).
 * Usa modelo ggml-small.bin (~244MB) ou ggml-base.bin (~140MB).
 * Output: array [{ start, end, text }] em segundos.
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import ffmpegStaticLib from 'ffmpeg-static'

const execAsync = promisify(exec)
const ffmpegPath = (ffmpegStaticLib || 'ffmpeg').replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/')

/**
 * Localiza whisper.cpp + modelo. Em prod: resources/bin/whisper-cli.exe.
 * Em dev: bin/whisper-cli.exe (ou %PATH%).
 */
function findWhisperBinaries() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null,
    path.join(process.cwd(), 'bin'),
  ].filter(Boolean)
  let exe = null, model = null
  for (const dir of candidates) {
    const e = path.join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
    if (fs.existsSync(e)) { exe = e; break }
  }
  for (const dir of candidates) {
    for (const m of ['ggml-small.bin', 'ggml-base.bin']) {
      const p = path.join(dir, m)
      if (fs.existsSync(p)) { model = p; break }
    }
    if (model) break
  }
  return { exe, model }
}

/**
 * @param {string} videoPath - mp4 input
 * @param {Object} opts
 * @param {string} [opts.lang='auto'] - 'auto', 'pt', 'en', 'es', 'ja', etc
 * @param {function} [opts.log]
 * @returns {Promise<Array<{start,end,text}>>}
 */
export async function transcreverVideo(videoPath, { lang = 'auto', log = () => {} } = {}) {
  const { exe, model } = findWhisperBinaries()
  if (!exe || !model) {
    log('⚠️ whisper.cpp binary ou modelo nao encontrado em bin/. Pulando transcricao.')
    return []
  }

  // Whisper exige WAV 16kHz mono
  const wavPath = videoPath.replace(/\.\w+$/, '_trans.wav')
  log('   🎙️ Extraindo audio (16kHz mono)...')
  await execAsync(
    `"${ffmpegPath}" -y -i "${videoPath}" -vn -ac 1 -ar 16000 -c:a pcm_s16le "${wavPath}"`,
    { timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  )

  // Roda whisper.cpp gerando JSON
  const jsonOut = wavPath.replace('.wav', '')
  log(`   🤖 Whisper.cpp transcrevendo (${lang})...`)
  const langFlag = lang === 'auto' ? '' : `-l ${lang}`
  await execAsync(
    `"${exe}" -m "${model}" -f "${wavPath}" -oj -of "${jsonOut}" ${langFlag} -t 4`,
    { timeout: 1200000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 }
  )

  // Parse JSON
  const jsonPath = jsonOut + '.json'
  if (!fs.existsSync(jsonPath)) { try { fs.unlinkSync(wavPath) } catch {} ; return [] }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
  const segments = (data.transcription || []).map(s => ({
    start: parseTime(s.timestamps?.from || s.offsets?.from || 0),
    end: parseTime(s.timestamps?.to || s.offsets?.to || 0),
    text: (s.text || '').trim(),
  })).filter(s => s.text.length > 0)

  try { fs.unlinkSync(wavPath); fs.unlinkSync(jsonPath) } catch {}
  return segments
}

function parseTime(v) {
  if (typeof v === 'number') return v / 1000 // offsets em ms
  if (typeof v === 'string') {
    // "00:00:01,500"
    const m = v.match(/(\d+):(\d+):(\d+)[.,](\d+)/)
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
  }
  return 0
}
