<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    label: string
    placeholder?: string
    visualLabel?: string
    markdownLabel?: string
  }>(),
  {
    placeholder: '',
    visualLabel: 'Visual',
    markdownLabel: 'Markdown',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const editorRoot = ref<HTMLElement | null>(null)
const sourceMode = ref(false)
let lastEmitted = ''

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
}

function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) return ''
  const html: string[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let listType: 'ul' | 'ol' | null = null
  let inCode = false
  let codeLines: string[] = []

  const closeList = () => {
    if (!listType) return
    html.push(`</${listType}>`)
    listType = null
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList()
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        codeLines = []
      }
      inCode = !inCode
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/)
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/)
    if (unordered || ordered) {
      const nextType = unordered ? 'ul' : 'ol'
      if (listType !== nextType) {
        closeList()
        listType = nextType
        html.push(`<${nextType}>`)
      }
      html.push(`<li>${inlineMarkdown((unordered ?? ordered)![1])}</li>`)
      continue
    }

    closeList()
    if (!line.trim()) continue
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
    } else if (line.startsWith('> ')) {
      html.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`)
    } else {
      html.push(`<p>${inlineMarkdown(line)}</p>`)
    }
  }

  closeList()
  if (inCode && codeLines.length) {
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  }
  return html.join('')
}

function serializeChildren(node: Node): string {
  return Array.from(node.childNodes).map(serializeNode).join('')
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ')
  if (!(node instanceof HTMLElement)) return ''

  const content = serializeChildren(node)
  switch (node.tagName) {
    case 'BR':
      return '\n'
    case 'STRONG':
    case 'B':
      return `**${content}**`
    case 'EM':
    case 'I':
      return `_${content}_`
    case 'H1':
      return `# ${content}\n\n`
    case 'H2':
      return `## ${content}\n\n`
    case 'H3':
      return `### ${content}\n\n`
    case 'P':
    case 'DIV':
      return `${content}\n\n`
    case 'BLOCKQUOTE':
      return `${content
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`
    case 'UL':
      return `${Array.from(node.children)
        .filter((child) => child.tagName === 'LI')
        .map((child) => `- ${serializeChildren(child).trim()}`)
        .join('\n')}\n\n`
    case 'OL':
      return `${Array.from(node.children)
        .filter((child) => child.tagName === 'LI')
        .map((child, index) => `${index + 1}. ${serializeChildren(child).trim()}`)
        .join('\n')}\n\n`
    case 'LI':
      return content
    case 'A': {
      const href = node.getAttribute('href') ?? ''
      return /^https?:\/\//i.test(href) ? `[${content}](${href})` : content
    }
    case 'CODE':
      return node.parentElement?.tagName === 'PRE' ? content : `\`${content}\``
    case 'PRE':
      return `\`\`\`\n${node.textContent ?? ''}\n\`\`\`\n\n`
    default:
      return content
  }
}

function visualMarkdown(): string {
  return editorRoot.value
    ? serializeChildren(editorRoot.value).replace(/\n{3,}/g, '\n\n').trim()
    : ''
}

function syncFromVisual() {
  const markdown = visualMarkdown()
  lastEmitted = markdown
  emit('update:modelValue', markdown)
}

function runCommand(command: string, value?: string) {
  editorRoot.value?.focus()
  document.execCommand(command, false, value)
  syncFromVisual()
}

function addLink() {
  const url = window.prompt('Paste an https:// link')
  if (url && /^https?:\/\//i.test(url)) runCommand('createLink', url)
}

function insertQuote() {
  runCommand('formatBlock', 'blockquote')
}

function insertCode() {
  runCommand('formatBlock', 'pre')
}

function handlePaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
  syncFromVisual()
}

async function setSourceMode(enabled: boolean) {
  sourceMode.value = enabled
  if (!enabled) {
    await nextTick()
    if (editorRoot.value) editorRoot.value.innerHTML = markdownToHtml(props.modelValue)
  }
}

onMounted(() => {
  if (editorRoot.value) editorRoot.value.innerHTML = markdownToHtml(props.modelValue)
})

