import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  int,
  length,
  max,
  mix,
  normalWorld,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  select,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
} from 'three/tsl'
import { CABLE_STATIONS, stationHeading, stationScene, type CableStationZone } from '../../../core/cableStations'
import { SITE } from '../../../core/town'
import { townEvents, townFocus } from '../../townHost'
import { interiors } from '../interior/interiors'
import { oNoise, outdoorHaze, outdoorUniforms, skyColor, unlit, withUniforms } from '../materials'
import { GeoBuilder } from '../site/builder'
import { townLight } from '../town/facades'
import { townLamps } from '../town/lamps'
import { townShadow } from '../town/shadows'
import { markPaint, outdoorPaint, paintEmit, paintFlat } from '../paint'
import { boatNet } from './boats'
import { cableTrack } from './cable'
import { CABLE_RUN, CABLE_TRIPS, cableTrip, tripStart } from '../../../core/transit/cableRun'
import { LANDING, landingPoint, topA, type BoatLanding } from './landings'
import { TRAM_PLATFORM, tramNet, tramPlatformTop, type TramPlatform } from './trams'

/**
 * 駅員ロボ「えきもり」（町営交通の案内ロボット。docs/design/town.md §20・§7 の 199）: 丘ノ上ケーブルの 3 駅のホーム・緑電の主な停留所のホーム・
 * 運河バスの乗り場の石段の上に 1 体ずつ立つ。設定では家庭用の浮遊ロボットは浮遊機器法で外を自由に飛べないので、駅員は床を走る車輪の型
 * （浮かない）。町営交通の色（ひらき緑とクリーム、真鍮）に、乗り物ごとの襟の色（ケーブル = 赤・緑電 = 山吹・運河バス = 紺）。目は電球色の
 * 2 つの灯り（シアンはラボだけ）。胸に名前の札（「えきもり」と駅・停留所の名前）。
 *
 * 動き: 待つ間は体をわずかに揺らし、頭をゆっくり左右に振ってまばたき。花音が 3m に近づくと会釈（小さな電子の音）し、近くにいる間は花音の方を見る。
 * 自分の駅・停留所・乗り場から乗り物が出る少し前に、右手の合図灯（緑の丸い板）を上げて発車の合図（やわらかい 3 つの音）。
 * 駅の中（ケーブルの駅の部屋）では、建物の中の光（interior/interiors.ts の lightAt）で照らす。
 * 花音は地図の注目点（townFocus）。会釈と発車の合図は出来事（robot.bow・robot.signal。townHost.ts）で知らせ、音は聞いた側が鳴らす。
 */

const LAB = SITE.labFloorElevation

type Kind = 'cable' | 'tram' | 'waterbus'

interface RobotSpot {
  id: string
  kind: Kind
  /** 合図を見る乗り場（ケーブルの駅のゾーン・緑電の停留所の名前・運河バスの乗り場の id） */
  key: string
  /** 名前の札の 2 行目 */
  label: string
  /** シーンの位置（足元）と向き（heading） */
  x: number
  y: number
  z: number
  heading: number
  /** 線路・水の向き（合図のときに頭を向ける。heading） */
  look: number
  /** 名前の札の行・襟の色の番号 */
  row: number
  band: number
  seed: number
  /** 動きの状態 */
  bow: number
  bowAt: number
  bowed: boolean
  signalAt: number
  signalFor: number
  yaw: number
  room: number
  roomColor: THREE.Color
}

/** 緑電の、駅員ロボのいる停留所 */
const TRAM_STOPS = ['桜見駅前', 'まるの森東', 'ひらき通り']

/* -------------------------------------------------------------------------- */
/* 形                                                                          */
/* -------------------------------------------------------------------------- */

/** 材質の番号: 0 塗装・1 黒いゴム・2 真鍮・3 顔の暗いガラス・4 目（光る）・5 名前の札（字）・6 襟の色 */
const RM = { paint: 0, rubber: 1, brass: 2, visor: 3, eye: 4, plate: 5, band: 6 } as const

