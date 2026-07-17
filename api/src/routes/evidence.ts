import { Hono } from 'hono'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { readEvidenceFile } from '../lib/evidence-store.js'

export const evidenceRoutes = new Hono<{ Variables: AppVariables }>()

evidenceRoutes.use('*', authMiddleware)

// Key format: <farmId>/<filename> (served at /api/evidence/<farmId>/<filename>)
evidenceRoutes.get('/:farmId/:filename', async (c) => {
  const user = c.get('user')
  const farmId = c.req.param('farmId')
  const filename = c.req.param('filename')

  if (user.farmId !== farmId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  try {
    const { buffer, contentType } = await readEvidenceFile(farmId, filename)
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})
