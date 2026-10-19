import * as THREE from 'three'
import { SITE } from '../../../core/town'
import { INTERIOR_ZONES } from '../../../core/interiors'
import type { LightItem, LightKind } from '../town/lights'
import { Frame, rng, seedOf, type V3 } from './frame'
import { KitBuilder, NO_BOTTOM } from './kitBuilder'
import { MassWriter } from './mass'
import { GLASS, LIGHT_CLASS, NM } from './namedMaterial'
import type { NamedRecord } from './namedData'
import { SignBuilder, signAtlas, type SignStyle } from './signs'

/**
 * 名前のある建物を組み立てる道具（1 棟ぶんの入れ物 Kit と、壁・開口・飾り・屋根の部品）。
 *
 * - 近くの形: solid（細かい形。namedMaterial の質感）・glass（窓のガラス）・glow（灯具）・signs（看板）・doors（開く扉。段階 4 の後半）
 * - 遠くの形: mass（町の建物のシェーダーで描く安い形。mass.ts）
 * - 夜の灯り: lamps（近くの壁と地面を照らす入口の灯り）・lights（町の光の点。遠くのきらめき）
 * 座標は面ごとの Frame（s 右へ・t 奥へ・h 上へ）。開口は壁の面の 2D（s, h）の多角形
 */

const LAB = SITE.labFloorElevation

/* -------------------------------------------------------------------------- */
/* 窓のガラス                                                                    */
/* -------------------------------------------------------------------------- */

export interface GlassSpec {
  /** 種類（namedMaterial の GLASS） */
  kind: number
  /** 明かりの決め方（LIGHT_CLASS） */
  cls: number
  /** 部屋の奥行き（m） */
  depth?: number
  /** 桟の数（縦・横）と太さ（m。0 なら桟なし） */
  cols?: number
  rows?: number
  bar?: number
  /** 枠の色 */
  frame?: string
  /** 開口の下端から部屋の床・天井まで（m。床は負） */
  yF?: number
  yC?: number
  seed?: number
}

const _gc = new THREE.Color()

export class GlassBuilder {
  pos: number[] = []
  nrm: number[] = []
  col: number[] = []
  win: number[] = []
  info: number[] = []
  grid: number[] = []
  room: number[] = []
  idx: number[] = []

  get count() {
    return this.pos.length / 3
  }

  /**
   * 開口のガラス: pts = シーンの点、loc = 開口の左下からの (u, v) m、w・h = 開口の大きさ、archV = アーチの始まる高さ（0 なら無し）。
   * tris = 三角形（loc の番号）
   */
  add(pts: V3[], loc: THREE.Vector2[], tris: number[][], w: number, h: number, normal: V3, g: GlassSpec, archV = 0) {
    _gc.set(g.frame ?? '#3a3d40')
    const i0 = this.count
    const seed = g.seed ?? Math.random()
    pts.forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2])
      this.nrm.push(normal[0], normal[1], normal[2])
      this.col.push(_gc.r, _gc.g, _gc.b)
      this.win.push(loc[i].x, loc[i].y, w, h)
      this.info.push(seed, g.kind, g.depth ?? 4, g.cls)
      this.grid.push(g.cols ?? 2, g.rows ?? 1, g.bar ?? 0.035, archV)
      this.room.push(g.yF ?? -0.9, g.yC ?? Math.max(h + 0.4, 2.4), 0, 0)
    })
    for (const t of tris) this.idx.push(i0 + t[0], i0 + t[1], i0 + t[2])
  }

  merge(o: GlassBuilder) {
    const base = this.count
    for (const k of ['pos', 'nrm', 'col', 'win', 'info', 'grid', 'room'] as const) {
      const s = o[k]
      const d = this[k]
      for (let i = 0; i < s.length; i++) d.push(s[i])
    }
    for (const i of o.idx) this.idx.push(i + base)
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.win, 4))
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4))
    g.setAttribute('aGrid', new THREE.Float32BufferAttribute(this.grid, 4))
    g.setAttribute('aRoom', new THREE.Float32BufferAttribute(this.room, 4))
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}

/* -------------------------------------------------------------------------- */
/* 1 棟ぶんの入れ物                                                              */
/* -------------------------------------------------------------------------- */

/** 近くの壁と地面を照らす灯り（シーンの位置・届く距離 m・色 × 強さ（リニア）） */
export interface Lamp {
  p: V3
  range: number
  color: [number, number, number]
}

/** 開く扉（段階 4 の後半で中を作る建物の入口）。蝶番の位置・扉の幅と高さ・開く向き */
export interface DoorSpec {
  buildingId: string
  entrance: number
  /** 蝶番の軸の下端（シーン）と、扉の幅の向き（シーンの単位ベクトル。蝶番 → 戸先）・外向き */
  hinge: V3
  across: V3
  out: V3
  width: number
  height: number
  /** 外へ開くなら 1、中へなら -1 */
  swing: 1 | -1
  /** 外へ開くときの rotation.y の符号（扉の局所の z が外向きなら -1、内向きなら +1） */
  openSign: 1 | -1
  /** 扉の板の形（扉の局所の座標: x = 蝶番から戸先へ、y = 上、z = x × y（右手系）。蝶番の軸の下端が原点） */
  leaf: KitBuilder
  glass: GlassBuilder | null
  /** 両開きのもう一枚（あれば） */
  pair?: DoorSpec
}

/** 時計（文字盤の中心・外向き・半径。針は createNamed が作って毎コマ回す） */
export interface ClockSpec {
  center: V3
  out: V3
  radius: number
}

/** 開口の記録（中のある建物の中の壁の穴・窓のガラス・桟を、外観と同じ位置に作るため。interior/） */
export interface OpeningRecord {
  f: Frame
  o: Opening
  /** 壁の面の奥行きの位置 */
  t0: number
}

/** ガラスの記録（中のある建物で、透けるガラスに替える所。pts = 面の (s, h)、t = ガラスの面の奥行き） */
export interface PaneRecord {
  f: Frame
  o: Opening
  pts: THREE.Vector2[]
  t: number
  g: GlassSpec
}

/** 中を作る建物（core/interiors.ts のゾーンの建物）。外観の窓のガラスと仮の物を、別の形に分けておく */
const INTERIOR_BUILDINGS = new Set(Object.values(INTERIOR_ZONES).map((z) => z.buildingId))

export class Kit {
  clocks: ClockSpec[] = []
  /** 中のある建物か（窓のガラスは glassSep、扉の奥の暗い箱などの仮の物は placeholder に分ける。中を作ったら隠す） */
  readonly interior: boolean
  /** 開口と窓のガラスの記録（中のある建物の中を作るときに使う） */
  openings: OpeningRecord[] = []
  panes: PaneRecord[] = []
  /** 中のある建物の窓のガラス（部屋の奥を描く不透明なガラス。中を作ったら隠して、透けるガラスに替える） */
  glassSep = new GlassBuilder()
  /** 中のある建物の仮の物（扉の奥の暗い箱など。中を作ったら隠す） */
  placeholder = new KitBuilder()
  solid = new KitBuilder()
  glass = new GlassBuilder()
  /** 光る物（aMat = (点き方, 強さ)） */
  glow = new KitBuilder()
  /** 透けるガラス（大庇・温室の屋根。空を映し、向こうが透ける） */
  clear = new KitBuilder()
  signs = new SignBuilder()
  mass = new MassWriter()
  lamps: Lamp[] = []
  lights: LightItem[] = []
  doors: DoorSpec[] = []
  readonly seed: number
  readonly rnd: () => number
  readonly rec: NamedRecord

  constructor(rec: NamedRecord) {
    this.rec = rec
    this.seed = seedOf(rec.id)
    this.rnd = rng(this.seed)
    this.solid.seed = (this.seed % 997) / 997
    this.solid.groundY = rec.z - LAB
    this.solid.dirt = 0.4
    this.interior = INTERIOR_BUILDINGS.has(rec.id)
    this.placeholder.groundY = rec.z - LAB
    this.placeholder.seed = this.solid.seed
  }

  /** 仮の物を足す先（中のある建物なら placeholder、ほかは solid） */
  get temp() {
    return this.interior ? this.placeholder : this.solid
  }

  /** 光る物を足す（灯具の箱・円柱など）。cls = 点き方（0 夜の灯り・1 店の時間・2 窓・3 時計）、power = 強さ */
  glowBox(center: V3, size: V3, color: string, cls: number, power: number, rot = 0) {
    this.glow.box(center, size, color, cls, power, rot)
  }

