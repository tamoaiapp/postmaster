/**
 * Traduz texto pra PT-BR usando Qwen 2.5 0.5B local (ja carregado pelo aiManager).
 * Processa em chunks pra nao estourar contexto.
 */
import { aiManager } from '../aiManager.mjs'

const CHUNK_CHARS = 600

/**
 * @param {Array<{start,end,text}>} segments - saida do whisper
 * @param {Object} [opts]
 * @param {function} [opts.log]
 * @returns {Promise<Array<{start,end,text,textPtBr}>>}
 */
export async function traduzirSegmentos(segments, { log = () => {} } = {}) {
  const llm = await aiManager.get().catch(() => null)
  if (!llm) {
    log('⚠️ IA local indisponivel pra traducao. Usando texto original como fallback.')
    return segments.map(s => ({ ...s, textPtBr: s.text }))
  }

  // Agrupa segmentos em chunks pra economizar LLM calls
  const out = []
  let i = 0
  while (i < segments.length) {
    let chunk = ''
    const startIdx = i
    while (i < segments.length && chunk.length + segments[i].text.length < CHUNK_CHARS) {
      chunk += (chunk ? ' | ' : '') + segments[i].text
      i++
    }
    if (chunk.length === 0) { i++; continue }

    const prompt = `Traduza pra portugues brasileiro coloquial natural. Mantenha o ritmo. Responda APENAS a traducao, sem comentarios:

ORIGINAL: ${chunk}

TRADUCAO PT-BR:`

    let translated = chunk
    try {
      translated = (await llm.complete(prompt, { maxTokens: 600, temperature: 0.3 }))
        .replace(/^TRADUCAO[^:]*:\s*/i, '').trim()
    } catch (e) {
      log(`⚠️ Erro tradutor: ${e.message.slice(0,60)} - usando original`)
    }

    // Re-distribui traducao nos segmentos originais proporcionalmente
    const parts = translated.split(/\s*\|\s*/)
    for (let k = startIdx; k < i; k++) {
      const j = k - startIdx
      out.push({ ...segments[k], textPtBr: (parts[j] || segments[k].text).trim() })
    }
  }
  return out
}
