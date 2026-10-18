import * as THREE from 'three'
import type { PlaceAction } from '../../core/places'
import { ACTION_HANDS, addCurl, blendHand, createHand, HANDS, lerpHand, setHand, type HandShape } from './hands'

/**
 * 体の姿勢（歩き・立ち寄り先の動作・反応を、腕・脚・上半身の角度で書く）。
 *
 * 腕は「体の横に下ろした状態」からの回転で書く（1 本ずつ）:
 *   raise … 前へ上げる角度（0 = 下ろす、π/2 = 前に水平、マイナスで後ろへ）
 *   out   … 横へ上げる角度（0 = 体の横、π/2 = 横に水平）
 *   twist … 腕のねじり（肘を曲げる向きが変わる。手を後ろで組むときなど）
 *   elbow … 肘の曲げ（前へ）、elbowSide … 肘から先を横へ倒す（手を振るとき）
 * 体は +Z を向き、+X が本人の左。VRM は T ポーズの向きに直して正規化ボーンに入れる（character/avatar/characterVisual.ts）。
 *
 * 手の形（handL / handR。指・前腕のひねり・手首。character/avatar/hands.ts）も、腕と同じ強さで混ぜる。
 * VRM の指の骨に入れる（character/avatar/vrmHands.ts）。
 */

export interface ArmPose {
  raise: number
  out: number
  twist: number
  elbow: number
  elbowSide: number
}

export interface BodyPose {
  armL: ArmPose
  armR: ArmPose
  /** 太ももの振り（前へ +）と膝の曲げ */
  thighL: number
  thighR: number
  kneeL: number
  kneeR: number
  /** 上半身の前傾（+ で前へ）・左右の傾き・ひねり */
  lean: number
  tilt: number
  twist: number
  /** 頭のうつむき（+ で下を見る）・左右（+ で本人の左）・かしげ */
  headPitch: number
  headYaw: number
  headRoll: number
  /** 体全体の上下（跳ねる・歩きの上下動、m） */
  bob: number
  /** 体全体を前へ（体の向きに、m。座るときに座面の上へ腰を動かす） */
  shift: number
  /** 行動の姿勢のとき、首をカメラへ向ける割合（0 = 行動の視線のまま） */
  lookCamera: number
  /** 手の形（本人の左手・右手。VRM だけが使う） */
  handL: HandShape
  handR: HandShape
}

const arm = (raise: number, out: number, elbow: number, twist = 0, elbowSide = 0): ArmPose => ({ raise, out, twist, elbow, elbowSide })

export function createPose(): BodyPose {
  return {
    armL: arm(0.04, 0.36, 0.22),
    armR: arm(0.04, 0.36, 0.22),
    thighL: 0,
    thighR: 0,
    kneeL: 0,
    kneeR: 0,
    lean: 0,
    tilt: 0,
    twist: 0,
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    bob: 0,
    shift: 0,
    lookCamera: 1,
    handL: createHand(),
    handR: createHand(),
  }
}

function setArm(a: ArmPose, raise: number, out: number, elbow: number, twist = 0, elbowSide = 0) {
  a.raise = raise
  a.out = out
  a.elbow = elbow
  a.twist = twist
  a.elbowSide = elbowSide
}

/** 待機（立ち位置で配信しているとき・歩いていないとき）の姿勢 */
export function restPose(out: BodyPose, t: number) {
  const breath = Math.sin((t / 4.2) * Math.PI * 2)
  setArm(out.armL, 0.04, 0.36 + breath * 0.01 + Math.sin(t * 0.7) * 0.015, 0.22)
  setArm(out.armR, 0.04, 0.36 + breath * 0.01 - Math.sin(t * 0.63) * 0.015, 0.22)
  out.thighL = out.thighR = out.kneeL = out.kneeR = 0
  out.lean = 0.01
  out.tilt = Math.sin((t / 7.5) * Math.PI * 2) * 0.012
  out.twist = 0
  out.headPitch = -Math.sin(t * 0.5) * 0.02
  out.headYaw = 0
  out.headRoll = Math.sin(t * 0.37 + 0.8) * 0.02
  out.bob = breath * 0.003
  out.shift = 0
  out.lookCamera = 1
  // 力の抜けた手（指がごくゆっくり少しだけ動く）
  setHand(out.handL, HANDS.relaxed)
  setHand(out.handR, HANDS.relaxed)
  const driftL = Math.sin(t * 0.41 + 0.3) * 0.03
  const driftR = Math.sin(t * 0.37 + 2.1) * 0.03
  addCurl(out.handL, driftL, driftL * 0.8, driftL * 0.6, driftL * 0.5)
  addCurl(out.handR, driftR, driftR * 0.8, driftR * 0.6, driftR * 0.5)
  return out
}

/**
 * 体の寸法（m。座る姿勢の腰の下げ方・机に手を置く高さに使う）。Character ごとに持ち（ch.body）、VRM を読んだら見た目（character/avatar/characterVisual.ts）が測って入れる（setBodyMetrics）。
 * 既定は前の VRM の値。VRM を替えると脚の長さが変わり、決まった値のままでは座面から浮いた（2026-10-05 の VRM は股関節 1.06m。§7 の 145）
 */