  /** 入口の灯り（近くの壁を照らす光と、遠くの光の点） */
  lamp(p: V3, range = 7, color = '#ffc27a', power = 1.6, size = 0.5, kind = 1, point = true) {
    const c = new THREE.Color(color).multiplyScalar(power)
    this.lamps.push({ p, range, color: [c.r, c.g, c.b] })
    // point = false: 照らすだけの灯り（灯具の形の無い所。町の光の点は出さない）
    if (!point) return
    // 町の光の点（平面座標と標高）: LIGHT_KIND.street = 1・path = 3
    this.lights.push({ x: p[0], y: -p[2], z: p[1] + LAB, kind: kind as LightKind, color, size, power: power * 0.8, seed: this.rnd() * 0.3 })
  }

  /** 投光器（夜に建物の正面を照らす。灯具は地面の小さな箱）。p = 灯具の位置、range = 届く距離 */
  flood(p: V3, range = 22, color = '#ffd6a0', power = 1.6) {
    const c = new THREE.Color(color).multiplyScalar(power)
    this.lamps.push({ p: [p[0], p[1] + 0.3, p[2]], range: -range, color: [c.r, c.g, c.b] })
    this.solid.box([p[0], p[1] + 0.15, p[2]], [0.45, 0.3, 0.35], '#2a2c2e', NM.iron, 0.4)
    this.glow.box([p[0], p[1] + 0.32, p[2]], [0.34, 0.06, 0.26], '#fff1d6', 0, 3)
  }

  /** 看板を貼る（面 f の (s, h) を左下に、幅 w・高さ h、壁から t だけ手前（負 = 外へ）） */
  sign(f: Frame, s: number, h: number, w: number, ht: number, t: number, style: Omit<SignStyle, 'w' | 'h'>, mode = 0) {
    const r = signAtlas.region({ ...style, w, h: ht } as SignStyle)
    this.signs.quad(f.p(s, t, h), f.p(s + w, t, h), f.p(s + w, t, h + ht), f.p(s, t, h + ht), r, mode)
  }
}

/* -------------------------------------------------------------------------- */
/* 箱・面                                                                       */
/* -------------------------------------------------------------------------- */

/** 面 f にそろえた箱（s0〜s1・t0〜t1（奥へ）・h0〜h1） */
export function fbox(b: KitBuilder, f: Frame, s0: number, s1: number, t0: number, t1: number, h0: number, h1: number, color: string, mat: number, aux = 0, faces = NO_BOTTOM) {
  if (s1 < s0) [s0, s1] = [s1, s0]
  if (t1 < t0) [t0, t1] = [t1, t0]
  if (h1 < h0) [h0, h1] = [h1, h0]
  b.box(f.p((s0 + s1) / 2, (t0 + t1) / 2, (h0 + h1) / 2), [s1 - s0, h1 - h0, t1 - t0], color, mat, aux, f.yaw, faces)
}

/** 面 f の 4 点の面（s, t, h の点。表から見て反時計回り） */
export function fquad(b: KitBuilder, f: Frame, a: V3, c: V3, d: V3, e: V3, color: string, mat: number, aux = 0) {
  b.quad(f.p(...a), f.p(...c), f.p(...d), f.p(...e), color, mat, aux)
}

/** 表が want（シーンの向き）を向くように 4 点の面を足す */
export function quadFacing(b: KitBuilder, a: V3, c: V3, d: V3, e: V3, want: V3, color: string, mat: number, aux = 0) {
  const e1 = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2])
  const e2 = new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2])
  const n = e1.cross(e2)
  if (n.x * want[0] + n.y * want[1] + n.z * want[2] >= 0) b.quad(a, c, d, e, color, mat, aux)
  else b.quad(e, d, c, a, color, mat, aux)
}

/* -------------------------------------------------------------------------- */
/* 開口と壁                                                                      */
/* -------------------------------------------------------------------------- */

export type OpeningShape = 'rect' | 'arch' | 'segment' | 'round' | 'pointed'

export interface DoorStyle {
  /** panel = 鏡板の扉、glass = ガラス戸、double = 両開きの板戸、doubleGlass = 両開きのガラス戸、lattice = 格子戸、sliding = 引き戸（ガラス）、shutter = シャッター、open = 開いたまま（奥が暗い。中のある建物では穴だけ）*/
  kind: 'panel' | 'glass' | 'double' | 'doubleGlass' | 'lattice' | 'sliding' | 'shutter' | 'open'
  color: string
  glass?: GlassSpec
  /** 開く扉にする（段階 4 の後半の 4 棟の入口）。番号はデータの入口の番号 */
  operable?: number
  /** 欄間（扉の上のガラス）の高さ m */
  transom?: number
}

export interface Opening {
  /** 左下（壁の面の s, h）と大きさ */
  s: number
  h: number
  w: number
  ht: number
  shape?: OpeningShape
  /** 見込み（壁の面からガラス・扉まで m） */
  depth?: number
  /** glass = ガラス、door = 扉、none = 暗い奥（中のある建物では穴だけ）、void = 穴だけ（中のある建物の中へ抜ける勝手口など） */
  fill?: 'glass' | 'door' | 'none' | 'void'
  glass?: GlassSpec
  door?: DoorStyle
  /** 見込みの面の色・質感（無ければ壁と同じ） */
  revealColor?: string
  revealMat?: number
}

const SEG = 10

/** 開口の外形（反時計回り。s, h） */
export function openingOutline(o: Opening): THREE.Vector2[] {
  const { s, h, w, ht } = o
  const shape = o.shape ?? 'rect'
  const pts: THREE.Vector2[] = []
  if (shape === 'rect') {
    pts.push(new THREE.Vector2(s, h), new THREE.Vector2(s + w, h), new THREE.Vector2(s + w, h + ht), new THREE.Vector2(s, h + ht))
  } else if (shape === 'arch') {
    const r = w / 2
    const spring = h + Math.max(0, ht - r)
    pts.push(new THREE.Vector2(s, h), new THREE.Vector2(s + w, h))
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI
      pts.push(new THREE.Vector2(s + r + Math.cos(a) * r, spring + Math.sin(a) * r))
    }
  } else if (shape === 'segment') {
    // 欠円アーチ（上端の弧の高さ = 幅の 1/6）
    const rise = w / 6
    const spring = h + ht - rise
    const R = (w * w) / (8 * rise) + rise / 2
    const cy = spring + rise - R
    const half = Math.asin(w / 2 / R)
    pts.push(new THREE.Vector2(s, h), new THREE.Vector2(s + w, h))
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI / 2 - half + (i / 6) * half * 2
      pts.push(new THREE.Vector2(s + w / 2 + Math.cos(a) * R, cy + Math.sin(a) * R))
    }
  } else if (shape === 'pointed') {
    // 尖頭アーチ（ゴシック）: 半径 = 幅の 2 つの弧が上で交わる
    const R = w
    const rise = Math.sqrt(R * R - (w / 2) * (w / 2))
    const spring = h + Math.max(0, ht - rise)
    pts.push(new THREE.Vector2(s, h), new THREE.Vector2(s + w, h))
    const half = Math.atan2(rise, w / 2)
    for (let i = 0; i <= 6; i++) {
      // 右の弧（中心は左の脚）
      const a = (i / 6) * half
      pts.push(new THREE.Vector2(s + Math.cos(a) * R, spring + Math.sin(a) * R))
    }
    for (let i = 5; i >= 0; i--) {
      const a = (i / 6) * half
      pts.push(new THREE.Vector2(s + w - Math.cos(a) * R, spring + Math.sin(a) * R))
    }
  } else {
    const r = Math.min(w, ht) / 2
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      pts.push(new THREE.Vector2(s + w / 2 + Math.cos(a) * r, h + ht / 2 + Math.sin(a) * r))
    }
  }
  return pts
}

/** アーチの始まる高さ（開口の下端から。アーチでなければ 0） */
function archStart(o: Opening) {
  const shape = o.shape ?? 'rect'
  if (shape === 'arch') return Math.max(0.01, o.ht - o.w / 2)
  if (shape === 'pointed') return Math.max(0.01, o.ht - Math.sqrt(0.75) * o.w)
  if (shape === 'segment') return o.ht - o.w / 6
  return 0
}

/**
 * 開口のある壁: outline = 壁の外形（s, h。反時計回り）、t0 = 壁の面の奥行きの位置。
 * 開口は穴をあけ、見込み（奥へ depth）・ガラス・扉を足す
 */
export function wall(k: Kit, f: Frame, outline: THREE.Vector2[], openings: Opening[], color: string, mat: number, aux = 0, t0 = 0) {
  const b = k.solid
  const holes = openings.map(openingOutline)
  const out = f.out
  b.polygonWithHoles(outline, holes, (p) => f.p(p.x, t0, p.y), out, color, mat, aux)
  openings.forEach((o, i) => {
    k.openings.push({ f, o, t0 })
    opening(k, f, o, holes[i], color, mat, aux, t0)
  })
}

