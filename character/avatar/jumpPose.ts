import * as THREE from 'three'
import type { BodyMetrics, BodyPose } from './body'
import { JUMP_CROUCH, type CharacterJump, type JumpPhase } from './jump'
import { VISUAL_DEFAULTS, type JumpLookConfig } from './visualConfig'

/**
 * 跳ぶ姿勢（見た目の側。character/avatar/characterVisual.ts が毎コマ使う。跳ぶ動きそのものは character/avatar/jump.ts）。
 * 段階（motion.jump）から、跳ぶ .vrma の 3 本（踏み切り start・跳んでいる間 loop・着く land。visualConfig.ts の animations.jump）を
 * どの時刻で・どの強さで混ぜるかと、.vrma が無いときのコードの姿勢（しゃがむ → 伸びる → 着いてしゃがむ）を決める。
 *
 * 強さ・再生の速さ・着くの深さなどの値は素材によるので、見た目の設定の jump（visualConfig.ts の VISUAL_DEFAULTS.jump。キャラクターごとに置き換えられる）から読む。
 *
 * - 踏み切る前（crouch）: 踏み切りの初め（しゃがんだ姿勢）へ、crouchWeight の強さまで寄せる（素材のしゃがみは深いので、半分ほどにする）
 * - 跳んでいる間（air）: 踏み切りを startRate 倍の速さで再生しながら 0.1 秒で強さ airWeight へ（伸びる。素材は膝を深く抱えるので、待機の脚と混ぜて浅くする）。
 *   上りの終わりから下りへ、跳んでいる間のループへ移す
 * - 着いたら（land）: 着くを landStart 秒から再生し、landSwap 秒でループから入れ替え、強さを落としてしゃがむ深さを浅くし（着いた速さで深さを変える。landDepth）、
 *   LAND_LOOK 秒で待機・歩きへ戻す。着いてからの戻りは、跳ぶ段階（land は JUMP_LAND 秒）より長く見せる（その間に歩き出しても、歩きと混ぜて戻す）
 * - コードの姿勢: しゃがむ深さ crouch（太ももを前へ・膝を曲げ・腰を下げ（足が床から動かない量）・前へ傾け・腕を後ろへ）と、
 *   跳んでいる間の脚の曲げ tuck（膝を軽く曲げ、腕を前へ上げる）
 */

/** 跳んでからの、伸びる長さ（秒） */
const EXTEND = 0.1
/** 着いてからの見た目の長さ（秒）と、着くの再生の速さ */
export const LAND_LOOK = 0.7
const LAND_RATE = 1.15

/** 見た目の側の様子（見た目が 1 つ持つ） */
export interface JumpLook {
  /** 最後に見た跳び（motion.jump.serial）と段階 */
  serial: number
  phase: JumpPhase
  /** 着いてからの秒（着いていなければ Infinity）と、着いた速さ（m/s） */
  landT: number
  impact: number
  /** 跳んでいた秒（ループの時刻を、着いてからもそのまま使う） */
  airT: number
}

export function createJumpLook(): JumpLook {
  return { serial: -1, phase: 'none', landT: Infinity, impact: 0, airT: 0 }
}

/** 1 コマ進める（段階が air → land に変わったら着いてからの秒を数え始め、LAND_LOOK 秒まで数える） */
export function updateJumpLook(st: JumpLook, j: CharacterJump, dt: number) {
  if (j.serial !== st.serial) {
    st.serial = j.serial
    st.landT = Infinity
  }
  if (j.phase === 'land' && st.phase === 'air') {
    st.landT = j.t
    st.impact = j.impact
  } else if (Number.isFinite(st.landT)) st.landT += dt
  if (j.phase === 'crouch' || j.phase === 'air') st.landT = Infinity
  if (j.phase === 'air') st.airT = j.t
  if (st.landT > LAND_LOOK) st.landT = Infinity
  st.phase = j.phase
}

const smooth = (x: number) => THREE.MathUtils.smoothstep(x, 0, 1)

/** 跳ぶ .vrma の 3 本の、再生する時刻（秒）と強さ（3 本の強さの合計は 1 まで。残りが待機・歩き） */
export interface JumpClipWeights {
  start: { time: number; weight: number }
  loop: { time: number; weight: number }
  land: { time: number; weight: number }
  /** 3 本の強さの合計 */
  total: number
}

export function createJumpClipWeights(): JumpClipWeights {
  return { start: { time: 0, weight: 0 }, loop: { time: 0, weight: 0 }, land: { time: 0, weight: 0 }, total: 0 }
}