export interface BodyMetrics {
  /** 立っているときの股関節の高さ */
  hipHeight: number
  /** 立っているときの、肩（上腕の付け根）の股関節からの高さ（座る姿勢の腕の高さ） */
  shoulderAboveHip: number
  /** 上腕・前腕の長さ */
  upperArm: number
  foreArm: number
  /** 体の真ん中から肩（上腕の付け根）まで（左右の上腕の付け根の間の半分。手を伸ばす先から腕の角度を解くとき） */
  shoulderHalf: number
}

/** 体の寸法の既定（VRM を測る前） */
export function createBodyMetrics(): BodyMetrics {
  return { hipHeight: 0.86, shoulderAboveHip: 0.35, upperArm: 0.25, foreArm: 0.22, shoulderHalf: 0.15 }
}

export function setBodyMetrics(body: BodyMetrics, m: Partial<BodyMetrics>) {
  Object.assign(body, m)
}

/** 座面から股関節まで（股関節の高さに比べた割合。座ると太ももの裏とお尻が股関節の下に来る） */
const SEAT_TO_HIP_RATIO = 0.125
/**
 * 座る姿勢（前傾 0.13）で、肩（上腕の付け根）が股関節より上に来る高さは、VRM を読んだときに測った体の寸法の shoulderAboveHip（立った姿勢の差）の
 * cos(前傾) 倍。机・カウンターの高さ（SeatSpec.desk）が分かれば、肘を天板の少し上に置き、前腕を天板に沿わせる（armOnDesk）。
 * 前は股関節の高さの 0.258 倍の決まった割合だった（靴底を測り違えていた VRM の値。§7 の 208）
 */
const sitShoulderAboveHip = (lean: number, body: BodyMetrics) => body.shoulderAboveHip * Math.cos(lean)
/** 天板から肘・手首の骨まで（腕の太さの半分ほど） */
const ELBOW_ABOVE_DESK = 0.04
const WRIST_ABOVE_DESK = 0.045

/** 座る椅子（立ち寄り先の seat。省けばふつうの椅子） */
export interface SeatSpec {
  height: number
  shift: number
  /** 手の置き場所: desk = 前の机・カウンター（既定）、lap = ひざの上（観覧車の長いす・ベンチ）、grip = 前のハンドルを握る（ホバーの一人乗り。desk = 握りの高さ） */
  hands?: 'desk' | 'lap' | 'grip'
  /** 前の机・カウンターの天板の高さ（床から m）。省けば腕の高さはそのまま */
  desk?: number
  /** hands = grip のとき、座面の真ん中（腰）から握りまでの前への距離（m） */
  reach?: number
  /** hands = grip のとき、体の真ん中から左右の握りの真ん中まで（m。省けば肩の幅の半分） */
  gripX?: number
}

/**
 * 腕を解く先の、握り（ハンドルの棒の真ん中）からのずれ（上・後ろ・外、m）。腕の式（reachArm）は肩の位置と手首の向きを単純にしているので、
 * VRM（2026-10-05）で撮って、指の付け根が棒の真ん中に来る所に合わせた（棒の位置そのままだと、手が 3〜4cm 手前・内側に来た）
 */
const GRIP_PALM = { up: -0.005, back: -0.025, out: 0.035 }
/** 前傾の回る所（股関節から上、m。背骨の spine・chest の間あたり） */
const LEAN_PIVOT = 0.15
/** 握りに届かないときに前へ倒す前傾の上限（rad） */
const GRIP_LEAN_MAX = 0.32
const _gripAt: BodyPoint = { right: 0, up: 0, fwd: 0 }

/**
 * 座ってハンドルを握る腕（hands = grip）: 握りの位置（座面の真ん中から前へ reach・床から desk・左右 gripX）を、前傾 lean の上半身の中の点に直して、
 * 腕を手のひらの真ん中がそこへ届く角度にする（reachArm）。届かなければ前傾を GRIP_LEAN_MAX まで深くして届かせる。使った前傾を返す
 */
function gripArms(out: BodyPose, seat: SeatSpec, h: number, seatToHip: number, lean: number, body: BodyMetrics) {
  const gx = (seat.gripX ?? body.shoulderHalf) + GRIP_PALM.out
  // 股関節の上の前傾の回る所から見た握り（座った体の中。前 fwd・上 up）
  const fwd0 = (seat.reach ?? 0.5) - GRIP_PALM.back
  const up0 = (seat.desk ?? h + 0.3) + GRIP_PALM.up - (h + seatToHip) - LEAN_PIVOT
  const shoulderUp = body.shoulderAboveHip - LEAN_PIVOT
  let l = lean
  for (; l < GRIP_LEAN_MAX; l += 0.01) {
    // 前傾 l の上半身の中へ（上半身ごと l だけ後ろへ戻した向き）
    const f = fwd0 * Math.cos(l) - up0 * Math.sin(l)
    const u = up0 * Math.cos(l) + fwd0 * Math.sin(l)
    if (Math.hypot(f, u - shoulderUp, gx - body.shoulderHalf) <= armReach(body) - 0.02) break
  }
  const f = fwd0 * Math.cos(l) - up0 * Math.sin(l)
  const u = up0 * Math.cos(l) + fwd0 * Math.sin(l)
  _gripAt.fwd = f
  _gripAt.up = body.hipHeight + LEAN_PIVOT + u
  _gripAt.right = -gx
  reachArm(out.armL, 1, _gripAt, body)
  _gripAt.right = gx
  reachArm(out.armR, -1, _gripAt, body)
  return l
}

