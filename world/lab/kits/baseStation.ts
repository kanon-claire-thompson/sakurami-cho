import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { rectOf } from '../../../core/labPlan'
import { GLOW, PALETTE } from '../../palette'
import { HologramMaterial } from '../../materials/hologram'
import { glowMaterial, overlayGlowMaterial, perforatedMaterial, type LabMaterials } from '../../materials/labMaterials'
import { createOwned, kitChannels, type LabKitBody, type LabKitContext, type LabKitDef, type Owned } from '../kit'
import { cable } from '../parts/cable'
import { bolts, glowBox, glowSprite, matrixInstances, sticker, type BoltsOptions, type GlowBoxOptions, type StickerOptions } from '../parts/details'
import { flowPipe, type FlowPipe, type FlowPipeOptions } from '../parts/flowPipe'
import { annulusGeometry, boltGrid, floorPath, radialMatrices, segmentedRingGeometry } from '../parts/geometry'
import { group, mesh } from '../parts/object'
import { BASE_STATION_RING_Y, BASE_STATION_RING_Z, PLACE, ROOM, type Placement, type Vec3 } from '../../../core/lab/plan'
import type { LabScreen, ScreenDraw } from '../screens'
import { baseStationPlan } from '../../../core/lab/kits/baseStation.plan'
import { drawLinkScreen } from './baseStation.screen'
import { markDynamic } from '../../staticMerge'

/**
 * リンク基地局（設定資料の XW-08 本体。ラボの主役）。
 * 胸のペンダント（クロスワールド・コミュニケーター）の通信を増幅・中継する大型装置。
 * 多層の縦向きリングが互いに逆回転し、中心で通信のコア（グリーン）が光る。
 * 資料（D-052）: 基壇 幅 4.8 × 奥行 1.6 × 高さ 0.25m（北の壁から 0.3m）、外径 3.2m のリングは南を向き、
 * 左（西）にサーバータワー「カストル」・右（東）に「ポルックス」（0.8 × 1.0m・高さ 2.6m。基壇の上）。
 *
 * ローカル座標: 原点 = 奥の壁の面・床・中央、+Z が部屋の内側。
 * リングとコアの形は外径 3.9m で作ってあり、RING_SCALE で外径 3.2m に縮めて置く。
 *
 * 前の zones/BaseStation.tsx を、同じ入れ子・同じ子の順・同じ作る順（部品ごとに hooks の素材と形 → JSX の子の順。子を作ってから群）・
 * 手で書いた数と式のまま three の形にした物（docs/design/map-split.md §6 の「段 4」・4-6）。アンカーと障害物はデータの側（baseStation.plan.ts）。
 * キットの object は単位の行列の群で、中は「置き場所の群（背面板・基壇・タワー ×2・リング・コア・上の吊り金具）・床のケーブル・危険線」
 * （床のケーブルと危険線はワールド座標のまま。前は置き場所の群の外の兄弟）。
 *
 * - channels（BaseStationChannels）: リングの加速（ring・ringBoost）・通信のグリーン（link）・フラッシュ（flash）・演出の脈（pulse）。既定は 0
 *   （配信が無くても待ち受けで回り・脈打つ）。kanon-lab は配信の演出（streamFx・showFx）を読む getter で結び付ける。照明のコアの光もこれを読む。
 *   コアの明るさ（core。既定 1 = 今の明るさ、0 で消灯）と琥珀の混ぜ具合（amber。既定 0 = 緑のまま）で、Qコアの状態（設定資料 vol6 3-8 の
 *   STANDBY・FLUCTUATING・LOST など）を外から決められる。状態ごとの光り方（呼吸・明滅）は使う側が時間で動かして入れる
 * - screens: castor・pollux（320×240・毎秒 12 回）。既定の中身は待機表示（baseStation.screen.ts。channels の link・flash を読む）。
 *   kanon-lab は ON AIR の入った画面（scene/stream/linkStatusScreen.ts）を入れる
 * - 毎コマ（前の購読の順）: カストルの管 → カストルの画面 → ポルックスの管 → ポルックスの画面 → リング → コアのにじみ（カメラを向く）→ コア →
 *   上の管 ×5
 */

/** 基地局の入力の値（既定は 0。読むたびに見る） */
export interface BaseStationChannels {
  /** 起動演出のリングの加速（0〜1。回る速さが 1 + 5 × ring 倍） */
  ring: number
  /** 投げ銭の演出のリングの加速（0〜1。回る速さに 14 × ringBoost を足し、管の流れも速く） */
  ringBoost: number
  /** 通信のグリーン（0〜1。管の色・コアの明るさ・画面の LINK ESTABLISHED） */
  link: number
  /** 接続が確立した瞬間のフラッシュ（0〜1） */
  flash: number
  /** 演出の脈（0〜1） */
  pulse: number
  /**
   * コアの明るさ（0〜1。既定 1 = 今の明るさ、0 = 消灯）。コアの球・光る殻・まわりのエネルギーリング・支柱とハウジングの緑の線・にじみと、
   * 照明のコアの光に掛ける（link・flash・pulse で強めたあとの明るさに掛ける）
   */
  core: number
  /**
   * 琥珀の混ぜ具合（0〜1。既定 0 = 今の色）。コアの緑（PALETTE.comm）と外周リングの表示灯（区切りの表示灯 24 個と縁の光の線。PALETTE.cyan。中間リングのエミッタ 12 個。PALETTE.blue）の色を、
   * 琥珀（PALETTE.amber）へ寄せる（外周の表示灯は白く飛ばないよう、琥珀のぶん少し暗く）。照明のコアの光の色も同じ。設定の LOST（消灯し、外周の表示灯が琥珀色）は core 0・amber 1
   */
  amber: number
}

