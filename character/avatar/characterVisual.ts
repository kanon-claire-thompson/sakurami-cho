import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { ACTION_PART, actionPose, applyGait, blendPose, createPose, restPose, setBodyMetrics, type ActionPart, type BodyMetrics, type BodyPoint, type BodyPose } from './body'
import { blendHand, createHand, HAND_SMOOTHING, HANDS, setHand } from './hands'
import { applyHandFingers, applyHandTwist, createHandsRig, type HandsRig } from './vrmHands'
import { stepLength, WALK_SPEED } from './locomotion'
import type { Character, CharacterAnchors, CharacterVisualLike } from './character'
import type { MotionClipFrame, VisualFrame } from './layers'
import { localShadowCasters } from '../../world/outdoor/town/shadows'
import { VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation'
import { estimateHeight, getBone, loadVrm, measureLowestPoint, releaseVrm } from './loadVrm'
import { addBoneRotation, idleBasePose, poseQuaternion, setBone, type Pose } from './pose'
import { applyFootIk, type FootIkState } from './footIk'
import { applyTurnStepPose, createTurnStepPose } from './turnStepPose'
import { applyJumpPose, createJumpClipWeights, createJumpLook, jumpClipWeights, jumpCodeAmounts, updateJumpLook } from './jumpPose'
import { loadVrmAnimation } from './vrmAnimation'
import { IdleMix, type IdleMixEntry } from './idleMix'
import { VISUAL_DEFAULTS, type VisualConfig } from './visualConfig'
import type { Car } from '../../world/outdoor/transit/vehicle'

/**
 * キャラクター（VRM）の見た目（three の形。docs/design/map-split.md §5 の「段 3 の作りの決めごと」）。
 * Character の動き（ch.motion）に合わせて立たせ、待機の動き・歩き・立ち寄り先での行動・視線・まばたきを付ける。
 * キャラクターに固有の身ぶり・反応・視線・表情・飾りは姿勢の層（ch.layers。character/avatar/layers.ts）と表情（ch.expressions。character/avatar/expressions.ts）から
 * 段ごとに入れる（kanon-lab の花音は src/kanon/KanonAvatar.tsx が付ける）。
 * VRM（url。assetBase からの相対パス。落としたファイルの blob: の URL など、絶対の URL ならそのまま）が無い・読み込めないときは、
 * 読み込みの状態（onStatus）を missing / error にする（案内は使う側）。
 *
 * 使い方: createCharacterVisual(ch, opts) で作り、object をシーンに置いて start() で読み込む。毎コマ update(t, dt, camera)
 * （Character に付けたら ch.updateVisual）。やめるときは stop()（読み込みの取り消しと、VRM をシーンから外す）。React（R3F）からは react/CharacterView.tsx。
 *
 * - 身長と足元の高さは読み込んだモデルから測る（height と比べて必要なら拡大縮小）
 * - 腕を下ろした待機姿勢 + 呼吸・体重移動・まばたき・カメラへの視線
 * - 手の形: 行動・反応ごとの手の形（character/avatar/hands.ts）を、指の骨・前腕のひねり・手首に入れる（character/avatar/vrmHands.ts）。
 *   切り替えは毎フレーム少しずつ近づけて、急に変わらないようにする。
 *   .vrma の再生中は腕と同じ決まりにそろえる: アニメーションの指（無ければコードの手の形）の上に、
 *   行動・反応の手の形を腕の姿勢と同じ強さ（overlay）で重ねる
 * - 待機・歩きの .vrma（`pnpm sync:anim` で作る）があれば、それを再生し、行動・反応の身ぶりはコードの姿勢をその強さで上に重ねる。
 *   立ち寄り先での行動（立ち位置の待機 present を除く）と層の lower の身ぶりは全身、ほかの身ぶりは上半身だけ
 *   （足は .vrma の待機の立ち方のまま、床を滑らないように）。どちらも強さ 1 なら、上半身の向きはコードだけのときと同じになる
 * - 行動の切り替え（ch.motion.action が替わる。kanon.activity の holo → type・行動 → 待機など）: 前のコマに見せた姿勢（正規化ボーンの回転・腰の位置・
 *   体の上下と前後）を覚え、ACTION_SWITCH_SEC（0.5 秒）かけて新しい姿勢へ混ぜる。腕だけの行動（gaze・pet）と体全体の行動の間も同じ。
 *   置き直した（placeSerial が進んだ）とき・前の行動がほとんど見えていなかった（歩いてきた）ときは混ぜない
 * - 立ったままの全身の身ぶり（clips。花音は kanon.gesture の look_around など）: 読み込んだクリップを、層の clip が返す強さ・時刻で
 *   待機の上に重ねる（腰から下もモーションのまま）。その間は首・目のカメラへの追従を弱めて、モーションの頭の動きを打ち消さないようにする。
 *   待機の .vrma が無いとき（コードの動き）は読み込まない
 * - 跳ぶ（ch.motion.jump。character/avatar/jump.ts）: 跳ぶ .vrma（踏み切り・跳んでいる間・着く。visualConfig.ts の animations.jump）が読めていれば、
 *   段階に合わせて再生する所と強さを決めて待機・歩きの上に重ねる（character/avatar/jumpPose.ts。その分だけ待機・歩き・身ぶり・行動の腰から下を弱める）。
 *   読めていない・待機の .vrma が無いときは、コードの姿勢（しゃがむ → 伸びる → 着いてしゃがむ）を重ねる。跳んでいる間は足の高さ合わせを弱める
 * - その場で向きを変える足踏み（ch.motion.step。character/avatar/turnStep.ts）: 床に残る足をその場に留め、持ち上げた足を次の所へ運ぶ
 *   （character/avatar/turnStepPose.ts。行動の姿勢を作った後・足の高さ合わせの前）
 * - 待機を何本か切り替える（animations.idleVariants の .vrma が読めたとき。character/avatar/idleMix.ts）: 待機の 1 本目と足した待機を、決まった乱数と
 *   シーンの時計（update の t）で枠ごとに選び、idleMix.fade 秒かけて強さを入れ替える（再生する所もシーンの時計から決めるので、撮影で同じ画になる）
 * - 寄りの画では待機の体の揺れを弱める（steady。顔のアップ = 頭が画の縦の steady.headFraction の割合を占めるほど強く、待機の .vrma の腰・背骨・首・脚を
 *   クリップの平均の姿勢へ steady.amount まで寄せる。層の steady（花音は話している間）は、腰から上の画（medium・close）でその分を足す。引きの画はそのまま）
 * - 姿勢の仕上げ（層の adjust。花音は顔・頭に触れる身ぶりで手を顔の目印へ届かせる）: 首・視線の後、表情と vrm.update の前
 */

/** 読み込みの状態（idle = まだ読み込んでいない・やめた。使う側へは loading 以降を知らせる） */
export type CharacterVisualStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

/** 待機の上に重ねる全身のクリップ（.vrma） */
export interface CharacterVisualClip {
  /** 名前（層の clip が返す名前） */
  name: string
  /** assetBase からの相対パス（絶対の URL ならそのまま。assetUrl） */
  url: string
  /** 身ぶりの長さ（秒）。クリップがこれより長いと終わりが切れるので、読み込んだときに警告を出す */
  length?: number
}

/** createCharacterVisual の引数（共通の設定 character/avatar/visualConfig.ts の欄も、ここで置き換えられる） */
export interface CharacterVisualOptions extends Partial<VisualConfig> {
  /** 読み込む VRM（assetBase からの相対パス。落としたファイルの blob: の URL など、絶対の URL ならそのまま。assetUrl） */
  url: string
  /** 設定上の身長（m）。読み込んだモデルの実測値とこれを比べて、必要なら拡大縮小する */
  height: number
  /** VRM・.vrma の置き場（url・animations・clips の相対パスの前に付ける。絶対の URL には付けない。kanon-lab は import.meta.env.BASE_URL） */
  assetBase: string
  /** 待機の上に重ねる全身のクリップ（待機の .vrma があるときだけ、この順で読み込む） */
  clips?: readonly CharacterVisualClip[]
  /** 読み込みの状態が変わったとき（missing・error は error に読み込めなかった理由） */
  onStatus?: (status: Exclude<CharacterVisualStatus, 'idle'>, error?: unknown) => void
}

/** 読み込んだ VRM に付けた物（層の onLoad へ渡す。?debug でコンソールから見る用） */
export interface CharacterVisualRig {
  springReady: boolean
  /** 手の骨と回転の軸 */
  hands: HandsRig
  /** .vrma があれば、待機と歩きのアニメーション */
  mixer: THREE.AnimationMixer | null
  idle: THREE.AnimationAction | null
  walk: THREE.AnimationAction | null
  /** 歩きの .vrma を 1 倍の速さで再生したときに、足が滑らない進む速さ（m/s） */
  walkSpeed: number
  /** 腰の骨の元の位置（.vrma は腰を動かすので、コードの姿勢を重ねるときに戻す先） */
  hipsRest: THREE.Vector3
  /** 立った待機姿勢の足首（足の骨）の、靴底からの高さ（m。歩く間の立脚の膝の直し） */
  ankleRest: number
  /** 行動・反応を重ねるときの、コードの姿勢（animatedBones の回転） */
  codePose: THREE.Quaternion[]
  /** 立ったままの全身の身ぶり（読み込めたものだけ） */
  motions: Map<string, THREE.AnimationAction>
  /** 跳ぶ（踏み切り・跳んでいる間・着く。3 本とも読めたときだけ） */
  jump: { start: THREE.AnimationAction; loop: THREE.AnimationAction; land: THREE.AnimationAction } | null
  /** 待機の .vrma の平均の姿勢（腰・背骨・首・脚。寄りの画で体の揺れを弱めるときに寄せる先） */
  idleMean: IdleMeanBone[]
  /**
   * 切り替える待機（0 番が idle。animations.idleVariants が 1 本も読めなければ空）と、切り替えの順番。
   * それぞれの平均の姿勢（mean）は、切り替えの強さで混ぜて steady の寄せる先にする
   */
  idles: { action: THREE.AnimationAction; duration: number; mean: IdleMeanBone[] }[]
  idleMix: IdleMix | null
}

/** 待機の .vrma の平均の姿勢（1 本の骨） */
export interface IdleMeanBone {
  node: THREE.Object3D
  q: THREE.Quaternion
  /** 腰だけ（位置） */
  p: THREE.Vector3 | null
}

/** 寄りの画で揺れを弱める骨 */
const STEADY_BONES: readonly VRMHumanBoneName[] = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot']
/** 頭の大きさの目安（m。画の縦に占める割合を出す） */
const HEAD_SIZE = 0.25

const _mean = new THREE.Vector3()

/** 待機のクリップの平均の姿勢（四元数は向きをそろえて足し、正規化。腰の位置は平均） */
function idleMeanPose(vrm: VRM, clip: THREE.AnimationClip): IdleMeanBone[] {
  const out: IdleMeanBone[] = []
  for (const name of STEADY_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode(name)
    if (!node) continue
    const qt = clip.tracks.find((t) => t.name === `${node.name}.quaternion`)
    if (!qt) continue
    const v = qt.values
    const sum = new THREE.Vector4()
    for (let i = 0; i + 3 < v.length; i += 4) {
      const sign = i === 0 || v[i] * v[0] + v[i + 1] * v[1] + v[i + 2] * v[2] + v[i + 3] * v[3] >= 0 ? 1 : -1
      sum.x += v[i] * sign
      sum.y += v[i + 1] * sign
      sum.z += v[i + 2] * sign
      sum.w += v[i + 3] * sign
    }
    const q = new THREE.Quaternion(sum.x, sum.y, sum.z, sum.w).normalize()
    let p: THREE.Vector3 | null = null
    const pt = name === 'hips' ? clip.tracks.find((t) => t.name === `${node.name}.position`) : undefined
    if (pt && pt.values.length >= 3) {
      p = new THREE.Vector3()
      const n = pt.values.length / 3
      for (let i = 0; i < pt.values.length; i += 3) p.add(_mean.fromArray(pt.values, i).divideScalar(n))
    }
    out.push({ node, q, p })
  }
  return out
}

/** キャラクターの見た目（Character の visual に付けると ch.updateVisual で進む） */
export interface CharacterVisual extends CharacterVisualLike {
  /** シーンに置く物（位置・向きは毎コマ ch.motion から。VRM はこの下に入れる。VRM が届くまでは動かさない） */
  readonly object: THREE.Group
  /** 読み込みの状態 */
  readonly status: CharacterVisualStatus
  /** 読み込んだ VRM（読み込むまで null） */
  readonly vrm: VRM | null
  /** 読み込んだ VRM に付けた物（読み込むまで null） */
  readonly rig: CharacterVisualRig | null
  /** 使っている共通の設定（既定値と引数を合わせた物） */
  readonly config: Readonly<VisualConfig>
  /** 読み込みを始める（読み込みの状態は loading → ready / missing / error） */
  start(): void
  /** 読み込みを取り消し、VRM をシーンから外す（もう一度 start() で読み込み直せる）。読んだ VRM は片付けない（片付けるのは dispose()） */
  stop(): void
  /**
   * 片付ける: stop() をして、この見た目が読んだ VRM の形・素材・テクスチャを片付け（VRMUtils.deepDispose）、Character の縁の光の素材の一覧
   * （ch.rim.tuned）から外す。読み込みの途中なら、あとで届いた VRM もすぐ片付ける。キャラクターの表情がこの VRM につないであれば外す。
   * VRM を入れ替える使う側は、前の見た目の dispose() を呼んでから新しい見た目を作る（層の onLoad で VRM に付けた物は、層が片付ける）
   */
  dispose(): void
  /** 毎コマ（t = シーンの経過秒、dt = 前のコマからの秒（丸めない）、camera = 見ているカメラ） */
  update(t: number, dt: number, camera: THREE.Camera): void
}

/** 腰から下のボーン（脚を使わない身ぶりでは .vrma のままにする） */
const LOWER_BONES = new Set<VRMHumanBoneName>(['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes'])

/** 片方の腕だけの行動（body.ts の ACTION_PART）で .vrma に重ねるボーン（肩から手首まで。指は vrmHands.ts） */
const ARM_BONES: Record<Exclude<ActionPart, 'body'>, Set<VRMHumanBoneName>> = {
  armL: new Set<VRMHumanBoneName>(['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand']),
  armR: new Set<VRMHumanBoneName>(['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']),
}

/**
 * 毎フレーム回転を作り直すボーン（基本姿勢 + 手続き的な動き。指は vrmHands.ts が毎フレーム入れる）。
 * .vrma の再生中に行動・反応の姿勢を重ねるときも、このボーンをコードの姿勢に近づける
 */
function animatedBones(basePose: Pose): VRMHumanBoneName[] {
  return Array.from(
    new Set<VRMHumanBoneName>([
      ...(Object.keys(basePose) as VRMHumanBoneName[]),
      'hips',
      'spine',
      'chest',
      'upperChest',
      'neck',
      'head',
      'leftUpperLeg',
      'rightUpperLeg',
      'leftLowerLeg',
      'rightLowerLeg',
      'leftFoot',
      'rightFoot',
      'leftToes',
      'rightToes',
    ]),
  )
}

/**
 * 行動を切り替えたとき（kanon.activity で holo → type、行動 → 待機など。ch.motion.action が替わる）、前に見せていた姿勢から新しい姿勢へ混ぜる秒。
 * 行動の強さ（actionBlend）が 1 のまま行動だけが替わると、前は 1 コマで姿勢が飛んだ（混ぜていたのは手の形だけ）
 */
export const ACTION_SWITCH_SEC = 0.5
/** 物に手を置く・座る行動（見る先を胸・腰でも追うときに、手が物から離れないよう半分に） */
const HANDS_ON: ReadonlySet<string> = new Set(['holo', 'work', 'type', 'pet', 'sit'])
/** 切り替えで混ぜないボーン（目・あご。視線と表情が毎コマ決める） */
const SWITCH_SKIP = new Set<VRMHumanBoneName>(['leftEye', 'rightEye', 'jaw'])

/** 腕を「下ろした状態」の向きから T ポーズの向きへ直す回転（体の左 = +1） */
const R0 = { L: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), R: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2)) }
const R0inv = { L: R0.L.clone().invert(), R: R0.R.clone().invert() }
const _e = new THREE.Euler()
const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()

