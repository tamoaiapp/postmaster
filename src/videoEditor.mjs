/**
 * videoEditor — corte de silêncio + legenda karaokê word-level + zoom dinâmico.
 *
 * Pipeline pensado pra rodar DEPOIS do smartCut (que escolhe o trecho de 60-120s)
 * e ANTES de converter pra 9:16 final.
 *
 * Funções puras: cada uma só monta filter graph / strings. A execução
 * do ffmpeg fica no orchestrator (edit-demo.mjs ou jobRunner.mjs).
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'

const execAsync = promisify(exec)

// ── 1. Parse VTT word-level ────────────────────────────────────────────────────

/**
 * VTT auto-gerada do YouTube contém tags <00:00:00.240><c> palavra</c> que
 * carregam timestamp por palavra. Extrai array de { word, start, end }.
 *
 * Padrão crítico do YT (rolling display): cada cue tem várias linhas, mas
 * APENAS UMA linha por cue tem tags <ts>. Outras linhas são "fantasmas" da
 * frase anterior repetindo no display. Logo: ignorar linhas sem tag.
 *
 * Também: a mesma palavra aparece como "head" (1ª palavra antes da 1ª tag)
 * em dois cues seguidos — porque o YT antecipa em 10ms uma cue só pra
 * remover o item anterior. Dedupe por (word, start) tolerância 200ms.
 */
export function parseVTTWordLevel(vttContent) {
  const lines = vttContent.split(/\r?\n/)
  const words = []
  let cueStart = 0
  let cueEnd = 0

  for (let i = 0; i < lines.length; i++) {
    const ts = lines[i].match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/)
    if (!ts) continue
    cueStart = +ts[1] * 3600 + +ts[2] * 60 + +ts[3] + +ts[4] / 1000
    cueEnd   = +ts[5] * 3600 + +ts[6] * 60 + +ts[7] + +ts[8] / 1000

    // Coleta todas as linhas de texto desta cue
    const textLines = []
    while (i + 1 < lines.length && !lines[i + 1].match(/-->/)) {
      i++
      const t = lines[i]
      if (t.trim() === '' && textLines.length) break
      if (t.trim()) textLines.push(t)
    }

    // CRÍTICO: só processa a linha que contém timestamp inline `<NN:NN:...>`
    // Linhas sem essa tag são repetições da frase anterior (rolling display)
    const activeLine = textLines.find(l => /<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(l))
    if (!activeLine) continue

    extractWordsFromActiveLine(activeLine, cueStart, cueEnd, words)
  }

  return dedupWords(words)
}

/**
 * Extrai palavras de UMA linha que contém tags inline.
 * Formato: "head<HH:MM:SS.mmm><c> palavra</c><HH:MM:SS.mmm><c> palavra</c>..."
 * head = primeira palavra (sem tag, timestamp = cueStart)
 */
function extractWordsFromActiveLine(text, cueStart, cueEnd, out) {
  text = text.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')

  const firstTagIdx = text.search(/<\d{2}:\d{2}:\d{2}\.\d{3}>/)
  if (firstTagIdx === -1) return // nunca deve acontecer (filtrado antes), defesa

  const head = text.slice(0, firstTagIdx).trim()
  const rest = text.slice(firstTagIdx)

  // 1ª palavra (head): timestamp = cueStart. Detecta prefixo ">>" como speaker change.
  const speakerChange = /^(?:>+|»+)/.test(head)
  const cleanedHead = head.replace(/^(>+|-|\.\.\.|»+)\s*/, '').trim()
  if (cleanedHead) {
    const firstWord = cleanedHead.split(/\s+/)[0]
    if (firstWord) {
      out.push({ word: cleanWord(firstWord), start: cueStart, end: cueStart + 0.25, speakerChange })
    }
  }

  // Palavras tagueadas
  const re = /<(\d{2}):(\d{2}):(\d{2})\.(\d{3})>(?:<c[^>]*>)?\s*([^<]+?)\s*(?:<\/c>)?(?=<\d|$)/g
  let m
  const tagged = []
  while ((m = re.exec(rest)) !== null) {
    const ts = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
    const w = cleanWord(m[5])
    if (w) tagged.push({ word: w, start: ts })
  }
  tagged.forEach((t, idx) => {
    out.push({ word: t.word, start: t.start, end: tagged[idx + 1]?.start ?? cueEnd })
  })
}