const GREEN = '#1f5a3e'
const CREAM = '#ece2c6'
const DARK = '#2a2c2e'
const BRASS = '#c9a24e'

/** 球面の一部の格子（中心 c・半径 r・方位 az0〜az1・仰角 el0〜el1。+z が正面） */
function spherePatch(g: GeoBuilder, c: [number, number, number], r: number, az0: number, az1: number, el0: number, el1: number, color: string, m: number, aux = 0, n = 8) {
  const P = (az: number, el: number): [number, number, number] => [c[0] + r * Math.cos(el) * Math.sin(az), c[1] + r * Math.sin(el), c[2] + r * Math.cos(el) * Math.cos(az)]
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const a0 = az0 + ((az1 - az0) * i) / n
      const a1 = az0 + ((az1 - az0) * (i + 1)) / n
      const e0 = el0 + ((el1 - el0) * j) / n
      const e1 = el0 + ((el1 - el0) * (j + 1)) / n
      g.quad(P(a0, e0), P(a1, e0), P(a1, e1), P(a0, e1), color, m, aux)
    }
}

/** 足元の台（車輪を隠すすそ）。原点 = 足元 */
function baseGeometry() {
  const g = new GeoBuilder()
  g.lathe(
    [
      [0.0, 0.0],
      [0.27, 0.0],
      [0.28, 0.04],
      [0.26, 0.13],
      [0.0, 0.13],
    ],
    24,
    new THREE.Matrix4(),
    DARK,
    RM.rubber,
    0.3,
  )
  // すその真鍮の線
  g.lathe(
    [
      [0.276, 0.085],
      [0.278, 0.095],
    ],
    24,
    new THREE.Matrix4(),
    BRASS,
    RM.brass,
    0,
  )
  return g.build()
}

/** 胴（原点 = 腰の回る所。足元から 0.14m） */
function torsoGeometry() {
  const g = new GeoBuilder()
  g.lathe(
    [
      [0.0, -0.02],
      [0.235, -0.02],
      [0.245, 0.08],
      [0.238, 0.32],
      [0.218, 0.54],
      [0.185, 0.64],
      [0.12, 0.69],
      [0.0, 0.7],
    ],
    28,
    new THREE.Matrix4(),
    GREEN,
    RM.paint,
    0.6,
  )
  // 腰の真鍮の帯・襟（乗り物の色）
  g.lathe(
    [
      [0.247, 0.26],
      [0.247, 0.29],
    ],
    28,
    new THREE.Matrix4(),
    BRASS,
    RM.brass,
    0,
  )
  g.lathe(
    [
      [0.19, 0.62],
      [0.165, 0.665],
    ],
    28,
    new THREE.Matrix4(),
    '#ffffff',
    RM.band,
    0,
  )
  // 胸のクリームの前掛けと、名前の札（字は札の絵）
  spherePatch(g, [0, 0.42, 0], 0.243, -0.62, 0.62, -0.28, 0.4, CREAM, RM.paint, 0.5, 6)
  const pz = 0.252
  g.quad([-0.12, 0.43, pz], [0.12, 0.43, pz], [0.12, 0.53, pz], [-0.12, 0.53, pz], '#ffffff', RM.plate, 0)
  g.boxMinMax(-0.125, 0.425, pz - 0.01, 0.125, 0.432, pz + 0.004, BRASS, RM.brass, 0)
  g.boxMinMax(-0.125, 0.528, pz - 0.01, 0.125, 0.535, pz + 0.004, BRASS, RM.brass, 0)
  // 肩（腕の付け根の丸）
  for (const s of [1, -1]) spherePatch(g, [s * 0.215, 0.6, 0], 0.06, 0, Math.PI * 2, -1.2, 1.2, GREEN, RM.paint, 0.6, 6)
  return g.build()
}