/** 共通の姿勢（character/avatar/body.ts）を VRM の正規化ボーンに入れる */
function applyBodyPose(vrm: VRM, pose: BodyPose) {
  const set = (name: VRMHumanBoneName, q: THREE.Quaternion) => {
    vrm.humanoid.getNormalizedBoneNode(name)?.quaternion.copy(q)
  }
  for (const [armKey, sideKey, side] of [
    ['armL', 'L', 1],
    ['armR', 'R', -1],
  ] as const) {
    const a = pose[armKey]
    // 上腕: 下ろした腕の向きで作った回転 Qp を、T ポーズの向きに直す（Qp · R0⁻¹）
    _qa.setFromEuler(_e.set(-a.raise, -side * a.twist, side * a.out, 'XZY'))
    set(side === 1 ? 'leftUpperArm' : 'rightUpperArm', _qb.copy(_qa).multiply(R0inv[sideKey]))
    // 前腕: 肘の曲げを T ポーズの向きに直す（R0 · E · R0⁻¹）
    _qa.setFromEuler(_e.set(-a.elbow, 0, side * a.elbowSide))
    set(side === 1 ? 'leftLowerArm' : 'rightLowerArm', _qb.copy(R0[sideKey]).multiply(_qa).multiply(R0inv[sideKey]))
  }
  // 脚（T ポーズでも下向きなので、そのまま前後に振る）
  set('leftUpperLeg', _qa.setFromEuler(_e.set(-pose.thighL, 0, 0.02)))
  set('rightUpperLeg', _qa.setFromEuler(_e.set(-pose.thighR, 0, -0.02)))
  set('leftLowerLeg', _qa.setFromEuler(_e.set(pose.kneeL, 0, 0)))
  set('rightLowerLeg', _qa.setFromEuler(_e.set(pose.kneeR, 0, 0)))
  // 背骨: 前傾・傾き・ひねりを 2 か所に分ける
  set('spine', _qa.setFromEuler(_e.set(pose.lean * 0.5 + 0.02, pose.twist * 0.5, pose.tilt * 0.5)))
  set('chest', _qa.setFromEuler(_e.set(pose.lean * 0.5 - 0.02, pose.twist * 0.5, pose.tilt * 0.5)))
}

