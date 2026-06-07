/**
 * Traduz texto pra PT-BR usando Qwen 2.5 0.5B local (ja carregado pelo aiManager).
 * Processa em chunks pra nao estourar contexto.
 */
import { aiManager } from '../aiManager.mjs'

/**
 * v1.1.8: traduz SEGMENTO POR SEGMENTO (sem chunk com pipes que quebra alinhamento)
 * + prompt que forca PT-BR e bloqueia palavras em ingles
 * + heuristica que detecta resposta-suja (eco do original, ingles cru)
 * @param {Array<{start,end,text}>} segments
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

  const out = []
  let lastProgress = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const original = (seg.text || '').trim()
    if (!original) { out.push({ ...seg, textPtBr: '' }); continue }

    const prompt = `Voce e um tradutor. Traduza pra portugues brasileiro coloquial.
REGRAS:
- Responda APENAS a traducao em portugues.
- NAO deixe palavras em ingles.
- NAO repita o original.
- NAO adicione comentarios, aspas ou explicacoes.
- Mantenha tamanho similar ao original.

INGLES: "${original}"
PORTUGUES:`

    let translated = ''
    try {
      const raw = await llm.complete(prompt, { maxTokens: 120, temperature: 0.2 })
      translated = sanitize(raw)
    } catch (e) {
      log(`⚠️ Erro tradutor seg ${i}: ${e.message.slice(0,40)}`)
    }

    // Heuristica: se a traducao saiu igual ao original ou tem muito ingles, mantemos a melhor versao
    if (!translated || isMostlyEnglish(translated) || translated.toLowerCase() === original.toLowerCase()) {
      translated = translated || original
    }
    out.push({ ...seg, textPtBr: translated })

    // Progresso a cada 10%
    const pct = Math.floor((i + 1) / segments.length * 10)
    if (pct > lastProgress) {
      log(`   📝 traduzindo ${i + 1}/${segments.length}`)
      lastProgress = pct
    }
  }
  return out
}

function sanitize(raw) {
  let t = String(raw || '').trim()
  // Remove prefixos comuns
  t = t.replace(/^(PORTUGUES|TRADUCAO|RESPOSTA|PT-?BR)[^:]*:\s*/i, '')
  // Remove aspas no inicio/fim
  t = t.replace(/^["'`]+|["'`]+$/g, '')
  // So pega a primeira linha (Qwen as vezes tagarela)
  t = t.split(/\n/)[0].trim()
  return t
}

function isMostlyEnglish(s) {
  // Sem acentos + sem palavras tipicas PT-BR + tem palavras tipicas EN
  const lower = s.toLowerCase()
  if (/[áàâãéêíóôõúç]/i.test(s)) return false
  if (/\b(o|a|os|as|de|da|do|que|nao|sim|com|para|por|um|uma|voce|esta|este|isso|sou|sao|tem)\b/.test(lower)) return false
  if (/\b(the|and|you|are|is|was|were|that|this|with|for|have|has|will|would|could|should|been|but|not|they|them)\b/.test(lower)) return true
  return false
}