/** 長方形の壁（s0〜s1・h0〜h1） */
export function rectWall(k: Kit, f: Frame, s0: number, s1: number, h0: number, h1: number, openings: Opening[], color: string, mat: number, aux = 0, t0 = 0) {
  wall(k, f, [new THREE.Vector2(s0, h0), new THREE.Vector2(s1, h0), new THREE.Vector2(s1, h1), new THREE.Vector2(s0, h1)], openings, color, mat, aux, t0)
}

/** 開口の見込みと中身（ガラス・扉・暗い奥） */
function opening(k: Kit, f: Frame, o: Opening, pts: THREE.Vector2[], color: string, mat: number, aux: number, t0: number) {
  const b = k.solid
  const d = o.depth ?? 0.18
  const rc = o.revealColor ?? color
  const rm = o.revealMat ?? mat
  const n = pts.length
  // 見込み（開口の縁から奥へ。開口の中心を向く）
  const cx = pts.reduce((s, p) => s + p.x, 0) / n
  const cy = pts.reduce((s, p) => s + p.y, 0) / n
  const prevAO = b.ao
  b.ao = prevAO * 0.8
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    const mx = (p.x + q.x) / 2
    const my = (p.y + q.y) / 2
    const want = f.dir(cx - mx, 0, cy - my)
    quadFacing(b, f.p(p.x, t0, p.y), f.p(q.x, t0, q.y), f.p(q.x, t0 + d, q.y), f.p(p.x, t0 + d, p.y), want, rc, rm, aux)
  }
  b.ao = prevAO
  const fill = o.fill ?? 'glass'
  const t1 = t0 + d
  if (fill === 'glass') {
    glassPane(k, f, o, pts, t1, o.glass ?? { kind: GLASS.house, cls: LIGHT_CLASS.window })
  } else if (fill === 'none') {
    // 暗い奥（アーケード・開いた入口）。中のある建物では仮の物（中を作ったら隠す）
    const back = pts.map((p) => f.p(p.x, t1 + 1.2, p.y))
    const tb = k.temp
    tb.ao = 0.4
    tb.polygon(back, '#1a1816', NM.dark)
    tb.ao = 1
  } else if (fill === 'door' && o.door) {
    door(k, f, o, t1)
  }
}

/** 開口の形のガラス（奥行き t の面） */
export function glassPane(k: Kit, f: Frame, o: Opening, pts: THREE.Vector2[], t: number, g: GlassSpec) {
  const loc = pts.map((p) => new THREE.Vector2(p.x - o.s, p.y - o.h))
  const tris = THREE.ShapeUtils.triangulateShape(loc, [])
  const fixed = tris.map((tr) => {
    const a = loc[tr[0]]
    const c = loc[tr[1]]
    const e = loc[tr[2]]
    return (c.x - a.x) * (e.y - a.y) - (c.y - a.y) * (e.x - a.x) >= 0 ? tr : [tr[0], tr[2], tr[1]]
  })
  // 中のある建物: 別に分け（中を作ったら隠す）、透けるガラスに替える所として記録する
  if (k.interior) k.panes.push({ f, o, pts: pts.map((p) => p.clone()), t, g })
  ;(k.interior ? k.glassSep : k.glass).add(
    pts.map((p) => f.p(p.x, t, p.y)),
    loc,
    fixed,
    o.w,
    o.ht,
    f.out,
    { ...g, seed: g.seed ?? k.rnd() },
    archStart(o),
  )
}

/** 長方形のガラス（面 f の s0〜s1・h0〜h1、奥行き t） */
export function glassRect(k: Kit, f: Frame, s0: number, s1: number, h0: number, h1: number, t: number, g: GlassSpec) {
  const o: Opening = { s: s0, h: h0, w: s1 - s0, ht: h1 - h0 }
  glassPane(k, f, o, openingOutline(o), t, g)
}

/* -------------------------------------------------------------------------- */
/* 扉                                                                          */
/* -------------------------------------------------------------------------- */

/** 扉の板（局所の builder に、蝶番の軸の下端を原点・x = 戸先へ・y = 上・z = 外向きで作る） */
function doorLeaf(style: DoorStyle, w: number, h: number, glassOut: GlassBuilder | null, seed: number) {
  const b = new KitBuilder()
  const c = style.color
  const th = 0.05
  const L = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: string, m: number, aux = 0) =>
    b.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [x1 - x0, y1 - y0, z1 - z0], col, m, aux)
  if (style.kind === 'panel' || style.kind === 'double') {
    L(0, w, 0, h, -th, 0, c, NM.paint, 0.4)
    // 鏡板（2 列 × 3 段）
    const mx = 0.1
    const cols = w > 0.7 ? 2 : 1
    const rows = 3
    const pw = (w - mx * (cols + 1)) / cols
    const ph = (h - 0.12 * (rows + 1)) / rows
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const x0 = mx + i * (pw + mx)
        const y0 = 0.12 + j * (ph + 0.12)
        L(x0, x0 + pw, y0, y0 + ph, 0, 0.012, c, NM.paint, 0.4)
      }
    L(w - 0.1, w - 0.06, h * 0.45, h * 0.5, 0, 0.05, '#c9a54a', NM.gold)
  } else if (style.kind === 'glass' || style.kind === 'doubleGlass' || style.kind === 'sliding') {
    const fr = 0.07
    L(0, fr, 0, h, -th, 0, c, NM.paint, 0.5)
    L(w - fr, w, 0, h, -th, 0, c, NM.paint, 0.5)
    L(fr, w - fr, 0, 0.22, -th, 0, c, NM.paint, 0.5)
    L(fr, w - fr, h - fr, h, -th, 0, c, NM.paint, 0.5)
    if (glassOut) {
      const g = style.glass ?? { kind: GLASS.shop, cls: LIGHT_CLASS.shop }
      const gw = w - fr * 2
      const gh = h - fr - 0.22
      const loc = [new THREE.Vector2(0, 0), new THREE.Vector2(gw, 0), new THREE.Vector2(gw, gh), new THREE.Vector2(0, gh)]
      glassOut.add(
        loc.map((p) => [fr + p.x, 0.22 + p.y, -th / 2] as V3),
        loc,
        [
          [0, 1, 2],
          [0, 2, 3],
        ],
        gw,
        gh,
        [0, 0, 1],
        { cols: 1, rows: 1, bar: 0, ...g, seed },
      )
    }
    L(w - 0.14, w - 0.11, h * 0.35, h * 0.62, 0, 0.06, '#b8b4aa', NM.paint, 0.9)
  } else if (style.kind === 'lattice') {
    L(0, 0.05, 0, h, -th, 0, c, NM.wood)
    L(w - 0.05, w, 0, h, -th, 0, c, NM.wood)
    L(0.05, w - 0.05, 0, 0.12, -th, 0, c, NM.wood)
    L(0.05, w - 0.05, h - 0.06, h, -th, 0, c, NM.wood)
    L(0.05, w - 0.05, 0.12, h - 0.06, -th * 0.6, -th * 0.2, c, NM.lattice, 0.045)
    if (glassOut) {
      const gw = w - 0.1
      const gh = h - 0.18
      const loc = [new THREE.Vector2(0, 0), new THREE.Vector2(gw, 0), new THREE.Vector2(gw, gh), new THREE.Vector2(0, gh)]
      glassOut.add(
        loc.map((p) => [0.05 + p.x, 0.12 + p.y, -th * 0.9] as V3),
        loc,
        [
          [0, 1, 2],
          [0, 2, 3],
        ],
        gw,
        gh,
        [0, 0, 1],
        { kind: GLASS.cafe, cls: LIGHT_CLASS.shop, cols: 1, rows: 1, bar: 0, ...style.glass, seed },
      )
    }
  } else if (style.kind === 'shutter') {
    L(0, w, 0, h, -th, 0, c, NM.metalRoof, -0.08)
  }
  return b
}

