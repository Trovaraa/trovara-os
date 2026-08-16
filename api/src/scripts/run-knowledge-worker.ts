import '../lib/env.js'
import { hostname } from 'node:os'
import { runKnowledgeWorkerOnce } from '../lib/knowledge-worker.js'

const workerId = `${hostname()}:${process.pid}`
const pollMs = Math.max(250, Number(process.env.KNOWLEDGE_WORKER_POLL_MS || 2_000))
let stopping = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true })
}

console.log(`Trovara knowledge worker ${workerId} started`)
while (!stopping) {
  const worked = await runKnowledgeWorkerOnce(workerId).catch((error) => {
    console.error('Knowledge worker loop failed:', error instanceof Error ? error.message : error)
    return false
  })
  if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs))
}
console.log('Trovara knowledge worker stopped')
