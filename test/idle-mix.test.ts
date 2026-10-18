import { describe, expect, test } from 'bun:test'
import { IdleMix } from '../character/avatar/idleMix'

describe('待機の切り替え（character/avatar/idleMix.ts）', () => {
  const cfg = { fade: 1.5, minSlot: 12, seed: 7 }

  test('初めは 1 本目だけ。強さの合計はいつも 1 で、同じ時刻なら同じ答え（時刻を戻しても）', () => {
    const mix = new IdleMix([9, 13, 23, 14], cfg)
    expect(mix.at(0)).toEqual([{ index: 0, weight: 1, time: 0 }])
    const seen = new Set<number>()
    const first: string[] = []
    for (let i = 0; i * 0.37 < 300; i++) {
      const e = mix.at(i * 0.37)
      expect(e.length === 1 || e.length === 2).toBe(true)
      expect(Math.abs(e.reduce((a, x) => a + x.weight, 0) - 1)).toBeLessThan(1e-9)
      for (const x of e) seen.add(x.index)
      first.push(JSON.stringify(e))
    }
    expect(seen.size).toBe(4)
    // 別の入れ物で、逆の順に聞いても同じ
    const again = new IdleMix([9, 13, 23, 14], cfg)
    const times = [...Array(first.length).keys()].reverse()
    for (const i of times) expect(JSON.stringify(again.at(i * 0.37))).toBe(first[i])
  })

  test('枠は minSlot 秒以上（短い待機は繰り返す）。続く枠は前と違う待機で、入れ替えはなめらか', () => {
    const mix = new IdleMix([9, 13], cfg)
    // 1 本目（9 秒）は 2 回繰り返して 18 秒。次は 16.5 秒から入れ替え始める
    expect(mix.at(16)).toEqual([{ index: 0, weight: 1, time: 16 }])
    const mid = mix.at(17.25)
    expect(mid.map((e) => e.index)).toEqual([0, 1])
    expect(mid[1].weight).toBeCloseTo(0.5, 6)
    expect(mid[1].time).toBeCloseTo(0.75, 6)
    expect(mix.at(18.1)).toEqual([{ index: 1, weight: 1, time: expect.closeTo(1.6, 6) as unknown as number }])
    let prev = mix.at(16.4)[0].weight
    for (let t = 16.5; t < 18; t += 0.05) {
      const w = mix.at(t).find((e) => e.index === 0)?.weight ?? 0
      expect(prev - w).toBeLessThan(0.07)
      prev = w
    }
  })

  test('待機が 1 本なら、いつもその 1 本', () => {
    const mix = new IdleMix([8.9], cfg)
    for (const t of [0, 5, 50, 500]) expect(mix.at(t).map((e) => [e.index, e.weight])).toEqual([[0, 1]])
  })
})