/** 開口の中の扉（t = 扉の外の面）。開く扉は doors に入れ、ほかは solid・glass にそのまま足す */
function door(k: Kit, f: Frame, o: Opening, t: number) {
  const st = o.door!
  if (st.kind === 'open') {
    const pts = openingOutline(o).map((p) => f.p(p.x, t + 1.5, p.y))
    k.temp.polygon(pts, '#141210', NM.dark)
    return
  }
  const transom = st.transom ?? 0
  const h = o.ht - transom - (archStart(o) > 0 ? o.ht - archStart(o) : 0)
  const doubleLeaf = st.kind === 'double' || st.kind === 'doubleGlass'
  const leaves = doubleLeaf ? 2 : 1
  const lw = o.w / leaves
  // 欄間・アーチの上のガラス
  if (transom > 0 || archStart(o) > 0) {
    const top: Opening = { s: o.s, h: o.h + h, w: o.w, ht: o.ht - h, shape: o.shape === 'arch' || o.shape === 'segment' ? o.shape : 'rect' }
    const ptsTop = openingOutline(top)
    glassPane(k, f, top, ptsTop, t + 0.02, { kind: st.glass?.kind ?? GLASS.cafe, cls: st.glass?.cls ?? LIGHT_CLASS.shop, cols: 3, rows: 1, bar: 0.03, frame: st.color })
    fbox(k.solid, f, o.s, o.s + o.w, t - 0.02, t + 0.04, o.h + h - 0.05, o.h + h + 0.05, st.color, NM.paint, 0.5)
  }
  for (let i = 0; i < leaves; i++) {
    const right = i === 1
    const glassB = new GlassBuilder()
    const leaf = doorLeaf(st, lw, h, glassB, k.rnd())
    // 局所 → シーン: 蝶番の軸（左の扉は左端、右の扉は右端）。局所の座標はいつも右手系（z = x × 上）にするので、
    // 右の扉は z が内向きになる。扉の板の形を z で裏返しておく（厚みは内へ、ガラスの表は外へ）
    const hs = right ? o.s + o.w : o.s
    const hinge = f.p(hs, t, o.h)
    const across = right ? f.dir(-1, 0, 0) : f.dir(1, 0, 0)
    const zAxis: V3 = right ? [-f.out[0], 0, -f.out[2]] : f.out
    if (right) {
      mirrorZ(leaf)
      mirrorZGlass(glassB)
    }
    if (st.operable !== undefined) {
      k.doors.push({ buildingId: k.rec.id, entrance: st.operable, hinge, across, out: zAxis, width: lw, height: h, swing: 1, openSign: right ? 1 : -1, leaf, glass: glassB.count ? glassB : null })
      continue
    }
    placeLocal(k.solid, leaf, hinge, across, zAxis)
    if (glassB.count) placeLocalGlass(k.interior ? k.glassSep : k.glass, glassB, hinge, across, zAxis)
  }
  if (doubleLeaf && st.operable !== undefined && k.doors.length >= 2) {
    const a = k.doors[k.doors.length - 2]
    a.pair = k.doors[k.doors.length - 1]
  }
}

/** 局所の形を z で裏返す（位置・法線の z の符号と、三角形の向き） */
function mirrorZ(b: KitBuilder) {
  for (let i = 2; i < b.pos.length; i += 3) {
    b.pos[i] = -b.pos[i]
    b.nrm[i] = -b.nrm[i]
  }
  // 細い棒の差（aThin）の z も
  for (let i = 2; i < b.thin.length; i += 4) b.thin[i] = -b.thin[i]
  for (let i = 0; i < b.idx.length; i += 3) [b.idx[i + 1], b.idx[i + 2]] = [b.idx[i + 2], b.idx[i + 1]]
}

function mirrorZGlass(b: GlassBuilder) {
  for (let i = 2; i < b.pos.length; i += 3) {
    b.pos[i] = -b.pos[i]
    b.nrm[i] = -b.nrm[i]
  }
  for (let i = 0; i < b.idx.length; i += 3) [b.idx[i + 1], b.idx[i + 2]] = [b.idx[i + 2], b.idx[i + 1]]
  // ガラスの u（開口の左からの位置）も左右が入れ替わる
  for (let i = 0; i < b.win.length; i += 4) b.win[i] = b.win[i + 2] - b.win[i]
}

/** 局所の形（x = across・y = 上・z = out）を hinge に置いて足す */
export function placeLocal(dst: KitBuilder, src: KitBuilder, hinge: V3, across: V3, out: V3) {
  const m = localMatrix(hinge, across, out)
  const nm = new THREE.Matrix3().getNormalMatrix(m)
  const v = new THREE.Vector3()
  const base = dst.vertexCount
  for (let i = 0; i < src.pos.length; i += 3) {
    v.set(src.pos[i], src.pos[i + 1], src.pos[i + 2]).applyMatrix4(m)
    dst.pos.push(v.x, v.y, v.z)
    v.set(src.nrm[i], src.nrm[i + 1], src.nrm[i + 2]).applyMatrix3(nm).normalize()
    dst.nrm.push(v.x, v.y, v.z)
  }
  dst.col.push(...src.col)
  dst.mat.push(...src.mat)
  for (let i = 0; i < src.ext.length; i += 4) dst.ext.push(src.ext[i], dst.groundY, dst.seed, dst.dirt)
  // 細い棒の差（aThin。向きだけ回す。頂点と同じ数だけ足さないと、ほかの値と頂点がずれる）
  const rot = new THREE.Matrix3().setFromMatrix4(m)
  for (let i = 0; i < src.thin.length; i += 4) {
    v.set(src.thin[i], src.thin[i + 1], src.thin[i + 2]).applyMatrix3(rot)
    dst.thin.push(v.x, v.y, v.z, src.thin[i + 3])
  }
  for (const i of src.idx) dst.idx.push(i + base)
}

function placeLocalGlass(dst: GlassBuilder, src: GlassBuilder, hinge: V3, across: V3, out: V3) {
  const m = localMatrix(hinge, across, out)
  const nm = new THREE.Matrix3().getNormalMatrix(m)
  const v = new THREE.Vector3()
  const base = dst.count
  for (let i = 0; i < src.pos.length; i += 3) {
    v.set(src.pos[i], src.pos[i + 1], src.pos[i + 2]).applyMatrix4(m)
    dst.pos.push(v.x, v.y, v.z)
    v.set(src.nrm[i], src.nrm[i + 1], src.nrm[i + 2]).applyMatrix3(nm).normalize()
    dst.nrm.push(v.x, v.y, v.z)
  }
  for (const key of ['col', 'win', 'info', 'grid', 'room'] as const) dst[key].push(...src[key])
  for (const i of src.idx) dst.idx.push(i + base)
}

/** 局所（x = across・y = 上・z = out）→ シーンの行列 */
export function localMatrix(hinge: V3, across: V3, out: V3) {
  const x = new THREE.Vector3(...across)
  const y = new THREE.Vector3(0, 1, 0)
  const z = new THREE.Vector3(...out)
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(hinge[0], hinge[1], hinge[2])
}

/* -------------------------------------------------------------------------- */
/* 開口のまわりの飾り                                                             */
/* -------------------------------------------------------------------------- */

/** 窓台（開口の下。外へ proj 張り出す） */
export function sill(k: Kit, f: Frame, o: Opening, color: string, mat: number = NM.stone, proj = 0.1, ht = 0.08, over = 0.08) {
  fbox(k.solid, f, o.s - over, o.s + o.w + over, -proj, 0.04, o.h - ht, o.h, color, mat, 0)
}