/** 頭（原点 = 首の回る所。胴の上 0.70m） */
function headGeometry() {
  const g = new GeoBuilder()
  // 首
  g.cylinder([0, -0.02, 0], 0.055, 0.06, 12, DARK, RM.rubber, 0.3, false)
  // 頭（丸）
  g.lathe(
    Array.from({ length: 13 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 12) * Math.PI
      return [Math.max(0.0001, 0.165 * Math.cos(a)), 0.16 + 0.155 * Math.sin(a)] as [number, number]
    }),
    24,
    new THREE.Matrix4(),
    CREAM,
    RM.paint,
    0.7,
  )
  // 顔の暗いガラス（前）と、2 つの目（電球色の灯り）
  spherePatch(g, [0, 0.16, 0], 0.168, -0.95, 0.95, -0.42, 0.34, '#101214', RM.visor, 0, 8)
  for (const s of [1, -1]) spherePatch(g, [0, 0.16, 0], 0.171, s * 0.3 - 0.11, s * 0.3 + 0.11, -0.02, 0.15, '#ffc070', RM.eye, 0, 3)
  // 制帽（緑の山・金の帯・黒いつば・真鍮の徽章）
  g.cylinder([0, 0.27, -0.01], 0.15, 0.075, 20, GREEN, RM.paint, 0.4, true, 0.162)
  g.cylinder([0, 0.27, -0.01], 0.151, 0.022, 20, '#d4a93c', RM.brass, 0, false)
  g.box([0, 0.272, 0.13], [0.22, 0.014, 0.1], '#0e0f10', RM.rubber, 0.8, [0.25, 0, 0])
  g.box([0, 0.315, 0.148], [0.04, 0.035, 0.012], BRASS, RM.brass, 0)
  // 耳の丸い灯り（小さな真鍮の縁）
  for (const s of [1, -1]) g.cylinder([s * 0.162, 0.16, 0], 0.035, 0.012, 12, BRASS, RM.brass, 0, true)
  return g.build()
}

/** 腕（原点 = 肩。下へ垂れる。右腕は合図灯（緑の丸い板）を持つ） */
function armGeometry(right: boolean) {
  const g = new GeoBuilder()
  g.cylinder([0, -0.36, 0], 0.042, 0.36, 10, GREEN, RM.paint, 0.5, false, 0.046)
  spherePatch(g, [0, -0.405, 0], 0.056, 0, Math.PI * 2, -1.5, 1.5, '#f4f1ea', RM.paint, 0.2, 6)
  if (right) {
    // 合図灯: 手から前へ出る柄と、緑の丸い板（裏は白）
    g.beam([0, -0.42, 0.02], [0, -0.42, 0.2], 0.018, DARK, RM.rubber, 0.4)
    const m = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, -0.42, 0.24)
    g.lathe(
      [
        [0.0, -0.008],
        [0.085, -0.008],
        [0.085, 0.008],
        [0.0, 0.008],
      ],
      18,
      m,
      '#2f9a54',
      RM.eye,
      1,
    )
  }
  return g.build()
}

/* -------------------------------------------------------------------------- */
/* シェーダー                                                                     */
/* -------------------------------------------------------------------------- */

/** 名前の札の絵が無いとき（document の無い所）の仮の画像（字の無い 1 画素） */
function blankPlate() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
  t.needsUpdate = true
  return t
}

/**
 * 駅員ロボの材質（インスタンス。TSL）。町と同じ光（太陽・空・町の影・夜の灯りの表）に、建物の中の光（iRoom・iInfo.z）、
 * 目と合図灯の光、名前の札の字。iInfo = (まばたき, 札の行, 中にいる割合, 襟の色の番号)
 */
