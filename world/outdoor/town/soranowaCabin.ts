import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  inverseSqrt,
  length,
  max,
  modelWorldMatrix,
  normalGeometry,
  normalWorld,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import { CABIN, CABIN_SPOTS } from '../../../core/soranowa'
import { outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { GeoBuilder } from '../site/builder'
import { townLamps } from './lamps'
import { townShadow } from './shadows'
import { markPaint, paintEmit } from '../paint'
import { cabinLight, flatGlass } from '../paintParts'

/**
 * 観覧車ソラノワの細かいゴンドラ（花音が乗る 1 基と、カメラの近くの数基。docs/design/town.md §17）。
 * 外の 60 基はふだん town/soranowa.ts の安い形（インスタンス）で描き、カメラから近い所と乗っている 1 基だけ、この形に替える。
 *
 * - 形（ゴンドラの局所。原点 = 吊る軸、扉は −z の面）: 丸みのある箱（角を丸めた断面を z へ押し出す）。白い腰・ぐるりのガラスの窓・
 *   5 色の屋根（安い形と同じ色）・窓の柱と桟・吊り金具と軸の筒・床の下の皿。中は床（黒いゴムの床）・長いす 2 列（x の両端。向かい合う）・
 *   手すり（ステンレス）・天井の丸い灯り・スピーカー・換気口。−z の面に引き戸（外へ出てから +x へ滑る）
 * - シェーダー: 町と同じ光（太陽・空・町の影・夜の灯りの表）に、中の天井の灯り（ゴンドラの局所で計算）と、夜のホイールの LED の光（ハブの向きから）を足す。
 *   ガラスは透けて、空と夜の LED と（中から見ると）中の灯りを映す
 * - インスタンスの iInfo = (中の灯り 0〜1, 色の種, ハブへの向き cos, ハブへの向き sin)
 */

/** 材質の番号（aMat.x） */
export const CM = {
  /** 外の塗装（白い腰・枠）。aux = つや */
  paint: 0,
  /** 中の FRP の壁・天井（明るい灰色のつや消し） */
  frp: 1,
  /** 長いすの布（紺のモケット） */
  fabric: 2,
  /** ステンレス（手すり・金具） */
  steel: 3,
  /** 床（黒いゴムの床。小さな丸い滑り止め） */
  floor: 4,
  /** 屋根の色（インスタンスの色の種で 5 色。安い形と同じ） */
  tint: 5,
  /** 灯り（中の灯りの点き具合で光る） */
  lamp: 6,
  /** 黒いゴム・樹脂。aux = つや */
  dark: 7,
  /** アルミの縞板（扉の敷居） */
  alum: 8,
} as const

const W = CABIN.halfW
const D = CABIN.halfD
const Y0 = CABIN.bottom
const Y1 = CABIN.top
const FLOOR = CABIN.floor
const CEIL = CABIN.ceiling
const IW = CABIN.innerW
const ID = CABIN.innerD
/** 窓の帯（外形の下から） */
const WIN0 = Y0 + CABIN.waist
const WIN1 = Y1 - 0.5
/** 扉の開口（−z の面） */
const DOOR_X = CABIN.doorW / 2
const DOOR_TOP = FLOOR + CABIN.doorH
/** 扉が開くときの動き（外へ出てから +x へ） */
export const DOOR_OPEN = { out: 0.05, slide: CABIN.doorW + 0.08 }

const WHITE = '#f2f0ea'
const FRP = '#dcdcd6'
const NAVY = '#24324a'
const STEEL = '#c4c9cc'

type V3 = [number, number, number]
type P2 = [number, number]

/** 断面（x, y。反時計回り）: 角を丸めた箱 */
function profile(): P2[] {
  const rb = 0.36
  const rt = 0.44
  const pts: P2[] = []
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 6) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  arc(W - rb, Y0 + rb, rb, -Math.PI / 2, 0)
  arc(W - rt, Y1 - rt, rt, 0, Math.PI / 2)
  arc(-W + rt, Y1 - rt, rt, Math.PI / 2, Math.PI)
  arc(-W + rb, Y0 + rb, rb, Math.PI, Math.PI * 1.5)
  return pts
}

/** 凸の多角形を軸に平行な長方形で切る（Sutherland–Hodgman） */
function clipRect(poly: P2[], x0: number, x1: number, y0: number, y1: number): P2[] {
  const edges: [(p: P2) => boolean, (a: P2, b: P2) => P2][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ]
  let out = poly
  for (const [inside, cut] of edges) {
    const src = out
    out = []
    for (let i = 0; i < src.length; i++) {
      const a = src[i]
      const b = src[(i + 1) % src.length]
      const ia = inside(a)
      const ib = inside(b)
      if (ia) out.push(a)
      if (ia !== ib) out.push(cut(a, b))
    }
    if (out.length < 3) return []
  }
  return out
}