/** まぐさ・アーチの迫石（開口の上の帯） */
export function lintel(k: Kit, f: Frame, o: Opening, color: string, mat: number = NM.stone, ht = 0.22, proj = 0.04, over = 0.1, keystone = false) {
  const shape = o.shape ?? 'rect'
  const b = k.solid
  if (shape === 'rect') {
    fbox(b, f, o.s - over, o.s + o.w + over, -proj, 0.02, o.h + o.ht, o.h + o.ht + ht, color, mat, 0)
    if (keystone) fbox(b, f, o.s + o.w / 2 - 0.12, o.s + o.w / 2 + 0.12, -proj - 0.03, 0.02, o.h + o.ht - 0.04, o.h + o.ht + ht + 0.06, color, mat, 0)
    return
  }
  if (shape === 'pointed' || shape === 'round') {
    // 外形の上の弧に沿った帯（線分ごとに外へ ht）
    const pts = openingOutline(o)
    const spring = o.h + archStart(o)
    const cx = o.s + o.w / 2
    const cyc = shape === 'round' ? o.h + o.ht / 2 : spring
    const list = shape === 'round' ? [...pts, pts[0]] : pts.slice(2)
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1]
      const q = list[i]
      if (shape !== 'round' && (p.y < spring - 0.01 || q.y < spring - 0.01)) continue
      const off = (v: THREE.Vector2) => {
        const d = new THREE.Vector2(v.x - cx, v.y - cyc).normalize()
        return new THREE.Vector2(v.x + d.x * ht, v.y + d.y * ht)
      }
      const po = off(p)
      const qo = off(q)
      const t = -proj
      b.quad(f.p(p.x, t, p.y), f.p(q.x, t, q.y), f.p(qo.x, t, qo.y), f.p(po.x, t, po.y), color, mat, 0)
      quadFacing(b, f.p(po.x, t, po.y), f.p(qo.x, t, qo.y), f.p(qo.x, 0.02, qo.y), f.p(po.x, 0.02, po.y), f.dir((po.x + qo.x) / 2 - cx, 0, (po.y + qo.y) / 2 - cyc), color, mat, 0)
    }
    return
  }
  // アーチ: 外へ少し張り出した弧の帯（迫石を数個に分けて目地の陰）
  const r0 = shape === 'arch' ? o.w / 2 : 0
  const spring = o.h + archStart(o)
  const N = shape === 'arch' ? 9 : 5
  for (let i = 0; i < N; i++) {
    let a0: number
    let a1: number
    let cx: number
    let cy: number
    let R: number
    if (shape === 'arch') {
      a0 = Math.PI - (i / N) * Math.PI
      a1 = Math.PI - ((i + 1) / N) * Math.PI
      cx = o.s + r0
      cy = spring
      R = r0
    } else {
      const rise = o.w / 6
      R = (o.w * o.w) / (8 * rise) + rise / 2
      cx = o.s + o.w / 2
      cy = spring + rise - R
      const half = Math.asin(o.w / 2 / R)
      a0 = Math.PI / 2 + half - (i / N) * half * 2
      a1 = Math.PI / 2 + half - ((i + 1) / N) * half * 2
    }
    const g = 0.012
    const p0 = [cx + Math.cos(a0 - g) * R, cy + Math.sin(a0 - g) * R]
    const p1 = [cx + Math.cos(a1 + g) * R, cy + Math.sin(a1 + g) * R]
    const q0 = [cx + Math.cos(a0 - g) * (R + ht), cy + Math.sin(a0 - g) * (R + ht)]
    const q1 = [cx + Math.cos(a1 + g) * (R + ht), cy + Math.sin(a1 + g) * (R + ht)]
    const t = -proj
    // 表・外の縁・内の縁
    b.quad(f.p(p0[0], t, p0[1]), f.p(p1[0], t, p1[1]), f.p(q1[0], t, q1[1]), f.p(q0[0], t, q0[1]), color, mat, 0)
    quadFacing(b, f.p(q0[0], t, q0[1]), f.p(q1[0], t, q1[1]), f.p(q1[0], 0.02, q1[1]), f.p(q0[0], 0.02, q0[1]), f.dir(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)), color, mat, 0)
    quadFacing(b, f.p(p0[0], t, p0[1]), f.p(p1[0], t, p1[1]), f.p(p1[0], 0.02, p1[1]), f.p(p0[0], 0.02, p0[1]), f.dir(-Math.cos((a0 + a1) / 2), 0, -Math.sin((a0 + a1) / 2)), color, mat, 0)
  }
  if (keystone && shape === 'arch') {
    const top = spring + r0
    fbox(b, f, o.s + o.w / 2 - 0.13, o.s + o.w / 2 + 0.13, -proj - 0.04, 0.02, top - 0.05, top + ht + 0.08, color, mat, 0)
  }
}

/** 開口のまわりの額縁（左右と上。幅 bw・張り出し proj） */
export function surround(k: Kit, f: Frame, o: Opening, color: string, mat: number, bw = 0.12, proj = 0.05) {
  const b = k.solid
  fbox(b, f, o.s - bw, o.s, -proj, 0.02, o.h, o.h + o.ht, color, mat)
  fbox(b, f, o.s + o.w, o.s + o.w + bw, -proj, 0.02, o.h, o.h + o.ht, color, mat)
  if ((o.shape ?? 'rect') === 'rect') fbox(b, f, o.s - bw, o.s + o.w + bw, -proj, 0.02, o.h + o.ht, o.h + o.ht + bw, color, mat)
}

/** 鎧戸（窓の左右の板戸。開いて壁に付く） */
export function shutters(k: Kit, f: Frame, o: Opening, color: string) {
  const w = o.w / 2
  for (const s0 of [o.s - w - 0.04, o.s + o.w + 0.04]) {
    fbox(k.solid, f, s0, s0 + w, -0.05, -0.01, o.h, o.h + o.ht, color, NM.paint, 0.3)
    // 羽板の陰（細い横の筋は格子の質感を横に使えないので、2 段の枠）
    fbox(k.solid, f, s0 + 0.04, s0 + w - 0.04, -0.06, -0.05, o.h + 0.06, o.h + o.ht * 0.48, color, NM.lattice, 0.05)
    fbox(k.solid, f, s0 + 0.04, s0 + w - 0.04, -0.06, -0.05, o.h + o.ht * 0.52, o.h + o.ht - 0.06, color, NM.lattice, 0.05)
  }
}

/** 窓の下の花の箱 */
export function flowerBox(k: Kit, f: Frame, o: Opening, color = '#5a3b26') {
  fbox(k.solid, f, o.s, o.s + o.w, -0.28, -0.02, o.h - 0.24, o.h - 0.02, color, NM.wood)
  const b = k.solid
  const prev = b.ao
  b.ao = 0.9
  for (let i = 0; i < 5; i++) {
    const s = o.s + 0.1 + ((i + k.rnd() * 0.5) / 5) * (o.w - 0.2)
    const c = ['#c0392b', '#e8a1b0', '#f2d14b', '#ffffff', '#9b59b6'][Math.floor(k.rnd() * 5)]
    fbox(b, f, s - 0.08, s + 0.08, -0.25, -0.05, o.h - 0.04, o.h + 0.12, '#3f6b2a', NM.leaf)
    fbox(b, f, s - 0.05, s + 0.05, -0.22, -0.08, o.h + 0.06, o.h + 0.16, c, NM.cloth)
  }
  b.ao = prev
}

/* -------------------------------------------------------------------------- */
/* 帯・柱・ひさし                                                                */
/* -------------------------------------------------------------------------- */

/** 面に沿った水平の帯（蛇腹・胴蛇腹）。s0〜s1・高さ h〜h + ht・外へ proj */
export function band(k: Kit, f: Frame, s0: number, s1: number, h: number, ht: number, proj: number, color: string, mat: number, aux = 0) {
  fbox(k.solid, f, s0 - proj, s1 + proj, -proj, 0.02, h, h + ht, color, mat, aux)
}

/** s0〜s1 から、すき間 gaps（[始まり, 終わり]）を除いた区間。扉の前を横切る腰板・幕板などを、扉の所で切るのに使う */
export function spansExcept(s0: number, s1: number, gaps: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = []
  let s = s0
  for (const [a, b] of [...gaps].sort((x, y) => x[0] - y[0])) {
    if (b <= s || a >= s1) continue
    if (a > s + 0.01) out.push([s, a])
    s = Math.max(s, b)
  }
  if (s1 > s + 0.01) out.push([s, s1])
  return out
}

/** 外形（平面の反時計回りの点）に沿った帯（隅は張り出した分だけ重ねる） */
export function ringBand(k: Kit, ring: readonly (readonly [number, number])[], z0: number, h: number, ht: number, proj: number, color: string, mat: number, aux = 0, inset = 0) {
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as [number, number]
    const q = ring[(i + 1) % ring.length] as [number, number]
    const f = Frame.edge(p, q, z0)
    const L = Math.hypot(q[0] - p[0], q[1] - p[1])
    fbox(k.solid, f, -proj + inset, L + proj - inset, -proj + inset, 0.02 + inset, h, h + ht, color, mat, aux)
  }
}

/** 付け柱（s の位置に幅 w。h0〜h1） */
export function pilaster(k: Kit, f: Frame, s: number, w: number, h0: number, h1: number, proj: number, color: string, mat: number, aux = 0) {
  fbox(k.solid, f, s - w / 2, s + w / 2, -proj, 0.02, h0, h1, color, mat, aux)
}

/** 布の日よけ（オーニング）: s0〜s1、取り付けの高さ h、出 depth、下がり drop。縞 stripes */
export function awning(k: Kit, f: Frame, s0: number, s1: number, h: number, depth: number, drop: number, color: string, stripes = 0) {
  const b = k.solid
  const hl = h - depth * 0.55
  b.quad(f.p(s0, 0, h), f.p(s1, 0, h), f.p(s1, -depth, hl), f.p(s0, -depth, hl), color, NM.cloth, stripes)
  // 下がり（垂れ）
  b.quad(f.p(s0, -depth, hl), f.p(s1, -depth, hl), f.p(s1, -depth, hl - drop), f.p(s0, -depth, hl - drop), color, NM.cloth, stripes)
  // 横の三角
  b.tri(f.p(s0, 0, h), f.p(s0, -depth, hl), f.p(s0, -depth, hl - drop), color, NM.cloth, stripes)
  b.tri(f.p(s1, -depth, hl - drop), f.p(s1, -depth, hl), f.p(s1, 0, h), color, NM.cloth, stripes)
  // 骨（腕）
  for (const s of [s0 + 0.05, s1 - 0.05]) b.beam(f.p(s, 0, h - 0.5), f.p(s, -depth + 0.05, hl - 0.02), 0.025, '#2a2a28', NM.iron)
}

