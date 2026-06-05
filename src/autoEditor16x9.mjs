/**
 * Auto-edit pra YouTube: mantem 16:9 (1920x1080), corta silencios, corta 5% das
 * bordas (anti-fingerprint), watermark opcional. Sem face-track nem split-screen
 * (esses sao pro 9:16 Shorts/Reels/TikTok).
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import ffmpegStaticLib from 'ffmpeg-static'
import { detectSilences, buildKeepRanges, totalKeptDuration, buildKeepRangesFilter, getVideoDuration } from './videoEditor.mjs'

const execAsync = promisify(exec)
const ffmpegPath = (ffmpegStaticLib || 'ffmpeg').replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/')

/**
 * @param {Object} opts
 * @param {string} opts.videoPath - mp4 input
 * @param {string} opts.outputPath - mp4 output (1920x1080 16:9)
 * @param {boolean} [opts.cutSilence=true]
 * @param {number} [opts.trimEdgePercent=5] - corta X% do inicio E fim (anti-dedup)
 * @param {string} [opts.watermarkText] - texto opcional canto inferior direito
 * @param {function} opts.log
 */
export async function applyAutoEdit16x9({ videoPath, outputPath, cutSilence = true, trimEdgePercent = 5, watermarkText = '', log = () => {} }) {
  const dur = await getVideoDuration(ffmpegPath, videoPath)
  if (!dur || dur < 2) throw new Error(`Duracao invalida: ${dur}s`)

  // ── 1. Corte de silencio (opcional) ──────────────────────────
  let workingPath = videoPath
  if (cutSilence) {
    log('   🔇 Detectando silencios...')
    const silences = await detectSilences(ffmpegPath, videoPath, { threshold: -28, minSilence: 0.35 })
    const keep = buildKeepRanges(silences, dur, 0.12)
    if (keep.length > 0 && silences.length > 5) {
      const kept = totalKeptDuration(keep)
      log(`   ✂️ ${silences.length} silencios -> cortou ${(dur - kept).toFixed(1)}s`)
      const fr = buildKeepRangesFilter(keep)
      const tmp = outputPath.replace('.mp4', '_denso.mp4')
      const cmd = `"${ffmpegPath}" -y -i "${videoPath}" -filter_complex "[0:v]${fr.vFilter}[v];[0:a]${fr.aFilter}[a]" -map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -crf 22 -c:a aac -b:a 192k "${tmp}"`
      await execAsync(cmd, { timeout: 900000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 })
      workingPath = tmp
    }
  }

  // ── 2. Corte de bordas (% inicio e fim) ──────────────────────
  let trimmedPath = workingPath
  if (trimEdgePercent > 0 && trimEdgePercent < 25) {
    const curDur = await getVideoDuration(ffmpegPath, workingPath)
    const edge = curDur * (trimEdgePercent / 100)
    const start = edge
    const end = curDur - edge
    if (end - start > 5) {
      log(`   ✂️ Cortando ${trimEdgePercent}% das bordas (${edge.toFixed(1)}s cada)`)
      const tmp = outputPath.replace('.mp4', '_trim.mp4')
      const cmd = `"${ffmpegPath}" -y -ss ${start.toFixed(2)} -to ${end.toFixed(2)} -i "${workingPath}" -c:v libx264 -preset ultrafast -crf 22 -c:a aac -b:a 192k "${tmp}"`
      await execAsync(cmd, { timeout: 900000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 })
      trimmedPath = tmp
    }
  }

  // ── 3. Render final 16:9 1920x1080 + watermark opcional ─────
  log('   🎬 Renderizando final 1920x1080 16:9...')
  let vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30'
  if (watermarkText) {
    const escTxt = watermarkText.replace(/'/g, "\\'").replace(/:/g, '\\:')
    vf += `,drawtext=text='${escTxt}':fontcolor=white:fontsize=24:x=w-tw-30:y=h-th-30:shadowcolor=black:shadowx=2:shadowy=2`
  }
  const finalCmd = `"${ffmpegPath}" -y -i "${trimmedPath}" -vf "${vf}" -c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${outputPath}"`
  await execAsync(finalCmd, { timeout: 1200000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 })

  // Limpa intermediarios
  for (const p of [workingPath, trimmedPath]) {
    if (p !== videoPath && p !== outputPath) {
      try { fs.unlinkSync(p) } catch {}
    }
  }
  return outputPath
}
