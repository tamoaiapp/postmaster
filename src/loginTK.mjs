/**
 * Abre janela de login do TikTok e salva a sessão.
 */

import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

export default async function loginTK(username, dataDir) {
  const sessionFile = path.join(dataDir, 'sessions', `tk-${username}.json`)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 800 } })
  const page = await ctx.newPage()

  await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded' })
  console.log(`[loginTK] Aguardando login manual para @${username}...`)

  try {
    await page.waitForURL(url => url.includes('tiktok.com') && !url.includes('/login'), {
      timeout: 300000,
    })
    // Aguarda um pouco para carregar cookies de sessão
    await new Promise(r => setTimeout(r, 3000))
  } catch {
    await browser.close()
    throw new Error('Login TikTok não concluído a tempo')
  }

  await ctx.storageState({ path: sessionFile })
  console.log(`[loginTK] Sessão salva em ${sessionFile}`)
  await browser.close()
}
