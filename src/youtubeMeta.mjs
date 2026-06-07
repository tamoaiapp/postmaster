/**
 * Gera titulo, descricao e tags pra YouTube via IA local (Qwen 2.5 0.5B GGUF).
 * Reusa o aiManager que ja roda na app.
 */
import { aiManager } from './aiManager.mjs'

/**
 * @param {Object} input
 * @param {string} input.tituloOriginal - titulo do video fonte
 * @param {string} [input.nicho] - "futebol", "noticia", "ciencia" etc
 * @param {string} [input.transcricao] - primeiras 500 chars da fala (se tiver)
 */
export async function gerarMetadadosYoutube({ tituloOriginal, nicho = '', transcricao = '' }) {
  const llm = await aiManager.get().catch(() => null)
  if (!llm) {
    return {
      title: sanitizeForYoutube(tituloOriginal).slice(0, 100),
      description: sanitizeForYoutube(tituloOriginal),
      tags: nicho ? [nicho] : [],
    }
  }

  const ctx = transcricao ? `\nPrimeiras frases do video: "${transcricao.slice(0, 400)}"` : ''
  const nichoTxt = nicho ? `\nNicho do canal: ${nicho}` : ''
  const prompt = `Voce e especialista em SEO de YouTube BR. Reescreva esse video pra atrair clicks BR.

Titulo original: "${tituloOriginal}"${nichoTxt}${ctx}

Responda EXATAMENTE neste formato (3 linhas):
TITULO: novo titulo BR com hook (max 90 chars, sem emojis, sem aspas tipograficas)
DESC: descricao em PT-BR 2 paragrafos com hook nas primeiras linhas (max 500 chars, sem emojis)
TAGS: tag1, tag2, tag3, tag4, tag5 (max 8 tags separadas por virgula, sem emojis, sem #)`

  let out = ''
  try {
    out = await llm.complete(prompt, { maxTokens: 600, temperature: 0.7 })
  } catch (e) {
    return {
      title: sanitizeForYoutube(tituloOriginal).slice(0, 100),
      description: sanitizeForYoutube(tituloOriginal),
      tags: nicho ? [nicho] : [],
    }
  }

  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  let title = ''
  let description = ''
  let tagsLine = ''
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (!title && lower.startsWith('titulo:')) {
      title = line.slice(7).trim().replace(/^["'“”]|["'“”]$/g, '')
    } else if (!description && lower.startsWith('desc:')) {
      description = line.slice(5).trim().replace(/^["'“”]|["'“”]$/g, '')
    } else if (!description && (lower.startsWith('descricao:') || lower.startsWith('descrição:'))) {
      description = line.slice(line.indexOf(':') + 1).trim().replace(/^["'“”]|["'“”]$/g, '')
    } else if (!tagsLine && lower.startsWith('tags:')) {
      tagsLine = line.slice(5).trim()
    }
  }

  if (!title || !description) {
    const cleaned = out.replace(/```(?:json)?/gi, '').replace(/```/g, '')
    const jsonMatch = cleaned.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      try {
        let raw = jsonMatch[0]
        const openBrackets = (raw.match(/\[/g) || []).length
        const closeBrackets = (raw.match(/\]/g) || []).length
        if (openBrackets > closeBrackets) raw += ']'.repeat(openBrackets - closeBrackets)
        if (!raw.trim().endsWith('}')) raw += '}'
        const parsed = JSON.parse(raw)
        if (!title) title = String(parsed.title || '').trim()
        if (!description) description = String(parsed.description || '').trim()
        if (!tagsLine && Array.isArray(parsed.tags)) tagsLine = parsed.tags.join(', ')
      } catch {}
    }
  }

  let tags = []
  if (tagsLine) {
    tags = [...new Set(
      tagsLine.split(/[,;]/).map(t => t.trim().replace(/^["#'“”]+|["'“”]+$/g, '').trim()).filter(Boolean)
    )].slice(0, 10)
  }

  if (!title) title = tituloOriginal
  if (!description) description = tituloOriginal
  if (tags.length === 0) {
    // Fallback: extrai palavras-chave do titulo (>3 chars, sem stopwords)
    const stop = new Set(['como','para','sobre','com','sem','que','dos','das','uma','uns','umas','este','esta','estes','estas','isso','aquele','aquela','muito','mais','seu','sua','seus','suas','por','pelo','pela','pelos','pelas','the','and','for','with'])
    const words = tituloOriginal.toLowerCase().replace(/[^a-záàâãéêíóôõúç0-9 ]/gi, ' ').split(/\s+/).filter(w => w.length > 3 && !stop.has(w))
    tags = [...new Set(words)].slice(0, 5)
    if (nicho) tags.unshift(nicho)
  }

  return {
    title: sanitizeForYoutube(title).slice(0, 100),
    description: sanitizeForYoutube(stripLoop(description)).slice(0, 4900),
    tags: tags.map(t => sanitizeForYoutube(t).slice(0, 30)).filter(Boolean),
  }
}

// v1.1.8: Qwen 0.5B as vezes entra em loop repetindo a mesma frase ate maxTokens.
// Detecta repeticao e corta no primeiro reaparecimento de uma mesma frase de 30+ chars.
function stripLoop(text) {
  if (!text || text.length < 60) return text
  const sentences = text.split(/(?<=[.!?])\s+/)
  const seen = new Map()
  const out = []
  for (const s of sentences) {
    const key = s.trim().toLowerCase().slice(0, 40)
    if (key.length < 30) { out.push(s); continue }
    const n = (seen.get(key) || 0) + 1
    if (n >= 2) break  // segunda ocorrencia = inicio do loop, descarta dali
    seen.set(key, n)
    out.push(s)
  }
  return out.join(' ').trim()
}

// v1.1.8: remove chars que a UIA do YT Studio nao digita corretamente
// (emoji, surrogates, aspas tipograficas) mas MANTEM acentuacao PT-BR (a~ ca~ c, etc)
function sanitizeForYoutube(s) {
  if (!s) return ''
  let t = String(s)
  // Remove emojis e simbolos pictograficos (planos suplementares Unicode)
  t = t.replace(/[\u{1F300}-\u{1FAFF}]/gu, '')   // emoji misc + dingbats sup
  t = t.replace(/[\u{1F000}-\u{1F2FF}]/gu, '')   // Mahjong/Domino/Playing cards
  t = t.replace(/[\u{2600}-\u{27BF}]/gu, '')     // misc symbols + dingbats
  t = t.replace(/[\u{2300}-\u{23FF}]/gu, '')     // misc technical
  t = t.replace(/[\u{FE00}-\u{FE0F}]/gu, '')     // variation selectors
  t = t.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')   // regional indicators (bandeiras)
  // Surrogates orfaos
  t = t.replace(/[\uD800-\uDFFF]/g, '')
  // Zero-width e BOM (todos via \u escapes pra nao depender do encoding do arquivo)
  t = t.replace(/[​‌‍‎‏‪-‮⁠﻿]/g, '')
  // Aspas e tracos tipograficos -> ASCII
  t = t.replace(/[‘’‚‛]/g, "'")
  t = t.replace(/[“”„‟]/g, '"')
  t = t.replace(/[–—―]/g, '-')
  t = t.replace(/…/g, '...')
  t = t.replace(/ /g, ' ')  // non-breaking space
  // Compacta espacos
  t = t.replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/g, '')
  return t
}
