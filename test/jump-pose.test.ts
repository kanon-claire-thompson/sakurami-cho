/**
 * 跳ぶ .vrma の混ぜ方（character/avatar/jumpPose.ts の jumpClipWeights）と、見た目の設定の jump（visualConfig.ts の VISUAL_DEFAULTS.jump）:
 * - 既定の値なら、設定を足す前の式（下の before）と同じ時刻と強さ
 * - 設定で変わる: しゃがみの強さ・踏み切りの再生の速さ・ループ → 着くの入れ替えの長さ・着くの再生の始め・着く深さ
 */
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import type { CharacterJump, JumpPhase } from '../character/avatar/jump'
import { JUMP_CROUCH } from '../character/avatar/jump'
import { createJumpClipWeights, createJumpLook, jumpClipWeights, updateJumpLook, type JumpClipWeights } from '../character/avatar/jumpPose'
import { VISUAL_DEFAULTS, type VisualConfig } from '../character/avatar/visualConfig'

const smooth = (x: number) => THREE.MathUtils.smoothstep(x, 0, 1)

/** 設定を足す前の jumpClipWeights（値を書き込んであった物） */
function before(landT: number, airT: number, impact: number, j: CharacterJump) {
  const arc = j.v0 > 1e-3 ? THREE.MathUtils.clamp((j.v0 - j.vy) / (2 * j.v0), 0, 1) : 1
  const o = { start: { time: 0, weight: 0 }, loop: { time: airT, weight: 0 }, land: { time: 0, weight: 0 } }
  if (j.phase === 'crouch') o.start.weight = 0.5 * smooth(j.t / JUMP_CROUCH)
  else if (j.phase === 'air') {
    const w = THREE.MathUtils.lerp(0.5, 0.75, smooth(j.t / 0.1))
    const f = THREE.MathUtils.smoothstep(arc, 0.3, 0.75)
    o.start.time = j.t
    o.start.weight = w * (1 - f)
    o.loop.weight = w * f
  } else if (Number.isFinite(landT)) {
    const L = landT
    const depth = THREE.MathUtils.clamp(0.3 + 0.08 * impact, 0.3, 0.6)
    const w = THREE.MathUtils.lerp(0.75, depth, smooth(L / 0.12)) * (1 - smooth((L - 0.28) / (0.7 - 0.3)))
    const x = smooth(L / 0.06)
    o.loop.weight = w * (1 - x)
    o.land.time = L * 1.15
    o.land.weight = w * x
  }
  return o
}

/** 止まって跳ぶ 1 回（しゃがむ 0.14 秒 → 0.45m 上がって落ちる → 着いてしゃがむ 0.3 秒）を 1/60 秒ごとに。着いた速さ impact は落ちる速さ */
function frames(): CharacterJump[] {
  const g = 9.8
  const v0 = Math.sqrt(2 * g * 0.45)
  const air = (2 * v0) / g
  const dt = 1 / 60
  const out: CharacterJump[] = []
  const at = (phase: JumpPhase, t: number, vy = 0, y = 0): CharacterJump => ({ phase, t, height: y, y, vy, v0: phase === 'none' ? 0 : v0, vh: 0, impact: phase === 'land' ? v0 : 0, serial: 1, placeSerial: 0 })
  for (let t = 0; t < JUMP_CROUCH; t += dt) out.push(at('crouch', t))
  for (let t = 0; t < air; t += dt) out.push(at('air', t, v0 - g * t, v0 * t - 0.5 * g * t * t))
  for (let t = 0; t < 0.3; t += dt) out.push(at('land', t))
  for (let t = 0; t < 0.6; t += dt) out.push(at('none', t))
  return out
}

function run(cfg?: VisualConfig['jump']) {
  const st = createJumpLook()
  const out: { st: { landT: number; airT: number; impact: number }; j: CharacterJump; w: JumpClipWeights }[] = []
  for (const j of frames()) {
    updateJumpLook(st, j, 1 / 60)
    const w = jumpClipWeights(st, j, createJumpClipWeights(), cfg)
    out.push({ st: { landT: st.landT, airT: st.airT, impact: st.impact }, j, w })
  }
  return out
}

