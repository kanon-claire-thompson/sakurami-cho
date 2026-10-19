import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  inverseSqrt,
  length,
  max,
  normalGeometry,
  normalWorldGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  sign,
  smoothstep,
  step,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { oHash, oNoise, outdoorHaze, outdoorUniforms } from '../materials'
import { GeoBuilder } from '../site/builder'
import { townLamps } from '../town/lamps'
import { townShadow } from '../town/shadows'
import { ObjectNodeMaterial, facingNormal, localFrame, matAttr, vertexColorAttr } from './transitMaterial'
import { markPaint, paintEmit } from '../paint'
import { cabinLight, flatGlass } from '../paintParts'

type Node<T = unknown> = THREE.Node<T>

/**
 * 乗れる車両の細かい形（緑電 9100 形 tramCar.ts・運河バス waterbusCar.ts）の共通の部品: 材質（TSL。町と同じ光、中は窓から入る空と太陽・
 * 天井の灯り）・材質の番号・形を作る道具・インスタンスの入れ物。丘ノ上ケーブルの車両（cableCar.ts）と同じ考えで、車両ごとの
 * 「中か」「窓を通る日なたか」「天井の灯り」だけを式（VehicleTsl）で渡す。docs/design/town.md §20。
 *
 * インスタンスの iInfo = (中の灯り 0〜1, 扉の開き具合 0〜1, 扉の側（局所の x の向き ±1）, 系統の色の番号 + 種 × 0.5)
 */

/** 材質の番号（aMat.x） */
export const VM = {
  /** 外の塗装。aux = つや */
  paint: 0,
  /** 化粧板（壁の腰・仕切り）。aux = 明るさのむら */
  panel: 1,
  /** 座席のモケット。aux = 0 緑の細かい柄（緑電）・1 紺の縞（運河バス） */
  fabric: 2,
  /** ステンレス・真鍮（握り棒・つり革の金具）。aux = 0 ステンレス・1 真鍮 */
  metal: 3,
  /** 床。aux = 0 ゴムの床（粒の滑り止め）・1 木の甲板（板張り） */
  floor: 4,
  /** 天井 */
  ceiling: 5,
  /** 灯り。aux = 0 中の灯り・1 前照灯・2 尾灯・3 舳先のランタン（夜にいつも） */
  lamp: 6,
  /** 黒い物（ゴム・台車・床下）。aux = つや */
  dark: 7,
  /** 屋根（灰色） */
  roof: 8,
  /** 樹脂（つり革の輪・取っ手）。aux = つや */
  plastic: 9,
  /** 案内の表示（橙の点の文字。暗い地）。aux = 種 */
  display: 10,
  /** 屋根庭（多肉植物と苔） */
  garden: 11,
  /** ニスを塗った木。aux = 木目の向き（0 横・1 縦） */
  wood: 12,
} as const

export type V3 = [number, number, number]

/** 2 点を結ぶ管（8 角） */
export function tube(g: GeoBuilder, a: V3, b: V3, r: number, color: string, m: number, aux = 0, seg = 8) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const len = d.length()
  if (len < 1e-4) return
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())
  const mtx = new THREE.Matrix4().compose(new THREE.Vector3(...a), q, new THREE.Vector3(1, 1, 1))
  g.lathe(
    [
      [r, 0],
      [r, len],
    ],
    seg,
    mtx,
    color,
    m,
    aux,
  )
}

/** 輪（中心・輪の面の法線の向き（x か z）・半径・太さ） */
export function ring(g: GeoBuilder, c: V3, axis: 'x' | 'z', R: number, r: number, color: string, m: number, aux = 0) {
  const prof: [number, number][] = []
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI * 2
    prof.push([R + Math.cos(a) * r, Math.sin(a) * r])
  }
  const mtx = new THREE.Matrix4().makeRotationX(Math.PI / 2)
  if (axis === 'x') mtx.premultiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
  mtx.setPosition(c[0], c[1], c[2])
  g.lathe(prof, 14, mtx, color, m, aux)
}

/** z0〜z1・y0〜y1 の縦の面（x の位置、表の向き sx） */
export function sideRect(g: GeoBuilder, x: number, sx: number, z0: number, z1: number, y0: number, y1: number, color: string, m: number, aux = 0) {
  if (z1 - z0 < 1e-4 || y1 - y0 < 1e-4) return
  if (sx > 0) g.quad([x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], color, m, aux)
  else g.quad([x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], color, m, aux)
}