/** 揺れもの（three-vrm の spring bone）の今と前の先の位置（シーンの座標。center が無いもの）を、車室 car の動きと一緒に運ぶ */
function carrySprings(vrm: VRM, car: Car, weight: number) {
  const mgr = vrm.springBoneManager
  if (!mgr) return
  for (const j of mgr.joints) {
    const jj = j as unknown as { center: THREE.Object3D | null; _currentTail?: THREE.Vector3; _prevTail?: THREE.Vector3 }
    if (jj.center || !jj._currentTail || !jj._prevTail) continue
    car.carry(jj._currentTail, weight)
    car.carry(jj._prevTail, weight)
  }
}

/** 絶対の URL（スキームで始まる blob:・data:・http(s): など、か / で始まる物） */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:|^\//i

/**
 * VRM・.vrma の URL（url が絶対の URL ならそのまま、ほかは assetBase の後ろに付ける）。使う側が落としたファイル（URL.createObjectURL の blob:）を
 * そのまま渡せるように（段 6 の例のアプリ。docs/design/map-split.md §8）。kanon-lab の URL は相対なので、前と同じ URL になる
 */
function assetUrl(base: string, url: string) {
  return ABSOLUTE_URL.test(url) ? url : `${base}${url}`
}

/**
 * キャラクターの見た目を作る（まだ読み込まない。start() で読み込む）。Character に付けるのは使う側（ch.visual = createCharacterVisual(ch, …)）。
 * 共通の設定は character/avatar/visualConfig.ts の既定値に、opts の同じ名前の欄を上書きした物（欄ごと。mtoon の既定は ch.rim の物）
 */
export function createCharacterVisual(ch: Character, opts: CharacterVisualOptions): CharacterVisual {
  return new VrmCharacterVisual(ch, opts)
}

class VrmCharacterVisual implements CharacterVisual {
  readonly object = new THREE.Group()
  readonly config: Readonly<VisualConfig>
  status: CharacterVisualStatus = 'idle'
  vrm: VRM | null = null
  rig: CharacterVisualRig | null = null

  private readonly ch: Character
  private readonly url: string
  private readonly height: number
  private readonly assetBase: string
  private readonly clips: readonly CharacterVisualClip[] | undefined
  private readonly onStatus: CharacterVisualOptions['onStatus']
  /** 待機の基本姿勢と、毎フレーム回転を作り直すボーン */
  private readonly basePose: Pose
  private readonly animatedBones: VRMHumanBoneName[]
  /** 読み込みの回（start・stop で進める。古い読み込みの結果は捨てる） */
  private run = 0
  /** dispose() をした時の読み込みの回（この回までに始めた読み込みの VRM は、届いたらすぐ片付ける） */
  private disposedRun = 0
  /** 読み込んで置いた VRM のうち、まだ片付けていない物（stop() では片付けない。dispose() で片付ける） */
  private readonly owned = new Set<VRM>()

  // 揺れものの先を最後に運んだ車室の動き（車室の serial）
  private springCarry = -1
  // 足の高さ合わせの状態（足ごとのなめらかにした高さの差）
  private readonly footIk: FootIkState = { dL: 0, dR: 0, drop: 0, lift: 0, applied: 0, lastY: null }
  // その場で向きを変える足踏みを脚に入れる強さ（character/avatar/turnStepPose.ts）
  private readonly turnPose = createTurnStepPose()
  // 寄りの画で待機の揺れを弱める今の強さ（なめらかに）
  private steadyNow = 0
  // 待機を切り替えるときの、そのコマの待機の強さと、混ぜた平均の姿勢（steady の寄せる先）
  private readonly idleEntries: IdleMixEntry[] = []
  private steadyMix: IdleMeanBone[] = []
  // 跳ぶ姿勢の様子と、跳ぶ .vrma の時刻と強さ（character/avatar/jumpPose.ts）
  private readonly jumpLook = createJumpLook()
  private readonly jumpWeights = createJumpClipWeights()
  // アニメーションの状態
  private readonly anim = { nextBlink: 2, blinkAt: -100, headYaw: 0, headPitch: 0, torsoYaw: 0, torsoPitch: 0 }
  private readonly poses = { rest: createPose(), action: createPose(), out: createPose() }
  /** 行動で手を伸ばす先（体の中の点。Character の actionTarget から毎コマ作る） */
  private readonly reach: BodyPoint = { right: 0, up: 0, fwd: 0 }
  /** 今の手の形（姿勢の手の形へ少しずつ近づける） */
  private readonly hands = { L: createHand(), R: createHand() }
  /**
   * 行動の切り替え（ACTION_SWITCH_SEC）: 前のコマに見せた姿勢（正規化ボーンの回転・腰の位置・体の上下と前後）と、切り替えた時に覚えた姿勢（from）。
   * key = 行動の名前（無ければ ''）、place = その時の置き直しの回数（kanon.place などで置き直したら混ぜない）、at = 切り替えた時刻（シーンの秒）
   */
  private readonly sw = {
    vrm: null as VRM | null,
    bones: [] as { node: THREE.Object3D; shown: THREE.Quaternion; from: THREE.Quaternion }[],
    shownHips: new THREE.Vector3(),
    fromHips: new THREE.Vector3(),
    shownBob: 0,
    shownShift: 0,
    fromBob: 0,
    fromShift: 0,
    key: null as string | null,
    place: -1,
    lastBlend: 0,
    at: -100,
  }
  private readonly lookProxy = new THREE.Object3D()
  /** 視線の細かい動き（n = 何回目、next = 次に動かす時刻、last = 前のコマの時刻、yaw・pitch = 今のずれ（rad）） */
  private readonly sacc = { n: 0, next: 0, last: -1, yaw: 0, pitch: 0 }
  private readonly tmp = {
    q: new THREE.Quaternion(),
    v: new THREE.Vector3(),
    head: new THREE.Vector3(),
    target: new THREE.Vector3(),
    inv: new THREE.Quaternion(),
    fwd: new THREE.Vector3(),
  }
  // 層へ渡す物（毎コマ書き直す。vrm・camera はそのコマの物）
  private readonly frame: { -readonly [K in keyof VisualFrame]: VisualFrame[K] }