function createRobotMaterial(plate: THREE.Texture | null, rows: number) {
  const u = outdoorUniforms
  const uniforms = {
    uPlate: texture(plate ?? blankPlate()),
    uPlateRows: uniform(rows),
    uBands: uniformArray([new THREE.Color('#a82b23'), new THREE.Color('#d9a21b'), new THREE.Color('#2c3f66')], 'color'),
  }
  const m = markPaint(unlit('stationRobot'), 'light')
  const paint = outdoorPaint()
  const flat = paintFlat()
  const vColor = attribute<'vec3'>('color', 'vec3')
  const vMat = attribute<'vec2'>('aMat', 'vec2')
  const vInfo = attribute<'vec4'>('iInfo', 'vec4')
  const vRoom = attribute<'vec3'>('iRoom', 'vec3')
  // 局所の位置（形の頂点のまま。名前の札の字・塗装のむら）
  const vLocal = varying(positionGeometry)
  m.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    const N = normalize(normalWorld).toVar() // 両面: normalWorld は裏の面で反転済み（MeshBasicNodeMaterial の setupNormal）
    const id = floor(vMat.x.add(0.5)).toVar()
    const aux = vMat.y.toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const dist = length(cameraPosition.sub(wp)).toVar()
    const albedo = vec3(vColor).toVar()
    const gloss = aux.mul(0.4).add(0.3).toVar()
    const metal = float(0.0).toVar()
    const emit = vec3(0.0).toVar()
    If(id.lessThan(0.5), () => {
      if (!flat) albedo.mulAssign(oNoise(vLocal.xy.mul(30.0)).mul(0.05).add(0.96))
    })
      .ElseIf(id.lessThan(1.5), () => {
        gloss.assign(aux.mul(0.4).add(0.08))
      })
      .ElseIf(id.lessThan(2.5), () => {
        metal.assign(1.0)
        gloss.assign(0.65)
      })
      .ElseIf(id.lessThan(3.5), () => {
        gloss.assign(0.92)
        albedo.assign(vec3(0.02))
      })
      .ElseIf(id.lessThan(4.5), () => {
        // 目（まばたきは iInfo.x）と合図灯
        albedo.assign(vColor.mul(0.4))
        emit.assign(select(aux.greaterThan(0.5), vColor.mul(0.5), vColor.mul(2.4).mul(vInfo.x)))
        gloss.assign(0.6)
      })
      .ElseIf(id.lessThan(5.5), () => {
        // 名前の札（行 = iInfo.y）
        const pu = clamp(vLocal.x.add(0.12).div(0.24), 0.0, 1.0)
        const pv = clamp(vLocal.y.sub(0.43).div(0.1), 0.0, 1.0)
        const tx = uniforms.uPlate.sample(vec2(pu, float(1.0).sub(vInfo.y.add(1.0).sub(pv).div(uniforms.uPlateRows))))
        albedo.assign(mix(vec3(0.93, 0.9, 0.82), vec3(0.08, 0.2, 0.14), tx.a))
        gloss.assign(0.4)
      })
      .Else(() => {
        albedo.assign(uniforms.uBands.element(int(clamp(floor(vInfo.w.add(0.5)), 0.0, 2.0))))
        gloss.assign(0.5)
      })
    const room = vInfo.z.toVar()
    if (flat) {
      // 外の塗り（paint.ts）の flat: 外は面の光の式、建物の中は中の光の式（灯りの色と上からの向き）。照り返し・映り込みは省く
      const sh0 = townShadow(wp, N)
      const a = albedo.mul(metal.mul(-0.6).add(1.0))
      const outC = townLight(a, N, float(1.0), sh0, 'vehicle')
      const inC = paint?.interior ? paint.interior(a, vRoom.mul(max(N.y, 0.0).mul(0.9).add(1.1)), vRoom, N, float(1.0)) : a.mul(vRoom)
      const c = mix(outC, inC, room).add(albedo.mul(townLamps(wp, N)).mul(0.7)).toVar()
      c.assign(outdoorHaze(c, wp))
      c.addAssign(paintEmit(emit).mul(exp(dist.negate().div(u.uHazeDist.mul(1.5)))))
      return c
    }
    const sh = townShadow(wp, N).toVar()
    const col = townLight(albedo.mul(metal.mul(-0.6).add(1.0)), N, float(1.0), mix(sh, 1.0, room.mul(0.5))).mul(room.mul(-0.75).add(1.0)).toVar()
    // 建物の中の光（まわりの明るさと灯りの色。上からの向き）
    col.addAssign(albedo.mul(vRoom).mul(max(N.y, 0.0).mul(0.45).add(0.55)).mul(room))
    const H = normalize(V.add(u.uSunDir))
    const pw = mix(10.0, 260.0, gloss).toVar()
    const f0 = mix(0.04, 0.9, metal).toVar()
    const fres = f0.add(f0.oneMinus().mul(pow(clamp(dot(N, V).oneMinus(), 0.0, 1.0), 5.0))).toVar()
    col.addAssign(
      u.uSunLight
        .mul(pow(max(dot(N, H), 0.0), pw))
        .mul(pw.add(2.0).div(8.0))
        .mul(fres)
        .mul(sh)
        .mul(max(dot(N, u.uSunDir), 0.0))
        .mul(gloss)
        .mul(room.mul(-0.8).add(1.0)),
    )
    const R = reflect(V.negate(), N).toVar()
    const env = select(R.y.greaterThan(0.0), skyColor(R), u.uSkyLight.mul(0.3)).toVar()
    env.assign(mix(env, vRoom.mul(0.8), room))
    col.addAssign(env.mul(fres).mul(mix(gloss.mul(0.4), 0.85, metal)).mul(mix(vec3(1.0), albedo.mul(2.0), metal)))
    col.addAssign(albedo.mul(townLamps(wp, N)).mul(0.7))
    col.assign(outdoorHaze(col, wp))
    col.addAssign(emit.mul(exp(dist.negate().div(u.uHazeDist.mul(1.5)))))
    return col
  })()
  return withUniforms(m, uniforms)
}

