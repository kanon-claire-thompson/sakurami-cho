/**
 * 細い形を遠くで太らせる仕組み（world/outdoor/thin.ts）の見張り: 名前のある建物の形（named/kitBuilder.ts の box）が、細い角柱の頂点にだけ
 * aThin（細い向きの中心の線からの差と断面の半分の幅）を書くか
 */
import { describe, expect, test } from 'bun:test'
import { KitBuilder } from '../world/outdoor/named/kitBuilder'

describe('KitBuilder の aThin', () => {
  test('細い角柱（格子の桟）は、細い 2 つの向きの差と断面の半分の幅', () => {
    const b = new KitBuilder()
    b.box([1, 2, 3], [0.035, 1.2, 0.04], '#ffffff', 0)
    const g = b.build()
    const a = g.getAttribute('aThin')
    expect(a.count).toBe(24)
    for (let i = 0; i < a.count; i++) {
      const p = [g.getAttribute('position').getX(i) - 1, g.getAttribute('position').getY(i) - 2, g.getAttribute('position').getZ(i) - 3]
      // 細い向き（x・z）は頂点の中心からの差、長い向き（y）は 0
      expect(a.getX(i)).toBeCloseTo(p[0], 3)
      expect(a.getY(i)).toBeCloseTo(0, 5)
      expect(a.getZ(i)).toBeCloseTo(p[2], 3)
      expect(a.getW(i)).toBeCloseTo(0.0175, 3)
    }
  })
  test('太い箱・細いが短い箱・板は 0', () => {
    const b = new KitBuilder()
    b.box([0, 0, 0], [0.5, 1, 0.5], '#ffffff', 0)
    b.box([0, 0, 0], [0.05, 0.08, 0.06], '#ffffff', 0)
    // 板（細い向きが 1 つ）
    b.box([0, 0, 0], [0.8, 0.5, 0.02], '#ffffff', 0)
    const a = b.build().getAttribute('aThin')
    for (let i = 0; i < a.count; i++) expect([a.getX(i), a.getY(i), a.getZ(i), a.getW(i)]).toEqual([0, 0, 0, 0])
  })
  test('merge しても頂点と同じ数', () => {
    const a = new KitBuilder()
    a.box([0, 0, 0], [0.03, 2, 0.03], '#ffffff', 0)
    const b = new KitBuilder()
    b.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], '#ffffff', 0)
    b.merge(a)
    expect(b.thin.length).toBe(b.vertexCount * 4)
  })
})