/** x0〜x1・y0〜y1 の z の面（表の向き sz） */
export function endRect(g: GeoBuilder, z: number, sz: number, x0: number, x1: number, y0: number, y1: number, color: string, m: number, aux = 0) {
  if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) return
  if (sz > 0) g.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], color, m, aux)
  else g.quad([x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], color, m, aux)
}

/** 水平の面（y の位置、表の向き sy） */
export function flatRect(g: GeoBuilder, y: number, sy: number, x0: number, x1: number, z0: number, z1: number, color: string, m: number, aux = 0) {
  if (x1 - x0 < 1e-4 || z1 - z0 < 1e-4) return
  if (sy > 0) g.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], color, m, aux)
  else g.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], color, m, aux)
}

/**
 * 車両ごとの決まり（局所の座標で。呼ぶ側の Fn の中で式を組む JS の関数）:
 * - `inside(p)`: 中の点か（壁・床・天井の内）
 * - `sunThrough(p, L)`: 中の点 p から光の向き L へ、窓を通って外へ出るか（0〜1）
 * - `lamp(p, n)`: 天井の灯りの照度（電球色。点き具合を掛ける前。中の点）
 * - `camInside(c)`: ガラスの材質で、カメラ（局所）が中か
 */
export interface VehicleTsl {
  name: string
  inside(p: Node<'vec3'>): Node<'bool'>
  camInside(c: Node<'vec3'>): Node<'bool'>
  sunThrough(p: Node<'vec3'>, L: Node<'vec3'>): Node<'float'>
  lamp(p: Node<'vec3'>, n: Node<'vec3'>): Node<'vec3'>
}

/**
 * 側の窓（x = ±iw の面）を通るか: 中の点 p から L へ進んで側の面に当たった所が、範囲（zMin〜zMax・yMin〜yMax）の内なら value、外なら 0
 * （前の GLSL の vehSunThrough の側の窓の分）
 */
export function sideWindowHit(p: Node<'vec3'>, L: Node<'vec3'>, iw: number, zMin: number, zMax: number, yMin: number, yMax: number, value: number) {
  const r = float(0.0).toVar()
  If(abs(L.x).greaterThan(1e-3), () => {
    const t = sign(L.x).mul(iw).sub(p.x).div(L.x).toVar()
    If(t.greaterThan(0.0), () => {
      const h = p.add(L.mul(t)).toVar()
      If(h.z.greaterThan(zMin).and(h.z.lessThan(zMax)).and(h.y.greaterThan(yMin)).and(h.y.lessThan(yMax)), () => {
        r.assign(value)
      })
    })
  })
  return r
}

/** 天井の灯り 2 列（x = ±lx、高さ ly、z は zMin〜zMax に収めた点）の照度（前の GLSL の vehLamp の形。色 c・減衰 a, b・倍率 gain・底上げ base） */
export function ceilingLamps(p: Node<'vec3'>, n: Node<'vec3'>, lx: number, ly: number, zMin: number, zMax: number, c: THREE.Color, a: number, b: number, gain: number, base: THREE.Color) {
  const acc = vec3(0.0).toVar()
  for (const x of [-lx, lx]) {
    const q = vec3(x, ly, clamp(p.z, zMin, zMax))
    const Lv = q.sub(p).toVar()
    const d2 = dot(Lv, Lv).toVar()
    const Ll = Lv.mul(inverseSqrt(max(d2, 1e-4)))
    const ndl = max(dot(n, Ll), 0.0)
    acc.addAssign(vec3(c.r, c.g, c.b).mul(ndl.mul(0.75).add(0.25)).div(d2.mul(a).add(b)))
  }
  return acc.mul(gain).add(vec3(base.r, base.g, base.b))
}

/** 細かい車両の頂点からの値（局所の座標・太陽とカメラの局所の向き）。呼ぶ側の Fn の中で使う */
function vehicleVaryings(builder: THREE.NodeBuilder) {
  const { m, rt } = localFrame(builder)
  const vSunLocal = varying(normalize(rt.mul(outdoorUniforms.uSunDir)))
  const vCamLocal = varying(rt.mul(cameraPosition.sub(m.mul(vec4(0.0, 0.0, 0.0, 1.0)).xyz)))
  return { vSunLocal, vCamLocal }
}