/**
 * 机・カウンターに前腕を置く: 肘を天板の少し上へ（上腕を前へ上げる角度を、肩から天板までの高さ drop から決める）、前腕は天板に沿ってほぼ水平に。
 * 決まった角度のままだと、天板が高いカウンターでは前腕が天板の下を通って手だけが天板の上に出た（星図珈琲の C4。§7 の 145）
 */
function armOnDesk(a: ArmPose, drop: number, body: BodyMetrics) {
  const U = body.upperArm
  const F = body.foreArm
  const elbowDrop = drop - ELBOW_ABOVE_DESK
  const r = Math.acos(THREE.MathUtils.clamp(elbowDrop / U, 0.05, 1))
  const forearm = Math.acos(THREE.MathUtils.clamp((drop - WRIST_ABOVE_DESK - elbowDrop) / F, -1, 1))
  a.raise = r
  a.elbow = Math.max(0.2, forearm - r)
}

/**
 * 窓の外を眺める（gaze）ときの左腕: 上腕はほぼ下ろして肘を体の横に置き、肘を深く曲げて、手を胸のペンダントに添える。
 * 角度は VRM（2026-10-05。肩幅 0.30m・上腕 0.28m・前腕 0.23m）の肩からペンダントまでを、腕の向きの式（applyBodyPose）で解いた物。
 * 手は胸から約 2.5cm 前に置き（前は手のひらがペンダントを覆い隠した）、指先でペンダントに添える（手の形 HANDS.pendant）
 */
const GAZE_ARM = { raise: 0.585, out: 0.175, twist: 0.7, elbow: 2.17 } as const

/** 体の中の点（足元から。本人の右 right・上 up・前 fwd、m） */
export interface BodyPoint {
  right: number
  up: number
  fwd: number
}

/**
 * なでる（pet）ときの右の手のひらの既定の位置（足元から）。なでる物の頭の上がこのあたりに来るよう、使う側がなでる物を呼ぶ
 * （kanon-lab の KB-001 は、花音がドックでなでている間、ドックから降りてここの下へ来る。src/kb001/follow.ts）。
 * なでる物の位置を渡さない（actionPose の reach が null）ときは、ここへ手を伸ばす。
 * 前はなでる物の位置を見ずに決まった角度で右腕を前へ伸ばしていて、ドックの上（肩より上・0.94m 先）の KB-001 に届かずに腕が宙を指していた
 */
export const PET_REACH: Readonly<BodyPoint> = { right: 0.2, up: 1.12, fwd: 0.44 }

/** なでる物の頭の上が PET_REACH からこれより近ければ、そこへ手を伸ばす（m。遠くなるほど手を前に出して待つ形へ） */
const PET_NEAR = 0.15

/** 手首の骨から手のひらの真ん中まで（m。手を伸ばす先は手のひらの真ん中） */
const PALM = 0.07

/**
 * 腕を、肩から手のひらの真ん中が to（足元から）へ届く角度にする（ねじりは 0。肘は体の横で下を向き、前腕が前へ曲がる）。
 * side = 1 なら本人の左腕、-1 なら右腕。届かなければ伸ばした腕で to の方を指す。
 *
 * 腕の向きの式（character/avatar/characterVisual.ts の applyBodyPose）: 上腕 = Rx(−raise)·Rz(side·out)·(0, −1, 0)、
 * 前腕 = 同じ回転·(0, −cos elbow, sin elbow)。Rz の後の手の位置は (A sinθ, −A cosθ, F sin e)（A = U + F cos e、θ = side·out）なので、
 * 肘は肩から先までの長さ（余弦定理）、out は横の成分、raise は縦の面の中の角度の差で解ける
 */
export function reachArm(a: ArmPose, side: 1 | -1, to: Readonly<BodyPoint>, body: BodyMetrics) {
  const U = body.upperArm
  const F = body.foreArm + PALM
  // 肩から先まで（体の座標: +X = 本人の左・+Y = 上・+Z = 前）
  let tx = -(to.right - -side * body.shoulderHalf)
  let ty = to.up - (body.hipHeight + body.shoulderAboveHip)
  let tz = to.fwd
  const len = Math.max(1e-6, Math.hypot(tx, ty, tz))
  const D = THREE.MathUtils.clamp(len, Math.abs(U - F) + 0.02, U + F - 0.005)
  // 届かない・近すぎる先は、同じ向きの届く長さの所へ
  tx *= D / len
  ty *= D / len
  tz *= D / len
  const e = Math.acos(THREE.MathUtils.clamp((D * D - U * U - F * F) / (2 * U * F), -1, 1))
  const A = U + F * Math.cos(e)
  const theta = Math.asin(THREE.MathUtils.clamp(tx / A, -1, 1))
  const before = Math.atan2(F * Math.sin(e), A * Math.cos(theta))
  const after = Math.atan2(tz, -ty)
  a.raise = after - before
  a.out = side * theta
  a.twist = 0
  a.elbow = e
  a.elbowSide = 0
  return a
}