export const BASE_STATION_CHANNELS: Readonly<BaseStationChannels> = { ring: 0, ringBoost: 0, link: 0, flash: 0, pulse: 0, core: 1, amber: 0 }

const _comm = new THREE.Color(PALETTE.comm)
const _cyan = new THREE.Color(PALETTE.cyan)
const _blue = new THREE.Color(PALETTE.blue)
const _amber = new THREE.Color(PALETTE.amber)
const _c = new THREE.Color()

/** コアの色（琥珀の混ぜ具合 amber で緑から琥珀へ）。out に書いて返す */
function coreColor(amber: number, out: THREE.Color): THREE.Color {
  return amber > 0 ? out.copy(_comm).lerp(_amber, Math.min(1, amber)) : out.copy(_comm)
}

/** 外周の表示灯を琥珀にしたときに明るさを落とす割合（琥珀 1 で 1 − 0.45 倍） */
const AMBER_DIM = 0.45

/** 0〜1 に収める（数でなければ既定の値） */
const unit = (v: number, fallback: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)

/** リングの中心 */
const RING_Y = BASE_STATION_RING_Y
const RING_Z = BASE_STATION_RING_Z
/** 外周リングの半径（形の上の値。置くときは RING_SCALE 倍） */
const R_OUT = 1.95
const R_OUT_IN = 1.72
/** リングとコアの縮尺（外径 3.2m） */
const RING_SCALE = 1.6 / R_OUT
/** 置いたときの外周リングの半径（1.6m） */
const R_RING = R_OUT * RING_SCALE
/** 基壇（ローカル z 0.3〜1.9・高さ 0.25） */
const PLINTH = { w: 4.8, z0: 0.3, z1: 1.9, h: 0.25 }
/** サーバータワー（中心の |x|・幅・奥行き・中心の z・高さ（床から）） */
const TOWER = { x: 2.0, w: 0.8, d: 1.0, z: 1.1, top: 2.6 }
/**
 * 内側リングの銀の縁（innerTrim）を、暗い金属のリング（inner）の前と後ろの面・穴の内側の面より出す量（形の上の値。置くと RING_SCALE 倍で約 1.6mm）。
 * 4-0b で決めた（持ち主が画を見て決めた）: もとは縁の前と後ろの面がリングの面と同じ深さ（z = ±0.06）、穴の内側の面も同じ半径（1.19）にあり、
 * 作る順（material.id）でどちらが見えるかが決まっていた。どの向きから見ても縁が見える形にそろえた（3-4 の目盛りを見せたのと同じ向き）
 */
const TRIM_PROUD = 0.002
/**
 * コアのガラスの球（普通の合成）と光る球（加算）の描く順: ガラスが先、光る球が後。4-0b で決めた。仮（もとの見え方のまま）:
 * 2 つは中心が同じで、three は物の深さを形の外接球の中心で出すので深さが同じになり、別々の物だと描く順が作った順（object.id）で決まっていた。
 * 1 つの物にして形のまとまり（groups）を「ガラス → 光る球」の順にすると、まとまりどうしは深さも id も同じで、three の並べ替えは
 * 安定なので入れた順のまま描かれる。作る順にもカメラの向きにもよらず、ほかの半透明の物との順（renderOrder・深さ）も変えない。
 * 遮りの影（N8AO）は物の material.transparent・material.depthWrite を見て、半透明の物を別に描き分ける（素材の配列にはこの 2 つが無く、
 * 無いと半透明の描き分けのどちらにも入らない）。2 つとも深さを書かない半透明なので、配列にも transparent: true・
 * depthWrite: false を付けて、別々の物だったときと同じ扱い（同じ回数の描画）にする。
 * 4-6 で three の形に移すときに、ほかの書き方も比べたが、この形のまま持ってきた: 2 つの物に分けて renderOrder で順を決めると、
 * ほかの半透明の物（同じ renderOrder 0 の光のにじみ・ホロなど）との順も変わる。2 つの物を作る順で決めると、作る順に頼る形に戻る。
 * 配列に値を付ける代わりに N8AO の userData（cannotReceiveAO）を使う形は、意味の違う印を借りることになる
 */
const CORE_SHELL_ORDER = ['glass', 'hologram'] as const
/** コア本体の球の名前（毎コマ大きさを変える物を群の中から引く） */
const CORE_NAME = 'baseStation:core'
/** ジンバルリングの半径 */
const GIMBAL_R = 0.5
/** 天井の高さ（吊り金具と通信の導管が天井まで上がる） */
const CEIL = ROOM.height

/** 組み立ての間に持ち回る物 */
interface Build {
  mats: LabMaterials
  /** 作った物の控え（共有の素材・キャッシュの発光の素材は控えない） */
  own: Owned
  ch: Readonly<BaseStationChannels>
  ctx: LabKitContext
}

/* -------------------------------------------------------------------------- */
/* 作り手（作った形・素材を控える）                                              */
/* -------------------------------------------------------------------------- */

/** 作った形（JSX の <boxGeometry> など）を控える */
const geo = <G extends THREE.BufferGeometry>(b: Build, g: G): G => b.own.add(g)

/** GlowBox（形は作った物、素材はキャッシュの発光の素材） */
function glowBoxOwned(b: Build, o: GlowBoxOptions): THREE.Mesh {
  const m = glowBox(o)
  b.own.add(m.geometry)
  return m
}

