<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ text: string }>()

type Segment = { type: 'text' | 'bold' | 'code'; value: string }
type Block =
  | { kind: 'ul'; items: Segment[][] }
  | { kind: 'ol'; items: Segment[][] }
  | { kind: 'p'; lines: Segment[][] }
  | { kind: 'h'; level: number; text: Segment[] }
  | { kind: 'table'; headers: Segment[][]; rows: Segment[][][] }

// Inline parser: **bold** and `code`. Never uses v-html, so input stays safe.
function parseInline(line: string): Segment[] {
  const segments: Segment[] = []
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: line.slice(lastIndex, match.index) })
    }
    if (match[2] !== undefined) {
      segments.push({ type: 'bold', value: match[2] })
    } else if (match[3] !== undefined) {
      segments.push({ type: 'code', value: match[3] })
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < line.length) {
    segments.push({ type: 'text', value: line.slice(lastIndex) })
  }
  return segments.length ? segments : [{ type: 'text', value: '' }]
}

const tableSeparatorRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/

function splitCells(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((c) => c.trim())
}

const blocks = computed<Block[]>(() => {
  const raw = (props.text ?? '').replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const result: Block[] = []

    const bulletRe = /^\s*[-•*]\s+(.*)$/
    const orderedRe = /^\s*\d+[.)]\s+(.*)$/
    const headingRe = /^(#{1,6})\s+(.*)$/

  let paragraph: Segment[][] = []
  const flushParagraph = () => {
    if (paragraph.length) {
      result.push({ kind: 'p', lines: paragraph })
      paragraph = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trim() === '') {
      flushParagraph()
      continue
    }

    // Table: a header row with pipes followed by a separator row
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      tableSeparatorRe.test(lines[i + 1])
    ) {
      flushParagraph()
      const headers = splitCells(line).map(parseInline)
      const rows: Segment[][][] = []
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        rows.push(splitCells(lines[j]).map(parseInline))
        j++
      }
      result.push({ kind: 'table', headers, rows })
      i = j - 1
      continue
    }

    const heading = line.match(headingRe)
    if (heading) {
      flushParagraph()
      result.push({ kind: 'h', level: heading[1]!.length, text: parseInline(heading[2] ?? '') })
      continue
    }

    const bullet = line.match(bulletRe)
    if (bullet) {
      flushParagraph()
      const last = result[result.length - 1]
      const item = parseInline(bullet[1])
      if (last && last.kind === 'ul') last.items.push(item)
      else result.push({ kind: 'ul', items: [item] })
      continue
    }

    const ordered = line.match(orderedRe)
    if (ordered) {
      flushParagraph()
      const last = result[result.length - 1]
      const item = parseInline(ordered[1])
      if (last && last.kind === 'ol') last.items.push(item)
      else result.push({ kind: 'ol', items: [item] })
      continue
    }

    paragraph.push(parseInline(line))
  }
  flushParagraph()
  return result
})
</script>

<template>
  <div class="space-y-2">
    <template v-for="(block, bIdx) in blocks" :key="bIdx">
      <p
        v-if="block.kind === 'h'"
        class="font-black text-white"
        :class="block.level <= 2 ? 'text-base' : 'text-sm'"
      >
        <template v-for="(seg, sIdx) in block.text" :key="sIdx">
          <strong v-if="seg.type === 'bold'" class="font-semibold text-white">{{ seg.value }}</strong>
          <code
            v-else-if="seg.type === 'code'"
            class="rounded bg-slate-900 px-1 py-0.5 text-[0.85em] font-mono text-farm-green"
          >{{ seg.value }}</code>
          <span v-else>{{ seg.value }}</span>
        </template>
      </p>

      <ul v-else-if="block.kind === 'ul'" class="list-disc pl-5 space-y-1">
        <li v-for="(item, iIdx) in block.items" :key="iIdx">
          <template v-for="(seg, sIdx) in item" :key="sIdx">
            <strong v-if="seg.type === 'bold'" class="font-semibold text-white">{{ seg.value }}</strong>
            <code
              v-else-if="seg.type === 'code'"
              class="rounded bg-slate-900 px-1 py-0.5 text-[0.85em] font-mono text-farm-green"
            >{{ seg.value }}</code>
            <span v-else>{{ seg.value }}</span>
          </template>
        </li>
      </ul>

      <ol v-else-if="block.kind === 'ol'" class="list-decimal pl-5 space-y-1">
        <li v-for="(item, iIdx) in block.items" :key="iIdx">
          <template v-for="(seg, sIdx) in item" :key="sIdx">
            <strong v-if="seg.type === 'bold'" class="font-semibold text-white">{{ seg.value }}</strong>
            <code
              v-else-if="seg.type === 'code'"
              class="rounded bg-slate-900 px-1 py-0.5 text-[0.85em] font-mono text-farm-green"
            >{{ seg.value }}</code>
            <span v-else>{{ seg.value }}</span>
          </template>
        </li>
      </ol>

      <div v-else-if="block.kind === 'table'" class="overflow-x-auto -mx-1">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-slate-600">
              <th
                v-for="(cell, cIdx) in block.headers"
                :key="cIdx"
                class="px-2 py-1.5 font-semibold text-white align-top"
              >
                <template v-for="(seg, sIdx) in cell" :key="sIdx">
                  <strong v-if="seg.type === 'bold'" class="font-semibold text-white">{{ seg.value }}</strong>
                  <code
                    v-else-if="seg.type === 'code'"
                    class="rounded bg-slate-900 px-1 py-0.5 text-[0.85em] font-mono text-farm-green"
                  >{{ seg.value }}</code>
                  <span v-else>{{ seg.value }}</span>
                </template>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, rIdx) in block.rows"
              :key="rIdx"
              class="border-b border-slate-800 last:border-0"
            >
              <td
                v-for="(cell, cIdx) in row"
                :key="cIdx"
                class="px-2 py-1.5 align-top text-slate-200"
              >
                <template v-for="(seg, sIdx) in cell" :key="sIdx">
                  <strong v-if="seg.type === 'bold'" class="font-semibold text-white">{{ seg.value }}</strong>
                  <code
                    v-else-if="seg.type === 'code'"
                    class="rounded bg-slate-900 px-1 py-0.5 text-[0.85em] font-mono text-farm-green"
                  >{{ seg.value }}</code>
                  <span v-else>{{ seg.value }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-else class="leading-relaxed">
        <template v-for="(line, lIdx) in block.lines" :key="lIdx">
          <template v-for="(seg, sIdx) in line" :key="sIdx">
            <strong v-if="seg.type === 'bold'" class="font-semibold text-white">{{ seg.value }}</strong>
            <code
              v-else-if="seg.type === 'code'"
              class="rounded bg-slate-900 px-1 py-0.5 text-[0.85em] font-mono text-farm-green"
            >{{ seg.value }}</code>
            <span v-else>{{ seg.value }}</span>
          </template>
          <br v-if="lIdx < block.lines.length - 1" />
        </template>
      </p>
    </template>
  </div>
</template>
