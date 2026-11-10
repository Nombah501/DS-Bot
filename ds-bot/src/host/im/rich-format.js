import { inlineHtml, toPlain } from './format.js'

// Local Bridge policy, measured in Unicode characters, not HTML bytes or UTF-16 units.
export const RICH_LIMIT = 32768
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const length = text => Array.from(toPlain(text)).length
const cells = line => {
  const parts = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/)
  return parts.map(part => part.trim().replace(/\\\|/g, '|'))
}
const delimiter = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)

// Each unit has its own complete wrapper; tables split only between complete rows.
export function chunkRich(markdown, limit = RICH_LIMIT) {
  const lines = String(markdown ?? '').split('\n')
  const units = []
  const add = (text, render) => {
    const points = Array.from(text)
    if (length(text) <= limit) units.push({ text, html: render(text), size: length(text) })
    else for (let at = 0; at < points.length; at += limit) {
      const part = points.slice(at, at + limit).join('')
      units.push({ text: part, html: render(part), size: length(part) })
    }
  }
  for (let at = 0; at < lines.length;) {
    const line = lines[at++]
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      const body = []
      while (at < lines.length && !/^```\s*$/.test(lines[at])) body.push(lines[at++])
      if (at < lines.length) at++
      add(body.join('\n'), text => `<pre><code${fence[1] ? ` class="language-${escape(fence[1])}"` : ''}>${escape(text)}</code></pre>`)
    } else if (line.includes('|') && at < lines.length && delimiter(lines[at])) {
      at++
      const header = `<tr>${cells(line).map(cell => `<th>${inlineHtml(cell)}</th>`).join('')}</tr>`
      let rows = header
      let text = line
      let size = length(cells(line).join(''))
      while (at < lines.length && lines[at].includes('|') && lines[at].trim() !== '') {
        const row = lines[at++]
        const rowSize = length(cells(row).join(''))
        if (rowSize + length(cells(line).join('')) > limit) {
          if (rows !== header) units.push({ text, html: `<table>${rows}</table>`, size })
          rows = header
          text = line
          size = length(cells(line).join(''))
          for (const [index, cell] of cells(row).entries()) {
            add(`${cells(line)[index] ?? ''}: ${cell}`, value => `<p>${inlineHtml(value)}</p>`)
          }
          continue
        }
        if (size + rowSize > limit) {
          units.push({ text, html: `<table>${rows}</table>`, size })
          rows = header
          text = line
          size = length(cells(line).join(''))
        }
        rows += `<tr>${cells(row).map(cell => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`
        text += `\n${row}`
        size += rowSize
      }
      if (rows !== header) units.push({ text, html: `<table>${rows}</table>`, size })
    } else if (line.trim() !== '') {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
      const quote = /^>\s?(.*)$/.exec(line)
      const tag = heading ? `h${heading[1].length}` : quote ? 'blockquote' : 'p'
      if (bullet || ordered) add((bullet || ordered)[1], text => `<${bullet ? 'ul' : 'ol'}><li>${inlineHtml(text)}</li></${bullet ? 'ul' : 'ol'}>`)
      else add(heading?.[2] ?? quote?.[1] ?? line, text => `<${tag}>${inlineHtml(text)}</${tag}>`)
    }
  }
  const chunks = []
  let current = { html: '', text: '', size: 0 }
  for (const unit of units) {
    if (current.html && current.size + unit.size + 1 > limit) {
      chunks.push(current)
      current = { html: '', text: '', size: 0 }
    }
    const separator = current.html ? '\n' : ''
    current.html += separator + unit.html
    current.text += separator + unit.text
    current.size += unit.size + separator.length
  }
  if (current.html) chunks.push(current)
  return chunks
}

export const toRichHtml = markdown => chunkRich(markdown).map(chunk => chunk.html).join('\n')