/** 断面の一部を z の面に貼る（front = +z を向く面） */
function capFace(g: GeoBuilder, poly: P2[], z: number, front: boolean, color: string, m: number, aux = 0) {
  if (poly.length < 3) return
  const c: P2 = [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length]
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (front) g.tri([c[0], c[1], z], [a[0], a[1], z], [b[0], b[1], z], color, m, aux)
    else g.tri([c[0], c[1], z], [b[0], b[1], z], [a[0], a[1], z], color, m, aux)
  }
}

/** 管（2 点を結ぶ 8 角の筒） */
function tube(g: GeoBuilder, a: V3, b: V3, r: number, color: string, m: number, aux = 0, seg = 8) {
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

/** 縦の面（内向き・外向きの四角。a → b を下の辺、h0〜h1） */
function wallQuad(g: GeoBuilder, a: P2, b: P2, h0: number, h1: number, color: string, m: number, aux = 0) {
  // a, b は (x, z)。表（a → b を左から右に見る側）を向く面
  g.quad([b[0], h0, b[1]], [a[0], h0, a[1]], [a[0], h1, a[1]], [b[0], h1, b[1]], color, m, aux)
}

export interface CabinGeometry {
  body: THREE.BufferGeometry
  glass: THREE.BufferGeometry
  door: THREE.BufferGeometry
  doorGlass: THREE.BufferGeometry
}

/** 細かいゴンドラの形（ゴンドラの局所） */
export function cabinGeometry(): CabinGeometry {
  const g = new GeoBuilder()
  const gl = new GeoBuilder()
  const prof = profile()
  const n = prof.length
  // --- 外の殻（断面を z へ押し出した側面。腰 = 白、窓の帯 = ガラス（別の形）、上 = 屋根の色） ---
  const bands: [number, number, string, number, number][] = [
    [Y0 - 1, WIN0, WHITE, CM.paint, 0.75],
    [WIN1, Y1 + 1, '#ffffff', CM.tint, 0.7],
  ]
  for (let i = 0; i < n; i++) {
    const [ax, ay] = prof[i]
    const [bx, by] = prof[(i + 1) % n]
    for (const [b0, b1, c, m, aux] of bands) {
      const lo = Math.max(Math.min(ay, by), b0)
      const hi = Math.min(Math.max(ay, by), b1)
      if (hi - lo < 1e-4 && ay !== by) continue
      if (ay === by && (ay < b0 || ay > b1)) continue
      let pa: P2 = [ax, ay]
      let pb: P2 = [bx, by]
      if (ay !== by) {
        const ta = (lo - ay) / (by - ay)
        const tb = (hi - ay) / (by - ay)
        const p0: P2 = [ax + (bx - ax) * ta, lo]
        const p1: P2 = [ax + (bx - ax) * tb, hi]
        // 断面の向き（反時計回り）を保つ
        pa = by > ay ? p0 : p1
        pb = by > ay ? p1 : p0
      }
      g.quad([pa[0], pa[1], D], [pb[0], pb[1], D], [pb[0], pb[1], -D], [pa[0], pa[1], -D], c, m, aux)
    }
  }
  // --- 前後の面（+z: 腰・窓・上。−z: 扉の開口を切る） ---
  for (const z of [D, -D]) {
    const front = z > 0
    if (front) {
      capFace(g, clipRect(prof, -W, W, Y0 - 1, WIN0), z, true, WHITE, CM.paint, 0.75)
    } else {
      capFace(g, clipRect(prof, -W, -DOOR_X, Y0 - 1, WIN0), z, false, WHITE, CM.paint, 0.75)
      capFace(g, clipRect(prof, DOOR_X, W, Y0 - 1, WIN0), z, false, WHITE, CM.paint, 0.75)
      capFace(g, clipRect(prof, -DOOR_X, DOOR_X, Y0 - 1, FLOOR), z, false, WHITE, CM.paint, 0.75)
      // 扉の上の帯（窓の帯の高さ）
      capFace(g, clipRect(prof, -DOOR_X, DOOR_X, DOOR_TOP, WIN1), z, false, WHITE, CM.paint, 0.75)
    }
    capFace(g, clipRect(prof, -W, W, WIN1, Y1 + 1), z, front, '#ffffff', CM.tint, 0.7)
  }
  // --- 窓のガラス（外の面。ぐるり） ---
  const gx = W - 0.004
  gl.quad([gx, WIN0, D - 0.05], [gx, WIN0, -D + 0.05], [gx, WIN1, -D + 0.05], [gx, WIN1, D - 0.05], '#ffffff', 0)
  gl.quad([-gx, WIN0, -D + 0.05], [-gx, WIN0, D - 0.05], [-gx, WIN1, D - 0.05], [-gx, WIN1, -D + 0.05], '#ffffff', 0)
  const gz = D - 0.004
  gl.quad([-W + 0.05, WIN0, gz], [W - 0.05, WIN0, gz], [W - 0.05, WIN1, gz], [-W + 0.05, WIN1, gz], '#ffffff', 0)
  gl.quad([W - 0.05, WIN0, -gz], [DOOR_X + 0.05, WIN0, -gz], [DOOR_X + 0.05, WIN1, -gz], [W - 0.05, WIN1, -gz], '#ffffff', 0)
  gl.quad([-DOOR_X - 0.05, WIN0, -gz], [-W + 0.05, WIN0, -gz], [-W + 0.05, WIN1, -gz], [-DOOR_X - 0.05, WIN1, -gz], '#ffffff', 0)
  // --- 窓の枠: 四隅の柱・横の真ん中の桟・前後の桟・窓台と窓の上の縁（外） ---
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.boxMinMax(sx > 0 ? W - 0.1 : -W, WIN0, sz > 0 ? D - 0.1 : -D, sx > 0 ? W : -W + 0.1, WIN1, sz > 0 ? D : -D + 0.1, WHITE, CM.paint, 0.75)
  for (const sx of [-1, 1]) g.boxMinMax(sx * W - 0.03, WIN0, -0.025, sx * W + 0.03, WIN1, 0.025, WHITE, CM.paint, 0.75)
  for (const x of [-0.42, 0.42]) g.boxMinMax(x - 0.025, WIN0, D - 0.03, x + 0.025, WIN1, D + 0.01, WHITE, CM.paint, 0.75)
  for (const x of [-DOOR_X - 0.05, DOOR_X]) g.boxMinMax(x, FLOOR, -D - 0.01, x + 0.05, WIN1, -D + 0.04, WHITE, CM.paint, 0.75)
  // 窓台（外へ少し出る縁）と窓の上の縁（外まわりの細い帯。扉の所は切る）
  const rim = (y0: number, y1: number, o: number) => {
    g.boxMinMax(W - 0.02, y0, -D - o, W + o, y1, D + o, '#e6e4de', CM.paint, 0.8)
    g.boxMinMax(-W - o, y0, -D - o, -W + 0.02, y1, D + o, '#e6e4de', CM.paint, 0.8)
    g.boxMinMax(-W, y0, D - 0.02, W, y1, D + o, '#e6e4de', CM.paint, 0.8)
    g.boxMinMax(-W, y0, -D - o, -DOOR_X - 0.05, y1, -D + 0.02, '#e6e4de', CM.paint, 0.8)
    g.boxMinMax(DOOR_X + 0.05, y0, -D - o, W, y1, -D + 0.02, '#e6e4de', CM.paint, 0.8)
  }
  rim(WIN0 - 0.03, WIN0, 0.014)
  rim(WIN1, WIN1 + 0.035, 0.01)
  // --- 中: 床・腰の壁・窓台・窓の上・天井 ---
  g.quad([-IW, FLOOR, ID], [IW, FLOOR, ID], [IW, FLOOR, -ID], [-IW, FLOOR, -ID], '#3a3d40', CM.floor, 0)
  // 腰の壁（内向き）。−z は扉の開口で切る
  wallQuad(g, [-IW, -ID], [-IW, ID], FLOOR, WIN0, FRP, CM.frp)
  wallQuad(g, [IW, ID], [IW, -ID], FLOOR, WIN0, FRP, CM.frp)
  wallQuad(g, [-IW, ID], [IW, ID], FLOOR, WIN0, FRP, CM.frp)
  wallQuad(g, [IW, -ID], [DOOR_X, -ID], FLOOR, WIN0, FRP, CM.frp)
  wallQuad(g, [-DOOR_X, -ID], [-IW, -ID], FLOOR, WIN0, FRP, CM.frp)
  // 窓台（中。上向き）と窓の上（下向き）
  const ledge = (inner: [P2, P2], outer: [P2, P2], y: number, up: boolean, color: string) => {
    const [a, b] = inner
    const [c, d] = outer
    if (up) g.quad([a[0], y, a[1]], [b[0], y, b[1]], [d[0], y, d[1]], [c[0], y, c[1]], color, CM.frp)
    else g.quad([c[0], y, c[1]], [d[0], y, d[1]], [b[0], y, b[1]], [a[0], y, a[1]], color, CM.frp)
  }
  for (const [y, up] of [
    [WIN0, true],
    [WIN1, false],
  ] as const) {
    const col = up ? '#e8e6e0' : '#d2d2cc'
    ledge([[IW, ID], [IW, -ID]], [[W - 0.01, D - 0.01], [W - 0.01, -D + 0.01]], y, up, col)
    ledge([[-IW, -ID], [-IW, ID]], [[-W + 0.01, -D + 0.01], [-W + 0.01, D - 0.01]], y, up, col)
    ledge([[-IW, ID], [IW, ID]], [[-W + 0.01, D - 0.01], [W - 0.01, D - 0.01]], y, up, col)
    if (up) {
      ledge([[IW, -ID], [DOOR_X, -ID]], [[W - 0.01, -D + 0.01], [DOOR_X, -D + 0.01]], y, up, col)
      ledge([[-DOOR_X, -ID], [-IW, -ID]], [[-DOOR_X, -D + 0.01], [-W + 0.01, -D + 0.01]], y, up, col)
    } else ledge([[IW, -ID], [-IW, -ID]], [[W - 0.01, -D + 0.01], [-W + 0.01, -D + 0.01]], y, up, col)
  }
  // 窓の上から天井までの壁と天井
  wallQuad(g, [-IW, -ID], [-IW, ID], WIN1, CEIL, FRP, CM.frp)
  wallQuad(g, [IW, ID], [IW, -ID], WIN1, CEIL, FRP, CM.frp)
  wallQuad(g, [-IW, ID], [IW, ID], WIN1, CEIL, FRP, CM.frp)
  wallQuad(g, [IW, -ID], [-IW, -ID], WIN1, CEIL, FRP, CM.frp)
  g.quad([-IW, CEIL, -ID], [IW, CEIL, -ID], [IW, CEIL, ID], [-IW, CEIL, ID], '#eeeeea', CM.frp)
  // 扉の開口の見込み（左右と上）と、扉の上の中の壁
  wallQuad(g, [-DOOR_X, -D], [-DOOR_X, -ID], FLOOR, DOOR_TOP, '#e6e4de', CM.paint, 0.5)
  wallQuad(g, [DOOR_X, -ID], [DOOR_X, -D], FLOOR, DOOR_TOP, '#e6e4de', CM.paint, 0.5)
  g.quad([-DOOR_X, DOOR_TOP, -D], [DOOR_X, DOOR_TOP, -D], [DOOR_X, DOOR_TOP, -ID], [-DOOR_X, DOOR_TOP, -ID], '#e6e4de', CM.paint, 0.5)
  wallQuad(g, [DOOR_X, -ID], [-DOOR_X, -ID], DOOR_TOP, WIN1, FRP, CM.frp)
  // 敷居（アルミの縞板）
  g.boxMinMax(-DOOR_X, FLOOR - 0.01, -D, DOOR_X, FLOOR + 0.006, -ID + 0.04, '#b8bcbe', CM.alum, 0)
  // --- 長いす（x の両端で向かい合う）: 白い台・紺の座面と背もたれ・座面の前の縁 ---
  for (const sx of [1, -1]) {
    const xa = (v: number) => sx * v
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: string, m: number, aux = 0) => g.boxMinMax(Math.min(xa(x0), xa(x1)), y0, z0, Math.max(xa(x0), xa(x1)), y1, z1, c, m, aux)
    box(CABIN.benchX + 0.02, IW, FLOOR, FLOOR + 0.35, -0.99, 0.99, '#e2e2dc', CM.frp)
    box(CABIN.benchX, IW - 0.01, FLOOR + 0.35, FLOOR + 0.42, -0.97, 0.97, NAVY, CM.fabric, 0)
    box(CABIN.benchX - 0.012, CABIN.benchX + 0.05, FLOOR + 0.34, FLOOR + 0.415, -0.96, 0.96, NAVY, CM.fabric, 0)
    box(IW - 0.1, IW - 0.01, FLOOR + 0.46, FLOOR + 0.82, -0.95, 0.95, NAVY, CM.fabric, 0)
    box(IW - 0.07, IW, FLOOR + 0.42, FLOOR + 0.46, -0.95, 0.95, '#d0d0ca', CM.frp)
    // 座面の下の換気の口
    box(CABIN.benchX + 0.015, CABIN.benchX + 0.03, FLOOR + 0.08, FLOOR + 0.16, -0.5, 0.5, '#2a2c2e', CM.dark, 0.2)
    // 手すり（窓の下。背もたれの上）
    tube(g, [xa(IW - 0.07), FLOOR + 0.98, -0.85], [xa(IW - 0.07), FLOOR + 0.98, 0.85], 0.017, STEEL, CM.steel, 0.9)
    for (const z of [-0.85, 0.85]) tube(g, [xa(IW), FLOOR + 0.98, z], [xa(IW - 0.075), FLOOR + 0.98, z], 0.012, STEEL, CM.steel, 0.9)
  }
  // 前後の壁の手すり（+z は窓の下を横に、−z は扉の両わきの縦の握り棒）
  tube(g, [-0.62, FLOOR + 0.98, ID - 0.07], [0.62, FLOOR + 0.98, ID - 0.07], 0.017, STEEL, CM.steel, 0.9)
  for (const x of [-0.62, 0.62]) tube(g, [x, FLOOR + 0.98, ID], [x, FLOOR + 0.98, ID - 0.075], 0.012, STEEL, CM.steel, 0.9)
  for (const x of [-DOOR_X - 0.11, DOOR_X + 0.11]) {
    tube(g, [x, FLOOR + 0.62, -ID + 0.07], [x, FLOOR + 1.78, -ID + 0.07], 0.017, STEEL, CM.steel, 0.9)
    for (const y of [FLOOR + 0.62, FLOOR + 1.78]) tube(g, [x, y, -ID], [x, y, -ID + 0.075], 0.012, STEEL, CM.steel, 0.9)
  }
  // --- 天井: 丸い灯り（光る板と縁）・スピーカー・換気口 ---
  const lp = CABIN_SPOTS.lamp
  const lampY = FLOOR + lp[1]
  g.cylinder([0, CEIL - 0.03, 0], 0.25, 0.03, 28, '#d8dadb', CM.steel, 0.7, false)
  g.cylinder([0, CEIL - 0.035, 0], 0.215, 0.012, 28, '#fff3de', CM.lamp, 1, true)
  void lampY
  g.cylinder([0.62, CEIL - 0.008, 0.62], 0.075, 0.008, 16, '#3a3c3e', CM.dark, 0.3, true)
  for (const sx of [-1, 1]) g.boxMinMax(sx * 0.95 - 0.12, CEIL - 0.008, -0.55, sx * 0.95 + 0.12, CEIL, 0.55, '#3a3c3e', CM.dark, 0.2)
  // --- 外: 吊り金具（二つの板と軸の筒）・屋根の台・換気のふた・床の下の皿・扉の上のレール ---
  g.boxMinMax(-0.36, Y1 - 0.02, -0.3, 0.36, Y1 + 0.05, 0.3, '#d6d8d8', CM.steel, 0.6)
  for (const sx of [-1, 1]) g.boxMinMax(sx * 0.13 - 0.025, Y1, -0.17, sx * 0.13 + 0.025, 0.08, 0.17, '#cfd2d4', CM.steel, 0.65)
  tube(g, [0, 0, -0.32], [0, 0, 0.32], 0.11, '#b8bcbe', CM.steel, 0.7, 12)
  g.boxMinMax(-0.18, Y1 + 0.05, 0.35, 0.18, Y1 + 0.16, 0.62, '#e6e4de', CM.paint, 0.6)
  g.boxMinMax(-W + 0.3, Y0 - 0.05, -D + 0.25, W - 0.3, Y0 + 0.01, D - 0.25, '#2a2c2e', CM.dark, 0.2)
  g.boxMinMax(-DOOR_X - 0.08, DOOR_TOP + 0.03, -D - 0.075, DOOR_X + DOOR_OPEN.slide + 0.06, DOOR_TOP + 0.085, -D - 0.02, STEEL, CM.steel, 0.8)
  // 前の面の下の換気の口と、小さな番号の板の地
  for (let i = 0; i < 5; i++) g.boxMinMax(-0.3 + i * 0.15 - 0.05, Y0 + 0.55, D - 0.003, -0.3 + i * 0.15 + 0.05, Y0 + 0.58, D + 0.006, '#3a3c3e', CM.dark, 0.2)

  // --- 扉（引き戸。閉じた位置。外の面の少し外。腰は白い板、上はガラス、戸先の黒いゴムと縦の取っ手） ---
  const dg = new GeoBuilder()
  const dgl = new GeoBuilder()
  const dz0 = -D - 0.055
  const dz1 = -D - 0.012
  const x0 = -DOOR_X - 0.02
  const x1 = DOOR_X + 0.02
  dg.boxMinMax(x0, FLOOR + 0.01, dz0, x1, WIN0, dz1, WHITE, CM.paint, 0.75)
  dg.boxMinMax(x0, WIN0, dz0, x0 + 0.06, DOOR_TOP, dz1, WHITE, CM.paint, 0.75)
  dg.boxMinMax(x1 - 0.06, WIN0, dz0, x1, DOOR_TOP, dz1, WHITE, CM.paint, 0.75)
  dg.boxMinMax(x0, DOOR_TOP - 0.08, dz0, x1, DOOR_TOP, dz1, WHITE, CM.paint, 0.75)
  dg.boxMinMax(x0 - 0.012, FLOOR + 0.01, dz0 + 0.005, x0, DOOR_TOP, dz1 - 0.005, '#1c1c1c', CM.dark, 0.3)
  dg.boxMinMax(x0 + 0.05, FLOOR + 0.9, dz0 - 0.03, x0 + 0.075, FLOOR + 1.3, dz0, STEEL, CM.steel, 0.9)
  dg.boxMinMax(x0 + 0.05, FLOOR + 0.9, dz1, x0 + 0.075, FLOOR + 1.3, dz1 + 0.03, STEEL, CM.steel, 0.9)
  const dgz = (dz0 + dz1) / 2
  dgl.quad([x1 - 0.06, WIN0, dgz], [x0 + 0.06, WIN0, dgz], [x0 + 0.06, DOOR_TOP - 0.08, dgz], [x1 - 0.06, DOOR_TOP - 0.08, dgz], '#ffffff', 0)
  return { body: g.build(), glass: gl.build(), door: dg.build(), doorGlass: dgl.build() }
}