/**
 * 不透明な面の色: むら・織りの目・滑り止めの粒・木目・つやの照り返し・映り込みは描かず、材質の番号ごとの
 * 平らな色を、外は面の光の式・中は中の光の式（窓から入る日なたと空の光・天井の灯り）で塗る。灯り・案内の表示は光る物の色の式（emit）に通す
 */
function flatDetailColor(builder: THREE.NodeBuilder, v: VehicleTsl) {
  const u = outdoorUniforms
  return Fn(() => {
    const { vSunLocal } = vehicleVaryings(builder)
    const wp = positionWorld.toVar()
    const N = facingNormal().toVar()
    const Nl = normalize(normalGeometry).mul(faceDirection).toVar()
    const vLocal = positionGeometry.toVar()
    const info = attribute<'vec4'>('iInfo', 'vec4').toVar()
    const mat = matAttr().toVar()
    const id = floor(mat.x.add(0.5)).toVar()
    const aux = mat.y.toVar()
    const dist = length(cameraPosition.sub(wp)).toVar()
    const vColor = vertexColorAttr().toVar()
    const albedo = vec3(vColor).toVar()
    const metal = float(0.0).toVar()
    const emit = vec3(0.0).toVar()
    const inside = v.inside(vLocal).toVar()
    const lampOn = info.x.toVar()
    const an = abs(Nl).toVar()
    If(id.greaterThan(2.5).and(id.lessThan(3.5)), () => {
      metal.assign(1.0)
    })
      .ElseIf(id.greaterThan(3.5).and(id.lessThan(4.5)).and(aux.greaterThan(0.5)), () => {
        // 木の甲板: 板の目地だけ（形）
        const seam = smoothstep(0.0, 0.006, abs(fract(vLocal.x.div(0.09)).sub(0.5)).mul(0.09).sub(0.04).add(0.006))
        albedo.mulAssign(seam.mul(0.3).add(0.7))
      })
      .ElseIf(id.greaterThan(5.5).and(id.lessThan(6.5)), () => {
        albedo.assign(vColor.mul(0.5))
        If(aux.lessThan(0.5), () => {
          emit.assign(vColor.mul(lampOn.mul(3.0).add(0.15)))
        })
          .ElseIf(aux.lessThan(1.5), () => {
            emit.assign(vColor.mul(lampOn.mul(2.6).add(0.2)))
          })
          .ElseIf(aux.lessThan(2.5), () => {
            emit.assign(vColor.mul(lampOn.mul(6.0).add(0.4)))
          })
          .Else(() => {
            emit.assign(vColor.mul(max(lampOn, u.uDaylight.oneMinus()).mul(3.5).add(0.3)))
          })
      })
      .ElseIf(id.greaterThan(9.5).and(id.lessThan(10.5)), () => {
        // 案内の表示（点の字の形はそのまま）
        const q = vec2(select(an.x.greaterThan(an.z), vLocal.z, vLocal.x).mul(72.0), vLocal.y.mul(72.0)).toVar()
        const cell = floor(q).toVar()
        const cx = floor(cell.x.div(6.0)).toVar()
        const dx = cell.x.sub(cx.mul(6.0)).toVar()
        const row = floor(cell.y.div(9.0)).toVar()
        const dy = cell.y.sub(row.mul(9.0)).toVar()
        const page = floor(u.uTime.div(4.0).add(aux)).toVar()
        const glyph = step(0.2, oHash(vec2(cx.add(page.mul(5.0)), row.add(aux.mul(3.0)))))
        const on = select(dx.lessThan(5.0).and(dy.lessThan(7.0)), step(0.5, oHash(vec2(cx.mul(7.0).add(dx).add(page.mul(31.0)).add(aux.mul(17.0)), row.mul(11.0).add(dy)))).mul(glyph), 0.0)
        const dot1 = smoothstep(0.4, 0.42, length(fract(q).sub(0.5))).oneMinus()
        albedo.assign(vec3(0.02))
        emit.assign(vec3(1.0, 0.45, 0.08).mul(on).mul(dot1).mul(2.2).mul(max(lampOn, 0.6).mul(0.65).add(0.35)))
      })
      .ElseIf(id.greaterThan(10.5).and(id.lessThan(11.5)), () => {
        albedo.mulAssign(smoothstep(0.58, 0.62, oNoise(vLocal.xz.mul(4.0))).mul(0.3).add(0.75))
      })
    const sh = townShadow(wp, N).toVar()
    // 中の照度: 窓を通る日なた・空の光・天井の灯り
    const sun = v.sunThrough(vLocal, vSunLocal).mul(max(dot(Nl, vSunLocal), 0.0)).mul(sh)
    const E = u.uSunLight.mul(sun).add(u.uSkyLight.mul(0.5)).add(v.lamp(vLocal, Nl).mul(lampOn))
    const amb = u.uSkyLight.mul(0.45).add(vec3(1.0, 0.86, 0.66).mul(lampOn).mul(0.12))
    const col = cabinLight(albedo.mul(metal.mul(-0.6).add(1.0)), N, float(1.0), sh, inside, E, amb).toVar()
    col.addAssign(albedo.mul(townLamps(wp, N)).mul(select(inside, 0.25, 0.6)))
    col.assign(outdoorHaze(col, wp))
    col.addAssign(paintEmit(emit).mul(exp(dist.negate().div(u.uHazeDist.mul(1.5)))))
    return col
  })()
}