/** 水平の庇（板の庇・ガラスの庇）: s0〜s1、高さ h、出 depth、厚さ th */
export function canopy(k: Kit, f: Frame, s0: number, s1: number, h: number, depth: number, color: string, mat: number, th = 0.12, brackets = true) {
  fbox(k.solid, f, s0, s1, -depth, 0.02, h - th, h, color, mat)
  if (brackets) for (const s of [s0 + 0.15, s1 - 0.15]) k.solid.beam(f.p(s, 0, h - th - 0.5), f.p(s, -depth * 0.8, h - th), 0.05, '#2b2b2b', NM.iron)
}

/** 段（入口の前の石段）: 正面の幅 s0〜s1、steps 段、1 段の高さ rise・踏み面 run。上の段の上面は h = 0（床）。外へ下りる */
export function steps(k: Kit, f: Frame, s0: number, s1: number, n: number, rise: number, run: number, color: string, mat: number = NM.granite) {
  for (let i = 0; i < n; i++) {
    const top = -i * rise
    fbox(k.solid, f, s0 - i * 0.02, s1 + i * 0.02, -(i + 1) * run, 0.05, top - rise - 1.5, top, color, mat)
  }
}

/** 壁付けの灯具（腕と小さな灯り。夜は光り、壁と地面を照らす） */
export function wallLamp(k: Kit, f: Frame, s: number, h: number, style: 'lantern' | 'bulb' | 'gas' = 'lantern', color = '#ffcf8a') {
  const b = k.solid
  b.beam(f.p(s, 0.02, h + 0.25), f.p(s, -0.32, h + 0.25), 0.03, '#1f1f1e', NM.iron)
  if (style === 'bulb') {
    k.glowBox(f.p(s, -0.32, h + 0.08), [0.12, 0.16, 0.12], color, 0, 3.2)
    fbox(b, f, s - 0.1, s + 0.1, -0.42, -0.22, h + 0.18, h + 0.24, '#1f1f1e', NM.iron)
  } else {
    fbox(b, f, s - 0.12, s + 0.12, -0.46, -0.2, h + 0.24, h + 0.3, '#1f1f1e', NM.iron)
    k.glowBox(f.p(s, -0.33, h + 0.07), [0.18, 0.3, 0.18], color, 0, 2.6)
    fbox(b, f, s - 0.1, s + 0.1, -0.43, -0.23, h - 0.12, h - 0.08, '#1f1f1e', NM.iron)
  }
  k.lamp(f.p(s, -0.6, h), 7.5, '#ffc27a', 1.5, 0.45, 3)
}

/** 提灯（赤い円筒の光る物）: 面の (s, h) から外へ吊る */
export function lantern(k: Kit, f: Frame, s: number, h: number, color = '#d63b2a', r = 0.18, len = 0.45, light = true) {
  k.solid.beam(f.p(s, 0.02, h + len / 2 + 0.15), f.p(s, -0.35, h + len / 2 + 0.15), 0.025, '#2a2a28', NM.iron)
  const c = f.p(s, -0.35, h)
  k.glow.cylinder([c[0], c[1] - len / 2, c[2]], r, len, 10, color, 1, 2.2, true, r, true)
  k.glow.cylinder([c[0], c[1] + len / 2, c[2]], r * 0.7, 0.05, 8, '#222', 1, 0.2)
  k.glow.cylinder([c[0], c[1] - len / 2 - 0.05, c[2]], r * 0.7, 0.05, 8, '#222', 1, 0.2)
  if (light) k.lamp(f.p(s, -0.5, h), 5, '#ff9a5a', 1.0, 0.4, 3)
}

/* -------------------------------------------------------------------------- */
/* 屋根                                                                         */
/* -------------------------------------------------------------------------- */

export interface RoofStyle {
  color: string
  mat: number
  aux?: number
  /** 軒の出・けらばの出（m） */
  eave?: number
  verge?: number
  /** 屋根の厚み（鼻隠しの高さ） */
  thick?: number
  /** 軒裏・鼻隠しの色 */
  soffit?: string
  fascia?: string
  /** 棟（棟瓦）の色。無ければ屋根の色を暗く */
  ridge?: string
  /** 妻壁の色・質感（切妻・入母屋）と、妻壁の開口（[s = 0 の側, s = W の側]。妻の面の s' は外から見て左から） */
  gable?: { color: string; mat: number; aux?: number; openings?: [Opening[], Opening[]] }
  /** 雨どい */
  gutter?: string
}

/**
 * 切妻（棟は s の向き。正面 t = 0 と裏 t = D が軒）。e = 軒の高さ（壁の上端）、r = 棟の高さ。
 * 妻壁（s = 0 と s = W の三角）も作る
 */
export function gableRoof(k: Kit, f: Frame, W: number, D: number, e: number, r: number, st: RoofStyle) {
  const b = k.solid
  const ov = st.eave ?? 0.5
  const vg = st.verge ?? 0.35
  const th = st.thick ?? 0.18
  const slope = (r - e) / (D / 2)
  const he = e - ov * slope
  const soff = st.soffit ?? '#6a5e50'
  const fas = st.fascia ?? soff
  const aux = st.aux ?? 0
  for (const side of [0, 1]) {
    // side 0 = 正面の斜面（t = -ov → D/2）、1 = 裏（t = D + ov → D/2）
    const tE = side === 0 ? -ov : D + ov
    const A: V3 = [-vg, tE, he]
    const B: V3 = [W + vg, tE, he]
    const C: V3 = [W + vg, D / 2, r]
    const E: V3 = [-vg, D / 2, r]
    const pts = side === 0 ? [A, B, C, E] : [B, A, E, C]
    b.quad(f.p(...pts[0]), f.p(...pts[1]), f.p(...pts[2]), f.p(...pts[3]), st.color, st.mat, aux)
    // 軒裏（厚み分下げた面。下を向く）
    const d = (p: V3): V3 => [p[0], p[1], p[2] - th]
    b.ao = 0.7
    b.quad(f.p(...d(pts[3])), f.p(...d(pts[2])), f.p(...d(pts[1])), f.p(...d(pts[0])), soff, NM.paint, 0.1)
    b.ao = 1
    // 鼻隠し（軒先の縦の帯）
    const out = side === 0 ? f.dir(0, -1, 0) : f.dir(0, 1, 0)
    quadFacing(b, f.p(...pts[0]), f.p(...pts[1]), f.p(...d(pts[1])), f.p(...d(pts[0])), out, fas, NM.paint, 0.2)
    // けらば（妻の縁の板）
    for (const [p, q, sx] of [
      [A, E, -1],
      [B, C, 1],
    ] as [V3, V3, number][]) {
      quadFacing(b, f.p(...p), f.p(...q), f.p(...d(q)), f.p(...d(p)), f.dir(sx, 0, 0), fas, NM.paint, 0.2)
    }
    // 雨どい
    if (st.gutter) {
      const g = f.p(W / 2, tE + (side === 0 ? -0.06 : 0.06), he - th - 0.06)
      void g
      const p0 = f.p(-vg + 0.05, tE + (side === 0 ? -0.07 : 0.07), he - th - 0.05)
      const p1 = f.p(W + vg - 0.05, tE + (side === 0 ? -0.07 : 0.07), he - th - 0.05)
      b.beam(p0, p1, 0.11, st.gutter, NM.paint, 0.5, 0.09)
    }
  }
  // 棟（棟瓦）
  const rc = st.ridge ?? st.color
  b.beam(f.p(-vg - 0.05, D / 2, r + 0.06), f.p(W + vg + 0.05, D / 2, r + 0.06), 0.3, rc, st.mat === NM.kawara ? NM.kawara : NM.paint, 0, 0.2)
  // 妻壁
  if (st.gable) {
    // 左の妻（s = 0。外向き −a、s' は t = D → 0）と右の妻（s = W。外向き a、s' は t = 0 → D）
    const GL = new Frame(...f.plan(0, D), f.nx, f.ny, f.z0)
    const GR = f.turnRight(W)
    const tri = [new THREE.Vector2(0, e), new THREE.Vector2(D, e), new THREE.Vector2(D / 2, r - th)]
    wall(k, GL, tri, st.gable.openings?.[0] ?? [], st.gable.color, st.gable.mat, st.gable.aux ?? 0)
    wall(k, GR, tri, st.gable.openings?.[1] ?? [], st.gable.color, st.gable.mat, st.gable.aux ?? 0)
  }
  // 遠くの形
  const m = k.mass
  const P = (s: number, t: number, h: number) => [...f.plan(s, t), f.z0 + h]
  m.roofQuad(P(-vg, -ov, he), P(W + vg, -ov, he), P(W + vg, D / 2, r), P(-vg, D / 2, r))
  m.roofQuad(P(W + vg, D + ov, he), P(-vg, D + ov, he), P(-vg, D / 2, r), P(W + vg, D / 2, r))
  m.wallTri(P(0, D, e) as V3, P(0, 0, e) as V3, P(0, D / 2, r) as V3, f.z0)
  m.wallTri(P(W, 0, e) as V3, P(W, D, e) as V3, P(W, D / 2, r) as V3, f.z0)
}