/** 腕の長さ（肩から手のひらの真ん中まで。reachArm が届く遠さ） */
export const armReach = (body: BodyMetrics) => body.upperArm + body.foreArm + PALM

const _petAt: BodyPoint = { right: 0, up: 0, fwd: 0 }
const _petArm = arm(0, 0, 0)

/**
 * 行動の姿勢が .vrma の待機に重ねる所（.vrma があるとき。character/avatar/characterVisual.ts）。
 * body = 上半身と腰から下（行動の姿勢のとおり）、armL・armR = その腕と手だけ（体・もう片方の腕・脚は待機の .vrma のまま。呼吸・重心の移しを残す）
 */
export type ActionPart = 'body' | 'armL' | 'armR'

export const ACTION_PART: Record<PlaceAction, ActionPart> = {
  present: 'body',
  holo: 'body',
  work: 'body',
  type: 'body',
  look: 'body',
  gaze: 'armL',
  pet: 'armR',
  sit: 'body',
}

/**
 * 立ち寄り先での行動の姿勢（t はシーンの経過秒）。seat = 座る椅子（sit のとき）、body = 体の寸法（Character の body）、
 * reach = 手を伸ばす先（足元から。pet = なでる物の頭の上。Character の actionTarget から見た目が作る。null なら行動の既定の位置）
 */