function cleanWord(w) {
  return (w || '').replace(/[<>]/g, '').trim()
}

// Dedupe: mesma word + start dentro de 200ms é duplicata (head repetido entre cues vizinhas)
function dedupWords(words) {
  const sorted = [...words].sort((a, b) => a.start - b.start)
  const out = []
  for (const w of sorted) {
    // Procura se já existe a mesma palavra recentemente
    let isDup = false
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].start < w.start - 0.5) break
      if (out[i].word === w.word && Math.abs(out[i].start - w.start) < 0.25) { isDup = true; break }
    }
    if (!isDup) out.push(w)
  }
  // Ajusta end de cada palavra pra não passar o start da próxima
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start
  }
  return out
}

// Recorta words para um range [from, to] e rebaseia pra começarem em 0.
export function rebaseWordsToRange(words, from, to) {
  return words
    .filter(w => w.start >= from && w.end <= to + 0.5)
    .map(w => ({
      word: w.word,
      start: w.start - from,
      end: Math.max(w.end - from, w.start - from + 0.08),
      speakerChange: !!w.speakerChange,
    }))
}

/**
 * Dado as words com flags speakerChange, gera segmentos de "qual lado do frame
 * mostrar" alternando a cada troca de speaker. Garante minSec entre trocas
 * pra evitar zapping insano (`>>` aparece muito no VTT do YT).
 *
 * Retorna [{from, to, side: 'left' | 'right'}]
 */
export function buildSpeakerSegments(words, totalDur, { minSec = 3.0, startSide = 'left' } = {}) {
  const segments = []
  let curSide = startSide
  let curFrom = 0

  for (const w of words) {
    if (!w.speakerChange) continue
    const t = w.start
    if (t - curFrom < minSec) continue // ainda cedo pra trocar
    if (t >= totalDur - minSec) break  // muito perto do fim
    // fecha segmento atual
    segments.push({ from: curFrom, to: t, side: curSide })
    curSide = curSide === 'left' ? 'right' : 'left'
    curFrom = t
  }
  segments.push({ from: curFrom, to: totalDur, side: curSide })
  return segments
}

/**
 * Gera ffmpeg filter pra crop alternado entre 'left' e 'right' do frame,
 * com mini-zoom suave dentro de cada segmento.
 *
 * Source: 16:9 escalado pra altura 1344 (largura ~2389 se source for 720p).
 * Output: 1080×1344 (cortado).
 *
 * O `x` do crop muda por segmento:
 *  - left:  x = padding (mostra metade esquerda do frame)
 *  - right: x = iw - 1080 - padding (mostra metade direita)
 *
 * Mini-zoom: ao longo de cada segmento, faz scale de 1.0 → 1.05 com easing
 * via expression. Pra simplificar, aplica o zoom GLOBAL (Ken Burns) só
 * variando o x do crop por segmento — sem mexer no scale por tempo.
 */
export function buildSpeakerCropFilter(segments, paddingPx = 0) {
  // Constrói expression x do crop usando aninhamento if(between(t,...))
  // O ffmpeg avalia da palavra "if" mais externa pra dentro
  let xExpr = '0' // fallback
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    const xVal = s.side === 'left'
      ? `${paddingPx}`
      : `(iw-1080-${paddingPx})`
    // Mini zoom: dentro do segmento, x oscila um pouco pra dar movimento
    // Pra "respirar": x_final = xVal + sin((t-from)/2) * 8
    const xWithZoom = `(${xVal}+sin((t-${s.from.toFixed(2)})/2)*12)`
    xExpr = `if(between(t\\,${s.from.toFixed(2)}\\,${s.to.toFixed(2)})\\,${xWithZoom}\\,${xExpr})`
  }
  // y centro (1344 altura — usa toda a altura disponível)
  return `scale=-2:1344,crop=1080:1344:'${xExpr}':0`
}

// ── 2. Detecção de silêncio ────────────────────────────────────────────────────

/**
 * Roda `ffmpeg ... -af silencedetect=...` e parseia stderr.
 * Retorna [{ start, end }] dos trechos silenciosos.
 */