/** 名前の札の絵（1 行 = 1 体。上の大きな字「えきもり」と、下の小さな駅・停留所の名前） */
function plateTexture(labels: string[]) {
  if (typeof document === 'undefined') return null
  const rows = Math.max(1, labels.length)
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 128 * rows
  const g = c.getContext('2d')
  if (!g) return null
  g.clearRect(0, 0, c.width, c.height)
  g.fillStyle = '#ffffff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  labels.forEach((label, i) => {
    const y = i * 128
    g.font = 'bold 54px "Noto Sans CJK JP", "Noto Sans JP", sans-serif'
    g.fillText('えきもり', 256, y + 44)
    g.font = '30px "Noto Sans CJK JP", "Noto Sans JP", sans-serif'
    g.fillText(label, 256, y + 98, 480)
  })
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  t.anisotropy = 4
  return t
}

/* -------------------------------------------------------------------------- */
/* 置く所                                                                       */
/* -------------------------------------------------------------------------- */

const headingOf = (dx: number, dy: number) => Math.atan2(dx, -dy)

function buildSpots(landings: BoatLanding[]): RobotSpot[] {
  const out: RobotSpot[] = []
  const push = (s: Omit<RobotSpot, 'row' | 'seed' | 'bow' | 'bowAt' | 'bowed' | 'signalAt' | 'signalFor' | 'yaw' | 'room' | 'roomColor'>) =>
    out.push({ ...s, row: out.length, seed: (out.length * 0.618) % 1, bow: 0, bowAt: -1e9, bowed: false, signalAt: -1e9, signalFor: -1, yaw: 0, room: 0, roomColor: new THREE.Color() })
  // 丘ノ上ケーブルの 3 駅: ホームの 3 つ目の区画の段の、扉と扉の間の外の壁ぎわ（乗り降りの道を空けて）。線路の方を向く
  for (const zone of Object.keys(CABLE_STATIONS) as CableStationZone[]) {
    const d = CABLE_STATIONS[zone]
    const side = d.sides[0]
    const comp = zone === 'cable-fumoto' ? 2 : 1
    const c = d.comps[comp]
    const p = stationScene(d, (c.s0 + c.door) / 2 - 0.1, side * (d.outerT - 0.75), c.h)
    push({ id: `robot.${zone}`, kind: 'cable', key: zone, label: d.label.replace('丘ノ上ケーブル ', ''), x: p[0], y: p[1], z: p[2], heading: stationHeading(d, 0, -side), look: stationHeading(d, 1, 0), band: 0 })
  }
  // 緑電の主な停留所: ホームの端（スロープの手前）の外の側。線路の方を向く
  for (const st of tramNet.stops) {
    if (!TRAM_STOPS.includes(st.name)) continue
    st.platforms.forEach((pf: TramPlatform, k) => {
      const nx = -pf.dy * pf.side
      const ny = pf.dx * pf.side
      const a = -(TRAM_PLATFORM.length / 2 - 3.2)
      const b = 0.55
      const x = pf.x + pf.dx * a + nx * b
      const y = pf.y + pf.dy * a + ny * b
      push({ id: `robot.tram.${st.name}.${k}`, kind: 'tram', key: st.name, label: `緑電 ${st.name}`, x, y: tramPlatformTop(pf, a) - LAB, z: -y, heading: headingOf(-nx, -ny), look: headingOf(pf.dx, pf.dy), band: 1 })
    })
  }
  // 運河バスの乗り場: 石段の上の陸の側の敷石（札の柱の陸の側）。上の踊り場と水の方を向く
  for (const l of landings) {
    const ta = topA(l)
    const [x, y] = landingPoint(l, ta + l.sgn * 0.95, -1.15)
    const fx = l.wx * 0.55 - l.sgn * l.ux * 0.83
    const fy = l.wy * 0.55 - l.sgn * l.uy * 0.83
    push({ id: `robot.landing.${l.id}`, kind: 'waterbus', key: l.id, label: `運河バス ${l.name}`, x, y: l.top - LAB, z: -y, heading: headingOf(fx, fy), look: headingOf(l.wx, l.wy), band: 2 })
  }
  void LANDING
  return out
}