/** Bolts（形と InstancedMesh は作った物、素材は共有） */
function boltsOwned(b: Build, o: BoltsOptions): THREE.InstancedMesh {
  const m = bolts(o, b.mats)
  b.own.add(m.geometry)
  return b.own.add(m)
}

/** Sticker（形と素材は作った物、絵はキャッシュ） */
function stickerOwned(b: Build, o: StickerOptions): THREE.Mesh {
  return b.own.mesh(sticker(o))
}

/** MatrixInstances（InstancedMesh を控える。形と素材は渡した側） */
function matrixOwned(b: Build, matrices: readonly THREE.Matrix4[], geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh {
  return b.own.add(matrixInstances({ matrices, geometry, material }))
}

/** FlowPipe（基地局の channels を読む） */
function pipeOwned(b: Build, o: FlowPipeOptions): FlowPipe {
  return b.own.add(flowPipe(o, b.mats, b.ch))
}

/* -------------------------------------------------------------------------- */

/** 回転するリング群 */
function rings(b: Build) {
  const { mats } = b
  const geoms = {
    outer: geo(b, annulusGeometry(R_OUT, R_OUT_IN, 0.34, 0.02, 160)),
    outerLip: geo(b, annulusGeometry(R_OUT + 0.02, R_OUT - 0.04, 0.38, 0.01, 160)),
    middle: geo(b, segmentedRingGeometry(1.62, 1.47, 0.14, 12, 0.07)),
    inner: geo(b, annulusGeometry(1.32, 1.2, 0.1, 0.01, 128)),
    innerTrim: geo(b, annulusGeometry(1.215, 1.19 - TRIM_PROUD, 0.12 + TRIM_PROUD * 2, 0, 128)),
    node: geo(b, new THREE.BoxGeometry(0.1, 0.16, 0.08)),
    nodeFace: geo(b, new THREE.BoxGeometry(0.03, 0.08, 0.01)),
    tick: geo(b, new THREE.BoxGeometry(0.012, 0.06, 0.008)),
    segLight: geo(b, new THREE.BoxGeometry(0.12, 0.01, 0.01)),
  }

  // 外周リングの縁の光の線・区切りの表示灯・中間リングのエミッタは、琥珀の混ぜ具合（amber）で色を変えるので、キャッシュの発光の素材の写しを持つ（既定の色は同じ）
  const lipGlow = b.own.add(glowMaterial(PALETTE.cyan, GLOW.strong).clone())
  const NODE_GLOW = 2.6
  const nodeGlow = b.own.add(glowMaterial(PALETTE.blue, NODE_GLOW).clone())
  // 配信カメラでは頭の後ろを通るので、にじまない程度に抑える
  const tickGlow = glowMaterial(PALETTE.cyan, 1.1)
  // 内側リングの目盛りは、リングの前の面とぴったり同じ深さ（z = 0.060）。作る順によらず面より手前に描く
  const tickOverlay = overlayGlowMaterial(PALETTE.cyan, 1.1)
  const SEG_GLOW = 2.2
  const segGlow = b.own.add(glowMaterial(PALETTE.cyan, SEG_GLOW).clone())

  // 外周リング前面の区切りライト（24 個）
  const segLights = radialMatrices(24, 1.835, 0.175, [1, 1, 1], Math.PI / 24).map((m) => {
    // 接線方向に向ける
    const r = new THREE.Matrix4().makeRotationZ(Math.PI / 2)
    return m.multiply(r)
  })
  // 中間リングのエミッタノード（12 個）
  const nodes = radialMatrices(12, 1.545, 0.1)
  const nodeFaces = radialMatrices(12, 1.545, 0.146)
  // 内側リングの目盛り（72 個）
  const ticks = radialMatrices(72, 1.26, 0.056).map((m, i) => (i % 6 === 0 ? m.multiply(new THREE.Matrix4().makeScale(1.6, 1.8, 1)) : m))
  // 外周リングを留めるボルト
  const ringBolts = radialMatrices(48, 1.93 - 0.06, 0.18).map((m) => {
    const p = new THREE.Vector3().setFromMatrixPosition(m)
    return [p.x, p.y, p.z] as Vec3
  })

  const object = group(
    [
      // 外周リング（固定）
      mesh(geoms.outer, mats.darkMetal, { cast: true, receive: true }),
      mesh(geoms.outerLip, mats.blackMetal, { receive: true, s: [1, 1, 1] }),
      mesh(geo(b, new THREE.TorusGeometry(R_OUT_IN + 0.004, 0.011, 8, 180)), lipGlow, { p: [0, 0, 0.12] }),
      matrixOwned(b, segLights, geoms.segLight, segGlow),
      boltsOwned(b, { positions: ringBolts, axis: 'z', radius: 0.011 }),

      // 中間リング（時計回り）
      group(
        [
          mesh(geoms.middle, mats.steel, { cast: true, receive: true }),
          matrixOwned(b, nodes, geoms.node, mats.blackMetal),
          matrixOwned(b, nodeFaces, geoms.nodeFace, nodeGlow),
        ],
        { p: [0, 0, 0.1] },
      ),

      // 内側リング（反時計回り）
      group(
        [
          mesh(geoms.inner, mats.darkMetal, { receive: true }),
          mesh(geoms.innerTrim, mats.chrome),
          matrixOwned(b, ticks, geoms.tick, tickOverlay),
        ],
        { p: [0, 0, 0.14] },
      ),

      // ジンバルリング（縦軸まわりに回る）。真横を向いたときに縦線になるので、
      // 配信カメラで頭の後ろにかからないようコアのまわりに収まる大きさにしている
      group([
        mesh(geo(b, new THREE.TorusGeometry(GIMBAL_R, 0.018, 12, 128)), mats.steel),
        ...[0, 1, 2, 3].map((i) =>
          mesh(geo(b, new THREE.SphereGeometry(0.03, 12, 12)), tickGlow, {
            p: [Math.cos((i * Math.PI) / 2) * GIMBAL_R, Math.sin((i * Math.PI) / 2) * GIMBAL_R, 0],
          }),
        ),
      ]),
    ],
    { p: [0, RING_Y, RING_Z], s: RING_SCALE },
  )
  const [middle, inner, gimbal] = object.children.slice(5) as [THREE.Group, THREE.Group, THREE.Group]
  // 回るリング（動かない物を合わせるときの体。world/staticMerge.ts）
  markDynamic(middle, inner, gimbal)

  let segAmber = 0
  return {
    object,
    update(dt: number) {
      // 配信の起動演出でリングが加速する（ring: 0〜1）
      // 投げ銭の演出（ringBoost）では一気に加速する
      const boost = 1 + b.ch.ring * 5 + b.ch.ringBoost * 14
      middle.rotation.z -= dt * 0.12 * boost
      inner.rotation.z += dt * 0.2 * boost
      gimbal.rotation.y += dt * 0.35 * boost
      // 外周の表示灯（区切りの表示灯・縁の光の線・中間リングのエミッタ 12 個）: 琥珀の混ぜ具合で、シアンから琥珀へ（変わったときだけ書く）。
      // 琥珀は明るいと白く飛んで琥珀に見えないので、琥珀のぶん明るさを落とす（琥珀 1 で 0.55 倍）
      const amber = unit(b.ch.amber, 0)
      if (amber !== segAmber) {
        segAmber = amber
        const dim = 1 - AMBER_DIM * amber
        segGlow.color.copy(_cyan).lerp(_amber, amber).multiplyScalar(SEG_GLOW * dim)
        lipGlow.color.copy(_cyan).lerp(_amber, amber).multiplyScalar(GLOW.strong * dim)
        nodeGlow.color.copy(_blue).lerp(_amber, amber).multiplyScalar(NODE_GLOW * dim)
      }
    },
  }
}

/** 中心のコア（通信 = グリーン） */
function core(b: Build) {
  const { mats, own } = b
  const coreMat = own.add(glowMaterial(PALETTE.comm, GLOW.core).clone())
  // まわりの緑の線（エネルギーリング・支柱とハウジングの線）は、コアの明るさ（core）と琥珀の混ぜ具合（amber）で変えるので、
  // キャッシュの発光の素材の写しを持つ（既定の色は同じ）
  const commGlow = own.add(glowMaterial(PALETTE.comm, GLOW.strong).clone())
  const commSoft = own.add(glowMaterial(PALETTE.comm, GLOW.strip).clone())
  const glassShell = own.add(
    new THREE.MeshPhysicalMaterial({
      color: '#0a1a12',
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      clearcoat: 1,
    }),
  )
  const HOLO_INTENSITY = 1.2
  const holo = own.add(
    new HologramMaterial({ color: PALETTE.comm, intensity: HOLO_INTENSITY, base: 0.0, fresnelStrength: 1, fresnelPower: 3, scanDensity: 200, sweep: 0.2, flicker: 0.1 }),
  )
  // ガラスの球と光る球を 1 つの物にまとめる。まとまりの順（CORE_SHELL_ORDER）= 描く順
  const shell = (() => {
    const parts = {
      glass: { radius: 0.34, material: glassShell },
      hologram: {
        radius: 0.37,
        material: holo,
      },
    }
    const spheres = CORE_SHELL_ORDER.map((k) => new THREE.SphereGeometry(parts[k].radius, 48, 32))
    const geometry = own.add(mergeGeometries(spheres, true))
    for (const g of spheres) g.dispose()
    const materials = Object.assign(
      CORE_SHELL_ORDER.map((k) => parts[k].material),
      { transparent: true, depthWrite: false },
    )
    return { geometry, materials }
  })()

  // 支柱（外周リング → コアのハウジング、固定）
  const struts = [45, 135, 225, 315].map((deg) => THREE.MathUtils.degToRad(deg))

  const object = group(
    [
      ...struts.map((a) =>
        group(
          [
            mesh(geo(b, new THREE.BoxGeometry(R_OUT_IN - 0.55, 0.12, 0.12)), mats.darkMetal, { p: [(R_OUT_IN + 0.55) / 2, 0, -0.1], cast: true }),
            mesh(geo(b, new THREE.BoxGeometry(R_OUT_IN - 0.7, 0.012, 0.008)), commSoft, { p: [(R_OUT_IN + 0.55) / 2, 0, -0.035] }),
          ],
          { r: [0, 0, a] },
        ),
      ),
      // ハウジング
      mesh(geo(b, new THREE.CylinderGeometry(0.56, 0.62, 0.5, 64)), mats.darkMetal, { p: [0, 0, -0.28], r: [Math.PI / 2, 0, 0], cast: true, receive: true }),
      mesh(geo(b, new THREE.TorusGeometry(0.52, 0.05, 16, 96)), mats.steel, { p: [0, 0, -0.02] }),
      mesh(geo(b, new THREE.TorusGeometry(0.455, 0.006, 8, 96)), commSoft, { p: [0, 0, -0.02] }),
      // コア本体
      mesh(geo(b, new THREE.SphereGeometry(0.24, 48, 32)), coreMat, { p: [0, 0, 0.06], name: CORE_NAME }),
      // ガラスの球（r 0.34）と光る球（r 0.37）。1 つの物の 2 つのまとまりで、ガラスが先・光る球が後（CORE_SHELL_ORDER）
      mesh(shell.geometry, shell.materials, { p: [0, 0, 0.06] }),
      // コアのまわりを回るエネルギーリング
      group(
        [
          mesh(geo(b, new THREE.TorusGeometry(0.31, 0.005, 8, 96)), commGlow),
          mesh(geo(b, new THREE.TorusGeometry(0.4, 0.004, 8, 96)), commGlow, { r: [Math.PI / 2, 0, 0] }),
          mesh(geo(b, new THREE.TorusGeometry(0.44, 0.003, 8, 96)), commSoft, { r: [Math.PI / 3, 0, 0] }),
        ],
        { p: [0, 0, 0.06] },
      ),
    ],
    { p: [0, RING_Y, RING_Z], s: RING_SCALE },
  )
  const coreMesh = object.getObjectByName(CORE_NAME)!
  const energyRings = object.children[object.children.length - 1]!
  // 脈打つコアと回るエネルギーリング（動く物）
  markDynamic(coreMesh, ...energyRings.children)
  const SPRITE_OPACITY = 0.38
  const sprite = glowSprite({ position: [0, 0, 0.3], size: 1.7, color: PALETTE.comm, opacity: SPRITE_OPACITY })
  const spriteMesh = own.mesh(sprite.inner.children[0] as THREE.Mesh)
  const spriteMat = spriteMesh.material as THREE.MeshBasicMaterial
  object.add(sprite.object)
  // まわりの物の明るさと色（コアの明るさ・琥珀の混ぜ具合が変わったときだけ書く。既定の 1・0 では作ったときのまま）
  let lit = { core: 1, amber: 0 }
  const relight = (level: number, amber: number) => {
    if (level === lit.core && amber === lit.amber) return
    lit = { core: level, amber }
    const c = coreColor(amber, _c)
    commGlow.color.copy(c).multiplyScalar(GLOW.strong * level)
    commSoft.color.copy(c).multiplyScalar(GLOW.strip * level)
    holo.color = c
    holo.intensity = HOLO_INTENSITY * level
    spriteMat.color.copy(c)
    spriteMat.opacity = SPRITE_OPACITY * level
  }

  return {
    object,
    /** コアのまわりのにじみ（カメラを向く。コアの更新より前に呼ぶ） */
    sprite,
    update(dt: number, t: number) {
      const pulse = 1 + Math.sin(t * 1.3) * 0.12 + Math.max(0, Math.sin(t * 0.45)) ** 16 * 0.6
      // 通信リンクが確立すると少し明るくなり、確立の瞬間にフラッシュする。コアの明るさ（core）を掛け、色は琥珀の混ぜ具合（amber）で
      const level = unit(b.ch.core, 1)
      const amber = unit(b.ch.amber, 0)
      coreColor(amber, coreMat.color).multiplyScalar(GLOW.core * pulse * (1 + b.ch.link * 0.35 + b.ch.flash * 1.6 + b.ch.pulse * 1.4) * level)
      relight(level, amber)
      coreMesh.scale.setScalar(1 + Math.sin(t * 1.3) * 0.02)
      const [a, c1, c] = energyRings.children as [THREE.Object3D, THREE.Object3D, THREE.Object3D]
      a.rotation.x += 0.9 * dt
      c1.rotation.y += 1.3 * dt
      c.rotation.x -= 0.7 * dt
      c.rotation.y += 0.5 * dt
    },
  }
}

/** サーバータワー カストル（西）・ポルックス（東）。基壇の上に立つ（冷却フィン・ステータス画面・シアンの縦ライン） */
function pylon(b: Build, side: -1 | 1, idle: ScreenDraw) {
  const { mats, own } = b
  const x = side * TOWER.x
  const W = TOWER.w
  const D = TOWER.d
  const Y0 = PLINTH.h
  const HGT = TOWER.top - PLINTH.h
  const zC = TOWER.z
  const front = zC + D / 2
  const screen = own.add(b.ctx.screens(side < 0 ? 'castor' : 'pollux', 320, 240, idle, 12))

  const finGeom = geo(b, new THREE.BoxGeometry(W - 0.16, 0.012, 0.07))
  const sideFinGeom = geo(b, new THREE.BoxGeometry(0.07, 0.012, D - 0.2))
  // 前面の上の冷却フィン（画面と LED の上から天板の下まで）と、外側の面のフィン
  const fins: THREE.Matrix4[] = []
  for (let y = 1.98; y < TOWER.top - 0.12; y += 0.07) fins.push(new THREE.Matrix4().makeTranslation(x, y, front + 0.035))
  const sideFins: THREE.Matrix4[] = []
  for (let y = 0.7; y < TOWER.top - 0.15; y += 0.07) sideFins.push(new THREE.Matrix4().makeTranslation(x + side * (W / 2 + 0.035), y, zC))
  // ステータス LED の列の素材（前は JSX の値で、部品を作る前に引いていた）
  const ledMats = Array.from({ length: 8 }, (_, i) => (i < 6 ? glowMaterial(PALETTE.cyan, 2.4) : glowMaterial(PALETTE.blue, 1.2)))

  const children: THREE.Object3D[] = []
  children.push(mesh(geo(b, new THREE.BoxGeometry(W, HGT, D)), mats.darkMetal, { p: [x, Y0 + HGT / 2, zC], cast: true, receive: true }))
  // 前面の化粧パネル
  children.push(mesh(geo(b, new THREE.BoxGeometry(W - 0.12, 1.3, 0.03)), mats.blackMetal, { p: [x, Y0 + 0.75, front + 0.015], receive: true }))
  children.push(matrixOwned(b, fins, finGeom, mats.steel))
  children.push(matrixOwned(b, sideFins, sideFinGeom, mats.darkMetal))
  // ステータス画面（通信状態なのでグリーン）
  const screenGeom = geo(b, new THREE.PlaneGeometry(0.52, 0.39))
  const screenMat = own.add(
    new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffffff', emissiveMap: screen.texture, emissiveIntensity: 1.15, roughness: 0.2, toneMapped: false }),
  )
  children.push(mesh(screenGeom, screenMat, { p: [x, 1.3, front + 0.032] }))
  children.push(
    stickerOwned(b, {
      text: side < 0 ? 'CASTOR' : 'POLLUX',
      sub: 'SERVER TOWER // XW-08',
      position: [x, 0.72, front + 0.032],
      width: 0.34,
      aspect: 2.6,
      background: '#0d1218',
      color: '#9fb4c8',
      font: 'display',
    }),
  )
  // リング側のスリット
  children.push(glowBoxOwned(b, { position: [x - side * (W / 2 + 0.004), Y0 + HGT / 2, zC + 0.3], size: [0.008, HGT - 0.4, 0.03], color: PALETTE.cyan, intensity: GLOW.strip }))
  children.push(glowBoxOwned(b, { position: [x - side * (W / 2 + 0.004), Y0 + HGT / 2, zC - 0.3], size: [0.008, HGT - 0.4, 0.03], color: PALETTE.blue, intensity: 2.4 }))
  // 天板の段と、前面の縦の継ぎ目
  children.push(mesh(geo(b, new THREE.BoxGeometry(W - 0.1, 0.08, D - 0.1)), mats.blackMetal, { p: [x, Y0 + HGT + 0.04, zC], cast: true }))
  for (const s of [-1, 1]) {
    children.push(mesh(geo(b, new THREE.BoxGeometry(0.012, HGT - 0.1, 0.006)), mats.blackMetal, { p: [x + s * (W / 2 - 0.06), Y0 + HGT / 2, front + 0.002] }))
  }
  // 外側の縦に流れるエネルギー管
  const pipe = pipeOwned(b, {
    points: [
      [x + side * (W / 2 - 0.02), Y0 + 0.1, front + 0.06],
      [x + side * (W / 2 - 0.02), Y0 + HGT - 0.1, front + 0.06],
    ],
    radius: 0.03,
    color: PALETTE.cyan,
    linkColor: PALETTE.comm,
    spacing: 0.7,
    speed: 0.9,
    collarSpacing: 0.6,
  })
  children.push(pipe.object)
  // ステータス LED の列
  for (let i = 0; i < 8; i++) {
    children.push(mesh(geo(b, new THREE.BoxGeometry(0.03, 0.012, 0.004)), ledMats[i]!, { p: [x - side * 0.22, 1.56 + i * 0.05, front + 0.004] }))
  }
  // リングを留めるクランプ（リングの外周とタワーの内側の面の間）
  children.push(mesh(geo(b, new THREE.BoxGeometry(0.2, 0.5, 0.42)), mats.blackMetal, { p: [side * (R_RING + 0.02), RING_Y, RING_Z], cast: true }))
  children.push(boltsOwned(b, { positions: boltGrid([side * (R_RING + 0.02), RING_Y, RING_Z + 0.212], 0.12, 0.38, 'xy', 2, 3), axis: 'z', radius: 0.014 }))
  children.push(boltsOwned(b, { positions: boltGrid([x, Y0 + 0.75, front + 0.031], W - 0.2, 1.2, 'xy', 2, 4), axis: 'z', radius: 0.012 }))

  return { object: group(children), pipe, screen }
}

/** 基壇（資料: 幅 4.8 × 奥行 1.6 × 高さ 0.25m。2 段 + 縁の LED。リングは上の段の受けに載る） */
function plinth(b: Build): THREE.Group {
  const { mats, own } = b
  const grating = own.add(perforatedMaterial(mats, 10, 2))
  for (const t of [grating.alphaMap, grating.normalMap]) if (t) own.add(t)
  const zc = (PLINTH.z0 + PLINTH.z1) / 2
  const d = PLINTH.z1 - PLINTH.z0
  return group([
    mesh(geo(b, new THREE.BoxGeometry(PLINTH.w, 0.13, d)), mats.darkMetal, { p: [0, 0.065, zc], receive: true, cast: true }),
    mesh(geo(b, new THREE.BoxGeometry(PLINTH.w - 0.3, PLINTH.h - 0.13, d - 0.2)), mats.blackMetal, { p: [0, 0.19, zc - 0.05], receive: true, cast: true }),
    // 段の縁の LED は、配信画面を横切る明るい線にならないよう控えめな破線にしている
    ...Array.from({ length: 9 }, (_, i) =>
      glowBoxOwned(b, { position: [-2.0 + i * 0.5, 0.11, PLINTH.z1 + 0.004], size: [0.22, 0.006, 0.006], color: PALETTE.cyan, intensity: 1.0 }),
    ),
    // リングの受け（上の段の上）
    mesh(geo(b, new THREE.BoxGeometry(0.7, 0.1, 0.5)), mats.blackMetal, { p: [0, PLINTH.h + 0.05, RING_Z], cast: true }),
    glowBoxOwned(b, { position: [0, PLINTH.h + 0.05, RING_Z + 0.252], size: [0.5, 0.006, 0.006], color: PALETTE.blue, intensity: 1.6 }),
    // 床下のケーブルピットのグレーチング（リングの前）
    mesh(geo(b, new THREE.PlaneGeometry(2.4, 0.4)), grating, { p: [0, PLINTH.h + 0.003, PLINTH.z1 - 0.32], r: [-Math.PI / 2, 0, 0] }),
    glowBoxOwned(b, { position: [0, PLINTH.h - 0.017, PLINTH.z1 - 0.32], size: [2.3, 0.004, 0.36], color: PALETTE.blue, intensity: 0.6 }),
    stickerOwned(b, {
      text: 'CROSS-WORLD LINK STATION',
      sub: 'XW-08 // HIGH VOLTAGE // KANON C. THOMPSON',
      position: [0, 0.06, PLINTH.z1 + 0.003],
      width: 1.4,
      aspect: 12,
      background: 'transparent',
      color: '#8fa3b8',
      font: 'display',
    }),
  ])
}

/** 背面板と放射状の冷却フィン */
function backplate(b: Build): THREE.Group {
  const { mats } = b
  const finGeom = geo(b, new THREE.BoxGeometry(0.46, 0.028, 0.22))
  const fins = radialMatrices(64, 2.24, 0.2)
  // 外径 5m で作った背面板を、リングの中心の高さ（床まで）に収まる大きさにする
  return group(
    [
      mesh(geo(b, new THREE.CylinderGeometry(2.5, 2.5, 0.1, 96)), mats.darkMetal, { p: [0, 0, 0.05], r: [Math.PI / 2, 0, 0], receive: true }),
      matrixOwned(b, fins, finGeom, mats.blackMetal),
      ...[1.05, 1.45, 1.85].map((r) => mesh(geo(b, new THREE.TorusGeometry(r, 0.02, 6, 128)), mats.blackMetal, { p: [0, 0, 0.105] })),
    ],
    { p: [0, RING_Y, 0], s: [(RING_Y - 0.05) / 2.5, (RING_Y - 0.05) / 2.5, 1] },
  )
}

/** 上部の吊り金具と通信の導管（グリーン） */
function topAssembly(b: Build) {
  const { mats } = b
  const children: THREE.Object3D[] = []
  children.push(
    mesh(geo(b, new THREE.BoxGeometry(0.42, CEIL - (RING_Y + R_RING) + 0.1, 0.4)), mats.blackMetal, { p: [0, (RING_Y + R_RING + CEIL) / 2, RING_Z], cast: true }),
  )
  for (const x of [-0.27, 0.27]) {
    children.push(mesh(geo(b, new THREE.CylinderGeometry(0.03, 0.03, CEIL - (RING_Y + R_RING), 12)), mats.steel, { p: [x, (RING_Y + R_RING + CEIL) / 2, RING_Z] }))
  }
  const pipes: FlowPipe[] = []
  // 通信の導管：コアの裏から天井へ
  pipes.push(
    pipeOwned(b, {
      points: [
        [0, RING_Y + 0.3, 0.42],
        [0, RING_Y + 1.6, 0.42],
        [0, RING_Y + 3.0, 0.42],
        [0, CEIL, 0.42],
      ],
      radius: 0.07,
      color: PALETTE.comm,
      linkColor: PALETTE.comm,
      spacing: 0.5,
      speed: 1.2,
      collarSpacing: 0.45,
    }),
  )
  // エネルギーパイプ：タワーの上からリングの上の吊り金具へ（リングの後ろを通る）
  for (const s of [-1, 1]) {
    pipes.push(
      pipeOwned(b, {
        points: [
          [s * TOWER.x, TOWER.top + 0.04, 0.8],
          [s * (TOWER.x - 0.15), TOWER.top + 0.5, 0.78],
          [s * 1.1, RING_Y + R_RING + 0.2, 0.8],
          [s * 0.25, RING_Y + R_RING + 0.22, 0.85],
        ],
        radius: 0.05,
        color: PALETTE.blue,
        linkColor: PALETTE.comm,
        spacing: 0.45,
        speed: 0.7,
        collarSpacing: 0.6,
      }),
    )
  }
  // エネルギーパイプ：基壇からタワーの前を上がってクランプへ
  for (const s of [-1, 1]) {
    pipes.push(
      pipeOwned(b, {
        points: [
          [s * 0.95, PLINTH.h + 0.03, PLINTH.z1 - 0.12],
          [s * 1.3, PLINTH.h + 0.15, PLINTH.z1 - 0.1],
          [s * 1.52, 0.9, TOWER.z + TOWER.d / 2 + 0.08],
          [s * 1.55, 1.4, TOWER.z + TOWER.d / 2 + 0.06],
          [s * (R_RING + 0.02), RING_Y - 0.28, RING_Z + 0.24],
        ],
        radius: 0.045,
        color: PALETTE.cyan,
        linkColor: PALETTE.comm,
        spacing: 0.4,
        speed: 0.9,
        collarSpacing: 0.35,
      }),
    )
  }
  for (const p of pipes) children.push(p.object)
  return { object: group(children), pipes }
}

/** 床を這う太いケーブル（ワールド座標。基壇の縁から各ゾーンへ） */
function floorCables(b: Build): THREE.Group {
  const { mats } = b
  const r1 = 0.04
  const r2 = 0.028
  // 基壇の前の縁と左右の縁（ワールドの z・x）
  const z1 = ROOM.north + PLINTH.z1
  const zMid = ROOM.north + (PLINTH.z0 + PLINTH.z1) / 2
  const xs = PLINTH.w / 2
  const c = (points: Vec3[], radius: number) => {
    const m = cable({ points, radius, material: mats.rubber })
    geo(b, m.geometry)
    return m
  }
  return group([
    // 立ち位置へ
    c(floorPath(r1, [0.75, z1], [0.95, z1 + 0.9], [1.2, z1 + 2.0]), r1),
    c(floorPath(r1, [1.15, z1], [1.45, z1 + 0.9], [1.65, z1 + 1.95]), r1),
    // 開発デスクへ
    c(floorPath(r1, [xs, zMid], [3.2, zMid + 0.5], [3.55, 0.9], [3.7, 2.6], [4.0, 3.85]), r1),
    c(floorPath(r2, [xs, zMid + 0.15], [3.1, zMid + 0.7], [3.4, 1.0], [3.52, 2.7], [3.8, 3.85]), r2),
    // 工作ゾーンへ
    c(floorPath(r1, [-xs, zMid], [-3.3, zMid + 0.35], [-4.6, -1.25], [-6.3, -1.3], [-7.35, 0.35]), r1),
    // ホロテーブルへ（仮: 行き先はホロテーブルの置き場所のデータ。表からホロテーブルを外しても、ケーブルはそのまま）
    c(floorPath(r2, [-0.6, z1], [-0.55, z1 + 1.1], [-0.35, PLACE.holoTable.position[2] - 0.5]), r2),
  ])
}

/**
 * 床の危険線（資料: 黄色の破線。リングの外周から 1.5m。x ±3.9・北の壁の手前から z = 1.06 まで）。
 * 見学者はこの外を歩く（花音の通り道も、配信ではこの外。baseStation.plan.ts の障害物「危険線の内側」）
 */
function dangerLine(b: Build): THREE.InstancedMesh {
  const paint = b.own.add(
    new THREE.MeshStandardMaterial({ color: '#e8b923', roughness: 0.7, metalness: 0, emissive: '#e8b923', emissiveIntensity: 0.08, polygonOffset: true, polygonOffsetFactor: -2 }),
  )
  const r = rectOf('危険線（黄色の破線）')
  const dashes: THREE.Matrix4[] = []
  const W = 0.06
  const DASH = 0.3
  const GAP = 0.2
  const edge = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const n = Math.floor((len + GAP) / (DASH + GAP))
    const pad = (len - (n * (DASH + GAP) - GAP)) / 2
    const along = x1 !== x0
    for (let i = 0; i < n; i++) {
      const t = (pad + i * (DASH + GAP) + DASH / 2) / len
      const m = new THREE.Matrix4().makeTranslation(x0 + (x1 - x0) * t, 0.0016, z0 + (z1 - z0) * t)
      m.multiply(new THREE.Matrix4().makeScale(along ? DASH : W, 1, along ? W : DASH))
      dashes.push(m)
    }
  }
  // 南の辺と東西の辺（北の辺は基壇の裏で、壁際なので引かない）
  edge(r.min[0], r.max[1], r.max[0], r.max[1])
  edge(r.min[0], r.min[1], r.min[0], r.max[1])
  edge(r.max[0], r.min[1], r.max[0], r.max[1])
  const geom = geo(b, new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
  return matrixOwned(b, dashes, geom, paint)
}

/* -------------------------------------------------------------------------- */

export function createBaseStation(at: Placement, _opts: object | undefined, ctx: LabKitContext): LabKitBody<BaseStationChannels> {
  const own = createOwned()
  const channels = kitChannels<BaseStationChannels>({ ...BASE_STATION_CHANNELS })
  const b: Build = { mats: ctx.materials, own, ch: channels.channels, ctx }
  // 画面の既定の中身: 待機表示（基地局の channels の link・flash を読む）
  const idle: ScreenDraw = (c, t, w, h) => drawLinkScreen(c, t, w, h, b.ch)

  // 作る順は前の JSX のまま（置き場所の群の中: 背面板・基壇・カストル・ポルックス・リング・コア・上の吊り金具。そのあと床のケーブル・危険線）
  const back = backplate(b)
  const base = plinth(b)
  const castor = pylon(b, -1, idle)
  const pollux = pylon(b, 1, idle)
  const ring = rings(b)
  const coreParts = core(b)
  const top = topAssembly(b)
  const station = group([back, base, castor.object, pollux.object, ring.object, coreParts.object, top.object], { p: at.position, ry: at.rotationY })
  const cables = floorCables(b)
  const danger = dangerLine(b)
  // キットの物は単位の行列の群（床のケーブルと危険線はワールド座標のまま）
  const object = group([station, cables, danger])

  const screens: Record<string, LabScreen> = { castor: castor.screen, pollux: pollux.screen }
  return {
    object,
    update(dt, f) {
      // 前の購読の順（子が先・親が後）: タワーごとに管 → 画面、リング、コアのにじみ → コア、上の管
      castor.pipe.update()
      castor.screen.update(dt, f.camera)
      pollux.pipe.update()
      pollux.screen.update(dt, f.camera)
      ring.update(dt)
      coreParts.sprite.update(f.camera)
      coreParts.update(dt, f.time)
      for (const p of top.pipes) p.update()
    },
    screens,
    channels,
    dispose: () => own.dispose(),
  }
}

export const baseStationKit: LabKitDef<object, BaseStationChannels> = {
  kind: 'baseStation',
  plan: baseStationPlan,
  create: createBaseStation,
}