/* -------------------------------------------------------------------------- */
/* シェーダー                                                                     */
/* -------------------------------------------------------------------------- */

export const cabinUniforms = {
  /** 夜のホイールの LED の明るさ（outdoor.soranowa） */
  uLed: uniform(0),
}

type V3n = THREE.Node<'vec3'>

/** 中の天井の灯りの位置・色と、LED の色（ゴンドラの局所） */
const CAB_LAMP = vec3(0.0, CEIL - 0.06, 0.0)
const CAB_LAMP_C = vec3(1.0, 0.88, 0.7).mul(1.9)

/** ゴンドラの中か（局所の位置。CPU の cabInside と同じ範囲） */
const cabInside = (p: V3n) =>
  abs(p.x).lessThan(IW + 0.015).and(abs(p.z).lessThan(ID + 0.015)).and(p.y.greaterThan(FLOOR - 0.02)).and(p.y.lessThan(CEIL + 0.02))

/** CPU で: 局所の位置 p がゴンドラの中か（シェーダーの cabInside と同じ範囲。カメラが中にいるかをインスタンスごとに決める） */
function cabInsideCpu(p: THREE.Vector3) {
  return Math.abs(p.x) < IW + 0.015 && Math.abs(p.z) < ID + 0.015 && p.y > FLOOR - 0.02 && p.y < CEIL + 0.02
}

