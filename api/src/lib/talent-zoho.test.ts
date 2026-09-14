import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../db/index.js', () => ({ db: {} }))
vi.mock('./talent.js', () => ({ importTalentEmail: vi.fn() }))
import { readBoundedResponse, talentZohoConfig, talentZohoStatus } from './talent-zoho.js'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
describe('Zoho Talent configuration', () => {
  it('keeps hello and fails closed without OAuth configuration', () => {
    vi.stubEnv('TALENT_FARM_ID', '')
    expect(talentZohoStatus('farm')).toMatchObject({ configured: false, mailbox: 'hello@trovara.farm', provider: 'Zoho', sendingEnabled: false })
  })
  it('never enables another farm to read the mailbox', () => {
    vi.stubEnv('TALENT_FARM_ID', 'farm-a'); vi.stubEnv('TALENT_ZOHO_ACCOUNT_ID', '123')
    vi.stubEnv('TALENT_ZOHO_FOLDER_IDS', '456'); vi.stubEnv('TALENT_ZOHO_CLIENT_ID', 'client')
    vi.stubEnv('TALENT_ZOHO_CLIENT_SECRET', 'secret'); vi.stubEnv('TALENT_ZOHO_REFRESH_TOKEN', 'refresh')
    expect(talentZohoStatus('farm-a').configured).toBe(true)
    expect(talentZohoStatus('farm-b').configured).toBe(false)
  })
  it('rejects arbitrary hosts and folder paths', () => {
    vi.stubEnv('TALENT_ZOHO_REGION', 'https://evil.example')
    expect(talentZohoConfig).toThrow('region')
    vi.stubEnv('TALENT_ZOHO_REGION', 'com'); vi.stubEnv('TALENT_ZOHO_FOLDER_IDS', '../inbox')
    expect(talentZohoConfig).toThrow('folder')
  })
  it('bounds responses even without a Content-Length', async () => {
    await expect(readBoundedResponse(new Response('0123456789'), 5)).rejects.toThrow('size limit')
    await expect(readBoundedResponse(new Response('okay'), 5)).resolves.toBe('okay')
  })
  it('uses only allowlisted HTTPS hosts, disables redirects, and rejects unconfirmed API success', async () => {
    vi.resetModules()
    vi.stubEnv('TALENT_ZOHO_REGION', 'com'); vi.stubEnv('TALENT_ZOHO_FOLDER_IDS', '456')
    vi.stubEnv('TALENT_ZOHO_ACCOUNT_ID', '123'); vi.stubEnv('TALENT_ZOHO_CLIENT_ID', 'test-client')
    vi.stubEnv('TALENT_ZOHO_CLIENT_SECRET', 'test-secret'); vi.stubEnv('TALENT_ZOHO_REFRESH_TOKEN', 'test-refresh')
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'provider failure' })))
    vi.stubGlobal('fetch', fetch)
    const { zohoRequest } = await import('./talent-zoho.js')
    await expect(zohoRequest('/messages/view?folderId=456')).rejects.toThrow('Zoho request failed')
    expect(fetch.mock.calls[0][0]).toBe('https://accounts.zoho.com/oauth/v2/token')
    expect(fetch.mock.calls[1][0]).toBe('https://mail.zoho.com/api/accounts/123/messages/view?folderId=456')
    expect(fetch.mock.calls[1][1].redirect).toBe('error')
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Zoho-oauthtoken test-token')
  })
})