/** 不透明な面の色 */
function detailColor(builder: THREE.NodeBuilder, v: VehicleTsl) {
  return flatDetailColor(builder, v)
}

/** ガラスの色と透け（vec4） */
export function detailGlassColor(builder: THREE.NodeBuilder, camInside: (c: Node<'vec3'>) => Node<'bool'>, room: THREE.Color) {
  // 透けるガラスの式（映り込み・太陽のきらめきは描かない）
  return Fn(() => {
    const { vCamLocal } = vehicleVaryings(builder)
    const wp = positionWorld.toVar()
    const info = attribute<'vec4'>('iInfo', 'vec4').toVar()
    const N = normalize(normalWorldGeometry).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    If(dot(N, V).lessThan(0.0), () => {
      N.assign(N.negate())
    })
    const roomC = vec3(room.r, room.g, room.b).mul(info.x).mul(0.3)
    const c = flatGlass(N, V, wp, roomC, camInside(vCamLocal)).toVar()
    return vec4(outdoorHaze(c.rgb, wp), c.a)
  })()
}

/** 細かい車両の不透明な面の材質（インスタンス） */
export function createDetailMaterial(v: VehicleTsl) {
  const m = markPaint(new ObjectNodeMaterial({ fog: false, side: THREE.DoubleSide }), 'light')
  m.name = `${v.name}Detail`
  m.buildNodes = (mat, builder) => {
    mat.colorNode = detailColor(builder, v)
  }
  return m
}

/** 細かい車両のガラス（透ける。空を映し、夜は中の灯りの色） */
export function createDetailGlassMaterial(v: VehicleTsl) {
  const m = markPaint(new ObjectNodeMaterial({ fog: false, side: THREE.DoubleSide, transparent: true, depthWrite: false }), 'window')
  m.name = `${v.name}DetailGlass`
  m.buildNodes = (mat, builder) => {
    mat.colorNode = detailGlassColor(builder, (c) => v.camInside(c), new THREE.Color(0.95, 0.85, 0.7))
  }
  return m
}

/** インスタンスの部品（形 1 つ・iInfo つき）。毎コマ begin → set → end */
export class InstancedPart {
  readonly mesh: THREE.InstancedMesh
  private readonly info: THREE.InstancedBufferAttribute
  count = 0
  readonly capacity: number

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, capacity: number) {
    this.capacity = capacity
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.info.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('iInfo', this.info)
    const mesh = new THREE.InstancedMesh(geo, mat, capacity)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.name = name
    this.mesh = mesh
  }

  begin() {
    this.count = 0
  }

  add(m: THREE.Matrix4, info: readonly number[]) {
    const i = this.count
    if (i >= this.capacity) return false
    this.mesh.setMatrixAt(i, m)
    this.info.setXYZW(i, info[0], info[1], info[2], info[3])
    this.count++
    return true
  }

  end() {
    const n = this.count
    const mesh = this.mesh
    mesh.count = n
    mesh.visible = n > 0
    if (!n) return
    mesh.instanceMatrix.clearUpdateRanges()
    mesh.instanceMatrix.addUpdateRange(0, n * 16)
    mesh.instanceMatrix.needsUpdate = true
    this.info.clearUpdateRanges()
    this.info.addUpdateRange(0, n * 4)
    this.info.needsUpdate = true
  }
}