  constructor(ch: Character, opts: CharacterVisualOptions) {
    const { url, height, assetBase, clips, onStatus, ...over } = opts
    this.ch = ch
    this.url = url
    this.height = height
    this.assetBase = assetBase
    this.clips = clips
    this.onStatus = onStatus
    this.config = { ...VISUAL_DEFAULTS, mtoon: ch.rim.mtoon, ...over }
    this.basePose = idleBasePose(this.config.idle)
    this.animatedBones = animatedBones(this.basePose)
    this.frame = { ch, vrm: null as unknown as VRM, t: 0, dt: 0, camera: null as unknown as THREE.Camera }
  }

  start() {
    const run = ++this.run
    const character = this.ch
    const cfg = this.config
    const base = this.assetBase
    const height = this.height
    const clips = this.clips
    const onStatus = this.onStatus
    // 読み込むたびに初めから（揺れもの・足・まばたき・首・手の形）
    this.springCarry = -1
    Object.assign(this.footIk, { dL: 0, dR: 0, drop: 0, lift: 0, applied: 0, lastY: null })
    Object.assign(this.turnPose, createTurnStepPose())
    this.steadyNow = 0
    Object.assign(this.anim, { nextBlink: 2, blinkAt: -100, headYaw: 0, headPitch: 0, torsoYaw: 0, torsoPitch: 0 })
    Object.assign(this.sacc, { n: 0, next: 0, last: -1, yaw: 0, pitch: 0 })
    Object.assign(this.jumpLook, createJumpLook())
    setHand(this.hands.L, HANDS.relaxed)
    setHand(this.hands.R, HANDS.relaxed)
    Object.assign(this.sw, { vrm: null, bones: [], key: null, place: -1, lastBlend: 0, at: -100 })
    this.status = 'loading'
    onStatus?.('loading')
    loadVrm(assetUrl(base, this.url), character.rim, { mtoon: cfg.mtoon, castShadow: cfg.castShadow }).then(async (result) => {
      if (run !== this.run) {
        if (result.status === 'ready') this.dropStale(run, result.vrm)
        return
      }
      if (result.status !== 'ready') {
        this.status = result.status
        onStatus?.(result.status, result.status === 'error' ? result.error : undefined)
        return
      }
      const loaded = result.vrm
      // 待機姿勢にしてから測る（腕を下ろした状態の足元・身長）
      applyPose(loaded, this.basePose)
      loaded.update(0)
      loaded.scene.updateMatrixWorld(true)
      // 身長は「靴底から目の高さ」で推定する（ボーンの原点と靴底のずれを含めないため）
      const sole = measureLowestPoint(loaded.scene)
      const estimated = estimateHeight(loaded, sole, cfg.eyeHeightRatio)
      if (estimated && cfg.normalizeHeight && Math.abs(estimated - height) / height > cfg.allowedHeightError) {
        loaded.scene.scale.setScalar(height / estimated)
        loaded.scene.updateMatrixWorld(true)
      }
      const lowest = measureLowestPoint(loaded.scene)
      loaded.scene.position.y = -lowest
      loaded.scene.updateMatrixWorld(true)
      const finalHeight = estimateHeight(loaded, 0, cfg.eyeHeightRatio) ?? 0
      character.anchors.measuredHeight = finalHeight
      // 体の寸法（座る姿勢の腰の高さ・机に手を置く高さ。character/avatar/body.ts）
      measureBody(loaded, character.body)
      console.info(
        `[sakurami-cho] VRM を読み込みました: 推定身長 ${(estimated ?? 0).toFixed(3)}m → ${finalHeight.toFixed(3)}m（設定 ${height}m）、足元の補正 ${(-lowest).toFixed(3)}m`,
      )
      // 腰の元の位置は、アニメーションが動かす前に覚えておく
      const hipsRest = loaded.humanoid.getNormalizedBoneNode('hips')?.position.clone() ?? new THREE.Vector3()
      const ankleRest = loaded.humanoid.getRawBoneNode('leftFoot')?.getWorldPosition(new THREE.Vector3()).y ?? 0.08
      // 視線のアニメーション用の入れ物（無いと createVRMAnimationClip が警告を出して自分で作る）
      if (loaded.lookAt && !loaded.scene.children.some((o) => o instanceof VRMLookAtQuaternionProxy)) {
        const proxy = new VRMLookAtQuaternionProxy(loaded.lookAt)
        proxy.name = 'VRMLookAtQuaternionProxy'
        loaded.scene.add(proxy)
      }
      // 待機・歩きのアニメーション（.vrma）があれば使う
      const [idleClip, walkClip] = await Promise.all([
        loadVrmAnimation(assetUrl(base, cfg.animations.idle), loaded),
        loadVrmAnimation(assetUrl(base, cfg.animations.walk), loaded),
      ])
      // 切り替える待機（待機の .vrma があるときだけ。読めなかった物は飛ばす）
      const variantClips = idleClip ? await Promise.all((cfg.animations.idleVariants ?? []).map((u) => loadVrmAnimation(assetUrl(base, u), loaded))) : []
      // 立ったままの全身の身ぶり（待機の .vrma があるときだけ。無ければコードの待機の上には重ねない）
      const motionClips = idleClip && clips ? await Promise.all(clips.map(async (c) => [c, await loadVrmAnimation(assetUrl(base, c.url), loaded)] as const)) : []
      // 跳ぶ（待機の .vrma があるときだけ。3 本とも読めなければ、コードの姿勢）
      const jumpSpec = cfg.animations.jump
      const jumpClips = idleClip && jumpSpec ? await Promise.all([jumpSpec.start, jumpSpec.loop, jumpSpec.land].map((u) => loadVrmAnimation(assetUrl(base, u), loaded))) : null
      if (run !== this.run) {
        this.dropStale(run, loaded)
        return
      }
      const mixer = idleClip || walkClip ? new THREE.AnimationMixer(loaded.scene) : null
      const idle = mixer && idleClip ? mixer.clipAction(idleClip.clip) : null
      const walk = mixer && walkClip ? mixer.clipAction(walkClip.clip) : null
      idle?.play()
      walk?.play()
      const motions = new Map<string, THREE.AnimationAction>()
      for (const [spec, loadedClip] of motionClips) {
        if (!mixer || !loadedClip) continue
        // 再生する位置は毎フレーム直接入れる（mixer には進めさせない）
        const action = mixer.clipAction(loadedClip.clip).setEffectiveWeight(0).setEffectiveTimeScale(0)
        action.play()
        motions.set(spec.name, action)
        if (spec.length !== undefined && loadedClip.clip.duration > spec.length + 0.15) {
          console.warn(`[sakurami-cho] 身ぶり ${spec.name} の .vrma（${loadedClip.clip.duration.toFixed(1)} 秒）が、身ぶりの長さ（GESTURE_MS）より長いので、終わりが切れます`)
        }
      }
      // 跳ぶ: 再生する位置は毎フレーム直接入れる（mixer には進めさせない）
      let jump: CharacterVisualRig['jump'] = null
      if (mixer && jumpClips && jumpClips.every((c) => c)) {
        const [start, loop, land] = jumpClips.map((c) => {
          const action = mixer.clipAction(c!.clip).setEffectiveWeight(0).setEffectiveTimeScale(0)
          action.play()
          return action
        })
        jump = { start, loop, land }
      }
      // 切り替える待機: 再生する所はシーンの時計から毎フレーム入れる（mixer には進めさせない）
      const idles: CharacterVisualRig['idles'] = []
      let idleMix: IdleMix | null = null
      const variants = variantClips.filter((c) => c !== null)
      if (mixer && idle && idleClip && variants.length) {
        idles.push({ action: idle.setEffectiveTimeScale(0), duration: idleClip.clip.duration, mean: idleMeanPose(loaded, idleClip.clip) })
        for (const c of variants) {
          const action = mixer.clipAction(c.clip).setEffectiveWeight(0).setEffectiveTimeScale(0)
          action.play()
          idles.push({ action, duration: c.clip.duration, mean: idleMeanPose(loaded, c.clip) })
        }
        idleMix = new IdleMix(
          idles.map((c) => c.duration),
          cfg.idleMix,
        )
        this.steadyMix = idles[0].mean.map((b) => ({ node: b.node, q: b.q.clone(), p: b.p?.clone() ?? null }))
      }
      // 速さの情報が無い .vrma は、決まり（WALK_SPEED で歩くループ）どおりとみなす
      const walkSpeed = walkClip?.walkSpeed ?? WALK_SPEED
      if (mixer) {
        const speedNote = walkClip ? `（1 倍で ${walkSpeed.toFixed(2)} m/s）` : ''
        console.info(`[sakurami-cho] VRM アニメーション: 待機 ${idle ? (idles.length ? `${idles.length} 本を切り替え` : 'あり') : 'なし'} / 歩き ${walk ? 'あり' : 'なし'}${speedNote} / 身ぶり ${motions.size} 本 / 跳ぶ ${jump ? 'あり' : 'なし（コードの姿勢）'}`)
      }
      const r: CharacterVisualRig = {
        hands: createHandsRig(loaded),
        springReady: false,
        mixer,
        idle,
        walk,
        walkSpeed,
        hipsRest,
        ankleRest,
        codePose: this.animatedBones.map(() => new THREE.Quaternion()),
        motions,
        jump,
        idleMean: idle && idleClip ? idleMeanPose(loaded, idleClip.clip) : [],
        idles,
        idleMix,
      }
      this.rig = r
      // シーンに置き、表情を読み込んだ VRM につなぎ、層の読み込み時の準備を付けた順に（花音はペンダント → 表情 → 工具 → ?debug の道具。Object3D・material を作る順）
      this.object.add(loaded.scene)
      character.expressions.bind(loaded)
      const layers = character.layers.list
      for (let i = 0; i < layers.length; i++) layers[i].onLoad?.(loaded, character, r)
      // 次のコマから動かす
      this.vrm = loaded
      this.owned.add(loaded)
      this.status = 'ready'
      onStatus?.('ready')
    })
    // 外にいるとき、まわりの細かい影の地図に入れる（地面・テラスにキャラクターの影が落ちる）
    localShadowCasters.add(this.object)
  }