export async function detectSilences(ffmpegPath, videoPath, { threshold = -32, minSilence = 0.55 } = {}) {
  const cmd = `"${ffmpegPath}" -nostats -i "${videoPath}" -af "silencedetect=noise=${threshold}dB:d=${minSilence}" -f null - 2>&1`
  let stderr = ''
  try {
    const { stdout } = await execAsync(cmd, { timeout: 180000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    stderr = stdout // o 2>&1 mandou tudo pra stdout
  } catch (e) {
    stderr = (e.stderr || '') + (e.stdout || '')
  }

  const silences = []
  let cur = null
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*([\d.]+)/)
    if (s) { cur = { start: parseFloat(s[1]) }; continue }
    const e = line.match(/silence_end:\s*([\d.]+)/)
    if (e && cur) { cur.end = parseFloat(e[1]); silences.push(cur); cur = null }
  }
  return silences
}

/**
 * Dado silêncios e duração total, calcula os "keep ranges" (trechos a manter).
 * Adiciona padding leve nas bordas pra cortes não ficarem secos.
 */
export function buildKeepRanges(silences, totalDur, paddingSec = 0.12) {
  const ranges = []
  let cursor = 0
  const sorted = [...silences].sort((a, b) => a.start - b.start)
  for (const s of sorted) {
    const sStart = Math.max(s.start + paddingSec, cursor)
    if (sStart > cursor) ranges.push({ start: cursor, end: sStart })
    cursor = Math.max(cursor, s.end - paddingSec)
  }
  if (cursor < totalDur) ranges.push({ start: cursor, end: totalDur })
  return ranges.filter(r => r.end - r.start > 0.2) // descarta fragmentos minúsculos
}

/**
 * Função de remapping: dado timestamp original e os keepRanges,
 * retorna o timestamp NO VÍDEO ENCURTADO (pós-corte de silêncio), ou null
 * se o timestamp caiu num trecho removido.
 */
export function remapTime(t, keepRanges) {
  let accumulated = 0
  for (const r of keepRanges) {
    if (t < r.start) return null // está num "buraco" removido
    if (t <= r.end) return accumulated + (t - r.start)
    accumulated += r.end - r.start
  }
  return accumulated // depois do último range (improvável)
}

export function totalKeptDuration(keepRanges) {
  return keepRanges.reduce((acc, r) => acc + (r.end - r.start), 0)
}

// ── 3. Seleção de palavras-chave (sem IA, heurística simples) ──────────────────

/**
 * Marca palavras "fortes" pra destaque na legenda.
 * Heurística sem IA: palavras longas (>= 5 letras) e fora de stopwords,
 * limitadas a ~1 por 5 palavras pra não saturar.
 */
const STOPWORDS = new Set([
  'esse','essa','isso','aquele','aquela','aquilo','este','esta','isto',
  'porque','porquê','quando','onde','quem','qual','quais',
  'então','assim','agora','depois','antes','sempre','nunca','muito','pouco',
  'também','tambem','sobre','entre','para','pelos','pelas','dele','dela','deles','delas',
  'sendo','sido','fazer','feito','ficar','ficou','foi','foram','será','serão',
  'estava','estavam','estamos','estão','estavam','tinha','tinham',
  'minha','minhas','meu','meus','nossa','nossos','sua','seus','dele',
  'voce','vocês','você','vocês','tudo','nada','algo','alguém','ninguém',
])