/** 寄棟（W ≥ D なら棟は s の向き）。kx = 隅棟の寄り（1 で 45°） */
export function hipRoof(k: Kit, f: Frame, W: number, D: number, e: number, r: number, st: RoofStyle) {
  const b = k.solid
  const ov = st.eave ?? 0.5
  const th = st.thick ?? 0.18
  const soff = st.soffit ?? '#6a5e50'
  const fas = st.fascia ?? soff
  const aux = st.aux ?? 0
  const alongS = W >= D
  const half = (alongS ? D : W) / 2
  const slope = (r - e) / half
  const he = e - ov * slope
  // 外の縁（軒先）と棟の 2 点
  const c0: V3 = [-ov, -ov, he]
  const c1: V3 = [W + ov, -ov, he]
  const c2: V3 = [W + ov, D + ov, he]
  const c3: V3 = [-ov, D + ov, he]
  const r0: V3 = alongS ? [half, D / 2, r] : [W / 2, half, r]
  const r1: V3 = alongS ? [W - half, D / 2, r] : [W / 2, D - half, r]
  const faces: V3[][] = alongS
    ? [
        [c0, c1, r1, r0],
        [c2, c3, r0, r1],
        [c1, c2, r1],
        [c3, c0, r0],
      ]
    : [
        [c0, c1, r0],
        [c2, c3, r1],
        [c1, c2, r1, r0],
        [c3, c0, r0, r1],
      ]
  const d = (p: V3): V3 => [p[0], p[1], p[2] - th]
  for (const fc of faces) {
    b.polygon(
      fc.map((p) => f.p(...p)),
      st.color,
      st.mat,
      aux,
    )
    b.ao = 0.7
    b.polygon(
      [...fc].reverse().map((p) => f.p(...d(p))),
      soff,
      NM.paint,
      0.1,
    )
    b.ao = 1
  }
  // 鼻隠し
  const edges: [V3, V3, V3][] = [
    [c0, c1, f.dir(0, -1, 0)],
    [c1, c2, f.dir(1, 0, 0)],
    [c2, c3, f.dir(0, 1, 0)],
    [c3, c0, f.dir(-1, 0, 0)],
  ]
  for (const [p, q, out] of edges) {
    quadFacing(b, f.p(...p), f.p(...q), f.p(...d(q)), f.p(...d(p)), out, fas, NM.paint, 0.2)
    if (st.gutter) b.beam(f.p(...offsetOut(p, q, -0.07, he - th - 0.05)), f.p(...offsetOut(q, p, -0.07, he - th - 0.05)), 0.1, st.gutter, NM.paint, 0.5, 0.09)
  }
  // 棟と隅棟
  const rc = st.ridge ?? st.color
  const rm = st.mat === NM.kawara ? NM.kawara : NM.paint
  b.beam(f.p(...lift(r0, 0.05)), f.p(...lift(r1, 0.05)), 0.26, rc, rm, 0, 0.18)
  for (const [c, rr] of [
    [c0, r0],
    [c3, r0],
    [c1, r1],
    [c2, r1],
  ] as [V3, V3][])
    b.beam(f.p(...lift(c, 0.05)), f.p(...lift(rr, 0.05)), 0.2, rc, rm, 0, 0.14)
  // 遠くの形
  const m = k.mass
  const P = (p: V3) => [...f.plan(p[0], p[1]), f.z0 + p[2]]
  for (const fc of faces) {
    if (fc.length === 4) m.roofQuad(P(fc[0]), P(fc[1]), P(fc[2]), P(fc[3]))
    else m.roofTri(P(fc[0]), P(fc[1]), P(fc[2]))
  }
}

const lift = (p: V3, dh: number): V3 => [p[0], p[1], p[2] + dh]
/** 辺 p → q の外へ ds ずらした点（軒先の雨どいの位置。局所の s, t） */
function offsetOut(p: V3, q: V3, ds: number, h: number): V3 {
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const L = Math.hypot(dx, dy) || 1
  // 外向き（局所の s, t で、反時計回りの外形の外 = 右手。t は奥へなので符号に注意）
  const nx = -dy / L
  const ny = dx / L
  return [p[0] - nx * ds + (dx / L) * 0.05, p[1] - ny * ds + (dy / L) * 0.05, h]
}

/**
 * 入母屋（下は寄棟、上は小さな切妻と妻の三角の壁）。屋根の中ほど mid（0〜1）で切り替える
 */
export function irimoyaRoof(k: Kit, f: Frame, W: number, D: number, e: number, r: number, st: RoofStyle, mid = 0.55) {
  const alongS = W >= D
  if (!alongS) {
    // 棟を長い辺の向きに（面を回す）
    const g = f.turnRight(W).shift(0, 0)
    // 右の側面から見ると幅 D・奥行き W
    irimoyaRoof(k, g, D, W, e, r, st, mid)
    return
  }
  const b = k.solid
  const half = D / 2
  const hm = e + (r - e) * mid
  const inset = half * mid
  // 下の寄棟（hm で切った台形の 4 面）
  hipBand(k, f, W, D, e, r, hm, st)
  // 上の切妻（内側の長方形 inset〜）
  const W2 = W - inset * 2 + 0.6
  const D2 = D - inset * 2
  const g = f.shift(inset - 0.3, inset)
  gableRoof(k, g, W2, D2, hm, r, { ...st, eave: 0.02, verge: 0.3, gable: st.gable ?? { color: '#4a3a2a', mat: NM.wood } })
  void b
}

/** 寄棟の下の部分（高さ cut まで。上は平ら）。r は勾配を決める仮の棟の高さ */
export function hipBand(k: Kit, f: Frame, W: number, D: number, e: number, r: number, cut: number, st: RoofStyle) {
  const b = k.solid
  const ov = st.eave ?? 0.6
  const th = st.thick ?? 0.2
  const half = D / 2
  const slope = (r - e) / half
  const he = e - ov * slope
  const ins = (cut - e) / slope
  const o: V3[] = [
    [-ov, -ov, he],
    [W + ov, -ov, he],
    [W + ov, D + ov, he],
    [-ov, D + ov, he],
  ]
  const i: V3[] = [
    [ins, ins, cut],
    [W - ins, ins, cut],
    [W - ins, D - ins, cut],
    [ins, D - ins, cut],
  ]
  const soff = st.soffit ?? '#5a4a3a'
  for (let j = 0; j < 4; j++) {
    const a = o[j]
    const c = o[(j + 1) % 4]
    const dd = i[(j + 1) % 4]
    const ee = i[j]
    b.polygon([f.p(...a), f.p(...c), f.p(...dd), f.p(...ee)], st.color, st.mat, st.aux ?? 0)
    b.ao = 0.65
    b.polygon([f.p(...lift(ee, -th)), f.p(...lift(dd, -th)), f.p(...lift(c, -th)), f.p(...lift(a, -th))], soff, NM.paint, 0.1)
    b.ao = 1
    quadFacing(b, f.p(...a), f.p(...c), f.p(...lift(c, -th)), f.p(...lift(a, -th)), f.dir(...([[0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]][j] as V3)), st.fascia ?? soff, NM.paint, 0.2)
  }
  b.polygon(i.map((p) => f.p(...p)).reverse(), st.color, st.mat, st.aux ?? 0)
  const m = k.mass
  const P = (p: V3) => [...f.plan(p[0], p[1]), f.z0 + p[2]]
  for (let j = 0; j < 4; j++) m.roofQuad(P(o[j]), P(o[(j + 1) % 4]), P(i[(j + 1) % 4]), P(i[j]))
}