/**
 * 頂点の値（両方の材質が共有）。iInfo = (中の灯り 0〜1, 色の種, ハブへの向き x, y（インスタンスの回転を CPU で掛けたゴンドラの吊りの面の向き）)、
 * iCam = カメラがこのゴンドラの中にいるか（CPU で決める。前の GLSL はカメラの位置をインスタンスの局所へ戻して画素ごとに見ていた。値は同じ）
 */
function cabinVaryings() {
  const info = attribute<'vec4'>('iInfo', 'vec4')
  return {
    color: attribute<'vec3'>('color', 'vec3'),
    mat: attribute<'vec2'>('aMat', 'vec2'),
    info,
    camIn: attribute<'float'>('iCam', 'float'),
    local: varying(positionGeometry),
    localN: varying(normalGeometry),
    hub: varying(normalize(modelWorldMatrix.mul(vec4(info.z, info.w, 0.0, 0.0)).xyz)),
  }
}

/** 細かいゴンドラの不透明な面の材質（インスタンス。TSL） */
export function createCabinMaterial() {
  // 中の面と外の面の向きを取り違えても欠けないように両面（裏から見た面は法線を返す）
  const m = markPaint(unlit('soranowaCabin', { side: THREE.DoubleSide }), 'light')
  const v = cabinVaryings()
  m.colorNode = flatCabinColor(v)
  return withUniforms(m, cabinUniforms)
}

