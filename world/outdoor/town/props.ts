import * as THREE from 'three/webgpu'
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  floor,
  fract as tslFract,
  fwidth,
  int,
  length,
  max,
  mix,
  modelWorldMatrixInverse,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SITE } from '../../../core/town'
import { outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { ROOF } from './buildingKit'
import { townLight } from './facades'
import { depthMaterial, townShadow } from './shadows'
import { townTextureUniforms } from './townTextures'
import { townLamps, LAMP, type Lamp } from './lamps'
import type { TownTile } from './townData'
import { markPaint, paintEmit, paintFlat, paintLampLight } from '../paint'
import { glyph } from '../glyph'
import { barHalfWidth, thinSize } from '../thin'

/**
 * 建物の小物（形で描く）。外壁のシェーダーの模様だけでは平らに見える所に、厚みのある物を足す。
 *
 * - 細かさの中心から detailRadius まで: 集合住宅・学校の正面のベランダ（床の板・手すり・隣との仕切り・室外機）、
 *   1 階の店のひさし（布の縞）と袖看板、家の壁の室外機・2 階の小さなベランダ・玄関の庇
 * - roofPropsRadius まで: 陸屋根の塔屋（階段室）・給水塔・室外機の列・アンテナ・屋上の手すり、瓦屋根の家のテレビのアンテナ
 *
 * どれも「箱」（と給水塔の円柱）のインスタンス。インスタンスの値: pA = (中心 x, y, z（シーン）, 向き)、pB = (大きさ x, 高さ, 奥行き, 傾き)、
 * pC = (色 r, g, b, 種類)。種類で質感を変える（PROP）。並びは建物のインスタンスの値と外壁の型（facades.ts の facadeType と同じ決め方）から、
 * 建物の種で決める（同じデータなら同じ町）。外壁のシェーダーは、この範囲の建物のベランダの手すりを描かない（propsCenter）
 */

export const PROP = { slab: 0, railBars: 1, railPanel: 2, awning: 3, sign: 4, acUnit: 5, tank: 6, mast: 7, penthouse: 8, roofRail: 9, partition: 10 } as const

const LAB = SITE.labFloorElevation

/* -------------------------------------------------------------------------- */
/* 外壁の型（GLSL の facadeType と同じ）                                           */
/* -------------------------------------------------------------------------- */

const has = (flags: number, bit: number) => (flags & bit) !== 0
const fract = (v: number) => v - Math.floor(v)

/** facades.ts の facadeType と同じ答え */
export function facadeTypeOf(facade: number, use: number, flags: number, floors: number, style: number, seed: number) {
  if (facade === 4) return 7
  if (has(flags, 32) || facade === 6) return 8
  if (use === 8 && floors > 1.5) return 9
  const oldTown = style === 2 || style === 7 || style === 1
  if ((facade === 3 || facade === 7) && (oldTown || floors < 4.5 || fract(seed * 5.7) < 0.5)) return 3
  if (facade === 2 && (oldTown || floors < 2.5 || use === 6 || use === 9)) return 4
  const officeUse = use === 3 || use === 6 || use === 7 || (use === 2 && floors > 4.5)
  if (officeUse && floors > 2.5) return 6
  if (use < 2.5 && floors > 2.5 && (floors > 3.5 || fract(seed * 7.31) < 0.6 || style === 3 || style === 4)) return 5
  if (facade === 2 || facade === 3) return facade === 3 ? 3 : 1
  if (facade === 0) return 0
  return 1
}

/** GLSL の bayTarget と同じ */
function bayTargetOf(type: number) {
  return type === 7 ? 1.5 : type === 8 ? 6 : type === 9 ? 3.6 : type === 6 ? 3 : type === 5 ? 3.3 : type === 3 ? 3.1 : type === 4 ? 3 : 2.9
}

/* -------------------------------------------------------------------------- */
/* 並べる                                                                        */
/* -------------------------------------------------------------------------- */

class PropWriter {
  a: number[] = []
  b: number[] = []
  c: number[] = []
  /** 建物の局所の座標（lx = 局所の x、ly = 局所の y、h = 床からの高さ）で箱を置く */
  cx = 0
  cy = 0
  floorZ = 0
  cos = 1
  sin = 0
  yaw = 0
  begin(cx: number, cy: number, floorZ: number, yaw: number) {
    this.cx = cx
    this.cy = cy
    this.floorZ = floorZ
    this.yaw = yaw
    this.cos = Math.cos(yaw)
    this.sin = Math.sin(yaw)
  }
  /** 箱: 中心（局所 lx, ly, 下端の高さ h）・大きさ（局所 x 方向 sx、高さ sy、局所 y 方向 sz）・傾き（局所 x の軸まわり）・向きの追加（yawAdd） */
  box(lx: number, ly: number, h: number, sx: number, sy: number, sz: number, kind: number, color: [number, number, number], tilt = 0, yawAdd = 0) {
    const px = this.cx + this.cos * lx - this.sin * ly
    const py = this.cy + this.sin * lx + this.cos * ly
    this.a.push(px, this.floorZ + h + sy / 2 - LAB, -py, this.yaw + yawAdd)
    this.b.push(sx, sy, sz, tilt)
    this.c.push(color[0], color[1], color[2], kind)
  }
  get count() {
    return this.a.length / 4
  }
}

const GREY: [number, number, number] = [0.5, 0.5, 0.5]
const AC: [number, number, number] = [0.62, 0.62, 0.6]

interface Bld {
  cx: number
  cy: number
  floorZ: number
  yaw: number
  w: number
  d: number
  eave: number
  ridge: number
  floors: number
  front: number
  roof: number
  wall: [number, number, number]
  facade: number
  use: number
  flags: number
  seed: number
  style: number
}

/** 0〜1 の乱数（建物の種と番号から） */
function rand(seed: number, k: number) {
  return fract(Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453)
}

/** 正面の壁の局所の情報: 壁に沿った軸の長さ・外向き */
function frontInfo(b: Bld, side: number) {
  // side: 0 = +y、1 = -y、2 = +x、3 = -x
  const span = side < 2 ? b.w : b.d
  const out = side < 2 ? b.d / 2 : b.w / 2
  const sign = side % 2 === 0 ? 1 : -1
  return { span, out, sign, alongX: side < 2 }
}

function srgb(c: [number, number, number]): [number, number, number] {
  return [Math.pow(c[0] / 255, 2.2), Math.pow(c[1] / 255, 2.2), Math.pow(c[2] / 255, 2.2)]
}

/** 壁に沿った位置 t（-span/2〜span/2）・外への距離 o の局所の座標 */
function wallPoint(side: number, t: number, o: number): [number, number] {
  const sign = side % 2 === 0 ? 1 : -1
  return side < 2 ? [t, sign * o] : [sign * o, t]
}

function addFacadeProps(w: PropWriter, b: Bld) {
  const type = facadeTypeOf(b.facade, b.use, b.flags, b.floors, b.style, b.seed)
  const eaveEff = b.roof === ROOF.flat ? Math.max(b.eave - 0.9, 2.2) : b.eave
  const floorH = Math.max(eaveEff / Math.max(1, b.floors), 0.6)
  const wallC = srgb(b.wall)
  const side = b.front
  const f = frontInfo(b, side)
  const nb = Math.max(1, Math.floor(f.span / bayTargetOf(type) + 0.5))
  const bayW = f.span / nb
  const yawSide = side < 2 ? 0 : Math.PI / 2
  // 集合住宅・学校の正面のベランダ
  if ((type === 5 || type === 9) && b.floors > 1) {
    const kind = fract(b.seed * 23)
    const railKind = type === 9 ? PROP.railPanel : kind < 0.4 ? PROP.railPanel : kind < 0.75 ? PROP.railPanel : PROP.railBars
    const railC: [number, number, number] = type === 9 ? [0.62, 0.62, 0.6] : kind < 0.4 ? [0.42, 0.47, 0.5] : kind < 0.75 ? [wallC[0] * 1.1, wallC[1] * 1.1, wallC[2] * 1.1] : [0.06, 0.065, 0.07]
    const depth = type === 9 ? 1.8 : 1.15
    for (let fi = 1; fi < b.floors; fi++) {
      const h = 0.15 + fi * floorH
      const [sx, sy] = wallPoint(side, 0, f.out + depth / 2)
      // 床の板（壁の幅いっぱい）
      w.box(sx, sy, h - 0.18, f.span, 0.18, depth, PROP.slab, [0.55, 0.55, 0.53], 0, yawSide)
      // 手すり
      const [rx, ry] = wallPoint(side, 0, f.out + depth - 0.04)
      w.box(rx, ry, h, f.span, 1.1, 0.07, railKind, railC, 0, yawSide)
      // 隣との仕切り（2 間ごと）と、室外機
      for (let k = 0; k <= nb; k += 2) {
        const t = -f.span / 2 + k * bayW
        const [px, py] = wallPoint(side, t, f.out + depth / 2)
        if (k > 0 && k < nb) w.box(px, py, h, 0.06, floorH - 0.25, depth, PROP.partition, [0.68, 0.68, 0.66], 0, yawSide)
      }
      for (let k = 0; k < nb; k++) {
        if (rand(b.seed, fi * 31 + k) > 0.55 || type === 9) continue
        const t = -f.span / 2 + (k + 0.25 + 0.5 * rand(b.seed, k + 7)) * bayW
        const [ax, ay] = wallPoint(side, t, f.out + 0.32)
        w.box(ax, ay, h, 0.8, 0.62, 0.3, PROP.acUnit, AC, 0, yawSide)
      }
    }
  }
  // 1 階の店: ひさしと袖看板
  if (has(b.flags, 16) && type < 7.5) {
    const roofH = Math.min(floorH * 0.8, 3.4)
    for (let k = 0; k < nb; k++) {
      const r = rand(b.seed, 100 + k)
      if (r < 0.62) {
        const depth = 1.0 + 0.5 * rand(b.seed, 140 + k)
        const t = -f.span / 2 + (k + 0.5) * bayW
        const [ax, ay] = wallPoint(side, t, f.out + depth / 2 - 0.05)
        const pal = rand(b.seed, 200 + k)
        const col: [number, number, number] = pal < 0.25 ? [0.42, 0.06, 0.05] : pal < 0.45 ? [0.05, 0.2, 0.1] : pal < 0.6 ? [0.06, 0.1, 0.26] : pal < 0.8 ? [0.6, 0.55, 0.45] : [0.35, 0.18, 0.06]
        // ひさしは外へ向かって下がる（壁の向きに応じて傾きの向きを変える）
        const tiltSign = side === 0 || side === 3 ? 1 : -1
        w.box(ax, ay, roofH - 0.35, bayW * 0.92, 0.05, depth, PROP.awning, col, tiltSign * 0.35, yawSide)
      }
    }
    if (rand(b.seed, 300) < 0.45 && b.floors > 1) {
      const t = (rand(b.seed, 301) - 0.5) * f.span * 0.8
      const [sx, sy] = wallPoint(side, t, f.out + 0.45)
      const pal = rand(b.seed, 302)
      const col: [number, number, number] = pal < 0.3 ? [0.55, 0.08, 0.05] : pal < 0.55 ? [0.7, 0.66, 0.55] : pal < 0.8 ? [0.05, 0.12, 0.3] : [0.08, 0.3, 0.12]
      w.box(sx, sy, floorH + 0.3, 0.12, Math.min(2.4, floorH * (b.floors - 1) * 0.8), 0.7, PROP.sign, col, 0, yawSide)
    }
  }
  // 家: 室外機（横か裏の壁の足元）・2 階の小さなベランダ・玄関の庇
  if (type <= 1) {
    const n = 1 + Math.floor(rand(b.seed, 400) * 2)
    for (let i = 0; i < n; i++) {
      const s = (side + 1 + Math.floor(rand(b.seed, 401 + i) * 3)) % 4
      const fi2 = frontInfo(b, s)
      const t = (rand(b.seed, 410 + i) - 0.5) * fi2.span * 0.7
      const [ax, ay] = wallPoint(s, t, fi2.out + 0.2)
      w.box(ax, ay, 0.05, 0.8, 0.6, 0.3, PROP.acUnit, AC, 0, s < 2 ? 0 : Math.PI / 2)
    }
    if (b.floors >= 2 && rand(b.seed, 420) < 0.42) {
      const bw = Math.min(f.span * 0.6, 3.6)
      const t = (rand(b.seed, 421) - 0.5) * (f.span - bw)
      const [sx, sy] = wallPoint(side, t, f.out + 0.45)
      const h = 0.15 + floorH
      w.box(sx, sy, h - 0.12, bw, 0.12, 0.9, PROP.slab, [0.5, 0.5, 0.48], 0, yawSide)
      const [rx, ry] = wallPoint(side, t, f.out + 0.87)
      w.box(rx, ry, h, bw, 0.95, 0.05, PROP.railBars, rand(b.seed, 422) < 0.5 ? [0.08, 0.08, 0.08] : [0.5, 0.5, 0.48], 0, yawSide)
    }
    if (rand(b.seed, 430) < 0.35) {
      const t = (rand(b.seed, 431) - 0.5) * f.span * 0.6
      const [cx, cy] = wallPoint(side, t, f.out + 0.45)
      w.box(cx, cy, 2.3, 1.6, 0.06, 0.9, PROP.slab, [0.3, 0.3, 0.3], (side === 0 || side === 3 ? 1 : -1) * 0.12, yawSide)
    }
  }
}

function addRoofProps(w: PropWriter, b: Bld, far: boolean, tanks: PropWriter) {
  const wallC = srgb(b.wall)
  if (b.roof === ROOF.flat) {
    const top = b.eave - 0.75
    const big = b.floors >= 3
    const ix = b.w / 2 - 1.2
    const iy = b.d / 2 - 1.2
    if (ix < 0.6 || iy < 0.6) return
    const r = (k: number) => rand(b.seed, 500 + k)
    // 塔屋（階段室・機械室）
    if (big && r(0) < 0.75) {
      const sx = Math.min(4.2, b.w * 0.3)
      const sz = Math.min(3.6, b.d * 0.3)
      const px = (r(1) - 0.5) * (b.w - sx - 2)
      const py = (r(2) - 0.5) * (b.d - sz - 2)
      w.box(px, py, top, sx, 2.8, sz, PROP.penthouse, [wallC[0] * 0.9, wallC[1] * 0.9, wallC[2] * 0.9])
    }
    // 給水塔（台の上の円柱）
    if (r(3) < (big ? 0.4 : 0.15) && b.floors <= 9) {
      const px = (r(4) - 0.5) * ix * 1.4
      const py = (r(5) - 0.5) * iy * 1.4
      tanks.begin(b.cx, b.cy, b.floorZ, b.yaw)
      tanks.box(px, py, top + 1.2, 2.0, 1.8, 2.0, PROP.tank, [0.62, 0.64, 0.62])
      w.box(px, py, top, 1.8, 1.2, 1.8, PROP.mast, [0.3, 0.3, 0.3])
    }
    if (far) return
    // 室外機の列
    const n = big ? 2 + Math.floor(r(6) * 5) : Math.floor(r(6) * 2.5)
    for (let i = 0; i < n; i++) {
      const px = (r(10 + i) - 0.5) * ix * 1.6
      const py = (r(20 + i) - 0.5) * iy * 1.6
      w.box(px, py, top, 1.0, 0.75, 0.75, PROP.acUnit, AC, 0, Math.floor(r(30 + i) * 4) * (Math.PI / 2))
    }
    // アンテナ
    if (r(40) < 0.3) {
      const px = (r(41) - 0.5) * ix
      const py = (r(42) - 0.5) * iy
      w.box(px, py, top, 0.08, 4.5, 0.08, PROP.mast, GREY)
      w.box(px, py, top + 3.4, 1.6, 0.05, 0.05, PROP.mast, GREY)
      w.box(px, py, top + 4.0, 1.1, 0.05, 0.05, PROP.mast, GREY)
    }
    // 屋上の手すり
    if (big && r(50) < 0.3) {
      const h = b.eave
      w.box(0, b.d / 2 - 0.15, h, b.w - 0.3, 1.1, 0.05, PROP.roofRail, GREY)
      w.box(0, -b.d / 2 + 0.15, h, b.w - 0.3, 1.1, 0.05, PROP.roofRail, GREY)
      w.box(b.w / 2 - 0.15, 0, h, 0.05, 1.1, b.d - 0.3, PROP.roofRail, GREY)
      w.box(-b.w / 2 + 0.15, 0, h, 0.05, 1.1, b.d - 0.3, PROP.roofRail, GREY)
    }
  } else if (!far && (b.style === 1 || b.style === 5) && rand(b.seed, 600) < 0.35 && b.roof !== ROOF.sawtooth) {
    // 瓦屋根の家のテレビのアンテナ（棟の上）
    const px = (rand(b.seed, 601) - 0.5) * b.w * 0.5
    w.box(px, 0, b.ridge - 0.2, 0.05, 2.6, 0.05, PROP.mast, GREY)
    w.box(px, 0, b.ridge + 1.6, 1.4, 0.04, 0.04, PROP.mast, GREY)
    w.box(px, 0, b.ridge + 2.1, 0.9, 0.04, 0.04, PROP.mast, GREY)
  }
}

/** タイルの建物から小物を並べる。center = 細かさの中心（平面座標） */
export function collectProps(tiles: TownTile[], center: [number, number], detailRadius: number, roofRadius: number, skip: (namedIndex: number, eave: number) => boolean) {
  const w = new PropWriter()
  const tanks = new PropWriter()
  for (const t of tiles) {
    const s = t.sections
    const n = s.b_pos.array.length / 4
    const P = s.b_pos.array as Float32Array
    const D = s.b_dim.array as Float32Array
    const E = s.b_ext.array as Float32Array
    const Wc = s.b_wall.array as Uint8Array
    const R = s.b_roof.array as Uint8Array
    const M = s.b_meta.array as Uint8Array
    for (let i = 0; i < n; i++) {
      const dist = Math.hypot(P[i * 4] - center[0], P[i * 4 + 1] - center[1])
      if (dist > roofRadius) continue
      const roof = R[i * 4 + 3]
      if (roof === ROOF.arch) continue
      const named = (s.b_named.array as Int32Array)[i]
      if (named >= 0 && skip(named, D[i * 4 + 2])) continue
      let yaw = P[i * 4 + 3]
      let front = E[i * 4 + 2]
      // 片流れは低い側（正面）を局所 +y に（collectInstances と同じ）
      if (roof === ROOF.shed && front === 1) {
        yaw += Math.PI
        front = 0
      }
      const seedInt = M[i * 4 + 2] + M[i * 4 + 3] * 256
      const b: Bld = {
        cx: P[i * 4],
        cy: P[i * 4 + 1],
        floorZ: P[i * 4 + 2],
        yaw,
        w: D[i * 4],
        d: D[i * 4 + 1],
        eave: D[i * 4 + 2],
        ridge: Math.max(D[i * 4 + 3], D[i * 4 + 2]),
        floors: Math.max(1, E[i * 4 + 1]),
        front,
        roof,
        wall: [Wc[i * 4], Wc[i * 4 + 1], Wc[i * 4 + 2]],
        facade: Wc[i * 4 + 3],
        use: M[i * 4],
        flags: M[i * 4 + 1],
        seed: seedInt / 65536,
        style: E[i * 4 + 3],
      }
      w.begin(b.cx, b.cy, b.floorZ, b.yaw)
      if (dist < detailRadius) addFacadeProps(w, b)
      w.begin(b.cx, b.cy, b.floorZ, b.yaw)
      addRoofProps(w, b, dist > roofRadius * 0.45, tanks)
    }
  }
  return { boxes: w, tanks }
}

/**
 * 1 階の店の店先の灯り（灯りの表に入れる。夜、店の前の歩道と向かいの壁を照らす）。ひさしのある間口ごとに、
 * 正面の壁から 1.2m 外・高さ 2.6m に 1 つ（ひさしの無い店は正面の中ほどに 1 つ）。町じゅう（灯りの表が使うのは近くだけ）
 */
export function shopFrontLamps(tiles: TownTile[], skip: (namedIndex: number, eave: number) => boolean): Lamp[] {
  const out: Lamp[] = []
  for (const t of tiles) {
    const s = t.sections
    const n = s.b_pos.array.length / 4
    const P = s.b_pos.array as Float32Array
    const D = s.b_dim.array as Float32Array
    const E = s.b_ext.array as Float32Array
    const Wc = s.b_wall.array as Uint8Array
    const R = s.b_roof.array as Uint8Array
    const M = s.b_meta.array as Uint8Array
    for (let i = 0; i < n; i++) {
      if (!has(M[i * 4 + 1], 16)) continue
      const roof = R[i * 4 + 3]
      if (roof === ROOF.arch) continue
      const named = (s.b_named.array as Int32Array)[i]
      if (named >= 0 && skip(named, D[i * 4 + 2])) continue
      let yaw = P[i * 4 + 3]
      let front = E[i * 4 + 2]
      if (roof === ROOF.shed && front === 1) {
        yaw += Math.PI
        front = 0
      }
      const seed = (M[i * 4 + 2] + M[i * 4 + 3] * 256) / 65536
      const floors = Math.max(1, E[i * 4 + 1])
      const type = facadeTypeOf(Wc[i * 4 + 3], M[i * 4], M[i * 4 + 1], floors, E[i * 4 + 3], seed)
      if (type >= 7.5) continue
      const b = { w: D[i * 4], d: D[i * 4 + 1] } as Bld
      const f = frontInfo(b, front)
      const nb = Math.max(1, Math.floor(f.span / bayTargetOf(type) + 0.5))
      const bayW = f.span / nb
      const cos = Math.cos(yaw)
      const sin = Math.sin(yaw)
      const push = (tt: number, power: number) => {
        const [lx, ly] = wallPoint(front, tt, f.out + 1.2)
        out.push({ x: P[i * 4] + cos * lx - sin * ly, y: P[i * 4 + 1] + sin * lx + cos * ly, z: P[i * 4 + 2] + 2.6, kind: LAMP.shop, power })
      }
      let any = false
      for (let k = 0; k < nb; k++) {
        if (rand(seed, 100 + k) >= 0.62) continue
        push(-f.span / 2 + (k + 0.5) * bayW, 1.6)
        any = true
      }
      if (!any) push(0, 1.4)
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* 形とシェーダー                                                                */
/* -------------------------------------------------------------------------- */

function instancedGeometry(base: THREE.BufferGeometry, wr: PropWriter) {
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  g.setAttribute('position', base.attributes.position)
  g.setAttribute('normal', base.attributes.normal)
  const n = Math.max(1, wr.count)
  const pad = (arr: number[]) => {
    const f = new Float32Array(n * 4)
    f.set(arr)
    return f
  }
  g.setAttribute('pA', new THREE.InstancedBufferAttribute(pad(wr.a), 4))
  g.setAttribute('pB', new THREE.InstancedBufferAttribute(pad(wr.b), 4))
  g.setAttribute('pC', new THREE.InstancedBufferAttribute(pad(wr.c), 4))
  g.instanceCount = wr.count
  return g
}

/**
 * 小物の材質（TSL。WebGPU への移行の第 2 段）。インスタンスの値: pA = 位置（シーン）・向き、pB = 大きさ・傾き、pC = 色・種類。
 * 形はワールドの位置で計算する（前の GLSL は viewMatrix だけを掛けていた）。影の深さだけの材質は同じ式の位置を使う（細い棒を太らせない形）
 */
export function createPropMaterials() {
  const uniforms = { uShop: uniform(0), uLightGain: uniform(1) }
  const u = outdoorUniforms
  const pA = attribute<'vec4'>('pA', 'vec4')
  const pB = attribute<'vec4'>('pB', 'vec4')
  const pC = attribute<'vec4'>('pC', 'vec4')
  const n0 = normalGeometry
  // 傾き（局所の x の軸まわり）と向き（縦の軸まわり。建物の局所 x = 平面の (cos, sin)、シーンでは (cos, 0, -sin)）
  const ct = cos(pB.w)
  const st = sin(pB.w)
  const c = cos(pA.w)
  const s = sin(pA.w)
  /** 大きさ size の箱の頂点（局所の (x, 上, y) → シーン（x = 東、z = -北）） */
  const placed = (size: Node<'vec3'>) => {
    const p0 = positionGeometry.mul(size)
    const p1 = vec3(p0.x, ct.mul(p0.y).sub(st.mul(p0.z)), st.mul(p0.y).add(ct.mul(p0.z)))
    const wp0 = pA.xyz.add(vec3(c.mul(p1.x).sub(s.mul(p1.z)), p1.y, s.mul(p1.x).add(c.mul(p1.z)).negate()))
    return modelWorldMatrixInverse.mul(vec4(wp0, 1.0)).xyz
  }
  // 外の塗りの flat: 手すりの子柱・アンテナの細い棒は、画素より細くなる遠くで画素の幅まで太らせる（outdoor/thin.ts。塗りを入れなければ前と同じ）。
  // 影の深さは太らせない形で（影の地図を描くときのカメラで太らせると、影が太くなる）
  const positionNode = placed(paintFlat() ? thinSize(pB.xyz, pA.xyz) : pB.xyz)
  const shadowPosition = placed(pB.xyz)
  const n1 = vec3(n0.x, ct.mul(n0.y).sub(st.mul(n0.z)), st.mul(n0.y).add(ct.mul(n0.z)))
  const vNormal = varying(vec3(c.mul(n1.x).sub(s.mul(n1.z)), n1.y, s.mul(n1.x).add(c.mul(n1.z)).negate()))
  const vLocal = varying(positionGeometry)
  const vSize = varying(pB.xyz)
  const vColor = varying(pC)
  const vLN = varying(normalGeometry)

  const material = markPaint(unlit('townProps', { side: THREE.DoubleSide }), 'light')
  // 外の塗り（paint.ts）の flat: コンクリート・漆喰の質感と金属の照り返しを省く（形の模様は残す）
  const flat = paintFlat()
  material.positionNode = positionNode
  material.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    const N = normalize(vNormal).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const kind = vColor.a.toVar()
    const albedo = vColor.rgb.toVar()
    const m = vLocal.add(0.5).mul(vSize).toVar()
    const ao = float(1.0).toVar()
    const emit = vec3(0.0).toVar()
    const dist = length(cameraPosition.sub(wp)).toVar()
    const fine = smoothstep(30.0, 120.0, dist).oneMinus().toVar()
    // 1 画素あたりの局所の座標の変わり（看板の文字の縁をなめらかにする。微分は分岐の外で取る）
    const fwm = fwidth(m).toVar()
    If(kind.lessThan(0.5).or(kind.greaterThan(9.5)), () => {
      // コンクリートの床の板・仕切り: コンクリートの質感
      if (!flat) {
        const t = townTextureUniforms.uBldAlb.sample(vec2(m.x.add(m.z), m.y).div(3.2)).depth(int(4)).rgb.mul(2.0)
        albedo.mulAssign(pow(max(t, 0.0), vec3(2.2)))
      }
      If(N.y.lessThan(-0.5), () => {
        ao.assign(0.6)
      })
    })
      .ElseIf(kind.lessThan(1.5), () => {
        // 金属の手すり（縦の格子。近くは格子の間を抜く）
        const along = select(abs(vLN.x).greaterThan(0.5), m.z, m.x)
        // 外の塗りの flat: 桟が画素より細くなる遠くでは、桟を画素の幅まで太らせる（抜く・抜かないが画素ごとに入れ替わらないように。outdoor/thin.ts）
        const bar = flat
          ? step(float(0.5).sub(barHalfWidth(0.115, select(abs(vLN.x).greaterThan(0.5), fwm.z, fwm.x), 0.11)), abs(tslFract(along.div(0.11)).sub(0.5)))
          : smoothstep(0.32, 0.45, abs(tslFract(along.div(0.11)).sub(0.5)))
        const top = step(vSize.y.sub(0.06), m.y).add(step(m.y, 0.05))
        If(fine.greaterThan(0.5).and(bar.lessThan(0.5)).and(top.lessThan(0.5)).and(abs(vLN.y).lessThan(0.5)), () => {
          Discard()
        })
      })
      .ElseIf(kind.lessThan(2.5), () => {
        // 手すりの板（すりガラス・金属の板）: 少し光る
        albedo.mulAssign(step(0.5, tslFract(m.x.div(1.8))).mul(0.1).add(0.9))
      })
      .ElseIf(kind.lessThan(3.5), () => {
        // ひさしの布（縞）
        const stripe = step(0.5, tslFract(m.x.div(0.45)))
        If(tslFract(vColor.r.mul(13.0).add(vColor.g.mul(7.0))).greaterThan(0.5), () => {
          albedo.assign(mix(albedo, vec3(0.75, 0.72, 0.66), stripe.mul(0.85)))
        })
        If(N.y.lessThan(0.0), () => {
          ao.assign(0.55)
        })
      })
      .ElseIf(kind.lessThan(4.5), () => {
        // 袖看板（文字と、夜は光る）
        if (flat) {
          // 外の塗り（paint.ts）の flat: 縦 1 列の文字（画を組んだ形。glyph.ts）。夜は板が光り、文字は板の色と分けて光らせる
          // （前は文字の上にも板の光を足していたので、明るい板では文字が光に埋もれて白い板に見えた）
          const cw = max(vSize.z.sub(0.24), 0.1).toVar()
          const ry = m.y.sub(0.16).div(cw.mul(1.08)).toVar()
          const q = vec2(m.z.sub(0.12).div(cw), tslFract(ry))
          const letters = glyph(q.x, q.y, tslFract(sin(floor(ry).mul(12.9).add(vColor.r.mul(37.0)).add(vColor.b.mul(11.0))).mul(43758.5)), max(fwm.z, fwm.y.div(1.08)).div(cw))
            .mul(step(0.12, m.z))
            .mul(step(m.z, vSize.z.sub(0.12)))
            .mul(step(0.16, m.y))
            .mul(step(floor(ry).add(1.0).mul(cw.mul(1.08)), vSize.y.sub(0.16)))
            .toVar()
          const light = dot(albedo, vec3(0.33)).greaterThan(0.4)
          const lc = select(light, vec3(0.08), vec3(0.85, 0.82, 0.72)).toVar()
          If(abs(vLN.x).greaterThan(0.5), () => {
            albedo.assign(mix(albedo, lc, letters.mul(fine)))
          })
          emit.assign(mix(vColor.rgb.mul(1.8), lc.mul(select(light, 0.4, 1.6)), letters.mul(fine).mul(step(0.5, abs(vLN.x)))).mul(uniforms.uShop))
        } else {
          const cellP = floor(vec2(m.z, m.y).div(vec2(0.18, 0.22)))
          const letters = step(0.5, tslFract(sin(dot(cellP, vec2(12.9, 78.2))).mul(43758.5)))
            .mul(step(0.1, m.z))
            .mul(step(m.z, vSize.z.sub(0.1)))
            .mul(step(0.12, m.y))
            .mul(step(m.y, vSize.y.sub(0.12)))
            .toVar()
          const lc = select(dot(albedo, vec3(0.33)).greaterThan(0.4), vec3(0.08), vec3(0.85, 0.82, 0.72)).toVar()
          If(abs(vLN.x).greaterThan(0.5), () => {
            albedo.assign(mix(albedo, lc, letters.mul(fine)))
          })
          emit.assign(vColor.rgb.mul(1.8).add(lc.mul(letters).mul(1.2)).mul(uniforms.uShop))
        }
      })
      .ElseIf(kind.lessThan(5.5), () => {
        // 室外機（前の面にファンの丸）
        If(abs(vLN.z).greaterThan(0.5), () => {
          const q = vec2(m.x.sub(vSize.x.mul(0.62)), m.y.sub(vSize.y.mul(0.5)))
          const fan = smoothstep(0.2, 0.24, length(q)).oneMinus()
          albedo.assign(mix(albedo, vec3(0.12), fan.mul(0.8)))
        })
      })
      .ElseIf(kind.lessThan(6.5), () => {
        // 給水塔（パネルの継ぎ目）
        albedo.mulAssign(step(0.08, tslFract(m.y.div(0.6))).mul(0.1).add(0.9))
      })
      .ElseIf(kind.greaterThan(7.5).and(kind.lessThan(8.5)), () => {
        // 塔屋: 外壁の質感（漆喰）と扉
        if (!flat) {
          const t = townTextureUniforms.uBldAlb.sample(vec2(m.x.add(m.z), m.y).div(3.0)).depth(int(1)).rgb.mul(2.0)
          albedo.mulAssign(pow(max(t, 0.0), vec3(2.2)))
        }
        If(vLN.z.greaterThan(0.5).and(abs(m.x.sub(vSize.x.mul(0.5))).lessThan(0.45)).and(m.y.lessThan(2.1)), () => {
          albedo.assign(vec3(0.18, 0.19, 0.2))
        })
        ao.assign(mix(0.7, 1.0, smoothstep(0.0, 1.0, m.y)))
      })
    const sh = townShadow(wp, N).toVar()
    const col = townLight(albedo, N, ao, sh, 'prop').toVar()
    col.addAssign(paintLampLight(albedo, townLamps(wp, N)).mul(ao))
    // 金属の照り返し
    if (!flat) If(kind.greaterThan(0.5).and(kind.lessThan(2.5)).or(kind.greaterThan(4.5).and(kind.lessThan(7.5))), () => {
      col.addAssign(u.uSunLight.mul(pow(max(dot(reflect(V.negate(), N), u.uSunDir), 0.0), 30.0)).mul(0.15).mul(sh))
    })
    col.assign(outdoorHaze(col, wp))
    col.addAssign(paintEmit(emit.mul(uniforms.uLightGain)).mul(exp(dist.negate().div(u.uHazeDist.mul(1.5)))))
    return col
  })()
  const depth = depthMaterial({ positionNode: shadowPosition })
  return { material: withUniforms(material, uniforms), depth }
}

export type PropMaterials = ReturnType<typeof createPropMaterials>

const BOX_GEO = new THREE.BoxGeometry(1, 1, 1)
const TANK_GEO = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1)

/** 小物のメッシュ（箱と給水塔）。center = 細かさの中心 */
export function propMeshes(tiles: TownTile[], mats: PropMaterials, center: [number, number], detailRadius: number, roofRadius: number, skip: (namedIndex: number, eave: number) => boolean = () => false) {
  const { boxes, tanks } = collectProps(tiles, center, detailRadius, roofRadius, skip)
  return [
    [boxes, BOX_GEO, 'boxes'],
    [tanks, TANK_GEO, 'tanks'],
  ].map(([wr, geo, name]) => {
    const mesh = new THREE.Mesh(instancedGeometry(geo as THREE.BufferGeometry, wr as PropWriter), mats.material)
    mesh.frustumCulled = false
    mesh.visible = (wr as PropWriter).count > 0
    mesh.name = `townProps:${name}`
    mesh.userData.shadowMaterial = mats.depth
    return mesh
  })
}