/** 片流れ（正面 t = 0 が低い eLow、裏 t = D が高い eHigh） */
export function shedRoof(k: Kit, f: Frame, W: number, D: number, eLow: number, eHigh: number, st: RoofStyle) {
  const b = k.solid
  const ov = st.eave ?? 0.5
  const vg = st.verge ?? 0.3
  const th = st.thick ?? 0.16
  const slope = (eHigh - eLow) / D
  const A: V3 = [-vg, -ov, eLow - ov * slope]
  const B: V3 = [W + vg, -ov, eLow - ov * slope]
  const C: V3 = [W + vg, D + 0.25, eHigh + 0.25 * slope]
  const E: V3 = [-vg, D + 0.25, eHigh + 0.25 * slope]
  b.quad(f.p(...A), f.p(...B), f.p(...C), f.p(...E), st.color, st.mat, st.aux ?? 0)
  b.ao = 0.7
  b.quad(f.p(...lift(E, -th)), f.p(...lift(C, -th)), f.p(...lift(B, -th)), f.p(...lift(A, -th)), st.soffit ?? '#6a5e50', NM.paint, 0.1)
  b.ao = 1
  const fas = st.fascia ?? st.soffit ?? '#6a5e50'
  quadFacing(b, f.p(...A), f.p(...B), f.p(...lift(B, -th)), f.p(...lift(A, -th)), f.dir(0, -1, 0), fas, NM.paint, 0.2)
  quadFacing(b, f.p(...C), f.p(...E), f.p(...lift(E, -th)), f.p(...lift(C, -th)), f.dir(0, 1, 0), fas, NM.paint, 0.2)
  quadFacing(b, f.p(...A), f.p(...E), f.p(...lift(E, -th)), f.p(...lift(A, -th)), f.dir(-1, 0, 0), fas, NM.paint, 0.2)
  quadFacing(b, f.p(...B), f.p(...C), f.p(...lift(C, -th)), f.p(...lift(B, -th)), f.dir(1, 0, 0), fas, NM.paint, 0.2)
  // 横の壁の三角（壁の上端 eLow から裏の高さまで）
  if (st.gable) {
    b.polygon([f.p(0, D, eLow), f.p(0, 0, eLow), f.p(0, D, eHigh)], st.gable.color, st.gable.mat, st.gable.aux ?? 0)
    b.polygon([f.p(W, 0, eLow), f.p(W, D, eLow), f.p(W, D, eHigh)], st.gable.color, st.gable.mat, st.gable.aux ?? 0)
    b.quad(f.p(W, D, eLow), f.p(0, D, eLow), f.p(0, D, eHigh), f.p(W, D, eHigh), st.gable.color, st.gable.mat, st.gable.aux ?? 0)
  }
  const m = k.mass
  const P = (p: V3) => [...f.plan(p[0], p[1]), f.z0 + p[2]]
  m.roofQuad(P(A), P(B), P(C), P(E))
  m.wallTri(P([0, D, eLow]) as V3, P([0, 0, eLow]) as V3, P([0, D, eHigh]) as V3, f.z0)
  m.wallTri(P([W, 0, eLow]) as V3, P([W, D, eLow]) as V3, P([W, D, eHigh]) as V3, f.z0)
  m.wallQuad(f.plan(W, D), f.plan(0, D), f.z0 + eLow, f.z0 + eHigh, f.z0, 0)
}

/**
 * 陸屋根: 外形（平面の反時計回り）の上に、屋上の面（h = top − parapet）とパラペット（内側の壁と笠木）
 */
export function flatRoof(k: Kit, ring: readonly (readonly [number, number])[], z0: number, top: number, parapet: number, wallColor: string, wallMat: number, roofColor = '#7d7b76', coping = '#b9b4aa', wallAux = 0) {
  const b = k.solid
  const deck = top - parapet
  const LABY = (z: number) => z - LAB
  const inner = insetRing(ring, 0.25)
  // 屋上の面
  b.polygon(
    inner.map((p) => [p[0], LABY(z0 + deck), -p[1]] as V3),
    roofColor,
    NM.membrane,
  )
  if (parapet > 0.05) {
    // パラペットの内側の壁（屋上へ下りる。内向き）
    for (let i = 0; i < inner.length; i++) {
      const p = inner[i]
      const q = inner[(i + 1) % inner.length]
      b.ao = 0.75
      b.quad([q[0], LABY(z0 + deck), -q[1]], [p[0], LABY(z0 + deck), -p[1]], [p[0], LABY(z0 + top), -p[1]], [q[0], LABY(z0 + top), -q[1]], wallColor, wallMat, wallAux)
      b.ao = 1
    }
    // 笠木（外へ 5cm 張り出す）
    ringBand(k, ring, z0, top, 0.08, 0.05, coping, NM.concrete)
    // 笠木の上の面（外の縁と内の縁の間）
    const outer = ring.map((p) => [p[0], LABY(z0 + top + 0.08), -p[1]] as V3)
    const inn = inner.map((p) => [p[0], LABY(z0 + top + 0.08), -p[1]] as V3)
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length
      b.quad(outer[j], outer[i], inn[i], inn[j], coping, NM.concrete)
    }
  }
  k.mass.roofFlat(ring as [number, number][], z0 + top)
}

/** 外形を内へ d だけ縮める（凸でない角も、隣の辺の交点で） */
export function insetRing(ring: readonly (readonly [number, number])[], d: number): [number, number][] {
  const n = ring.length
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i - 1 + n) % n]
    const p1 = ring[i]
    const p2 = ring[(i + 1) % n]
    const n1 = inward(p0, p1)
    const n2 = inward(p1, p2)
    const bx = n1[0] + n2[0]
    const by = n1[1] + n2[1]
    const bl = Math.hypot(bx, by) || 1
    const cos = (n1[0] * bx + n1[1] * by) / bl
    const k = d / Math.max(cos, 0.3)
    out.push([p1[0] + (bx / bl) * k, p1[1] + (by / bl) * k])
  }
  return out
}

function inward(p: readonly number[], q: readonly number[]): [number, number] {
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const L = Math.hypot(dx, dy) || 1
  return [-dy / L, dx / L]
}

/** 半球のドーム（中心の平面座標と標高、半径、高さ（半径より低ければ平たい））。outward のみ */
export function dome(k: Kit, cx: number, cy: number, z: number, radius: number, height: number, color: string, mat: number, aux = 0, seg = 32, rings = 10) {
  const prof: [number, number][] = []
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * (Math.PI / 2)
    prof.push([Math.cos(a) * radius + (i === rings ? 0 : 0), Math.sin(a) * height])
  }
  prof[prof.length - 1][0] = 0.001
  const m = new THREE.Matrix4().makeTranslation(cx, z - LAB, -cy)
  k.solid.lathe(prof, seg, m, color, mat, aux)
  // 遠くの形（低い多角錐）
  const ms = k.mass
  const n = 12
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    for (let j = 0; j < 3; j++) {
      const t0 = (j / 3) * (Math.PI / 2)
      const t1 = ((j + 1) / 3) * (Math.PI / 2)
      const P = (a: number, t: number) => [cx + Math.cos(a) * Math.cos(t) * radius, cy + Math.sin(a) * Math.cos(t) * radius, z + Math.sin(t) * height]
      if (j < 2) ms.roofQuad(P(a0, t0), P(a1, t0), P(a1, t1), P(a0, t1))
      else ms.roofTri(P(a0, t0), P(a1, t0), P(a0, t1))
    }
  }
}

/** 角錐・円錐の屋根（尖塔・塔屋）。中心・底の半径・底の標高・高さ・辺の数 */
export function spire(k: Kit, cx: number, cy: number, z: number, radius: number, height: number, sides: number, color: string, mat: number, aux = 0, rot = 0) {
  const b = k.solid
  const apex: V3 = [cx, z + height - LAB, -cy]
  for (let i = 0; i < sides; i++) {
    const a0 = rot + (i / sides) * Math.PI * 2
    const a1 = rot + ((i + 1) / sides) * Math.PI * 2
    b.tri([cx + Math.cos(a0) * radius, z - LAB, -(cy + Math.sin(a0) * radius)], [cx + Math.cos(a1) * radius, z - LAB, -(cy + Math.sin(a1) * radius)], apex, color, mat, aux)
    k.mass.roofTri([cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius, z], [cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, z], [cx, cy, z + height])
  }
}

/** 屋根窓（ドーマー）: 面 f の (s, t) の屋根の上に、幅 w・窓の高さ ht の小さな切妻の箱。h = 窓の下端の高さ */
export function dormer(k: Kit, f: Frame, s: number, t: number, h: number, w: number, ht: number, wallColor: string, wallMat: number, roof: RoofStyle, glass: GlassSpec) {
  const d = 1.6
  const g = f.shift(s - w / 2, t)
  const b = k.solid
  // 前の壁（窓つき）と横の壁
  rectWall(k, g, 0, w, h - 0.8, h + ht + 0.15, [{ s: 0.18, h, w: w - 0.36, ht, depth: 0.08, glass }], wallColor, wallMat)
  fbox(b, g, 0, 0.02, 0, d, h - 0.8, h + ht + 0.15, wallColor, wallMat)
  fbox(b, g, w - 0.02, w, 0, d, h - 0.8, h + ht + 0.15, wallColor, wallMat)
  // 小さな切妻（棟は奥へ）
  const r = g.turnRight(w)
  gableRoof(k, new Frame(...r.plan(0, 0), r.ax, r.ay, r.z0), d, w, h + ht + 0.15, h + ht + 0.15 + w * 0.45, { ...roof, eave: 0.15, verge: 0.12, gable: undefined, thick: 0.1 })
  // 正面の三角
  b.polygon([g.p(0, -0.01, h + ht + 0.15), g.p(w, -0.01, h + ht + 0.15), g.p(w / 2, -0.01, h + ht + 0.15 + w * 0.45 - 0.08)], wallColor, wallMat)
}
