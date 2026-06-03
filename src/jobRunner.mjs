/**
 * Core de execução de um job:
 * 1. Busca vídeo na fonte configurada
 * 2. Converte para 9:16 se necessário
 * 3. Gera caption (IA ou template)
 * 4. Posta na plataforma de destino
 * 5. Retorna { posted: boolean }
 */

import fs from 'fs'
import path from 'path'
import {
  buscarVideoYoutube, baixarVideoYoutube, downloadThumbnail,
  converterParaReel, loadState, marcarPostado, marcarFalhou,
  marcarTrechoUsado, proximoVideoComEspaco, calcGapsLivres,
} from './sources/youtube.mjs'
import { smartCutYouTube } from './smartCut.mjs'
import { applyAutoEdit } from './autoEditor.mjs'
import ffmpegStaticOriginal from 'ffmpeg-static'
const ffmpegPath = ffmpegStaticOriginal
  ? ffmpegStaticOriginal.replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/').replace(/\\/g, '/')
  : null
import { buscarVideoTiktok, baixarVideoTiktok, marcarPostadoTk, marcarFalhouTk } from './sources/tiktok.mjs'
import { buscarVideoInstagram, baixarVideoInstagram, marcarPostadoIg, marcarFalhouIg } from './sources/instagram.mjs'
import { postReelInstagram } from './poster/instagram.mjs'
import { postVideoTikTok }   from './poster/tiktok.mjs'
import { gerarCaption }      from './caption/ollama.mjs'
import * as liveView         from './liveView.mjs'