export function actionPose(
  action: PlaceAction,
  t: number,
  out: BodyPose,
  seat: SeatSpec | null | undefined,
  body: BodyMetrics,
  reach: Readonly<BodyPoint> | null = null,
) {
  restPose(out, t)
  setHand(out.handL, ACTION_HANDS[action].L)
  setHand(out.handR, ACTION_HANDS[action].R)
  switch (action) {
    case 'present':
      break
    case 'holo': {
      // ホログラムを見ながら、両手で拡大・回転させるように動かす
      const s = Math.sin(t * 1.3)
      const c = Math.cos(t * 1.05)
      setArm(out.armL, 0.95 + s * 0.14, 0.32 + c * 0.2, 0.85 + s * 0.12)
      setArm(out.armR, 0.9 - s * 0.12, 0.28 - c * 0.18, 0.95 - c * 0.1)
      out.headPitch = 0.05 + Math.sin(t * 0.6) * 0.05
      out.headYaw = Math.sin(t * 0.45) * 0.18
      out.lean = 0.04
      out.lookCamera = 0.15
      // 指先で触れる・つつく
      out.handR.index += Math.max(0, Math.sin(t * 2.1)) * 0.12
      out.handR.wrist += Math.sin(t * 2.1) * 0.06
      out.handL.spread += c * 0.15
      break
    }
    case 'work': {
      // 作業台で両手を前に出し、細かく手を動かす
      const a = Math.sin(t * 3.1)
      const b = Math.sin(t * 2.3 + 1)
      setArm(out.armL, 0.62 + a * 0.05, 0.12, 0.95 + b * 0.08)
      setArm(out.armR, 0.66 - b * 0.06, 0.08, 0.88 + a * 0.1)
      out.lean = 0.2
      out.headPitch = 0.42 + Math.sin(t * 0.8) * 0.04
      out.headYaw = Math.sin(t * 0.5) * 0.1
      out.lookCamera = 0.05
      // 左手は部品をつまみ直し、右手は工具の先を細かく動かす
      out.handL.thumbCurl += Math.sin(t * 2.3 + 1) * 0.06
      out.handL.index += Math.sin(t * 2.3 + 1) * 0.05
      out.handR.wrist += a * 0.08
      out.handR.index += Math.sin(t * 3.1 + 0.6) * 0.04
      break
    }
    case 'type': {
      // 立ったままキーボードを打つ（左右の手が交互に小さく上下する）
      const tapL = Math.max(0, Math.sin(t * 17)) * 0.05
      const tapR = Math.max(0, Math.sin(t * 15 + 1.3)) * 0.05
      setArm(out.armL, 0.42, 0.14, 1.05 + tapL)
      setArm(out.armR, 0.45, 0.12, 1.02 + tapR)
      out.lean = 0.22
      out.headPitch = 0.08 + Math.sin(t * 0.4) * 0.03
      out.headYaw = Math.sin(t * 0.33) * 0.22
      out.lookCamera = 0.05
      // 指が 1 本ずつキーを押す
      typeFingers(out, t, 1)
      break
    }
    case 'look': {
      // 後ろで手を組んで、展示をゆっくり眺める
      setArm(out.armL, -0.28, 0.12, 1.35, 2.5)
      setArm(out.armR, -0.28, 0.12, 1.35, 2.5)
      out.headYaw = Math.sin(t * 0.3) * 0.38
      out.headPitch = 0.12 + Math.sin(t * 0.52) * 0.05
      out.headRoll = Math.sin(t * 0.3) * 0.06
      out.lean = 0.05
      out.lookCamera = 0
      break
    }
    case 'gaze': {
      // 窓の前に立って外を眺める。左手は胸のペンダントに軽く添え、右腕は下ろしたまま（.vrma があれば、右腕と体は待機の .vrma のまま。ACTION_PART）。
      // 前は左腕を前へ伸ばして窓に手を当てていたが、立ち寄り先からガラスまでの距離は場所ごとに違い（ラボの窓際で約 0.6m）、
      // 腕が届かずに手が宙に浮いて、腕が前へ伸びたまま固まって見えた
      const sway = Math.sin(t * 0.43 + 0.6)
      setArm(out.armL, GAZE_ARM.raise + sway * 0.015, GAZE_ARM.out, GAZE_ARM.elbow + Math.sin(t * 0.31) * 0.025, GAZE_ARM.twist)
      // 指先がごくゆっくりペンダントをなぞる
      const drift = Math.sin(t * 0.37 + 1.4) * 0.05
      addCurl(out.handL, drift, drift * 0.8, drift * 0.6, drift * 0.4)
      out.handL.thumbCurl += Math.sin(t * 0.29) * 0.04
      out.headPitch = -0.08 + Math.sin(t * 0.35) * 0.04
      out.headYaw = Math.sin(t * 0.22) * 0.3
      out.tilt = 0.02
      out.lookCamera = 0
      break
    }
    case 'sit': {
      // 椅子に座る: 座面の上へ腰を前に動かして下ろし、太ももを前へ、すねは下へ（高い椅子なら足をのせ台に）。
      // 両手は前の机・カウンターに置き、ときどき指を動かす
      const h = seat?.height ?? 0.46
      const breath = Math.sin((t / 4.6) * Math.PI * 2)
      const seatToHip = body.hipHeight * SEAT_TO_HIP_RATIO
      out.bob = h + seatToHip - body.hipHeight + breath * 0.002
      out.shift = seat?.shift ?? 0.3
      const thigh = h > 0.62 ? 1.42 : 1.36
      out.thighL = thigh + Math.sin(t * 0.31) * 0.02
      out.thighR = thigh - 0.06 + Math.sin(t * 0.27 + 1) * 0.02
      out.kneeL = thigh + (h > 0.62 ? 0.25 : 0.02)
      out.kneeR = thigh + (h > 0.62 ? 0.12 : 0.1)
      setArm(out.armL, 0.62 + breath * 0.01, 0.18, 1.2 + Math.sin(t * 0.7) * 0.03)
      setArm(out.armR, 0.66, 0.16, 1.12 + Math.sin(t * 0.53 + 2) * 0.03)
      out.lean = 0.13 + Math.sin(t * 0.21) * 0.015
      out.headPitch = 0.12 + Math.sin(t * 0.37) * 0.04
      out.headYaw = Math.sin(t * 0.19) * 0.12
      out.lookCamera = 0.3
      out.handL.wrist += Math.sin(t * 1.3) * 0.04
      out.handR.index += Math.max(0, Math.sin(t * 0.9)) * 0.08
      if (seat?.desk !== undefined && seat.hands !== 'lap') {
        // 前腕を天板に置く（座面と天板の差は椅子ごとに違う。作業机 0.26m・カウンター 0.3〜0.35m）
        const drop = h + seatToHip + sitShoulderAboveHip(out.lean, body) - seat.desk
        armOnDesk(out.armL, drop + breath * 0.004, body)
        armOnDesk(out.armR, drop, body)
      }
      if (seat?.hands === 'grip') {
        // ハンドルを握る（ホバーの一人乗り）: 背すじを起こして前を見る。腕は、手のひらの真ん中がハンドルの握り（乗り物の局所の握りの位置から
        // 座面の真ん中・前傾を引いた所）に届くように（reachArm。肘は少し曲げて下へ）。届かなければ前傾を深くして届かせる。手は握る形。
        // 前は左右の握りの幅を見ずに、肩の前の縦の面だけで解いていて、手が握りの内側・手前に浮いていた
        out.lean = gripArms(out, seat, h, seatToHip, 0.08 + Math.sin(t * 0.21) * 0.008, body)
        out.armL.raise += breath * 0.006
        out.armR.raise += breath * 0.006
        setHand(out.handL, HANDS.hold)
        setHand(out.handR, HANDS.hold)
        out.handL.wrist += 0.1
        out.handR.wrist += 0.1
        out.headPitch = 0.02 + Math.sin(t * 0.37) * 0.02
        out.headYaw = Math.sin(t * 0.19) * 0.15
        out.lookCamera = 0.15
      }
      if (seat?.hands === 'lap') {
        // 両手をひざの上に重ねて、背すじを少し起こす（前に机が無い長いす）
        setArm(out.armL, 0.3 + breath * 0.01, 0.2, 1.02 + Math.sin(t * 0.6) * 0.02, 0.2)
        setArm(out.armR, 0.32, 0.19, 0.98 + Math.sin(t * 0.47 + 2) * 0.02, 0.2)
        out.lean = 0.05 + Math.sin(t * 0.21) * 0.01
        out.headPitch = 0.04 + Math.sin(t * 0.37) * 0.03
        out.lookCamera = 0.35
      }
      break
    }
    case 'pet': {
      // KB-001 をなでる: 右手を、なでる物の頭の上（reach。無ければ PET_REACH）へ伸ばし、手のひらを下にして前後に小さく往復させる。
      // 右腕だけを .vrma の待機に重ねる（ACTION_PART）。なでる物がまだ PET_REACH のそばに来ていない（ドックから降りてくる途中・
      // 花音の右後ろに付いてきた所から回り込む途中）間は、手を前に出して待つ（肩より上・後ろの物へ腕を回さない）
      const to = reach ?? PET_REACH
      const s = Math.sin(t * 2.4)
      const lift = Math.max(0, -Math.cos(t * 2.4)) * 0.01
      const off = Math.hypot(to.right - PET_REACH.right, to.up - PET_REACH.up, to.fwd - PET_REACH.fwd)
      // 届く: 頭の上で往復（戻すときに少し浮かせる）
      _petAt.right = to.right
      _petAt.up = to.up + lift
      _petAt.fwd = to.fwd + s * 0.035
      reachArm(out.armR, -1, _petAt, body)
      // 待つ: PET_REACH の少し手前・下に手を出しておく
      _petAt.right = PET_REACH.right - 0.02
      _petAt.up = PET_REACH.up - 0.06
      _petAt.fwd = PET_REACH.fwd - 0.08
      reachArm(_petArm, -1, _petAt, body)
      const k = 1 - smoothstep(off, PET_NEAR, PET_NEAR + 0.25)
      for (const key of ['raise', 'out', 'twist', 'elbow', 'elbowSide'] as const) out.armR[key] = THREE.MathUtils.lerp(_petArm[key], out.armR[key], k)
      // 手のひらを頭の丸みに沿わせる（手首を少し下へ）。往復に合わせて手首と指が遅れて付いてくる
      out.handR.wrist += 0.18 + Math.sin(t * 2.4 - 0.7) * 0.1 * k
      addCurl(out.handR, s * 0.04 * k, s * 0.035 * k, s * 0.03 * k, s * 0.025 * k)
      // 頭をなでる物の方へ（首の高さはおよそ肩の 0.2m 上）
      const neck = body.hipHeight + body.shoulderAboveHip + 0.2
      out.headYaw = THREE.MathUtils.clamp(Math.atan2(-to.right, Math.max(0.1, to.fwd)), -0.9, 0.9) * 0.8
      out.headPitch = THREE.MathUtils.clamp(Math.atan2(neck - to.up, Math.max(0.15, Math.hypot(to.right, to.fwd))), -0.3, 0.6) * 0.75
      out.headRoll = 0.08
      out.lookCamera = 0.15
      break
    }
  }
  return out
}

