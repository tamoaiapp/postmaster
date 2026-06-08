/**
 * Traduz texto pra PT-BR usando Qwen 2.5 0.5B local (ja carregado pelo aiManager).
 * v1.2.9: Qwen 0.5B eh instavel - vaza prompt no output, deixa ingles, etc.
 * Adicionado: retry 1x com prompt mais forte, sanitize com palavras-chave do prompt,
 * fallback simples (mapa de palavras) quando retry tambem falha.
 */
import { aiManager } from '../aiManager.mjs'

export async function traduzirSegmentos(segments, { log = () => {} } = {}) {
  const llm = await aiManager.get().catch(() => null)
  if (!llm) {
    log('IA local indisponivel pra traducao. Usando texto original como fallback.')
    return segments.map(s => ({ ...s, textPtBr: s.text }))
  }

  const out = []
  let lastProgress = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const original = (seg.text || '').trim()
    if (!original) { out.push({ ...seg, textPtBr: '' }); continue }

    // Tentativa 1: prompt normal
    let translated = await tryTranslate(llm, original, 0.2)
    let attempts = 1

    // Detecta falha: vazio, ingles, eco do original, vazou "REGRAS:"/"INGLES:" do prompt
    while (attempts < 2 && needsRetry(translated, original)) {
      translated = await tryTranslate(llm, original, 0.5, true)
      attempts++
    }

    // Se AINDA falhou, usa fallback baseado em mapa de palavras-chave comuns
    if (needsRetry(translated, original)) {
      translated = quickReplace(original)
    }

    out.push({ ...seg, textPtBr: translated })

    const pct = Math.floor((i + 1) / segments.length * 10)
    if (pct > lastProgress) {
      log(`   📝 traduzindo ${i + 1}/${segments.length}`)
      lastProgress = pct
    }
  }
  return out
}

async function tryTranslate(llm, original, temperature, forceMode = false) {
  const prompt = forceMode
    ? `Reescreva esta frase em portugues brasileiro coloquial. SEM ingles. SEM aspas. SEM comentarios. Apenas a frase traduzida em uma unica linha.

Frase: ${original}

Traducao em portugues brasileiro:`
    : `Voce e um tradutor. Traduza pra portugues brasileiro coloquial. Responda APENAS a traducao em portugues, em uma unica linha, sem aspas.

EN: ${original}
PT:`

  try {
    const raw = await llm.complete(prompt, { maxTokens: 150, temperature })
    return sanitize(raw, original)
  } catch (e) {
    return ''
  }
}