/** 置き換えた値の例（しゃがみを強く・踏み切りを速く・着くを途中から・入れ替えを長く・深く） */
const CUSTOM = { ...VISUAL_DEFAULTS.jump, crouchWeight: 0.7, startRate: 2, landSwap: 0.15, landStart: 0.12, landDepth: [0.45, 0.8] as [number, number] }

describe('跳ぶ .vrma の混ぜ方（character/avatar/jumpPose.ts）', () => {
  test('既定の値（設定を渡さない・VISUAL_DEFAULTS.jump）なら、設定を足す前と同じ時刻と強さ', () => {
    const a = run()
    const b = run(VISUAL_DEFAULTS.jump)
    let landed = 0
    a.forEach(({ st, j, w }, i) => {
      const o = before(st.landT, st.airT, st.impact, j)
      for (const k of ['start', 'loop', 'land'] as const) {
        expect(w[k].weight).toBeCloseTo(o[k].weight, 9)
        expect(w[k].time).toBeCloseTo(o[k].time, 9)
        expect(b[i].w[k].weight).toBe(w[k].weight)
        expect(b[i].w[k].time).toBe(w[k].time)
      }
      expect(w.total).toBeCloseTo(o.start.weight + o.loop.weight + o.land.weight, 9)
      if (w.land.weight > 0) landed++
    })
    expect(landed).toBeGreaterThan(5)
  })

  test('設定で変わる: しゃがみの強さ・踏み切りの再生の速さ・入れ替えの長さ・着くの再生の始め・着く深さ', () => {
    const a = run()
    const h = run(CUSTOM)
    // 踏み切る前: しゃがみの終わりで 0.5 → 0.7 まで
    const crouch = (r: typeof a) => Math.max(...r.filter((x) => x.j.phase === 'crouch').map((x) => x.w.start.weight))
    expect(crouch(a)).toBeCloseTo(0.5 * smooth((Math.ceil(JUMP_CROUCH * 60) - 1) / 60 / JUMP_CROUCH), 6)
    expect(crouch(h) / crouch(a)).toBeCloseTo(0.7 / 0.5, 6)
    // 跳んでいる間: 踏み切りは跳んでからの秒の 2 倍の時刻
    const air = h.find((x) => x.j.phase === 'air' && x.j.t > 0.1)!
    expect(air.w.start.time).toBeCloseTo(air.j.t * 2, 9)
    // 着いたら: 着くは 0.12 秒から再生し、0.15 秒かけてループから入れ替える
    const land = h.filter((x) => Number.isFinite(x.st.landT) && x.j.phase !== 'air')
    const first = land[0]
    expect(first.w.land.time).toBeCloseTo(0.12 + first.st.landT * 1.15, 9)
    const mid = land.find((x) => x.st.landT >= 0.075 && x.st.landT < 0.1)!
    expect(mid.w.loop.weight).toBeGreaterThan(0.1)
    expect(a.find((x) => x.st.landT === mid.st.landT)!.w.loop.weight).toBe(0)
    // しゃがむ深さ: 0.45 + 0.08 × 着いた速さ（2.97m/s）= 0.69（既定は 0.3 + 0.24 = 0.54）
    const deep = (r: typeof a) => r.find((x) => x.st.landT >= 0.2 && x.st.landT < 0.22)!
    const imp = deep(h).st.impact
    expect(deep(h).w.total).toBeCloseTo(THREE.MathUtils.clamp(0.45 + 0.08 * imp, 0.45, 0.8), 2)
    expect(deep(a).w.total).toBeCloseTo(THREE.MathUtils.clamp(0.3 + 0.08 * imp, 0.3, 0.6), 2)
    // 強さの合計は 1 まで
    for (const x of h) expect(x.w.total).toBeLessThanOrEqual(1 + 1e-9)
  })
})