export default async function jobRunner(job, dataDir, log) {
  // Registra a sessao no Live View desde o inicio (mesmo sem browser aberto ainda)
  // Mostra card com fonte (canal YT, pasta, etc) durante busca/download/conversao
  const liveJobId = job.id
  liveView.register(liveJobId, null, {
    account: job.account,
    platform: job.platform,
    sourceLabel: extractSourceLabel(job),
    sourceType: job.source,
    status: 'Iniciando...',
  })
  const downloadsDir = path.join(dataDir, 'downloads')
  const stateFile    = path.join(dataDir, `state-${job.id}.json`)

  try {
    const result = await runJob()
    // Mantem card visivel 8s mostrando resultado final
    liveView.markCompleted(liveJobId, { success: !!result?.posted, message: result?.posted ? null : 'Sem novo' })
    return result
  } catch (e) {
    liveView.markCompleted(liveJobId, { success: false, message: e.message?.split('\n')[0]?.slice(0, 30) || 'Erro' })
    throw e
  }

  async function runJob() {

  // ── Verificar janela de horário ──────────────────────────────────────────────
  if (job.scheduleType === 'window' && job.timeWindows) {
    if (!dentroJanela(job.timeWindows)) {
      log(`⏸ Fora da janela de horário (${job.timeWindows})`)
      return { posted: false }
    }
  }

  // ── Buscar vídeo na fonte ────────────────────────────────────────────────────
  let videoPath
  let videoMeta = { titulo: '', id: null }

  if (job.source === 'youtube') {
    // Limites por plataforma e alvo padrão de corte
    // IG Reels max 90s, TikTok aceita ate 600s (alvo viral 120s)
    const platformLimit = job.platform === 'instagram' ? 90 : 600
    const targetCut = Math.min(job.maxClipSec ?? 120, platformLimit)
    const minClip   = job.minClipSec ?? 30 // gap menor que isso = vídeo esgotado
    let video = null
    let excludeRanges = []
    let videoSource = 'novo' // 'novo' | 'reaproveitado'

    // 1️⃣ Tenta reaproveitar vídeo já parcialmente cortado (cortes diferentes em ciclos seguintes)
    // Só faz sentido pra modos de corte parcial (smart/default), não pra 'full'
    const reuse = job.cutType !== 'full' ? proximoVideoComEspaco(stateFile, minClip) : null
    if (reuse) {
      video = { id: reuse.id, duracao: reuse.duracao, titulo: reuse.titulo }
      excludeRanges = reuse.excludeRanges
      videoSource = 'reaproveitado'
      log(`♻️  Reaproveitando vídeo (${excludeRanges.length} trecho(s) já usado(s))`)
    } else {
      // 2️⃣ Busca novo vídeo no canal
      liveView.updateStatus(liveJobId, 'Buscando vídeos no canal')
      const candidatos = await buscarVideoYoutube(job.sourceUrls || '', stateFile, log, {
        minDur:         job.filterMinDur         ?? 60,
        maxDur:         job.filterMaxDur         ?? 300,
        maxVideos:      job.filterMaxVideos       ?? 20,
        keywordInclude: job.filterKeywordInclude  || '',
        keywordExclude: job.filterKeywordExclude  || '',
        onlyNew:        job.filterOnlyNew         ?? true,
      }, dataDir)
      if (!candidatos.length) { log('⏭ Sem candidatos neste canal'); return { posted: false } }
      video = candidatos[0]
    }
    videoMeta = video
    log(`🎬 ${(video.titulo || '').substring(0, 80)} (${Math.round(video.duracao || 0)}s)`)

    const prefix = `pm_${job.id.slice(-6)}`
    let cutRange = null

    // Se editMode='auto', precisamos preservar a VTT pro autoEditor reusar
    const wantsVtt = job.editMode === 'auto'
    if (job.cutType === 'smart' || videoSource === 'reaproveitado' || wantsVtt) {
      // wantsVtt força smartCut pra ter VTT mesmo se cutType !== 'smart' (autoEditor precisa)
      liveView.updateStatus(liveJobId, '🧠 IA escolhendo melhor trecho')
      try {
        const aiManager = await import('./aiManager.mjs').catch(() => null)
        cutRange = await smartCutYouTube({
          videoId: video.id,
          durationSec: video.duracao || 600,
          targetCutSec: targetCut,
          dataDir,
          log,
          aiManager,
          excludeRanges,
          keepVtt: wantsVtt,
        })
      } catch (e) { log(`   ⚠️ Smart cut falhou: ${e.message.split('\n')[0]}`) }
    }

    // Se eh "video inteiro" mas passa do limite, corta inicio com platformLimit
    if (!cutRange && job.cutType === 'full' && video.duracao > platformLimit) {
      cutRange = { start: 0, end: platformLimit }
      log(`✂️ Vídeo inteiro maior que limite (${platformLimit}s) — cortando primeiros ${platformLimit}s`)
    }

    // Default (cutType !== 'full' e smart cut falhou): pega primeiros targetCut segundos
    if (!cutRange && job.cutType !== 'full' && video.duracao > targetCut) {
      cutRange = { start: 0, end: targetCut }
    }

    try {
      liveView.updateStatus(liveJobId, cutRange ? `Baixando trecho ${cutRange.start}-${cutRange.end}s` : `Baixando ${(video.titulo || '').substring(0, 30)}`)
      videoPath = await baixarVideoYoutube(video, downloadsDir, prefix, log, dataDir, cutRange)
    } catch (err) {
      log(`❌ Download falhou: ${err.message.split('\n')[0]}`)
      marcarFalhou(stateFile, video.id)
      return { posted: false }
    }

    // Guarda o range escolhido pra registrar como usado APÓS post bem-sucedido
    videoMeta.usedRange = cutRange
    videoMeta.minClip   = minClip

    // Compositing: bifurca em 2 modos
    //   - 'auto' (edição automática IA): autoEditor faz silêncio + face track + karaokê + 9:16
    //   - 'original' (default): converterParaReel atual (16:9 com thumb topo + watermark)
    const editMode = job.editMode || 'original'
    let reelPath

    if (editMode === 'auto') {
      liveView.updateStatus(liveJobId, '🎬 Edição automática (IA)')
      const outPath = videoPath.replace('.mp4', '_reel.mp4')
      const modelPath = path.join(dataDir, 'face-detector.onnx')
      try {
        if (!fs.existsSync(modelPath)) {
          log(`⚠️ Modelo face não encontrado em ${modelPath} — fallback pro modo original`)
          throw new Error('face-detector.onnx ausente')
        }
        reelPath = await applyAutoEdit({
          videoPath, outputPath: outPath,
          vttPath: cutRange?.vttPath || null,
          fromSec: cutRange?.start ?? 0,
          toSec: cutRange?.end ?? (cutRange?.start ?? 0) + 120,
          ffmpegPath, modelPath,
          tmpDir: path.join(dataDir, 'edit-tmp', job.id),
          log,
          options: {
            cutSilence: job.editCutSilence !== false,
            karaokeSubs: job.editKaraokeSubs !== false,
            faceTrack:   job.editFaceTrack   !== false,
          },
        })
        try { fs.unlinkSync(videoPath) } catch {}
        // Limpa VTT do smartCut
        if (cutRange?.vttPath) try { fs.unlinkSync(cutRange.vttPath) } catch {}
      } catch (err) {
        log(`⚠️ Edição automática falhou: ${err.message.split('\n')[0]} — caindo no modo original`)
        // fallback: fluxo antigo
        const thumbPath = await downloadThumbnail(video.id, videoPath.replace('.mp4', '_thumb.jpg'))
        try {
          reelPath = await converterParaReel(videoPath, thumbPath, log, {
            watermarkType: job.watermarkType,
            watermarkText: job.watermarkText,
            watermarkImagePath: job.watermarkImagePath,
            watermarkPosition: job.watermarkPosition,
          })
          fs.unlinkSync(videoPath)
        } catch (e) { log(`⚠️ Compositing fallback falhou: ${e.message}`); reelPath = videoPath }
        if (thumbPath) try { fs.unlinkSync(thumbPath) } catch {}
      }
    } else {
      // Modo original (retrocompat): thumb + 16:9 com bandas + watermark
      const thumbDest = videoPath.replace('.mp4', '_thumb.jpg')
      const thumbPath = await downloadThumbnail(video.id, thumbDest)
      if (thumbPath) log('🖼️ Thumbnail baixado')

      try {
        liveView.updateStatus(liveJobId, 'Convertendo para 9:16')
        reelPath = await converterParaReel(videoPath, thumbPath, log, {
          watermarkType: job.watermarkType,
          watermarkText: job.watermarkText,
          watermarkImagePath: job.watermarkImagePath,
          watermarkPosition: job.watermarkPosition,
        })
        fs.unlinkSync(videoPath)
      } catch (err) {
        log(`⚠️ Compositing falhou: ${err.message}`)
        reelPath = videoPath
      }
      if (thumbPath) try { fs.unlinkSync(thumbPath) } catch {}
    }
    videoPath = reelPath

  } else if (job.source === 'tiktok') {
    liveView.updateStatus(liveJobId, 'Buscando videos no TikTok')
    const candidatos = await buscarVideoTiktok(job.sourceHandles || job.sourceUrls || '', stateFile, log, {
      minDur: job.filterMinDur ?? 5, maxDur: job.filterMaxDur ?? 600,
      maxVideos: job.filterMaxVideos ?? 10,
      keywordInclude: job.filterKeywordInclude || '', keywordExclude: job.filterKeywordExclude || '',
      onlyNew: job.filterOnlyNew ?? true,
    }, dataDir)
    if (!candidatos.length) { log('⏭ Sem candidatos neste perfil'); return { posted: false } }
    const video = candidatos[0]
    videoMeta = video
    log(`🎬 ${(video.titulo || video.id).substring(0, 80)}`)
    const prefix = `pm_tt_${job.id.slice(-6)}`
    try {
      liveView.updateStatus(liveJobId, `Baixando do TikTok`)
      videoPath = await baixarVideoTiktok(video, downloadsDir, prefix, log, dataDir)
    } catch (err) {
      log(`❌ Download TikTok falhou: ${err.message.split('\n')[0]}`)
      marcarFalhouTk(stateFile, video.id)
      return { posted: false }
    }
  } else if (job.source === 'instagram') {
    liveView.updateStatus(liveJobId, 'Buscando posts no Instagram')
    let candidatos
    try {
      candidatos = await buscarVideoInstagram(job.sourceHandles || job.sourceUrls || '', stateFile, log, {
        minDur: job.filterMinDur ?? 5, maxDur: job.filterMaxDur ?? 600,
        maxVideos: job.filterMaxVideos ?? 10,
        keywordInclude: job.filterKeywordInclude || '', keywordExclude: job.filterKeywordExclude || '',
        onlyNew: job.filterOnlyNew ?? true,
      }, dataDir)
    } catch (e) {
      log(`❌ ${e.message}`)
      return { posted: false }
    }
    if (!candidatos.length) { log('⏭ Sem candidatos neste perfil'); return { posted: false } }
    const video = candidatos[0]
    videoMeta = video
    log(`🎬 ${(video.titulo || video.id).substring(0, 80)}`)
    const prefix = `pm_ig_${job.id.slice(-6)}`
    try {
      liveView.updateStatus(liveJobId, `Baixando do Instagram`)
      videoPath = await baixarVideoInstagram(video, downloadsDir, prefix, log, dataDir)
    } catch (err) {
      log(`❌ Download Instagram falhou: ${err.message.split('\n')[0]}`)
      marcarFalhouIg(stateFile, video.id)
      return { posted: false }
    }
  } else if (job.source === 'manual') {
    const caminho = job.sourceFolder
    if (!caminho || !fs.existsSync(caminho)) { log('❌ Pasta de vídeos não configurada ou não existe'); return { posted: false } }
    // Aceita tanto PASTA quanto ARQUIVO unico — alguns clientes selecionam o .mp4
    // direto em vez da pasta (a UI nao distingue), e antes isso quebrava com ENOTDIR.
    let stat
    try { stat = fs.statSync(caminho) } catch (e) {
      log(`❌ Erro ao acessar caminho: ${e.message}`); return { posted: false }
    }
    const VIDEO_RE = /\.(mp4|mov|avi|mkv|webm)$/i
    const state = loadState(stateFile)
    const vistos = new Set(state.postados || [])
    let arquivo, pastaBase
    if (stat.isFile()) {
      if (!VIDEO_RE.test(caminho)) {
        log(`❌ "${path.basename(caminho)}" não é um vídeo suportado (mp4/mov/avi/mkv/webm)`)
        return { posted: false }
      }
      const nome = path.basename(caminho)
      if (vistos.has(nome)) { log(`⏭ "${nome}" já foi postado anteriormente`); return { posted: false } }
      arquivo = nome
      pastaBase = path.dirname(caminho)
    } else if (stat.isDirectory()) {
      const arquivos = fs.readdirSync(caminho)
        .filter(f => VIDEO_RE.test(f) && !vistos.has(f))
      if (!arquivos.length) { log('⏭ Sem vídeos novos na pasta'); return { posted: false } }
      arquivo = arquivos[0]
      pastaBase = caminho
    } else {
      log(`❌ "${caminho}" não é pasta nem arquivo de vídeo`); return { posted: false }
    }
    videoPath = path.join(pastaBase, arquivo)
    videoMeta.titulo = path.basename(arquivo, path.extname(arquivo))
    videoMeta.id = arquivo
    log(`📂 Arquivo: ${arquivo}`)
  } else {
    log(`❌ Fonte "${job.source}" ainda não suportada nesta versão`)
    return { posted: false }
  }

  // ── Gerar caption ────────────────────────────────────────────────────────────
  let caption = ''
  if (job.captionType === 'ai') {
    log('🤖 Gerando legenda com IA...')
    caption = await gerarCaption(videoMeta.titulo, job.captionNiche || '')
    log(`   "${caption.split('\n')[0].substring(0, 60)}..."`)
  } else if (job.captionType === 'template') {
    caption = (job.captionTemplate || '').replace(/\{titulo\}/gi, videoMeta.titulo)
  } else if (job.captionType === 'video') {
    caption = videoMeta.titulo || ''
  } else {
    caption = ''
  }

  // ── Postar ───────────────────────────────────────────────────────────────────
  let ok = false
  try {
    if (job.platform === 'instagram') {
      log('📤 Postando no Instagram...')
      ok = await postReelInstagram({ account: job.account, videoPath, caption, dataDir, log, jobId: job.id })
    } else if (job.platform === 'tiktok') {
      log('📤 Postando no TikTok...')
      ok = await postVideoTikTok({ account: job.account, videoPath, caption, dataDir, log, jobId: job.id })
    }
  } catch (err) {
    log(`❌ Erro ao postar: ${err.message}`)
  } finally {
    // Limpar vídeo baixado (não limpar se for pasta manual)
    if (job.source !== 'manual') {
      try { if (videoPath) fs.unlinkSync(videoPath) } catch {}
    }
  }

  if (ok && videoMeta.id) {
    // YouTube com reaproveitamento: salva trecho usado, esgota apenas se sem espaço
    // (apenas pra cutType !== 'full' — full significa "vídeo inteiro", não múltiplos cortes)
    if (job.source === 'youtube' && videoMeta.usedRange && job.cutType !== 'full') {
      marcarTrechoUsado(stateFile, videoMeta.id, videoMeta.usedRange, videoMeta.duracao || 0, videoMeta.titulo || '')
      // Re-carrega state pra ver se ainda sobra gap utilizável
      const s = loadState(stateFile)
      const usados = s.trechosUsados?.[videoMeta.id] || []
      const gapsRestantes = calcGapsLivres(usados, videoMeta.duracao || 0, videoMeta.minClip || 30)
      if (!gapsRestantes.length) {
        log(`🏁 Vídeo esgotado — todos os trechos úteis foram postados`)
        marcarPostado(stateFile, videoMeta.id)
      } else {
        const totalRestante = gapsRestantes.reduce((a, g) => a + (g.end - g.start), 0)
        log(`💾 Trecho salvo. Restam ~${Math.round(totalRestante)}s aproveitáveis desse vídeo`)
      }
    } else {
      marcarPostado(stateFile, videoMeta.id)
    }
  }
  return { posted: ok }
  } // fim de runJob()
}

// Extrai um label legivel da fonte do job (canal YT, pasta, etc)
function extractSourceLabel(job) {
  if (job.source === 'youtube' && job.sourceUrls) {
    const first = job.sourceUrls.split(',')[0].trim()
    const m = first.match(/@([\w.-]+)/)
    return m ? `@${m[1]}` : first.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30)
  }
  if (job.source === 'manual' && job.sourceFolder) {
    return path.basename(job.sourceFolder)
  }
  return job.source || 'fonte'
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function dentroJanela(timeWindows) {
  const agora = new Date()
  const hm = agora.getHours() * 60 + agora.getMinutes()
  for (const w of timeWindows.split(',')) {
    const m = w.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)
    if (!m) continue
    const start = parseInt(m[1]) * 60 + parseInt(m[2])
    const end   = parseInt(m[3]) * 60 + parseInt(m[4])
    if (hm >= start && hm < end) return true
  }
  return false
}
