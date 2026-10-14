import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccessStore, authorize, normalizeGrant, presetGrant, type Principal, type SessionRef } from '../src/server/access.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-access-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const guest = (preset: 'viewer' | 'participant' | 'collaborator', over = {}): Principal => ({ kind: 'guest', id: 'g1', name: 'Sam', grant: presetGrant(preset, over) })
const ownerSession: SessionRef = { id: 's-owner', shared: true }
const privateOwnerSession: SessionRef = { id: 's-private', shared: false }
const mySession: SessionRef = { id: 's-mine', participantId: 'g1' }
const otherGuestSession: SessionRef = { id: 's-other', participantId: 'g2' }

describe('permissions — the matrix', () => {
  it('the owner may do everything', () => {
    for (const a of ['session.list', 'session.read', 'session.send', 'session.create', 'session.pause', 'session.setMode', 'session.setModel', 'admin'] as const) {
      expect(authorize({ kind: 'owner' }, a, privateOwnerSession).ok).toBe(true)
    }
  })

  it('viewer: watches the shared session and nothing else', () => {
    const v = guest('viewer')
    expect(authorize(v, 'session.read', ownerSession).ok).toBe(true)
    expect(authorize(v, 'session.send', ownerSession).ok).toBe(false)
    expect(authorize(v, 'session.create').ok).toBe(false)
    expect(authorize(v, 'session.pause', ownerSession).ok).toBe(false)
    expect(authorize(v, 'session.read', privateOwnerSession).ok).toBe(false) // owner did not share it
    expect(authorize(v, 'session.read', otherGuestSession).ok).toBe(false) // never another guest's session
  })

  it('participant: can talk in the shared session but not interrupt it, and has no session of their own', () => {
    const p = guest('participant')
    expect(authorize(p, 'session.send', ownerSession).ok).toBe(true)
    expect(authorize(p, 'session.pause', ownerSession).ok).toBe(false)
    expect(authorize(p, 'session.create').ok).toBe(false)
    expect(authorize(p, 'session.send', privateOwnerSession).ok).toBe(false)
  })

  it('collaborator: owns an independent session, read-only agent unless the owner raises the ceiling', () => {
    const c = guest('collaborator')
    expect(authorize(c, 'session.create', undefined, { mode: 'plan' }).ok).toBe(true)
    expect(authorize(c, 'session.send', mySession).ok).toBe(true)
    expect(authorize(c, 'session.pause', mySession).ok).toBe(true)
    expect(authorize(c, 'session.create', undefined, { mode: 'build' }).ok).toBe(false)
    expect(authorize(c, 'session.setMode', mySession, { mode: 'build' }).ok).toBe(false)
    expect(authorize(c, 'session.send', otherGuestSession).ok).toBe(false)
    const builder = guest('collaborator', { mode: 'build', canChangeMode: true })
    expect(authorize(builder, 'session.create', undefined, { mode: 'build' }).ok).toBe(true)
    expect(authorize(builder, 'session.setMode', mySession, { mode: 'plan' }).ok).toBe(true)
  })

  it('model policy: locked refuses any switch, list allows only the listed, any allows all', () => {
    const locked = guest('collaborator')
    expect(authorize(locked, 'session.setModel', mySession, { model: 'gpt-4o' }).ok).toBe(false)
    expect(authorize(locked, 'session.create', undefined, { model: 'gpt-4o' }).ok).toBe(false)
    const list = guest('collaborator', { modelPolicy: 'list', allowedModels: ['cheap-1'] })
    expect(authorize(list, 'session.setModel', mySession, { model: 'cheap-1' }).ok).toBe(true)
    expect(authorize(list, 'session.setModel', mySession, { model: 'big-1' }).ok).toBe(false)
    const any = guest('collaborator', { modelPolicy: 'any' })
    expect(authorize(any, 'session.setModel', mySession, { model: 'whatever' }).ok).toBe(true)
  })

  it('a guest can never use admin actions or interrupt the shared session unless granted', () => {
    expect(authorize(guest('collaborator'), 'admin').ok).toBe(false)
    expect(authorize(guest('participant', { canInterrupt: true }), 'session.pause', ownerSession).ok).toBe(true)
  })

  it('caps: model calls and known cost stop new work; unknown cost is not treated as zero spend', () => {
    const capped = guest('collaborator', { maxModelCalls: 10, maxCostUsd: 1 })
    expect(authorize(capped, 'session.send', mySession, { usage: { modelCalls: 9, costUsd: 0.2 } }).ok).toBe(true)
    expect(authorize(capped, 'session.send', mySession, { usage: { modelCalls: 10, costUsd: 0.2 } }).ok).toBe(false)
    expect(authorize(capped, 'session.send', mySession, { usage: { modelCalls: 3, costUsd: 1.5 } }).ok).toBe(false)
    expect(authorize(capped, 'session.create', undefined, { usage: { modelCalls: 10, costUsd: null } }).ok).toBe(false)
    // Unknown cost cannot be compared — the call cap is what protects the owner then.
    expect(authorize(capped, 'session.send', mySession, { usage: { modelCalls: 3, costUsd: null } }).ok).toBe(true)
  })

  it('an expired grant stops working', () => {
    const g = guest('participant', { expiresAt: new Date(1000).toISOString() })
    expect(authorize(g, 'session.read', ownerSession, { now: 5000 }).ok).toBe(false)
    expect(authorize(g, 'session.read', ownerSession, { now: 500 }).ok).toBe(true)
  })

  it('normalizes inconsistent grants', () => {
    expect(normalizeGrant({ ...presetGrant('collaborator'), mode: 'plan', canChangeMode: true }).canChangeMode).toBe(false)
    expect(normalizeGrant({ ...presetGrant('collaborator'), modelPolicy: 'list', allowedModels: [] }).modelPolicy).toBe('locked')
    expect(normalizeGrant({ ...presetGrant('collaborator'), maxCostUsd: -3 }).maxCostUsd).toBeUndefined()
  })
})