/** なめらかな 0〜1（x が a で 0、b で 1） */
function smoothstep(x: number, a: number, b: number) {
  const u = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1)
  return u * u * (3 - 2 * u)
}

/**
 * 打鍵の指（1 本ずつ、少しずつずらしてキーを押す）。強さ k（devGestures の「速く打つ」で大きくする）
 */
export function typeFingers(p: BodyPose, t: number, k: number) {
  const tap = (ph: number) => Math.pow(Math.max(0, Math.sin(t * 11 + ph)), 3) * 0.2 * k
  addCurl(p.handL, tap(0), tap(2.1), tap(4.3), tap(1.2) * 0.5)
  addCurl(p.handR, tap(3.4), tap(0.9), tap(5.2), tap(2.7) * 0.5)
  return p
}

/** 歩き（周期 gait、強さ walk）を姿勢に重ねる */
export function applyGait(p: BodyPose, gait: number, walk: number, speed: number) {
  if (walk <= 0.001) return p
  const amp = walk * (0.33 + 0.12 * Math.min(1, speed / 1.1))
  const s = Math.sin(gait)
  p.thighL = THREE.MathUtils.lerp(p.thighL, s * amp, walk)
  p.thighR = THREE.MathUtils.lerp(p.thighR, -s * amp, walk)
  // 振り出す脚の膝を曲げる
  p.kneeL = THREE.MathUtils.lerp(p.kneeL, Math.max(0, Math.sin(gait + 1.1)) * 0.75 * amp * 2, walk)
  p.kneeR = THREE.MathUtils.lerp(p.kneeR, Math.max(0, Math.sin(gait + 1.1 + Math.PI)) * 0.75 * amp * 2, walk)
  // 腕は脚と逆に振る
  const armSwing = s * 0.42 * walk
  p.armL.raise = THREE.MathUtils.lerp(p.armL.raise, -armSwing, walk)
  p.armR.raise = THREE.MathUtils.lerp(p.armR.raise, armSwing, walk)
  p.armL.out = THREE.MathUtils.lerp(p.armL.out, 0.2, walk)
  p.armR.out = THREE.MathUtils.lerp(p.armR.out, 0.2, walk)
  p.armL.elbow = THREE.MathUtils.lerp(p.armL.elbow, 0.35 + Math.max(0, -s) * 0.3, walk)
  p.armR.elbow = THREE.MathUtils.lerp(p.armR.elbow, 0.35 + Math.max(0, s) * 0.3, walk)
  p.armL.twist = THREE.MathUtils.lerp(p.armL.twist, 0, walk)
  p.armR.twist = THREE.MathUtils.lerp(p.armR.twist, 0, walk)
  // 上下動（1 周期に 2 回）・腰の揺れ・少し前傾
  p.bob += walk * 0.028 * (0.5 - 0.5 * Math.cos(2 * gait)) - walk * 0.02
  p.tilt += Math.sin(gait) * 0.03 * walk
  p.twist += Math.sin(gait) * 0.05 * walk
  p.lean = THREE.MathUtils.lerp(p.lean, 0.06, walk)
  p.headPitch = THREE.MathUtils.lerp(p.headPitch, 0.04, walk)
  lerpHand(p.handL, HANDS.walk, walk)
  lerpHand(p.handR, HANDS.walk, walk)
  return p
}