/* -------------------------------------------------------------------------- */
/* 入れ物と動き                                                                    */
/* -------------------------------------------------------------------------- */

const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _t = new THREE.Matrix4()
const _h = new THREE.Matrix4()
const _a = new THREE.Matrix4()
const _cam = new THREE.Vector3()
const _p = new THREE.Vector3()
const _c = new THREE.Color()
const _light = { dir: new THREE.Vector3(), color: new THREE.Color(), intensity: 0, ambient: new THREE.Color() }

/** 描く距離（カメラから m） */
const NEAR = 90

class PartMesh {
  readonly mesh: THREE.InstancedMesh
  private info: THREE.InstancedBufferAttribute
  private room: THREE.InstancedBufferAttribute
  n = 0
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, cap: number) {
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
    this.room = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)
    this.info.setUsage(THREE.DynamicDrawUsage)
    this.room.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('iInfo', this.info)
    geo.setAttribute('iRoom', this.room)
    this.mesh = new THREE.InstancedMesh(geo, mat, cap)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.name = name
  }
  begin() {
    this.n = 0
  }
  add(m: THREE.Matrix4, info: readonly number[], room: THREE.Color, k: number) {
    if (this.n >= this.mesh.instanceMatrix.count) return
    this.mesh.setMatrixAt(this.n, m)
    this.info.setXYZW(this.n, info[0], info[1], info[2], info[3])
    this.room.setXYZ(this.n, room.r * k, room.g * k, room.b * k)
    this.n++
  }
  end() {
    const n = this.n
    this.mesh.count = n
    this.mesh.visible = n > 0
    if (!n) return
    this.mesh.instanceMatrix.clearUpdateRanges()
    this.mesh.instanceMatrix.addUpdateRange(0, n * 16)
    this.mesh.instanceMatrix.needsUpdate = true
    this.info.needsUpdate = true
    this.room.needsUpdate = true
  }
}