/**
 * ゴンドラの面: むら・織りの目・つやの照り返し・映り込みは描かず、材質の番号ごとの平らな色を、
 * 外は面の光の式・中は中の光の式（天井の灯りと窓から入る空の光）で塗る。灯りは光る物の色の式（emit）に通す
 */
function flatCabinColor(v: ReturnType<typeof cabinVaryings>) {
  const u = outdoorUniforms
  return Fn(() => {
    const wp = positionWorld.toVar()
    const N = normalize(normalWorld).toVar()
    const Nl = normalize(v.localN).mul(faceDirection).toVar()
    const local = v.local.toVar()
    const id = floor(v.mat.x.add(0.5)).toVar()
    const albedo = vec3(v.color).toVar()
    const metal = float(0.0).toVar()
    const emit = vec3(0.0).toVar()
    const inside = cabInside(local).toVar()
    const lampOn = v.info.x.toVar()
    const dist = length(cameraPosition.sub(wp)).toVar()
    If(id.greaterThan(2.5).and(id.lessThan(3.5)).or(id.greaterThan(7.5)), () => {
      metal.assign(1.0)
    })
      .ElseIf(id.greaterThan(4.5).and(id.lessThan(5.5)), () => {
        const k = floor(fract(v.info.y.mul(5.0).add(0.01)).mul(5.0)).toVar()
        albedo.assign(
          select(
            k.lessThan(0.5),
            vec3(0.62, 0.16, 0.14),
            select(k.lessThan(1.5), vec3(0.14, 0.3, 0.52), select(k.lessThan(2.5), vec3(0.62, 0.5, 0.12), select(k.lessThan(3.5), vec3(0.16, 0.42, 0.26), vec3(0.55, 0.3, 0.42)))),
          ),
        )
      })
      .ElseIf(id.greaterThan(5.5).and(id.lessThan(6.5)), () => {
        albedo.assign(v.color.mul(0.55))
        emit.assign(v.color.mul(lampOn.mul(3.2).add(0.15)))
      })
    const ao = select(inside, select(Nl.y.lessThan(-0.5), 0.8, 1.0), 1.0)
    const sh = townShadow(wp, N).toVar()
    // 中の照度: 天井の灯り（局所）と、四方の窓から入る空の光
    const Lv = CAB_LAMP.sub(local).toVar()
    const d2 = dot(Lv, Lv).toVar()
    const ndl = max(dot(Nl, Lv.mul(inverseSqrt(max(d2, 1e-4)))), 0.0)
    const E = CAB_LAMP_C.mul(lampOn).mul(ndl.mul(0.75).add(0.25)).div(d2.mul(1.4).add(0.35)).add(u.uSkyLight.mul(0.6)).add(u.uSunLight.mul(0.08))
    const amb = u.uSkyLight.mul(0.45).add(CAB_LAMP_C.mul(lampOn).mul(0.12))
    const col = cabinLight(albedo.mul(metal.mul(-0.6).add(1.0)), N, ao, sh, inside, E, amb).toVar()
    If(inside.not(), () => {
      col.addAssign(albedo.mul(townLamps(wp, N)).mul(0.45))
    })
    col.assign(outdoorHaze(col, wp))
    col.addAssign(paintEmit(emit).mul(exp(dist.negate().div(u.uHazeDist.mul(1.5)))))
    return col
  })()
}