/** 2 つの姿勢を混ぜる（out = a から b へ k だけ） */
export function blendPose(a: BodyPose, b: BodyPose, k: number, out: BodyPose) {
  const L = THREE.MathUtils.lerp
  for (const side of ['armL', 'armR'] as const) {
    for (const key of ['raise', 'out', 'twist', 'elbow', 'elbowSide'] as const) out[side][key] = L(a[side][key], b[side][key], k)
  }
  for (const key of ['thighL', 'thighR', 'kneeL', 'kneeR', 'lean', 'tilt', 'twist', 'headPitch', 'headYaw', 'headRoll', 'bob', 'shift', 'lookCamera'] as const) {
    out[key] = L(a[key], b[key], k)
  }
  blendHand(a.handL, b.handL, k, out.handL)
  blendHand(a.handR, b.handR, k, out.handR)
  return out
}

/** 手を振るときの腕（ラジアン）。swing は肘の曲げの振れ幅（片側） */
const WAVE_ARM = { raise: 0.55, out: 1.0, twist: -1.1, elbow: 1.95, swing: 0.3 } as const
/**
 * 座って手を振るときの腕: 肘を肩の高さ近くまで上げ、手を肩より上へ。座る姿勢は上半身が前へ傾き（前傾 0.13）、立って振る角度のままでは
 * 肘が下がって手があごの高さに留まり、手首だけで振っているように見えた
 */
const WAVE_ARM_SEATED = { raise: 0.5, out: 1.38, twist: -1.2, elbow: 2.0, swing: 0.3 } as const

/** 手を振る速さ（振りの位相 = 振り始めてからの秒 × これ。11 で 1 秒に約 1.75 往復） */
export const WAVE_RATE = 11

/**
 * 手を振る（本人の左手 = カメラから見て右手）。w は強さ、ph は振りの位相（ラジアン。1 秒に約 1.75 往復の速さで渡す）。
 * seated は座る姿勢の強さ（0〜1。座っているときは肘を肩の高さ近くまで上げる形 WAVE_ARM_SEATED へ）。
 *
 * 人の「バイバイ」と同じ形にする: 上腕は横へ肩より少し下まで上げて少し前に出し、外へひねって肘の曲がる向きを上にする。
 * 肘を曲げて前腕を立て、肘の曲げ伸ばしで前腕を左右（頭の方と外側）に振る。手のひらはカメラの方。
 * （前は肘を伸ばしたまま横へ倒して振っていたので、肘が曲がらない向きに折れて見えた）
 */
export function applyWave(p: BodyPose, w: number, ph: number, seated = 0) {
  if (w <= 0.001) return p
  const L = THREE.MathUtils.lerp
  const a = p.armL
  const sway = Math.sin(ph)
  // 座っている（seated = 座る姿勢の強さ）なら、肘を上げた形へ
  const raise = L(WAVE_ARM.raise, WAVE_ARM_SEATED.raise, seated)
  const out = L(WAVE_ARM.out, WAVE_ARM_SEATED.out, seated)
  const twist = L(WAVE_ARM.twist, WAVE_ARM_SEATED.twist, seated)
  const elbow = L(WAVE_ARM.elbow, WAVE_ARM_SEATED.elbow, seated)
  // 振りの中で肩も少しだけ動かす（前腕だけが動くと機械っぽい）
  a.raise = L(a.raise, raise + Math.sin(ph - 0.6) * 0.03, w)
  a.out = L(a.out, out + sway * 0.05, w)
  a.twist = L(a.twist, twist, w)
  // 肘は上げ下ろしの途中では浅く曲げる（w の 2 乗）。曲げたまま上腕のひねりが戻ると、前腕が胸の前を横切るため
  a.elbow = L(a.elbow, elbow + sway * WAVE_ARM.swing, w * w)
  a.elbowSide = L(a.elbowSide, 0, w)
  lerpHand(p.handL, HANDS.wave, w)
  // 手首は前腕より少し遅れて付いてくる
  p.handL.wrist += Math.sin(ph - 1.1) * 0.1 * w
  p.headRoll = L(p.headRoll, -0.07, w)
  p.headYaw = L(p.headYaw, 0.06, w)
  p.tilt = L(p.tilt, -0.025, w)
  return p
}


