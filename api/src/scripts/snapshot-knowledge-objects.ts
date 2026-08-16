import '../lib/env.js'
import { join } from 'node:path'
import { getEvidenceStorageRoot } from '../lib/evidence-store.js'
import { snapshotCleanKnowledgeObjects } from '../lib/knowledge-storage.js'

const destination = join(getEvidenceStorageRoot(), '_knowledge_object_backup')
const result = await snapshotCleanKnowledgeObjects(destination)
console.log(`Knowledge object snapshot complete: ${result.copied} copied from ${result.backend}`)
