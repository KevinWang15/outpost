/* global Image, document */
// Derive every raster logo and favicon from the approved SVG.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const publicDirectory = new URL('../../public/', import.meta.url)
const svg = await readFile(new URL('outpost.svg', publicDirectory), 'utf8')
const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage()
  const icons = new Map()
  for (const size of [16, 32, 48, 180, 512]) {
    const data = await page.evaluate(async ({ svg, size }) => {
      const image = new Image()
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0, size, size)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { svg, size })
    const pixels = Buffer.from(data, 'base64')
    icons.set(size, pixels)
    const filename = size === 512 ? 'outpost.png' : size === 180 ? 'apple-touch-icon.png' : `favicon-${size}x${size}.png`
    if (size !== 48) await writeFile(new URL(filename, publicDirectory), pixels)
  }

  // ICO directories can embed PNG frames, preserving transparency at each size.
  const sizes = [16, 32, 48]
  const directory = Buffer.alloc(6 + sizes.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(sizes.length, 4)
  let offset = directory.length
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16
    const pixels = icons.get(size)
    directory[entry] = directory[entry + 1] = size
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(pixels.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += pixels.length
  }
  await writeFile(new URL('favicon.ico', publicDirectory), Buffer.concat([directory, ...sizes.map(size => icons.get(size))]))
  console.log(`Generated logo PNG, Apple touch icon, and PNG/ICO favicons in ${fileURLToPath(publicDirectory)}`)
} finally {
  await browser.close()
}