function sanitize(raw, original) {
  let t = String(raw || '').trim()

  // v1.3.2: Qwen as vezes inicia com frase explicativa que vaza pro TTS.
  // Ex: "Aqui está a tradução em português brasileiro: <texto>"
  // Ou: "Eis a tradução: <texto>"
  // Ou: "Tradução: <texto>"
  // Strip o prefixo inteiro ate o primeiro ":" ou ate uma quebra de linha.
  const explicacoes = [
    /^aqui (est[áa]|vai|tem)[^:.]*[:.]?\s*/i,
    /^eis (a|o)[^:.]*[:.]?\s*/i,
    /^segue[^:.]*[:.]?\s*/i,
    /^a (tradu[çc][ãa]o|frase|resposta)[^:.]*[:.]?\s*/i,
    /^minha (tradu[çc][ãa]o|resposta)[^:.]*[:.]?\s*/i,
    /^a seguir[^:.]*[:.]?\s*/i,
    /^conforme solicitado[^:.]*[:.]?\s*/i,
    /^claro[!,.]?\s*/i,
    /^certo[!,.]?\s*/i,
    /^entendi[!,.]?\s*/i,
  ]
  for (const r of explicacoes) {
    t = t.replace(r, '').trim()
  }

  // Remove prefixos comuns (PORTUGUES:, TRADUCAO:, PT:, RESPOSTA:, etc)
  t = t.replace(/^(PORTUGUES|TRADUCAO|RESPOSTA|PT-?BR|PT|TRANSLATION|TRADU[ÇC][ÃA]O)[^:]*:\s*/i, '')
  // Remove aspas no inicio/fim
  t = t.replace(/^["'`]+|["'`]+$/g, '')
  // So pega a primeira linha nao-vazia
  t = t.split(/\n/).map(l => l.trim()).find(l => l.length > 0) || ''

  // Re-aplica strip de explicacoes depois da split (pode ter sobrado)
  for (const r of explicacoes) {
    t = t.replace(r, '').trim()
  }

  // Remove palavras-chave do prompt que vazaram pra resposta (REGRAS:, INGLES:, etc)
  t = t.replace(/^(REGRAS|RULES|EN|INGLES|INPUT|OUTPUT|FRASE|TEXTO)\s*:?\s*-?\s*/i, '').trim()

  // Se sobrou so um padrao tipo "- algo", limpa o "-"
  t = t.replace(/^[-*•]\s+/, '')

  // Se ainda tem aspas envolvendo
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim()

  return t
}

function isMostlyEnglish(s) {
  if (!s) return false
  const lower = s.toLowerCase()
  // Tem acento PT? Provavelmente PT.
  if (/[áàâãéêíóôõúç]/i.test(s)) return false
  // Tem palavras tipicas PT-BR? Provavelmente PT.
  if (/\b(o|a|os|as|de|da|do|que|nao|sim|com|para|por|um|uma|voce|esta|este|isso|sou|sao|tem|na|no|ele|ela|esse|essa|sobre|aqui|ai|la|nosso|seu|sua|meu|minha)\b/.test(lower)) return false
  // Tem palavras tipicas EN? Marca como ingles.
  if (/\b(the|and|you|are|is|was|were|that|this|with|for|have|has|will|would|could|should|been|but|not|they|them|when|where|which|what|how|why|some|just|also|like|then|than|been|because|while|about|here|there|their)\b/.test(lower)) return true
  return false
}

function needsRetry(translated, original) {
  if (!translated) return true
  const t = translated.toLowerCase().trim()
  const o = original.toLowerCase().trim()
  if (t === o) return true                                  // ecoou original
  if (t.startsWith(o.slice(0, 40))) return true             // copiou inicio do original
  if (isMostlyEnglish(translated)) return true              // saiu em ingles
  if (/^(REGRAS|RULES|INGLES|EN)\b/i.test(translated)) return true  // vazou prompt
  if (translated.length < 3) return true                    // resposta minuscula
  return false
}

// Fallback super simples: troca palavras-chave comuns EN->PT
// Nao traduz tudo, mas pelo menos quebra o ingles cru
const SIMPLE_MAP = {
  'the': 'o', 'and': 'e', 'or': 'ou', 'but': 'mas', 'not': 'nao',
  'is': 'é', 'are': 'são', 'was': 'era', 'were': 'eram',
  'this': 'isso', 'that': 'isso', 'these': 'esses', 'those': 'aqueles',
  'you': 'voce', 'your': 'seu', "you're": 'voce é', "you've": 'voce tem',
  'i': 'eu', "i'm": 'eu sou', "i've": 'eu tenho',
  'he': 'ele', 'she': 'ela', 'his': 'dele', 'her': 'dela',
  'we': 'nos', 'they': 'eles', 'their': 'deles',
  'what': 'o que', 'how': 'como', 'why': 'por que', 'when': 'quando', 'where': 'onde',
  'with': 'com', 'without': 'sem', 'for': 'para', 'about': 'sobre',
  'because': 'porque', 'so': 'entao', 'then': 'depois', 'now': 'agora',
  'good': 'bom', 'bad': 'ruim', 'great': 'otimo', 'best': 'melhor',
  'football': 'futebol', 'soccer': 'futebol', 'player': 'jogador', 'team': 'time',
  'goal': 'gol', 'match': 'jogo', 'game': 'jogo', 'league': 'liga',
  'win': 'ganhar', 'lose': 'perder', 'play': 'jogar', 'score': 'marcar',
}
function quickReplace(text) {
  return text.split(/\s+/).map(w => {
    const clean = w.toLowerCase().replace(/[^a-z']/g, '')
    return SIMPLE_MAP[clean] || w
  }).join(' ')
}
