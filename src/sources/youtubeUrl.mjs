/**
 * Helpers de URL YouTube — sem deps nativas (testável com `node --test`).
 */

export function extractVideoId(url) {
  if (!url) return null
  const m1 = String(url).match(/(?:v=|\/shorts\/|youtu\.be\/)([\w-]{11})/)
  if (m1) return m1[1]
  const m2 = String(url).match(/^([\w-]{11})$/)
  return m2 ? m2[1] : null
}

export function isYoutubeChannelUrl(url) {
  return /\/(@|c\/|channel\/|user\/|playlist\?)/i.test(String(url || ''))
}

/**
 * True se TODAS as linhas forem URL/ID de vídeo (watch, youtu.be, shorts, id 11 chars)
 * e nenhuma for canal/playlist. Usado pra auto-rotear cola de vídeo no campo de canal.
 */
export function urlsLookLikeYoutubeVideos(urls) {
  const lista = String(urls || '').split('\n').map(s => s.trim()).filter(Boolean)
  if (!lista.length) return false
  return lista.every(u => !isYoutubeChannelUrl(u) && Boolean(extractVideoId(u)))
}