watch(
  () => props.modelValue,
  (value) => {
    if (value === lastEmitted) {
      lastEmitted = ''
      return
    }
    if (!sourceMode.value && editorRoot.value && !editorRoot.value.contains(document.activeElement)) {
      editorRoot.value.innerHTML = markdownToHtml(value)
    }
  },
)
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
    <div class="flex flex-wrap items-center gap-1 border-b border-slate-700 bg-slate-900 p-2">
      <template v-if="!sourceMode">
        <button type="button" class="editor-tool font-black" title="Heading 2" aria-label="Heading 2" @mousedown.prevent @click="runCommand('formatBlock', 'h2')">H2</button>
        <button type="button" class="editor-tool font-black" title="Heading 3" aria-label="Heading 3" @mousedown.prevent @click="runCommand('formatBlock', 'h3')">H3</button>
        <button type="button" class="editor-tool font-black" title="Bold" aria-label="Bold" @mousedown.prevent @click="runCommand('bold')">B</button>
        <button type="button" class="editor-tool italic" title="Italic" aria-label="Italic" @mousedown.prevent @click="runCommand('italic')">I</button>
        <button type="button" class="editor-tool" title="Bulleted list" aria-label="Bulleted list" @mousedown.prevent @click="runCommand('insertUnorderedList')">• List</button>
        <button type="button" class="editor-tool" title="Numbered list" aria-label="Numbered list" @mousedown.prevent @click="runCommand('insertOrderedList')">1. List</button>
        <button type="button" class="editor-tool" title="Quote" aria-label="Quote" @mousedown.prevent @click="insertQuote">❝</button>
        <button type="button" class="editor-tool" title="Link" aria-label="Link" @mousedown.prevent @click="addLink">Link</button>
        <button type="button" class="editor-tool" title="Code block" aria-label="Code block" @mousedown.prevent @click="insertCode">&lt;/&gt;</button>
      </template>
      <div class="ml-auto inline-flex rounded-md bg-slate-950 p-0.5">
        <button
          type="button"
          class="rounded px-2.5 py-1 text-xs font-semibold"
          :class="!sourceMode ? 'bg-slate-700 text-white' : 'text-slate-400'"
          @click="setSourceMode(false)"
        >
          {{ visualLabel }}
        </button>
        <button
          type="button"
          class="rounded px-2.5 py-1 text-xs font-semibold"
          :class="sourceMode ? 'bg-slate-700 text-white' : 'text-slate-400'"
          @click="setSourceMode(true)"
        >
          {{ markdownLabel }}
        </button>
      </div>
    </div>

    <textarea
      v-if="sourceMode"
      :value="modelValue"
      rows="18"
      :aria-label="label"
      :placeholder="placeholder"
      class="min-h-[26rem] w-full resize-y bg-slate-950 px-4 py-3 font-mono text-sm leading-6 text-white outline-none"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <div
      v-else
      ref="editorRoot"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      :aria-label="label"
      :data-placeholder="placeholder"
      class="journal-visual-editor min-h-[26rem] px-5 py-4 text-base leading-7 text-slate-100 outline-none"
      @input="syncFromVisual"
      @paste.prevent="handlePaste"
    />
  </div>
</template>

<style scoped>
.editor-tool {
  min-height: 2rem;
  border-radius: 0.375rem;
  padding: 0.25rem 0.55rem;
  color: rgb(203 213 225);
  font-size: 0.75rem;
}

.editor-tool:hover,
.editor-tool:focus-visible {
  background: rgb(51 65 85);
  color: white;
}

.journal-visual-editor:empty::before {
  content: attr(data-placeholder);
  color: rgb(100 116 139);
  pointer-events: none;
}

.journal-visual-editor :deep(h1),
.journal-visual-editor :deep(h2),
.journal-visual-editor :deep(h3) {
  margin: 1rem 0 0.5rem;
  color: white;
  font-weight: 800;
  line-height: 1.25;
}

.journal-visual-editor :deep(h1) { font-size: 1.875rem; }
.journal-visual-editor :deep(h2) { font-size: 1.5rem; }
.journal-visual-editor :deep(h3) { font-size: 1.25rem; }
.journal-visual-editor :deep(p) { margin: 0.5rem 0; }
.journal-visual-editor :deep(ul) { margin: 0.5rem 0; padding-left: 1.5rem; list-style: disc; }
.journal-visual-editor :deep(ol) { margin: 0.5rem 0; padding-left: 1.5rem; list-style: decimal; }
.journal-visual-editor :deep(blockquote) { margin: 0.75rem 0; border-left: 3px solid rgb(52 211 153); padding-left: 1rem; color: rgb(148 163 184); }
.journal-visual-editor :deep(a) { color: rgb(52 211 153); text-decoration: underline; }
.journal-visual-editor :deep(pre) { margin: 0.75rem 0; overflow-x: auto; border-radius: 0.375rem; background: rgb(15 23 42); padding: 0.75rem; font-family: monospace; }
.journal-visual-editor :deep(code) { border-radius: 0.25rem; background: rgb(30 41 59); padding: 0.1rem 0.3rem; font-family: monospace; }
</style>