  stop() {
    this.run++
    localShadowCasters.delete(this.object)
    this.vrm?.scene.removeFromParent()
    this.vrm = null
    this.rig = null
    this.status = 'idle'
  }

  dispose() {
    const current = this.vrm
    this.stop()
    this.disposedRun = this.run
    // キャラクターの表情が今の VRM につないであれば外す（ほかの見た目が読んだ VRM につなぎ替えていれば、そのまま）
    if (current && this.ch.visual === this) this.ch.expressions.bind(null)
    for (const vrm of this.owned) releaseVrm(vrm, this.ch.rim)
    this.owned.clear()
  }

  /**
   * 行動の切り替えの混ぜる強さ（1 = 切り替えた時に見せていた姿勢のまま → 0 = 新しい姿勢。0 なら混ぜない）。
   * 行動（ch.motion.action）が替わったコマで、前のコマに見せた姿勢を from に写す。前の行動がほとんど見えていなかった（行動の強さ 0.05 未満。歩いてきた）とき・
   * 置き直した（placeSerial が進んだ）ときは混ぜない
   */
  private actionSwitch(vrm: VRM, t: number) {
    const sw = this.sw
    const m = this.ch.motion
    if (sw.vrm !== vrm) {
      sw.vrm = vrm
      sw.bones = []
      for (const name of Object.keys(vrm.humanoid.humanBones) as VRMHumanBoneName[]) {
        const node = vrm.humanoid.getNormalizedBoneNode(name)
        if (node && !SWITCH_SKIP.has(name)) sw.bones.push({ node, shown: node.quaternion.clone(), from: new THREE.Quaternion() })
      }
      sw.key = null
    }
    const key = m.action ?? ''
    if (sw.key === null || m.placeSerial !== sw.place) {
      sw.at = -100
    } else if (key !== sw.key && sw.lastBlend > 0.05) {
      sw.at = t
      for (const b of sw.bones) b.from.copy(b.shown)
      sw.fromHips.copy(sw.shownHips)
      sw.fromBob = sw.shownBob
      sw.fromShift = sw.shownShift
    }
    sw.key = key
    sw.place = m.placeSerial
    sw.lastBlend = m.action ? m.actionBlend : 0
    const u = (t - sw.at) / ACTION_SWITCH_SEC
    if (u >= 1 || u < 0) return 0
    return 1 - u * u * (3 - 2 * u)
  }

  /**
   * 視線の細かい動き（サッカード）を進める: lookAt.saccade.interval の間隔で、見る先のずれ（左右 ±yaw・上下 ±pitch rad）を跳ばす。
   * 間隔とずれは回数 n から決まった乱数で決める（シーンの時計だけを使うので、撮影で毎回同じ）。注意している間（attend）は小さく
   */
  private saccade(t: number, attend: number) {
    const sc = this.sacc
    const S = this.config.lookAt.saccade
    if (t < sc.last) Object.assign(sc, { n: 0, next: 0, yaw: 0, pitch: 0 })
    sc.last = t
    if (t < sc.next) return
    sc.n++
    const h = (i: number) => {
      const x = Math.sin(sc.n * 12.9898 + i * 78.233) * 43758.5453
      return x - Math.floor(x)
    }
    const k = 1 - 0.4 * attend
    // 3 回に 1 回ほどは真ん中へ戻る（見つめ直す）
    const center = h(3) < 0.33
    sc.yaw = center ? 0 : (h(1) * 2 - 1) * S.yaw * k
    sc.pitch = center ? 0 : (h(2) * 2 - 1) * S.pitch * k
    sc.next = t + S.interval[0] + h(4) * (S.interval[1] - S.interval[0])
  }