export function pickKeyWords(words, perN = 5) {
  const out = words.map(w => ({ ...w, highlight: false }))
  for (let i = 0; i < out.length; i++) {
    const wn = stripDiacritics(out[i].word.toLowerCase().replace(/[^\p{L}\d]/gu, ''))
    if (wn.length < 5) continue
    if (STOPWORDS.has(wn)) continue
    // não destaca 2 vizinhas (deixa pelo menos perN-1 entre destaques)
    const lastHi = out.slice(Math.max(0, i - perN + 1), i).findIndex(w => w.highlight)
    if (lastHi !== -1) continue
    out[i].highlight = true
  }
  return out
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

// ── 3b. Smart cut heurístico: escolhe melhor janela viral ─────────────────────

/**
 * Palavras com peso extra (PT-BR + algumas EN comuns). Indicadores de
 * conteúdo emocional / viral / clickbait.
 */
const EMOTIVE_WORDS = new Set([
  // Intensificadores
  'incrivel','incrível','absurdo','absurda','louco','louca','doido','doida','horrivel','horrível',
  'inacreditavel','inacreditável','impossivel','impossível','enorme','gigante','minusculo','minúsculo',
  'gigantesco','catastrofico','catastrófico','espetacular','sensacional','genial','perfeito','perfeita',
  // Pronomes-extremos
  'nunca','sempre','ninguem','ninguém','todo','tudo','nada','jamais',
  // Emocionais
  'medo','raiva','amor','odio','ódio','triste','feliz','chorando','rindo','assustado','chocado','chocada',
  'apaixonado','apaixonada','arrependido','arrependida','furioso','furiosa','desesperado','desesperada',
  // Palavrões / força (BRs usam muito em viral)
  'porra','caralho','merda','foda','puta','desgracado','desgraçado','bagulho','treta',
  // Provocadores
  'segredo','revelacao','revelação','escandalo','escândalo','polemica','polêmica','traicao','traição',
  'bomba','exclusivo','exclusiva','chocante','revelou','revelaram','confessou','admitiu','contou',
  // Numéricos chamativos
  'milhao','milhão','bilhao','bilhão','milhoes','milhões','bilhoes','bilhões','centena','milhares',
])

const HOOK_STARTERS = new Set([
  'nunca','olha','cara','mano','presta','sabe','imagina','pensa','escuta','agora',
])

function scoreWord(w, isFirstOfSentence = false) {
  // Peso baixo na palavra "neutra" — densidade NÃO deve dominar
  let s = 0.2
  const word = w.word
  const lower = stripDiacritics(word.toLowerCase()).replace(/[^\w]/g, '')
  // Exclamação / interrogação → bom marker emocional
  if (/[!?]/.test(word)) s += 3
  // Palavra emotiva → peso alto
  if (EMOTIVE_WORDS.has(lower)) s += 6
  // Hook starter (palavra de abertura forte) → MUITO peso (define se trecho engaja já no início)
  if (isFirstOfSentence && HOOK_STARTERS.has(lower)) s += 5
  // Palavra longa não-stopword → leve bônus
  if (lower.length >= 7 && !STOPWORDS.has(lower)) s += 0.5
  return s
}

/**
 * Varre o vídeo em janelas deslizantes e retorna a janela com maior score viral.
 *
 * @param words      array completo de words {word, start, end, speakerChange?}
 * @param windowSec  duração da janela alvo (default 120s)
 * @param stepSec    quão fino é o sliding (default 15s)
 * @param searchUntilSec  só considera janelas que começam até esse ponto
 *                        (default 300s = primeiros 5min). null = vídeo todo.
 * @param minStartSec     pula intro: ignora janelas começando antes disso (default 20s)
 *
 * Retorna { start, end, score, density, hooks, emotives, words }
 */
export function pickBestViralWindow(words, {
  windowSec = 120, stepSec = 15,
  searchFromSec = 20,     // ignora janelas começando antes disso (pula intro)
  searchUntilSec = 300,   // ignora janelas começando depois disso (null = vídeo todo)
  minStartSec = null,     // alias retrocompatível pra searchFromSec
  excludeRanges = [],     // janelas que sobrepõem com algum desses são descartadas
} = {}) {
  if (!words.length) return null
  const startLimit = minStartSec !== null ? minStartSec : searchFromSec
  const last = words[words.length - 1].end
  const limit = searchUntilSec === null
    ? Math.max(0, last - windowSec)
    : Math.min(searchUntilSec, Math.max(0, last - windowSec))

  // Pré-marca "primeira palavra de frase" (após pontuação final ou speakerChange)
  const flagged = words.map((w, i) => {
    const prev = words[i - 1]
    const isFirst = !prev || w.speakerChange || /[.!?]\s*$/.test(prev.word)
    return { ...w, _firstOfSentence: isFirst }
  })

  // Helper: testa se uma janela [s,e] sobrepõe com qualquer excludeRange
  const overlapsExcluded = (s, e) => {
    for (const r of (excludeRanges || [])) {
      if (s < r.end && r.start < e) return true
    }
    return false
  }

  let best = null
  for (let s = startLimit; s <= limit; s += stepSec) {
    const e = s + windowSec
    if (overlapsExcluded(s, e)) continue
    let score = 0, hooks = 0, emotives = 0, count = 0, hookEarly = 0
    for (const w of flagged) {
      if (w.start < s || w.end > e) continue
      count++
      score += scoreWord(w, w._firstOfSentence)
      const lw = stripDiacritics(w.word.toLowerCase()).replace(/[^\w]/g, '')
      if (EMOTIVE_WORDS.has(lw)) emotives++
      if (w._firstOfSentence && HOOK_STARTERS.has(lw)) {
        hooks++
        // BOOST: hook nos primeiros 10s da janela define o gancho do reel
        if (w.start - s < 10) { score += 8; hookEarly++ }
      }
    }
    // Janelas muito vazias (< 50 palavras em 120s) descartadas
    if (count < 50) continue
    if (!best || score > best.score) {
      best = { start: s, end: e, score, density: count, hooks, emotives, hookEarly }
    }
  }
  return best
}

// ── 4. Gerador de arquivo .ass (Advanced SubStation) com karaokê word-by-word ──

/**
 * Gera string .ass que renderiza word-by-word, "pop" effect:
 * palavra normal aparece branca grande com contorno preto;
 * palavra de destaque aparece amarela pelo seu tempo + scale-up via \fscx\fscy.
 *
 * O agrupamento é em "frases curtas" (~ 4-6 palavras), uma frase por linha.
 * Cada frase usa um ÚNICO evento Dialogue com tags inline \k pra animar
 * cada palavra na hora certa.
 */
export function buildKaraokeASS(words, {
  videoW = 1080, videoH = 1920,
  words_per_line = 3, fontSize = 100,
  marginV = 700, marginL = 130, marginR = 130,
  outline = 8, shadow = 4,
  fontName = 'Arial Black',
} = {}) {
  // Cor amarelo TikTok &HBBGGRR& = &H0034EBFC&
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoW}
PlayResY: ${videoH}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Pop, ${fontName}, ${fontSize}, &H00FFFFFF, &H00FFFFFF, &H00000000, &HC0000000, 1, 0, 0, 0, 100, 100, 2, 0, 1, ${outline}, ${shadow}, 2, ${marginL}, ${marginR}, ${marginV}, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

  // Agrupa em "frases" de N palavras
  const lines = []
  for (let i = 0; i < words.length; i += words_per_line) {
    lines.push(words.slice(i, i + words_per_line))
  }

  const dialogues = lines.map(line => {
    if (!line.length) return ''
    const lineStart = line[0].start
    const lineEnd   = line[line.length - 1].end + 0.15
    const t0 = lineStart

    // Estratégia: linha INTEIRA aparece de uma vez (fade-in 80ms).
    // Cada palavra individual ANIMA cor: branco → amarelo → branco no seu tempo.
    // SEM mudança de tamanho (\fscx/\fscy) — evita que palavra ativa invada vizinha.
    // Resultado: efeito karaokê word-by-word fluido, sem sobreposição.
    const segments = line.map(w => {
      const relStart = Math.max(0, (w.start - t0) * 1000)        // ms desde início da linha
      const fadeIn   = relStart + 60                              // chega cor amarela
      const holdEnd  = relStart + 260                             // começa voltar a branco
      const fadeOut  = relStart + 380                             // já está branca de novo
      const word = sanitizeAss(w.word)
      if (w.highlight) {
        // Destaque mais forte: amarelo aceso + dura mais
        return `{\\r\\1c&H00FFFFFF&\\t(${relStart},${fadeIn},\\1c&H0034EBFC&)\\t(${holdEnd + 200},${fadeOut + 200},\\1c&H00FFFFFF&)}${word} `
      }
      // Palavra normal: amarelo curto na hora de ser dita (efeito karaokê)
      return `{\\r\\1c&H00FFFFFF&\\t(${relStart},${fadeIn},\\1c&H0034EBFC&)\\t(${holdEnd},${fadeOut},\\1c&H00FFFFFF&)}${word} `
    }).join('')

    // \fad(80,0) = fade-in 80ms no início da linha; sem fade out
    return `Dialogue: 0,${assTime(lineStart)},${assTime(lineEnd)},Pop,,0,0,0,,{\\fad(80,0)}${segments.trim()}`
  })

  return header + dialogues.join('\n') + '\n'
}