/** 上りから下りへ移る割合（踏み切った速さ v0 から今の速さ vy まで。0 = 踏み切った所・0.5 = いちばん高い所・1 = 同じ高さへ戻った所） */
function arc(j: CharacterJump) {
  return j.v0 > 1e-3 ? THREE.MathUtils.clamp((j.v0 - j.vy) / (2 * j.v0), 0, 1) : 1
}

/** 跳ぶ .vrma の時刻と強さ（out に書いて返す。cfg = 見た目の設定の jump） */
export function jumpClipWeights(st: JumpLook, j: CharacterJump, out: JumpClipWeights, cfg: JumpLookConfig = VISUAL_DEFAULTS.jump): JumpClipWeights {
  out.start.weight = out.loop.weight = out.land.weight = 0
  out.start.time = 0
  out.loop.time = st.airT
  out.land.time = 0
  if (j.phase === 'crouch') {
    out.start.weight = cfg.crouchWeight * smooth(j.t / JUMP_CROUCH)
  } else if (j.phase === 'air') {
    const w = THREE.MathUtils.lerp(cfg.crouchWeight, cfg.airWeight, smooth(j.t / EXTEND))
    const f = THREE.MathUtils.smoothstep(arc(j), 0.3, 0.75)
    out.start.time = j.t * cfg.startRate
    out.start.weight = w * (1 - f)
    out.loop.weight = w * f
  } else if (Number.isFinite(st.landT)) {
    const L = st.landT
    // しゃがむ深さ（着くの素材は深くしゃがむので、強さで浅くする。速く着いたほど深く）
    const [lo, hi] = cfg.landDepth
    const depth = THREE.MathUtils.clamp(lo + cfg.landDepthPerImpact * st.impact, lo, hi)
    const w = THREE.MathUtils.lerp(cfg.airWeight, depth, smooth(L / 0.12)) * (1 - smooth((L - 0.28) / (LAND_LOOK - 0.3)))
    const x = cfg.landSwap > 0 ? smooth(L / cfg.landSwap) : 1
    out.loop.weight = w * (1 - x)
    out.land.time = cfg.landStart + L * LAND_RATE
    out.land.weight = w * x
  }
  out.total = out.start.weight + out.loop.weight + out.land.weight
  return out
}

/** コードの姿勢の強さ: crouch = しゃがむ深さ（0〜1）、tuck = 跳んでいる間の脚の曲げ（0〜1） */
export function jumpCodeAmounts(st: JumpLook, j: CharacterJump): { crouch: number; tuck: number } {
  if (j.phase === 'crouch') return { crouch: 0.8 * smooth(j.t / JUMP_CROUCH), tuck: 0 }
  if (j.phase === 'air') {
    const p = arc(j)
    return { crouch: 0.8 * (1 - smooth(j.t / EXTEND)), tuck: smooth(j.t / 0.12) * (1 - 0.6 * THREE.MathUtils.smoothstep(p, 0.6, 1)) }
  }
  if (Number.isFinite(st.landT)) {
    const L = st.landT
    const depth = THREE.MathUtils.clamp(0.4 + 0.1 * st.impact, 0.4, 0.8)
    return { crouch: depth * smooth(L / 0.08) * (1 - smooth((L - 0.15) / (LAND_LOOK - 0.2))), tuck: 0.4 * (1 - smooth(L / 0.08)) }
  }
  return { crouch: 0, tuck: 0 }
}

/**
 * コードの姿勢を pose に重ねる（.vrma が無いとき）。しゃがむ: 太ももを前へ θ・膝を 2θ 曲げ（足が床の上で前後に動かない）、腰を
 * 脚の長さ × (1 − cos θ) 下げ、前へ傾ける。腕は後ろへ引く。跳んでいる間: 膝を軽く曲げ、腕を前へ上げる。強さが 0 なら何もしない
 */
export function applyJumpPose(pose: BodyPose, crouch: number, tuck: number, body: BodyMetrics) {
  if (crouch < 1e-4 && tuck < 1e-4) return
  const theta = 0.62 * crouch
  const leg = Math.max(0.5, body.hipHeight - 0.08)
  pose.thighL += theta + tuck * 0.5
  pose.thighR += theta + tuck * 0.35
  pose.kneeL += 2 * theta + tuck * 0.9
  pose.kneeR += 2 * theta + tuck * 0.7
  pose.bob -= leg * (1 - Math.cos(theta))
  pose.lean += 0.32 * crouch + 0.06 * tuck
  for (const a of [pose.armL, pose.armR]) {
    a.raise += -0.45 * crouch + 0.55 * tuck
    a.out += 0.1 * crouch + 0.25 * tuck
    a.elbow += 0.25 * crouch + 0.3 * tuck
  }
  pose.headPitch -= 0.15 * crouch
}