/** 細かいゴンドラのガラス（透ける。空・夜の LED・中の灯りを映す。TSL） */
export function createCabinGlassMaterial() {
  const m = markPaint(unlit('soranowaCabinGlass', { transparent: true, depthWrite: false, side: THREE.DoubleSide }), 'window')
  const v = cabinVaryings()
  // 透けるガラスの式（映り込み・LED の映り・太陽のきらめきは描かない）
  const g = Fn(() => {
    const wp = positionWorld.toVar()
    const N = normalize(normalWorld).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    If(dot(N, V).lessThan(0.0), () => {
      N.assign(N.negate())
    })
    const room = vec3(0.86, 0.84, 0.8).mul(v.info.x).mul(0.32)
    const c = flatGlass(N, V, wp, room, v.camIn.greaterThan(0.5)).toVar()
    return vec4(outdoorHaze(c.rgb, wp), c.a)
  })()
  m.colorNode = g
  return withUniforms(m, cabinUniforms)
}

/* -------------------------------------------------------------------------- */
/* 細かいゴンドラの入れ物                                                           */
/* -------------------------------------------------------------------------- */

const _dm = new THREE.Matrix4()
const _inv = new THREE.Matrix4()
const _cl = new THREE.Vector3()

/** 細かいゴンドラ（最大 capacity 基）。毎コマ begin → add（ホイールの局所の行列・iInfo・扉の開き具合）→ end */
export class DetailedCabins {
  readonly meshes: THREE.InstancedMesh[]
  private body: THREE.InstancedMesh
  private glass: THREE.InstancedMesh
  private door: THREE.InstancedMesh
  private doorGlass: THREE.InstancedMesh
  private infos: THREE.InstancedBufferAttribute[] = []
  /** カメラがそのゴンドラの中にいるか（形ごと。本体・窓と扉では行列が違う） */
  private cams: THREE.InstancedBufferAttribute[] = []
  private count = 0
  readonly material: ReturnType<typeof createCabinMaterial>
  readonly glassMaterial: ReturnType<typeof createCabinGlassMaterial>