function assTime(t) {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const cs = Math.floor((t * 100) % 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function sanitizeAss(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/[{}]/g, '').trim()
}

// ── 5. Zoom dinâmico baseado nos timestamps das palavras-chave ────────────────

/**
 * Gera filtro ffmpeg pra aplicar zoom variável usando o filter `scale + crop`
 * com curva expression baseada em `t`. Mais simples que zoompan (que confia
 * em frames fixos): cria um zoom factor que pulsa em torno de 1.0 nos
 * momentos de palavra-chave.
 *
 * Retorna um filter string. INPUT label: [in], OUTPUT: [zoomed].
 *
 * Estratégia:
 *  - Define z(t) = 1.0 + soma de "pulsos" gaussianos centrados nas keywords
 *  - pulso = 0.12 * exp(-((t - t_kw)/0.25)^2)
 *  - z(t) clamp em [1.0, 1.18]
 *  - Aplica via zoompan='z=...':d=1:fps=30:s=...
 *
 * SIMPLIFICAÇÃO PRÁTICA: zoompan com expression gigante quebra fácil.
 * Em vez disso, vou gerar uma SEQUÊNCIA de comandos `crop` que zoomam
 * em momentos discretos. Pra demo, basta aplicar UM zoom geral subtle
 * + Ken Burns oscilatório.
 */
export function buildSubtleKenBurnsFilter() {
  // Oscilação leve de zoom (1.00 ↔ 1.04) ao longo do vídeo, periodo ~6s
  // Aplica em [in] e gera [zoomed]
  // Mantém o aspect ratio do input
  return `[in]scale=iw*1.08:ih*1.08,crop=iw/1.08:ih/1.08:(iw-iw/1.08)/2+sin(t/3)*20:(ih-ih/1.08)/2+cos(t/4)*15[zoomed]`
}

/**
 * Zoom mais agressivo nos momentos de palavras-chave.
 * Recebe a lista de words já com highlight=true marcados.
 * Retorna filter string que aplica `crop` com zoom variável.
 *
 * Pra evitar complexidade do zoompan, usa abordagem por keyframes do `crop`
 * com `if/else` no expression — manageable até ~20-30 keywords.
 *
 * Quando há muitas keywords, cai pro buildSubtleKenBurnsFilter.
 */
export function buildKeywordZoomFilter(words, totalDur) {
  const kws = words.filter(w => w.highlight)
  if (kws.length > 30 || kws.length === 0) return buildSubtleKenBurnsFilter()
  // Expressão de zoom: 1.0 + soma de pulsos
  // Cada pulso: 0.12 * exp(-pow((t - tk)/0.3, 2))
  const pulses = kws.map(w => `0.12*exp(-pow((t-${w.start.toFixed(2)})/0.3\\,2))`).join('+')
  const zExpr = `(1+${pulses})`
  // Aplica via scale+crop:
  // zoom factor z(t): scale por z, crop pra resolução original
  return `[in]scale=iw*1.2:ih*1.2,crop=iw/${zExpr}*0.833:ih/${zExpr}*0.833:(iw-iw/${zExpr}*0.833)/2:(ih-ih/${zExpr}*0.833)/2[zoomed]`
}

// ── 6. Helper: concatena ranges via ffmpeg select+aselect ──────────────────────

/**
 * Gera filter_complex que mantém apenas os keepRanges do vídeo, fazendo
 * concat tight via filter select/aselect + setpts/asetpts.
 */
export function buildKeepRangesFilter(keepRanges) {
  if (!keepRanges.length) return null
  const between = keepRanges.map(r => `between(t\\,${r.start.toFixed(3)}\\,${r.end.toFixed(3)})`).join('+')
  // setpts=N/FRAME_RATE/TB reseta timestamps por número de frame (vídeo).
  // No áudio, asetpts pode descasar dos samples — adicionamos aresample=async=1
  // que ressincroniza inserindo/removendo samples imperceptíveis nos cortes.
  // Sem isso, trechos pós-corte ficam mudos por desalinhamento PTS↔samples.
  const vFilter = `select='${between}',setpts=N/FRAME_RATE/TB`
  const aFilter = `aselect='${between}',asetpts=N/SR/TB,aresample=async=1:first_pts=0`
  return { vFilter, aFilter }
}

// ── 7. Helpers diversos ───────────────────────────────────────────────────────

export async function getVideoDuration(ffmpegPath, videoPath) {
  const cmd = `"${ffmpegPath}" -i "${videoPath}" 2>&1`
  try {
    const { stdout } = await execAsync(cmd, { timeout: 30000, windowsHide: true })
    const m = stdout.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/)
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100
  } catch (e) {
    const s = (e.stderr || '') + (e.stdout || '')
    const m = s.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/)
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100
  }
  return 0
}
