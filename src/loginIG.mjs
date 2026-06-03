/**
 * Abre janela de login do Instagram e salva a sessão.
 */

import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

export default async function loginIG(username, dataDir) {
  const sessionFile = path.join(dataDir, 'sessions', `ig-${username}.json`)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 1080, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' })

  console.log(`[loginIG] Aguardando login manual para @${username}...`)

  // Aguarda até o usuário estar logado (até 5 min)
  try {
    await page.waitForURL(url => !url.includes('/accounts/login') && !url.includes('/challenge'), {
      timeout: 300000,
    })
  } catch {
    await browser.close()
    throw new Error('Login não concluído a tempo')
  }

  await ctx.storageState({ path: sessionFile })
  console.log(`[loginIG] Sessão salva em ${sessionFile}`)
  await browser.close()
}