  /**
   * 待機の揺れを弱める強さ（0〜steady.max。なめらかに）: 頭が画の縦に占める割合（カメラから頭までの距離と縦の画角から）が steady.headFraction の
   * 間で 0 → steady.amount、層の steady（話している間など）は腰から上の画（割合 0.15〜0.3 で 0 → 1）でその分を足す
   */
  private steady(f: VisualFrame, camera: THREE.Camera, delta: number) {
    const S = this.config.steady
    const cam = camera as THREE.PerspectiveCamera
    let want = 0
    if (cam.isPerspectiveCamera) {
      camera.getWorldPosition(this.tmp.target)
      const dist = Math.max(0.05, this.tmp.target.distanceTo(this.ch.anchors.head))
      const frac = HEAD_SIZE / (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (cam.zoom || 1))
      let extra = 0
      const layers = this.ch.layers.list
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i]
        if (l.steady) extra = Math.max(extra, l.steady(f))
      }
      want = Math.min(S.max, THREE.MathUtils.smoothstep(frac, S.headFraction[0], S.headFraction[1]) * S.amount + extra * THREE.MathUtils.smoothstep(frac, 0.15, 0.3))
    }
    // カメラを切り替えたコマで急に変わらないよう、0.3 秒ほどで
    this.steadyNow += (want - this.steadyNow) * (1 - Math.exp(-Math.min(delta, 0.1) * 8))
    return this.steadyNow
  }

  /** 切り替えている待機の平均の姿勢を、そのコマの強さで混ぜる（steady の寄せる先。入れ物は読み込んだときに作った steadyMix） */
  private mixedIdleMean(r: CharacterVisualRig, entries: readonly IdleMixEntry[]) {
    const out = this.steadyMix
    const a = r.idles[entries[0].index].mean
    const b = entries.length > 1 ? r.idles[entries[1].index].mean : null
    const w = b ? entries[1].weight : 0
    for (let i = 0; i < out.length; i++) {
      const o = out[i]
      const from = a.find((x) => x.node === o.node)
      const to = b?.find((x) => x.node === o.node) ?? from
      if (!from || !to) continue
      o.q.copy(from.q).slerp(to.q, w)
      if (o.p && from.p && to.p) o.p.copy(from.p).lerp(to.p, w)
    }
    return out
  }

  /** 取り消した読み込みの VRM が届いた: dispose() のあとなら、すぐ片付ける（stop() だけなら今までどおり何もしない） */
  private dropStale(run: number, vrm: VRM) {
    if (run <= this.disposedRun) releaseVrm(vrm, this.ch.rim)
  }

  update(t: number, delta: number, camera: THREE.Camera) {
    const vrm = this.vrm
    const r = this.rig
    if (!vrm || !r) return
    const character = this.ch
    const cfg = this.config
    const group = this.object
    const a = this.anim
    const poses = this.poses
    const hands = this.hands
    const tmp = this.tmp
    const lookProxy = this.lookProxy
    const ANIMATED_BONES = this.animatedBones
    const m = character.motion
    const layers = character.layers.list
    const f = this.frame
    f.vrm = vrm
    f.t = t
    f.dt = delta
    f.camera = camera
    // 層のそのコマの計算（反応の強さなど）
    for (let i = 0; i < layers.length; i++) layers[i].begin?.(f)
    // 立ったままの全身の身ぶり（読み込めていれば。最初に返した層の物）。歩き出したら抜ける
    let clip: MotionClipFrame | null = null
    for (let i = 0; i < layers.length && !clip; i++) clip = layers[i].clip?.(f) ?? null
    const motion = clip ? r.motions.get(clip.name) : undefined
    // 跳ぶ: 跳ぶ .vrma があれば、その強さ（jw）の分だけ待機・歩き・身ぶり・行動の腰から下を弱める。無ければコードの姿勢（下の applyJumpPose）
    updateJumpLook(this.jumpLook, m.jump, delta)
    const jumpClips = r.mixer ? r.jump : null
    const jw = jumpClips ? jumpClipWeights(this.jumpLook, m.jump, this.jumpWeights, cfg.jump).total : 0
    const jumpCode = jumpClips ? null : jumpCodeAmounts(this.jumpLook, m.jump)
    const mw = motion && clip ? clip.weight * (1 - m.walk) * (1 - jw) : 0

    // --- 位置と向き（共通の歩きの制御から） ---
    group.position.copy(m.position)
    group.rotation.y = m.heading

    // 最初のフレーム: 立ち位置に置いた状態で揺れもの（おさげ・ペンダント）を初期化する
    if (!r.springReady) {
      vrm.scene.updateMatrixWorld(true)
      vrm.springBoneManager?.setInitState()
      vrm.springBoneManager?.reset()
      r.springReady = true
    }

    // --- 姿勢: 待機 → 行動 → 歩き → 層（反応・身ぶり。character/avatar/body.ts の共通の姿勢） ---
    const pose = poses.out
    restPose(poses.rest, t)
    if (m.action && m.actionBlend > 0.001) {
      // 手を伸ばす先（ワールド座標）を、足元から見た体の中の点に（右 = 体の向きから 90° 右）
      const at = character.actionTarget
      let reach: BodyPoint | null = null
      if (at) {
        const dx = at.x - m.position.x
        const dz = at.z - m.position.z
        const sh = Math.sin(m.heading)
        const chd = Math.cos(m.heading)
        reach = this.reach
        reach.fwd = dx * sh + dz * chd
        reach.right = -(dx * chd - dz * sh)
        reach.up = at.y - m.position.y
      }
      actionPose(m.action, t, poses.action, m.seat, character.body, reach)
      blendPose(poses.rest, poses.action, m.actionBlend * m.actionBlend * (3 - 2 * m.actionBlend), pose)
    } else blendPose(poses.rest, poses.rest, 0, pose)
    const bobBeforeGait = pose.bob
    applyGait(pose, m.gait, m.walk, m.speed)
    // 歩きの .vrma は腰の上下の揺れを含むので、コードの歩きの上下の揺れは足さない
    if (r.walk) pose.bob = bobBeforeGait
    // 跳ぶ姿勢（跳ぶ .vrma が無いときのコードの姿勢。しゃがむ → 伸びる → 着いてしゃがむ）
    if (jumpCode) applyJumpPose(pose, jumpCode.crouch, jumpCode.tuck, character.body)
    // 層の身ぶり（付けた順に重ねる）
    for (let i = 0; i < layers.length; i++) layers[i].pose?.(pose, f)
    // 行動の切り替え: 前のコマに見せた姿勢を覚え、ACTION_SWITCH_SEC かけて新しい姿勢へ混ぜる（下のボーンの混ぜと、ここの体の上下・前後）
    const swW = this.actionSwitch(vrm, t)
    if (swW > 0) {
      pose.bob = THREE.MathUtils.lerp(pose.bob, this.sw.fromBob, swW)
      pose.shift = THREE.MathUtils.lerp(pose.shift, this.sw.fromShift, swW)
    }
    this.sw.shownBob = pose.bob
    this.sw.shownShift = pose.shift
    group.position.y += pose.bob
    // 座るときは体ごと前（座面の上）へ
    if (Math.abs(pose.shift) > 1e-4) {
      group.position.x += Math.sin(m.heading) * pose.shift
      group.position.z += Math.cos(m.heading) * pose.shift
    }
    // 手の形: 行動の切り替え（kanon.activity など）でも急に変わらないよう、少しずつ近づける
    const kh = 1 - Math.exp(-delta * HAND_SMOOTHING)
    blendHand(hands.L, pose.handL, kh, hands.L)
    blendHand(hands.R, pose.handR, kh, hands.R)

    for (const name of ANIMATED_BONES) setBone(vrm, name, tmp.q.identity())
    applyPose(vrm, this.basePose)
    // 指はまずコードの手の形にする（.vrma に指が無ければ、これがそのまま残る）
    applyHandFingers(r.hands, hands.L, hands.R)
    if (r.mixer) {
      // .vrma があれば: 行動・反応（身ぶりを含む）はその上に重ねる。立ち位置の待機（present）は .vrma の待機そのものなので重ねない。
      // 腰から下は、行動と層の lower の身ぶり（花音はスパチャで跳ねる cheer）のときだけ。ほかの身ぶりは上半身だけに重ねる
      // 立ったままの全身の身ぶりの間は、立ち寄り先での行動の姿勢より身ぶりを優先する
      // 跳んでいる間は、跳ぶ .vrma の強さの分だけ行動を弱める（腰から下は跳ぶ姿勢にする）。跳ぶ .vrma が無ければ、コードの跳ぶ姿勢を腰から下に重ねる
      // 片方の腕だけの行動（窓の外を眺める gaze・KB-001 をなでる pet。body.ts の ACTION_PART）は、その腕と手だけに重ね（armW）、体・もう片方の腕・脚は .vrma の待機のまま
      const actionW = (m.action === 'present' ? 0 : m.actionBlend) * (1 - mw) * (1 - jw)
      const part = m.action ? ACTION_PART[m.action] : 'body'
      const armW = part === 'body' ? 0 : actionW
      let overlay = part === 'body' ? actionW : 0
      let lower = overlay
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i]
        if (l.overlay) overlay = Math.max(overlay, l.overlay(f))
        if (l.lower) lower = Math.max(lower, l.lower(f))
      }
      // 腰から下を重ねるのは、前からの決まりでは姿勢を重ねるとき（overlay）だけ。跳ぶコードの姿勢は、それとは別に腰から下へ
      lower = overlay > 0.001 ? lower * (1 - jw) : 0
      if (jumpCode) lower = Math.max(lower, Math.min(1, (jumpCode.crouch + jumpCode.tuck) * 3))
      const hips = vrm.humanoid.getNormalizedBoneNode('hips')
      if (overlay > 0.001 || lower > 0.001 || armW > 0.001) {
        // 重ねる先 = コードだけのときの姿勢（腰は元の位置）を覚えておく
        applyBodyPose(vrm, pose)
        ANIMATED_BONES.forEach((name, i) => {
          const node = vrm.humanoid.getNormalizedBoneNode(name)
          if (node) r.codePose[i].copy(node.quaternion)
        })
      }
      // 待機と歩きを歩きの強さで混ぜ、進む速さに合わせて再生の速さを変える（足が床を滑らないように）。
      // 立ったままの全身の身ぶりは、その上にその強さで重ねる（1 回だけ。繰り返すアニメーション（腕組み）は身ぶりの長さだけ繰り返す）
      const idleW = (r.walk ? 1 - m.walk : 1) * (1 - mw) * (1 - jw)
      let steadyTo = r.idleMean
      if (r.idleMix) {
        // 待機を切り替える: シーンの時計で、今の 1〜2 本の強さと再生する所を決める
        const entries = r.idleMix.at(t, this.idleEntries)
        for (const c of r.idles) c.action.setEffectiveWeight(0)
        for (const e of entries) {
          const c = r.idles[e.index]
          c.action.time = e.time % c.duration
          c.action.setEffectiveWeight(idleW * e.weight)
        }
        steadyTo = this.mixedIdleMean(r, entries)
      } else r.idle?.setEffectiveWeight(idleW)
      if (r.walk) {
        r.walk.setEffectiveWeight(m.walk * (1 - mw) * (1 - jw))
        // 町の中の移動の早送り（timeScale）では、その倍で。町の石段の上は踏面ごとに 1 歩（stride）になるよう、歩幅の比で速める
        r.walk.setEffectiveTimeScale(Math.max(0.2, m.speed / r.walkSpeed) * m.timeScale * (m.stride ? stepLength(m.speed) / m.stride : 1))
      }
      for (const action of r.motions.values()) {
        if (action !== motion) {
          action.setEffectiveWeight(0)
          continue
        }
        // 身ぶりの長さより明らかに短いアニメーション（腕組み）は繰り返し、それ以外は最後の姿勢で止める
        const d = action.getClip().duration
        const loops = clip!.length > d + 0.5
        action.time = loops ? clip!.time % d : Math.min(clip!.time, d - 1e-4)
        action.setEffectiveWeight(mw)
      }
      // 跳ぶ（3 本の再生する所と強さ。jumpPose.ts）
      if (jumpClips) {
        const jwt = this.jumpWeights
        for (const [action, w] of [
          [jumpClips.start, jwt.start],
          [jumpClips.loop, jwt.loop],
          [jumpClips.land, jwt.land],
        ] as const) {
          const d = action.getClip().duration
          action.time = action === jumpClips.loop ? w.time % d : Math.min(w.time, d - 1e-4)
          action.setEffectiveWeight(w.weight)
        }
      }
      r.mixer.update(delta)
      // 寄りの画では待機の体の揺れ（腰・背骨・首・脚）を、クリップの平均の姿勢へ寄せて弱める（待機の強さの分だけ）
      const steady = this.steady(f, camera, delta) * (r.walk ? 1 - m.walk : 1) * (1 - mw) * (1 - jw)
      if (steady > 0.001) {
        for (const b of steadyTo) {
          b.node.quaternion.slerp(b.q, steady)
          if (b.p) b.node.position.lerp(b.p, steady)
        }
      }
      if (lower > 0.001) {
        ANIMATED_BONES.forEach((name, i) => {
          if (LOWER_BONES.has(name)) vrm.humanoid.getNormalizedBoneNode(name)?.quaternion.slerp(r.codePose[i], lower)
        })
        hips?.position.lerp(r.hipsRest, lower)
      }
      if (overlay > 0.001 || armW > 0.001) {
        const armBones = part === 'body' ? null : ARM_BONES[part]
        ANIMATED_BONES.forEach((name, i) => {
          if (LOWER_BONES.has(name)) return
          const w = armBones?.has(name) ? Math.max(overlay, armW) : overlay
          if (w <= 0.001) return
          // 背骨の付け根では腰の回り（.vrma の待機の腰のひねりなど）を打ち消し、上半身の向きをコードの姿勢（腰は回さない）と同じにする。
          // 対象の位置に合わせた身ぶり（物に触る・画面を示す）の向きがずれないように
          const target = name === 'spine' && hips ? tmp.q.copy(hips.quaternion).invert().multiply(r.codePose[i]) : r.codePose[i]
          vrm.humanoid.getNormalizedBoneNode(name)?.quaternion.slerp(target, w)
        })
        // 手の形も腕と同じ強さで
        const wL = part === 'armL' ? Math.max(overlay, armW) : overlay
        const wR = part === 'armR' ? Math.max(overlay, armW) : overlay
        applyHandFingers(r.hands, hands.L, hands.R, wL, wR)
        applyHandTwist(r.hands, hands.L, hands.R, wL, wR)
      }
    } else {
      applyBodyPose(vrm, pose)
      applyHandTwist(r.hands, hands.L, hands.R)
    }

    // 行動の切り替えの途中なら、切り替えた時に見せていた姿勢から混ぜる。混ぜた後の姿勢を、次の切り替えのために覚える（視線・首を足す前・足の高さ合わせの前）
    {
      const sw = this.sw
      const hips = vrm.humanoid.getNormalizedBoneNode('hips')
      for (const b of sw.bones) {
        if (swW > 0) b.node.quaternion.slerp(b.from, swW)
        b.shown.copy(b.node.quaternion)
      }
      if (hips) {
        if (swW > 0) hips.position.lerp(sw.fromHips, swW)
        sw.shownHips.copy(hips.position)
      }
    }

    // --- その場で向きを変える足踏み: 床に残る足を留め、持ち上げた足を次の所へ（turnStepPose.ts。置き場の位置も少し動かす） ---
    applyTurnStepPose(character, vrm, group, this.turnPose, delta)

    // --- 足を地面の高さに合わせる（ラボの外の坂・石段。中の平らな床では何もしない）。跳ぶ姿勢の間は、歩く間の膝を伸ばす直しを弱める ---
    applyFootIk(character, vrm, this.footIk, delta, r.ankleRest, jumpCode ? Math.min(1, (jumpCode.crouch + jumpCode.tuck) * 3) : jw)

    // --- 視線と首: 行動の視線とカメラの方を混ぜ、層が見る先を書き換える（花音はコメントが来たらパネルを見る） ---
    const headBone = getBone(vrm, 'head')
    if (headBone) headBone.getWorldPosition(tmp.head)
    else tmp.head.copy(character.anchors.head)
    camera.getWorldPosition(tmp.target)
    // 層の見る先（付けた順に書き換える）と、注意の強さ（層の max）
    let attend = 0
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]
      if (l.look) attend = Math.max(attend, l.look(tmp.target, f))
    }
    const L = cfg.lookAt
    const clamp = THREE.MathUtils.clamp
    const lerp = THREE.MathUtils.lerp
    tmp.v.subVectors(tmp.target, tmp.head)
    group.getWorldQuaternion(tmp.inv)
    tmp.v.applyQuaternion(tmp.inv.invert())
    // 見る先の向き（体の向きから。左 = +・上 = +）
    const rawYaw = Math.atan2(tmp.v.x, tmp.v.z)
    const rawPitch = Math.atan2(tmp.v.y, Math.hypot(tmp.v.x, tmp.v.z))
    const lookCam = Math.max(pose.lookCamera * (1 - m.walk * 0.7), attend)
    // ふだん（カメラの方）: 首の回せる範囲に収めて、その headFollow 倍だけ首で追う（残りは目）。
    // 注意している間（層の look。kanon.look_at・コメントのパネル）: attendFollow 倍を首で追い、首の範囲（maxYaw・maxPitchUp）を超える分は
    // 胸・腰（spine・chest・upperChest）へ torsoYaw・torsoPitchUp まで分ける。物に手を置く行動・座っている間は胸・腰の分を半分に
    const yawA = clamp(rawYaw * L.attendFollow, -(L.maxYaw + L.torsoYaw), L.maxYaw + L.torsoYaw)
    const pitchA = clamp(rawPitch * L.attendFollow, -L.maxPitchDown, L.maxPitchUp + L.torsoPitchUp)
    const headYawA = clamp(yawA, -L.maxYaw, L.maxYaw)
    const headPitchA = clamp(pitchA, -L.maxPitchDown, L.maxPitchUp)
    const camYaw = lerp(clamp(rawYaw, -L.maxYaw, L.maxYaw) * L.headFollow, headYawA, attend)
    const camPitch = lerp(clamp(rawPitch, -L.maxPitchDown, L.maxPitchUp) * L.headFollow, headPitchA, attend)
    const handsOn = m.action && HANDS_ON.has(m.action) ? m.actionBlend : 0
    const torsoK = attend * (1 - mw) * (1 - 0.5 * handsOn)
    // 立ったままの全身の身ぶりの間は、首の追従を弱めて、モーションの頭の動き（見回す・見上げるなど）を打ち消さない
    const yawT = lerp(pose.headYaw, camYaw, lookCam) * (1 - mw)
    const pitchT = lerp(-pose.headPitch, camPitch, lookCam) * (1 - mw)
    const k = 1 - Math.exp(-delta * L.damping)
    a.headYaw += (yawT - a.headYaw) * k
    a.headPitch += (pitchT - a.headPitch) * k
    // 胸・腰は首より少し遅れて付いてくる
    const kt = 1 - Math.exp(-delta * L.damping * 0.6)
    a.torsoYaw += ((yawA - headYawA) * torsoK - a.torsoYaw) * kt
    a.torsoPitch += ((pitchA - headPitchA) * torsoK - a.torsoPitch) * kt
    if (Math.abs(a.torsoYaw) > 1e-4 || Math.abs(a.torsoPitch) > 1e-4) {
      addBoneRotation(vrm, 'spine', -a.torsoPitch * 0.3, a.torsoYaw * 0.3, 0)
      addBoneRotation(vrm, 'chest', -a.torsoPitch * 0.35, a.torsoYaw * 0.35, 0)
      addBoneRotation(vrm, 'upperChest', -a.torsoPitch * 0.35, a.torsoYaw * 0.35, 0)
    }
    // うなずき（層の分を 0 から足す）
    let nod = 0
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]
      if (l.nod) nod += l.nod(f)
    }
    addBoneRotation(vrm, 'neck', -a.headPitch * 0.4, a.headYaw * 0.4, 0)
    addBoneRotation(vrm, 'head', -a.headPitch * 0.6 + nod, a.headYaw * 0.6, pose.headRoll)
    // 目は vrm.lookAt で（モデルの可動域の設定に従う）。見る先は首（注意している間は胸・腰まで）と同じ範囲に収める
    if (vrm.lookAt) {
      const dist = tmp.v.length() || 1
      const eyeYaw = clamp(rawYaw, -(L.maxYaw + L.torsoYaw * attend), L.maxYaw + L.torsoYaw * attend)
      const eyePitch = clamp(rawPitch, -L.maxPitchDown, L.maxPitchUp + L.torsoPitchUp * attend)
      tmp.v.set(Math.sin(eyeYaw) * Math.cos(eyePitch), Math.sin(eyePitch), Math.cos(eyeYaw) * Math.cos(eyePitch)).multiplyScalar(dist)
      group.getWorldQuaternion(tmp.q)
      lookProxy.position.copy(tmp.v.applyQuaternion(tmp.q)).add(tmp.head)
      // 行動の視線（カメラを見ない分 1 - lookCam）と立ったままの全身の身ぶりの間は、目を頭の向き（顔の正面）へ寄せる（VRM 0.x の正規化したボーンは -Z が前）。
      // 手元を見る行動（頭を下げている）では、目は顔の正面より少し下（手元）へ
      const toHead = Math.max(1 - lookCam, mw)
      const headNode = toHead > 0.001 ? vrm.humanoid.getNormalizedBoneNode('head') : null
      if (headNode) {
        headNode.getWorldQuaternion(tmp.q)
        const down = L.focusDown * clamp(pose.headPitch / 0.3, 0, 1) * (1 - lookCam) * (1 - mw)
        tmp.fwd.set(0, -Math.sin(down), Math.cos(down) * (vrm.meta.metaVersion === '0' ? -1 : 1)).applyQuaternion(tmp.q)
        lookProxy.position.lerp(tmp.fwd.multiplyScalar(dist).add(tmp.head), toHead)
      }
      // 視線の細かい動き（サッカード）: 決まった間隔の乱れで、見る先を少しだけずらす（シーンの時計と決まった乱数。撮影で毎回同じ）
      this.saccade(t, attend)
      const sc = this.sacc
      if (sc.yaw !== 0 || sc.pitch !== 0) {
        group.getWorldQuaternion(tmp.q)
        tmp.fwd.set(1, 0, 0).applyQuaternion(tmp.q)
        lookProxy.position.addScaledVector(tmp.fwd, dist * sc.yaw)
        lookProxy.position.y += dist * sc.pitch
      }
      lookProxy.updateMatrixWorld()
      vrm.lookAt.target = lookProxy
    }

    // --- 姿勢の仕上げ（層の adjust。顔に手を届かせる IK など） ---
    for (let i = 0; i < layers.length; i++) layers[i].adjust?.(f)

    // --- 表情（モデルに無い表情は ch.expressions が飛ばす）: 層の表情 → まばたき ---
    const ex = character.expressions
    for (let i = 0; i < layers.length; i++) layers[i].face?.(f)
    // まばたき（ランダムな間隔。強さは層が決める blinkScale を掛ける（花音は笑顔のときは閉じない））
    if (t > a.nextBlink) {
      a.blinkAt = t
      const [lo, hi] = cfg.idle.blinkInterval
      a.nextBlink = t + lo + ((t * 7.31) % 1) * (hi - lo)
    }
    const bt = t - a.blinkAt
    const blink = bt < 0.16 ? Math.sin((bt / 0.16) * Math.PI) : 0
    ex.set(cfg.blink, blink * ex.blinkScale)

    // 乗り物の車室の中: 揺れもの（おさげ・ペンダント）の先を車室と一緒に運ぶ（車室の動きを慣性で受けない。早送りの緑電・運河バスで、
    // 1 コマに大きく動く車室の分だけおさげが横へ流れていた。§7 の 219）
    const ride = character.ride
    const rideCar = ride.lastCar
    if (ride.attach > 0 && rideCar && this.springCarry !== rideCar.serial) {
      this.springCarry = rideCar.serial
      carrySprings(vrm, rideCar, ride.attach)
    }
    vrm.update(delta)

    // --- 共有する位置と、層の最後（花音はペンダント） ---
    writeAnchors(character.anchors, headBone, getBone(vrm, 'upperChest', 'chest'))
    for (let i = 0; i < layers.length; i++) layers[i].after?.(f)
  }
}