  constructor(capacity: number) {
    const geo = cabinGeometry()
    this.material = createCabinMaterial()
    this.glassMaterial = createCabinGlassMaterial()
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
      const info = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
      info.setUsage(THREE.DynamicDrawUsage)
      g.setAttribute('iInfo', info)
      const cam = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
      cam.setUsage(THREE.DynamicDrawUsage)
      g.setAttribute('iCam', cam)
      this.cams.push(cam)
      if (!g.getAttribute('color')) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3))
      if (!g.getAttribute('aMat')) g.setAttribute('aMat', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
      const mesh = new THREE.InstancedMesh(g, m, capacity)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.name = `soranowa:cabin:${name}`
      this.infos.push(info)
      return mesh
    }
    this.body = mk(geo.body, this.material, 'body')
    this.door = mk(geo.door, this.material, 'door')
    this.glass = mk(geo.glass, this.glassMaterial, 'glass')
    this.doorGlass = mk(geo.doorGlass, this.glassMaterial, 'doorGlass')
    this.glass.renderOrder = 22
    this.doorGlass.renderOrder = 22
    this.meshes = [this.body, this.door, this.glass, this.doorGlass]
  }

  begin() {
    this.count = 0
  }

  /**
   * 1 基（m = ゴンドラの局所 → 観覧車の局所（入れ物の group）の行列、info = (中の灯り, 色の種, ハブへの向き x, y（観覧車の局所の xy の面）)、
   * door = 扉の開き具合 0〜1、cam = カメラの位置（観覧車の局所。ガラスが中から見た映り方にするか））
   */
  add(m: THREE.Matrix4, info: readonly [number, number, number, number], door: number, cam: THREE.Vector3 | null = null) {
    const i = this.count
    if (i >= this.infos[0].count) return false
    this.body.setMatrixAt(i, m)
    this.glass.setMatrixAt(i, m)
    // 扉: 外へ出てから +x へ滑る（開き具合の前の 2 割で外へ、あとの 8 割で滑る）
    const e = door * door * (3 - 2 * door)
    const out = Math.min(1, e / 0.2) * DOOR_OPEN.out
    const slide = Math.max(0, (e - 0.2) / 0.8) * DOOR_OPEN.slide
    _dm.makeTranslation(slide, 0, -out).premultiply(m)
    this.door.setMatrixAt(i, _dm)
    this.doorGlass.setMatrixAt(i, _dm)
    // ハブへの向きは、前の GLSL と同じくインスタンスの回転を掛けた向きで渡す（シェーダーは物の行列だけを掛ける）
    const me = m.elements
    const hx = me[0] * info[2] + me[4] * info[3]
    const hy = me[1] * info[2] + me[5] * info[3]
    for (const a of this.infos) a.setXYZW(i, info[0], info[1], hx, hy)
    // カメラが中にいるか（前の GLSL はカメラをインスタンスの局所へ戻して画素ごとに見ていた。インスタンスごとに同じ値なのでここで決める）
    const inBody = cam ? cabInsideCpu(_cl.copy(cam).applyMatrix4(_inv.copy(m).invert())) : false
    const inDoor = cam ? cabInsideCpu(_cl.copy(cam).applyMatrix4(_inv.copy(_dm).invert())) : false
    this.cams[0].setX(i, inBody ? 1 : 0)
    this.cams[1].setX(i, inDoor ? 1 : 0)
    this.cams[2].setX(i, inBody ? 1 : 0)
    this.cams[3].setX(i, inDoor ? 1 : 0)
    this.count++
    return true
  }

  end() {
    for (const mesh of this.meshes) {
      mesh.count = this.count
      mesh.visible = this.count > 0
      if (this.count) {
        mesh.instanceMatrix.clearUpdateRanges()
        mesh.instanceMatrix.addUpdateRange(0, this.count * 16)
        mesh.instanceMatrix.needsUpdate = true
      }
    }
    for (const a of this.infos) {
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.count * 4)
      a.needsUpdate = true
    }
    for (const a of this.cams) {
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.count)
      a.needsUpdate = true
    }
  }
}