describe('invites and guests', () => {
  it('redeems once, issues a different access token, and never stores a token in the clear', async () => {
    const store = new AccessStore(dir)
    const inv = store.createInvite(presetGrant('collaborator'), { label: 'Sam' })
    const res = store.redeem(inv.token, 'Sam')
    expect('error' in res).toBe(false)
    if ('error' in res) return
    expect(res.accessToken).not.toBe(inv.token)
    expect(res.guest.grant.ownSession).toBe(true)
    expect(store.authenticate(res.accessToken)?.id).toBe(res.guest.id)
    expect(store.authenticate(inv.token)).toBeNull() // the invite is not an access token
    expect('error' in store.redeem(inv.token, 'Eve')).toBe(true) // single use
    const raw = await readFile(join(dir, 'access.json'), 'utf8')
    expect(raw).not.toContain(inv.token)
    expect(raw).not.toContain(res.accessToken)
  })

  it('multi-use invites count uses; expiry and revocation are honored', () => {
    let now = 1_000_000
    const store = new AccessStore(join(dir, 'b'), () => now)
    const inv = store.createInvite(presetGrant('viewer'), { maxUses: 2, ttlMs: 10_000 })
    expect('error' in store.redeem(inv.token, 'a')).toBe(false)
    expect('error' in store.redeem(inv.token, 'b')).toBe(false)
    expect('error' in store.redeem(inv.token, 'c')).toBe(true)

    const inv2 = store.createInvite(presetGrant('viewer'), { ttlMs: 1_000 })
    now += 2_000
    expect(store.redeem(inv2.token, 'late')).toEqual({ error: 'this invite has expired' })

    const inv3 = store.createInvite(presetGrant('viewer'))
    store.revokeInvite(inv3.id)
    expect(store.redeem(inv3.token, 'x')).toEqual({ error: 'invalid invite' })
    expect(store.redeem('not-a-token', 'x')).toEqual({ error: 'invalid invite' })
  })

  it('revoking a guest or editing their grant takes effect immediately, even from another process', () => {
    const a = new AccessStore(join(dir, 'c'))
    const b = new AccessStore(join(dir, 'c')) // a second "process" on the same file
    const inv = a.createInvite(presetGrant('collaborator'))
    const res = b.redeem(inv.token, 'Sam')
    if ('error' in res) throw new Error(res.error)
    expect(a.authenticate(res.accessToken)).not.toBeNull()
    a.updateGrant(res.guest.id, { modelPolicy: 'any' })
    expect(b.authenticate(res.accessToken)!.grant.modelPolicy).toBe('any')
    expect(b.authenticate(res.accessToken)!.grant.preset).toBe('custom')
    a.revokeGuest(res.guest.id)
    expect(b.authenticate(res.accessToken)).toBeNull()
    expect(a.listGuests()[0]).not.toHaveProperty('tokenHash')
  })

  it('guest names are sanitised', () => {
    const store = new AccessStore(join(dir, 'd'))
    const res = store.redeem(store.createInvite(presetGrant('viewer')).token, '  <b>Evil\u0007Name</b>  ')
    if ('error' in res) throw new Error(res.error)
    expect(res.guest.name).toBe('bEvilName/b')
  })
})
