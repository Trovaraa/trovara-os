// Run with Node 22 --env-file pointing to the private environment. Dry-run by default.
// No mailbox access, mail sending, document writes, deletion or hiring-stage changes.
import postgres from 'postgres'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveTalentEmailIdentity } from '../api/dist/lib/talent-identity.js'

const args = process.argv.slice(2)
const option = (key) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
const anchor = option('--anchor')
const expectedCount = Number(option('--expected-count'))
const snapshotFile = option('--snapshot')
const applyHash = option('--apply')
if (!/^[a-f0-9-]{36}$/i.test(anchor || '') || !Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20 || !snapshotFile) throw new Error('Explicit anchor, expected-count (1–20) and private snapshot path required')
if ((statSync(dirname(resolve(snapshotFile))).mode & 0o077) !== 0) throw new Error('Snapshot directory must be private (0700)')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be explicitly configured')
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} })
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sameName = (a, b) => a.toLowerCase().split(/\s+/).sort().join(' ') === b.toLowerCase().split(/\s+/).sort().join(' ')
async function inspect(tx) {
  const [application] = await tx`select * from talent_applications where id=${anchor} and deleted_at is null`
  if (!application) throw new Error('Anchor not found')
  const applications = await tx`select * from talent_applications where farm_id=${application.farm_id} and candidate_id=${application.candidate_id} order by id`
  if (applications.length !== expectedCount || applications.some(row => row.deleted_at)) throw new Error('Cohort changed or contains deleted records')
  const ids = applications.map(row => row.id)
  const candidates = await tx`select * from talent_candidates where farm_id=${application.farm_id} order by id`
  const documents = await tx`select * from talent_documents where farm_id=${application.farm_id} and application_id in ${tx(ids)} order by id`
  const events = await tx`select * from talent_events where farm_id=${application.farm_id} and application_id in ${tx(ids)} order by id`
  const plans = applications.map(row => {
    const emails = events.filter(e => e.application_id === row.id && e.kind === 'email')
    if (emails.length !== 1 || !/^From: info@trovara\.farm\n/i.test(emails[0].body)) throw new Error('Unexpected source correspondence; review manually')
    const subject = emails[0].body.match(/^Subject: (.*)$/m)?.[1] || ''
    const identity = resolveTalentEmailIdentity({ senderEmail: 'info@trovara.farm', subject, body: emails[0].body.split('\n').slice(3).join('\n') })
    if (!identity.forwarded || !identity.email) throw new Error('Ambiguous original identity; no automatic repair')
    const cvs = documents.filter(d => d.application_id === row.id && d.kind !== 'email' && /cv|curriculum|resume/i.test(d.filename))
    const cv = cvs.find(d => d.extractedFields?.email?.toLowerCase() === identity.email || d.extracted_fields?.email?.toLowerCase() === identity.email)
    const fields = cv?.extracted_fields || cv?.extractedFields
    const name = row.id === anchor && option('--anchor-name') ? option('--anchor-name') :
      identity.name === identity.email && fields?.name ? fields.name : identity.name
    const match = candidates.find(c => c.email === identity.email && c.id !== application.candidate_id)
    if (match && !sameName(match.name, name)) throw new Error('Existing candidate identity mismatch; manual review required')
    return { id: row.id, name, email: identity.email, existingCandidateId: match?.id || null,
      sourceName: identity.name, cvName: fields?.name || null, emailMatchesCv: Boolean(cv), documentCount: documents.filter(d => d.application_id === row.id).length }
  })
  if (new Set(plans.map(p => p.email)).size !== plans.length) throw new Error('Repeated original identities need manual reconciliation')
  const relevantIds = new Set([application.candidate_id, ...plans.map(p => p.existingCandidateId).filter(Boolean)])
  const before = { applications, candidates: candidates.filter(c => relevantIds.has(c.id)), documents, events }
  return { farmId: application.farm_id, oldCandidateId: application.candidate_id, before, plans }
}
try {
  if (!applyHash) {
    const result = await sql.begin('isolation level repeatable read read only', inspect)
    const fingerprint = digest(result)
    writeFileSync(snapshotFile, JSON.stringify({ fingerprint, ...result }, null, 2), { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ mode: 'dry-run', fingerprint, applications: result.plans.map(({ email, ...p }) => ({ ...p, hasOriginalEmail: Boolean(email) })) }, null, 2))
  } else {
    if ((statSync(snapshotFile).mode & 0o077) !== 0) throw new Error('Snapshot permissions are not private')
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    if (snapshot.fingerprint !== applyHash) throw new Error('Snapshot approval fingerprint mismatch')
    await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtext(${'talent:' + snapshot.farmId}))`
      const current = await inspect(tx)
      if (digest(current) !== applyHash) throw new Error('Live data changed since dry-run; refusing repair')
      for (const plan of current.plans) {
        let id = plan.existingCandidateId
        if (!id) {
          const [candidate] = await tx`insert into talent_candidates (farm_id,name,email) values (${current.farmId},${plan.name},${plan.email}) returning id`
          id = candidate.id
        }
        await tx`update talent_applications set candidate_id=${id},updated_at=now() where farm_id=${current.farmId} and id=${plan.id}`
        await tx`insert into talent_events (farm_id,application_id,kind,body) values (${current.farmId},${plan.id},'identity_repaired','Forwarded-email identity repaired from preserved original sender after owner approval and verified backup. Application documents, notes, hiring stage and follow-up fields retained.')`
        await tx`insert into audit_events (farm_id,action,entity_type,entity_id,metadata) values (${current.farmId},'update','talent_application',${plan.id},${tx.json({ reason: 'forwarded_identity_repair', beforeCandidateId: current.oldCandidateId, afterCandidateId: id, snapshotFingerprint: applyHash })})`
      }
      const ids = current.plans.map(p => p.id)
      const after = await tx`select * from talent_applications where farm_id=${current.farmId} and id in ${tx(ids)} order by id`
      const omitMutable = ({candidate_id,updated_at,...row}) => row
      if (digest(after.map(omitMutable)) !== digest(current.before.applications.map(omitMutable))) throw new Error('Unexpected application changes')
      const docs = await tx`select * from talent_documents where farm_id=${current.farmId} and application_id in ${tx(ids)} order by id`
      if (digest(docs) !== digest(current.before.documents)) throw new Error('Document preservation check failed')
      const originalEventIds = current.before.events.map(e => e.id)
      const events = await tx`select * from talent_events where farm_id=${current.farmId} and id in ${tx(originalEventIds)} order by id`
      if (digest(events) !== digest(current.before.events)) throw new Error('Correspondence/note preservation check failed')
      // Retain the old candidate (unlinked) in this repair, so recovery never needs a deleted profile.
    })
    console.log(JSON.stringify({ mode: 'applied', repaired: expectedCount, preservedDocumentsAndEvents: true, fingerprint: applyHash }))
  }
} catch (error) {
  // Database error details can include applicant data; do not print them.
  console.error(error.code ? `Repair failed with database code ${error.code}; transaction rolled back.` : error.message)
  process.exitCode = 1
} finally { await sql.end() }
