import { describe, expect, it } from 'vitest'
import { DeviceRegistry, type LanDevice, type TrackedDevice } from './registry'

const device = (id: string): LanDevice => ({
  id,
  name: `device-${id}`,
  kind: 'phone',
  port: 8443,
  ver: '1',
  serviceName: id,
  domain: 'local.',
})

const seen = (d: TrackedDevice) => ({ firstSeen: d.firstSeen, lastSeen: d.lastSeen })

describe('DeviceRegistry', () => {
  it('adds a device with firstSeen = lastSeen = now', () => {
    const r = new DeviceRegistry()
    r.add(device('a'), 100)
    expect(seen(r.get('a')!)).toEqual({ firstSeen: 100, lastSeen: 100 })
  })

  it('re-add updates lastSeen but keeps firstSeen and refreshes payload', () => {
    const r = new DeviceRegistry()
    r.add(device('a'), 100)
    r.add({ ...device('a'), name: 'new-name' }, 200)
    const d = r.get('a')!
    expect(seen(d)).toEqual({ firstSeen: 100, lastSeen: 200 })
    expect(d.name).toBe('new-name')
  })

  it('touch updates lastSeen only', () => {
    const r = new DeviceRegistry()
    r.add(device('a'), 100)
    expect(r.touch('a', 300)).toBe(true)
    expect(seen(r.get('a')!)).toEqual({ firstSeen: 100, lastSeen: 300 })
  })

  it('touch on unknown id returns false', () => {
    const r = new DeviceRegistry()
    expect(r.touch('nope', 1)).toBe(false)
  })

  it('remove deletes and returns true; second remove is false', () => {
    const r = new DeviceRegistry()
    r.add(device('a'), 0)
    expect(r.remove('a')).toBe(true)
    expect(r.get('a')).toBeUndefined()
    expect(r.remove('a')).toBe(false)
  })

  it('pruneStale removes only entries not seen within ttlMs', () => {
    const r = new DeviceRegistry()
    r.add(device('fresh'), 1500)
    r.add(device('stale'), 500)
    r.add(device('edge'), 1000) // lastSeen == cutoff → 视为过期移除
    const removed = r.pruneStale(1000, 2000)
    expect(removed.sort()).toEqual(['edge', 'stale'])
    expect(r.get('stale')).toBeUndefined()
    expect(r.get('edge')).toBeUndefined()
    expect(r.get('fresh')).toBeDefined()
  })

  it('pruneStale with empty registry returns []', () => {
    const r = new DeviceRegistry()
    expect(r.pruneStale(1000, 99999)).toEqual([])
  })

  it('list returns all entries in insertion order', () => {
    const r = new DeviceRegistry()
    r.add(device('b'), 0)
    r.add(device('a'), 1)
    expect(r.list().map((d) => d.id)).toEqual(['b', 'a'])
  })
})