const smooth = (x: number) => {
  const k = Math.min(1, Math.max(0, x))
  return k * k * (3 - 2 * k)
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** 駅員ロボ（町のデータを読んだあと、交通を作ったときに 1 つ） */
export class StationRobots {
  readonly group = new THREE.Group()
  readonly spots: RobotSpot[]
  private parts: PartMesh[]
  private base: PartMesh
  private torso: PartMesh
  private head: PartMesh
  private armL: PartMesh
  private armR: PartMesh
  private lastT = 0

  constructor(landings: BoatLanding[]) {
    this.spots = buildSpots(landings)
    const cap = Math.max(1, this.spots.length)
    const plate = plateTexture(this.spots.map((s) => s.label))
    const mat = createRobotMaterial(plate, cap)
    this.base = new PartMesh(baseGeometry(), mat, 'robot:base', cap)
    this.torso = new PartMesh(torsoGeometry(), mat, 'robot:torso', cap)
    this.head = new PartMesh(headGeometry(), mat, 'robot:head', cap)
    this.armL = new PartMesh(armGeometry(false), mat, 'robot:armL', cap)
    this.armR = new PartMesh(armGeometry(true), mat, 'robot:armR', cap)
    this.parts = [this.base, this.torso, this.head, this.armL, this.armR]
    for (const p of this.parts) this.group.add(p.mesh)
    this.group.name = 'stationRobots'
  }

  /** 自分の乗り場から乗り物が出るまでの秒（近くに無ければ null） */
  private departIn(s: RobotSpot, t: number): number | null {
    if (s.kind === 'cable') {
      const line = cableTrack.line
      if (!line) return null
      // 端の駅は次の発車、楓坂駅は行き違いのあとの発車
      const { k, s: since } = cableTrip(t)
      const kk = s.key === 'cable-kaedezaka' ? Math.max(0, since > CABLE_RUN.leg + CABLE_RUN.midDwell ? k + 1 : k) : k + 1
      if (kk >= CABLE_TRIPS) return null
      const dep = tripStart(kk) + (s.key === 'cable-kaedezaka' ? CABLE_RUN.leg + CABLE_RUN.midDwell : 0)
      return dep - t
    }
    if (s.kind === 'tram') {
      const f = tramNet.fleet
      if (!f) return null
      let best: number | null = null
      for (const r of f.runs) {
        if (r.stop < 0) continue
        const list = r.stopDir > 0 ? r.line.outStops : r.line.backStops
        const st = list[r.stop]
        if (st?.name !== s.key) continue
        if (Math.hypot(r.center.x - s.x, r.center.z - s.z) > 22) continue
        const dep = r.line.deps[r.run] + st.depart - t
        if (best === null || dep < best) best = dep
      }
      return best
    }
    const f = boatNet.fleet
    if (!f) return null
    let best: number | null = null
    for (const b of f.runs) {
      if (b.stop < 0) continue
      const list = b.stopDir > 0 ? b.route.outStops : b.route.backStops
      const st = list[b.stop]
      if (st?.id !== s.key) continue
      const dep = b.route.deps[b.run] + st.depart - t
      if (best === null || dep < best) best = dep
    }
    return best
  }

  /** 毎コマ（交通の update のあと）。t = 交通の時計（運転の日の秒）、time = シーンの時計の秒 */
  update(camera: THREE.Camera, t: number, time: number) {
    camera.getWorldPosition(_cam)
    const dt = Math.min(0.1, Math.max(0, time - this.lastT))
    this.lastT = time
    for (const p of this.parts) p.begin()
    const focus = townFocus()
    const k = focus.position
    for (const s of this.spots) {
      const dc = Math.hypot(s.x - _cam.x, s.z - _cam.z)
      if (dc > NEAR) continue
      // 駅の中の光
      _p.set(s.x, s.y + 1.0, s.z)
      const inRoom = interiors.lightAt(_p, _light)
      s.room += ((inRoom ? 1 : 0) - s.room) * Math.min(1, dt * 4 + (s.room === 0 && inRoom ? 1 : 0))
      if (inRoom) s.roomColor.copy(_light.ambient).multiplyScalar(2.2).add(_c.copy(_light.color).multiplyScalar(_light.intensity * 0.35))
      // 花音との距離（同じ高さのあたり）
      const dk = Math.hypot(k.x - s.x, k.z - s.z) + Math.abs(k.y - s.y) * 2
      if (dk > 7) s.bowed = false
      // 会釈は花音が乗り場を歩いているときだけ（乗り物の中から近くを通り過ぎるときはしない）
      if (!s.bowed && dk < 3.0 && !focus.ride.inside) {
        s.bowed = true
        s.bowAt = time
        townEvents.emit('robot.bow', { x: s.x, y: s.y + 1.0, z: s.z })
      }
      // 発車の合図（出る 8.5 秒前から 2.5 秒前まで右手を上げる。合図の音は上げたとき）
      const dep = this.departIn(s, t)
      const signaling = dep !== null && dep < 8.5 && dep > 2.5
      if (signaling && s.signalFor !== Math.round(t + dep!)) {
        s.signalFor = Math.round(t + dep!)
        s.signalAt = time
        townEvents.emit('robot.signal', { x: s.x, y: s.y + 1.1, z: s.z })
      }
      const sig = signaling ? smooth((time - s.signalAt) / 0.6) : Math.max(0, 1 - (time - s.signalAt - 6) / 0.6) * (time - s.signalAt < 6.6 ? 1 : 0)
      // 会釈（0.7 秒で 0.3rad 前へ、0.5 秒止めて、0.8 秒で戻す）
      const bt = time - s.bowAt
      const bow = bt < 0.7 ? smooth(bt / 0.7) : bt < 1.2 ? 1 : bt < 2.0 ? 1 - smooth((bt - 1.2) / 0.8) : 0
      // 頭: 花音が近ければ花音、合図の間は線路・水の方、ほかはゆっくり見回す
      let want = Math.sin(time * 0.35 + s.seed * 20) * 0.45
      if (sig > 0.1) want = wrap(s.look - s.heading)
      else if (dk < 8) want = wrap(Math.atan2(k.x - s.x, k.z - s.z) - s.heading)
      want = THREE.MathUtils.clamp(want, -1.25, 1.25)
      s.yaw += (want - s.yaw) * Math.min(1, dt * 3)
      // まばたき（4〜6 秒に 1 回）
      const blinkT = (time + s.seed * 7) % (4 + s.seed * 2)
      const eye = blinkT < 0.12 ? 0.15 : 1
      const breath = Math.sin(time * 1.6 + s.seed * 9) * 0.006
      // 行列: 置く所 → 腰（会釈）→ 頭・腕
      _r.makeRotationY(s.heading).setPosition(s.x, s.y + breath, s.z)
      const info = [eye, s.row, s.room, s.band]
      this.base.add(_r, info, s.roomColor, 1)
      _t.copy(_r).multiply(_m.makeTranslation(0, 0.14, 0)).multiply(_a.makeRotationX(bow * 0.3))
      this.torso.add(_t, info, s.roomColor, 1)
      _h.copy(_t).multiply(_m.makeTranslation(0, 0.7, 0)).multiply(_a.makeRotationY(s.yaw)).multiply(_m.makeRotationX(bow * 0.15 + Math.sin(time * 0.5 + s.seed * 5) * 0.03))
      this.head.add(_h, info, s.roomColor, 1)
      // 腕（左は下げたまま少し揺れる。右は合図で前の上へ）
      _h.copy(_t).multiply(_m.makeTranslation(0.24, 0.6, 0)).multiply(_a.makeRotationX(-0.08 - bow * 0.25 + Math.sin(time * 1.1 + s.seed) * 0.03)).multiply(_m.makeRotationZ(0.08))
      this.armL.add(_h, info, s.roomColor, 1)
      const raise = sig * (2.55 + Math.sin(time * 5) * 0.08)
      _h.copy(_t).multiply(_m.makeTranslation(-0.24, 0.6, 0)).multiply(_a.makeRotationX(-0.08 - raise - bow * 0.25)).multiply(_m.makeRotationZ(-0.08 - sig * 0.15))
      this.armR.add(_h, info, s.roomColor, 1)
    }
    for (const p of this.parts) p.end()
  }
}