/** 体の位置（頭・胸）を Character の anchors へ書く（頭は頭のボーンの 6cm 上。カメラ・被写界深度・KB-001 などが読む） */
function writeAnchors(an: CharacterAnchors, head: THREE.Object3D | null, chest: THREE.Object3D | null) {
  if (head) {
    head.getWorldPosition(an.head)
    an.head.y += 0.06
  }
  if (chest) chest.getWorldPosition(an.chest)
  an.ready = true
}

const _ma = new THREE.Vector3()
const _mb = new THREE.Vector3()

/** 立った待機姿勢の VRM（足元を床に合わせたあと）から、股関節の高さと腕の長さを測る（character/avatar/body.ts の体の寸法。Character の body へ） */
function measureBody(vrm: VRM, body: BodyMetrics) {
  const node = (n: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(n)
  const leg = node('leftUpperLeg')
  const ua = node('leftUpperArm')
  const uaR = node('rightUpperArm')
  const la = node('leftLowerArm')
  const hand = node('leftHand')
  if (!leg || !ua || !la || !hand) return
  const sceneY = vrm.scene.parent ? vrm.scene.parent.getWorldPosition(_mb).y : 0
  leg.getWorldPosition(_ma)
  const hipHeight = _ma.y - sceneY
  const shoulderAboveHip = ua.getWorldPosition(_mb).y - _ma.y
  const upperArm = ua.getWorldPosition(_ma).distanceTo(la.getWorldPosition(_mb))
  const foreArm = la.getWorldPosition(_ma).distanceTo(hand.getWorldPosition(_mb))
  // 左右の上腕の付け根の間の半分（右の上腕が無ければ既定のまま）
  const half = uaR ? ua.getWorldPosition(_ma).distanceTo(uaR.getWorldPosition(_mb)) / 2 : 0
  if (hipHeight > 0.4 && hipHeight < 1.4 && upperArm > 0.1 && foreArm > 0.1 && shoulderAboveHip > 0.15 && shoulderAboveHip < 0.7) {
    setBodyMetrics(body, { hipHeight, upperArm, foreArm, shoulderAboveHip, ...(half > 0.08 && half < 0.3 ? { shoulderHalf: half } : {}) })
    console.info(
      `[sakurami-cho] 体の寸法: 股関節 ${hipHeight.toFixed(3)}m・肩は股関節の ${shoulderAboveHip.toFixed(3)}m 上・上腕 ${upperArm.toFixed(3)}m・前腕 ${foreArm.toFixed(3)}m・肩の幅の半分 ${body.shoulderHalf.toFixed(3)}m`,
    )
  }
}

const _poseQ = new THREE.Quaternion()

/** ポーズ（正規化ボーンの回転）を設定する */
function applyPose(vrm: VRM, pose: Pose) {
  const q = _poseQ
  for (const name of Object.keys(pose) as VRMHumanBoneName[]) {
    const node = vrm.humanoid.getNormalizedBoneNode(name)
    if (node) node.quaternion.copy(poseQuaternion(pose[name]!, q))
  }
}