/**
 * 喜ぶ（両手を突き上げて弾む）。w は強さ、ct は始まってからの秒（3.4 秒の身ぶり）。
 * 拳を胸の前に引き寄せてから、体の前を通して真上へ突き上げる（2 回）。腕は前へ上げ、横へは張らない（シルエットを体の幅に収める）。
 * 最後に両手を胸の前で握って締める。弾みは小さく（座っている・乗り物の中でも使うので、体の上下と膝は少しだけ足す）。
 * 立っているときの全身の喜ぶは、使う側が .vrma で見せてもよい（花音は stream-video の自作のキーポーズ）
 */
export function applyCheer(p: BodyPose, w: number, ct: number) {
  if (w <= 0.001) return p
  const L = THREE.MathUtils.lerp
  // 突き上げる強さ（0 = 拳を胸の前、1 = 真上）。0.55〜0.75 秒と 1.5〜1.7 秒に上げ、1.25 秒と 2.2 秒から下ろす
  const up = smoothstep(ct, 0.55, 0.75) * (1 - smoothstep(ct, 1.25, 1.45)) + smoothstep(ct, 1.5, 1.7) * (1 - smoothstep(ct, 2.2, 2.42))
  for (const a of [p.armL, p.armR]) {
    a.raise = L(a.raise, L(0.45, 2.75, up), w)
    a.out = L(a.out, 0.06 + 0.06 * up, w)
    a.twist = L(a.twist, 0, w)
    a.elbow = L(a.elbow, L(2.3, 0.25, up), w)
    a.elbowSide = L(a.elbowSide, 0, w)
  }
  lerpHand(p.handL, HANDS.fist, w)
  lerpHand(p.handR, HANDS.fist, w)
  // 2 回弾む（踏み切りの前に少し沈む）。高さは控えめ
  let hop = 0
  let crouch = 0
  for (const t0 of [0.7, 1.62]) {
    const k = (ct - t0) / 0.24
    if (k > 0 && k < 1) hop = Math.sin(k * Math.PI) * 0.05
    crouch += Math.max(0, 1 - Math.abs(ct - (t0 - 0.15)) / 0.15) * 0.25 + Math.max(0, 1 - Math.abs(ct - (t0 + 0.38)) / 0.15) * 0.2
  }
  p.bob += hop * w
  p.kneeL += crouch * w
  p.kneeR += crouch * w
  p.thighL += crouch * 0.5 * w
  p.thighR += crouch * 0.5 * w
  // 頭は 1 回目に左、2 回目に右へ小さく傾ける。上半身は少し前へ（反らせない）
  const roll = 0.1 * (smoothstep(ct, 0.5, 0.8) * (1 - smoothstep(ct, 1.2, 1.45)) - smoothstep(ct, 1.45, 1.7) * (1 - smoothstep(ct, 2.1, 2.4)))
  p.headRoll = L(p.headRoll, roll, w)
  p.headPitch = L(p.headPitch, 0.04, w)
  p.lean = L(p.lean, 0.06, w)
  return p
}

/**
 * コメントを読む仕草（chat.pick の「DECODING…」の間）: 右手をあごに当て、左手でその肘を支え、少し前かがみになる。
 * w は強さ（0〜1）、t はシーンの経過秒（小さく揺らす）
 */
export function applyRead(p: BodyPose, w: number, t: number) {
  if (w <= 0.001) return p
  const L = THREE.MathUtils.lerp
  const r = p.armR
  r.raise = L(r.raise, 1.02 + Math.sin(t * 1.3) * 0.03, w)
  r.out = L(r.out, 0.42, w)
  r.twist = L(r.twist, 0.55, w)
  r.elbow = L(r.elbow, 2.25, w)
  r.elbowSide = L(r.elbowSide, 0, w)
  const l = p.armL
  l.raise = L(l.raise, 0.5, w)
  l.out = L(l.out, 0.02, w)
  l.twist = L(l.twist, 1.25, w)
  l.elbow = L(l.elbow, 1.7, w)
  l.elbowSide = L(l.elbowSide, 0, w)
  lerpHand(p.handR, HANDS.chin, w)
  lerpHand(p.handL, HANDS.hold, w)
  p.lean = L(p.lean, 0.06, w)
  p.tilt = L(p.tilt, 0.05, w)
  p.headRoll = L(p.headRoll, 0.1, w)
  return p
}
