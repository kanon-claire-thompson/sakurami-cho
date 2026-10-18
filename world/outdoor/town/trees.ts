import * as THREE from 'three/webgpu'
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  fwidth,
  int,
  length,
  log2,
  max,
  min,
  mix,
  mod,
  modelWorldMatrixInverse,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SITE } from '../../../core/town'
import { oHash, oNoise, outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { townLight } from './facades'
import { depthMaterial, townShadow } from './shadows'
import { townTextureUniforms } from './townTextures'
import { townLampsEx } from './lamps'
import { paintFlat } from '../paint'
import type { TownTile } from './townData'
import { LANE_CORRIDOR_HALF_W, laneCorridor, type CorridorHit } from '../../walk/laneCorridor'

const _hit: CorridorHit = { nx: 0, ny: 0, dist: 0, z0: 0, z1: 0 }

/**
 * 木（`pnpm sync:town` が置いた木。タイルの t_pos = 平面座標・根元の標高・高さ、t_attr = 樹冠の半径 × 10・種類・色のばらつき・印）。
 *
 * - **近くの木**（細かさの中心から nearTreeDistance まで）: 幹と枝（先細りの円柱）と、葉のかたまりの板（葉の写真を並べた絵。アルファで抜く）を
 *   樹冠の形に 40 枚ほど並べた形。種類ごとの形（広葉樹 2 つ・楓・針葉樹）をインスタンスで描く。板の法線は樹冠の球の向きとまぜて、
 *   ふんわりした陰影にする。風で揺れる（幹は根元から、葉の板は細かく震える）
 * - **遠くの木**: 樹冠の絵の板 1 枚（カメラの方を向く。インポスター）。陰影は樹冠を球とみなした法線で、下ほど暗く。遠いほどアルファの縁を太らせて、
 *   ミップマップで木が消えないようにする
 * - どちらも町の影を受け、影を落とす（深さだけのシェーダーで葉の形に抜く）。楓は秋に紅葉、桜は春に花
 */

/** 木の種類（tools/town/scatter.mjs の TREE と同じ番号） */
export const TREE = { broadleaf: 0, maple: 1, sakura: 2, conifer: 3 } as const

/** 葉の絵（foliage.webp の 2×2 の絵の番号） */
const CELL = { dense: 0, sparse: 1, maple: 2, conifer: 3 }

const LAB = SITE.labFloorElevation

/* -------------------------------------------------------------------------- */
/* 近くの木の形（底の中心が原点。高さ 1、樹冠の幅 1）                                    */
/* -------------------------------------------------------------------------- */

class TreeWriter {
  pos: number[] = []
  nrm: number[] = []
  crown: number[] = []
  uv: number[] = []
  /** 葉の板の真ん中（幹・枝は頂点そのもの）。浮遊レーンの通り道の剪定で、板をどちらの壁へ寄せるかを決める */
  cardC: number[] = []
  idx: number[] = []
  private rnd: () => number
  constructor(seed: number) {
    let s = seed >>> 0
    this.rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
  }
  r() {
    return this.rnd()
  }
  /** 頂点: 位置・板の法線・(樹冠の法線 xyz, 樹冠の中の深さ ao)・(u, v, 絵の番号（-1 は幹）, 揺れの重み) */
  vert(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Vector3, ao: number, u: number, v: number, cell: number, sway: number, card: THREE.Vector3 = p) {
    this.pos.push(p.x, p.y, p.z)
    this.cardC.push(card.x, card.y, card.z)
    this.nrm.push(n.x, n.y, n.z)
    this.crown.push(c.x, c.y, c.z, ao)
    this.uv.push(u, v, cell, sway)
    return this.pos.length / 3 - 1
  }
  /** 先細りの円柱（幹・枝）。a → b、半径 ra → rb */
  limb(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, sides: number, swayA: number, swayB: number) {
    const dir = b.clone().sub(a)
    const len = dir.length()
    dir.normalize()
    const side = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const u = new THREE.Vector3().crossVectors(dir, side).normalize()
    const w = new THREE.Vector3().crossVectors(dir, u)
    const base = this.pos.length / 3
    for (let i = 0; i <= sides; i++) {
      const t = (i / sides) * Math.PI * 2
      const n = u.clone().multiplyScalar(Math.cos(t)).addScaledVector(w, Math.sin(t))
      this.vert(a.clone().addScaledVector(n, ra), n, n, 0.7, i / sides, 0, -1, swayA)
      this.vert(b.clone().addScaledVector(n, rb), n, n, 0.75, i / sides, len * 6, -1, swayB)
    }
    for (let i = 0; i < sides; i++) {
      const k = base + i * 2
      this.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  /** 葉の板（中心 c・法線 n・大きさ s・回転 rot）。center = 樹冠の中心（樹冠の法線を作る） */
  card(c: THREE.Vector3, n: THREE.Vector3, s: number, rot: number, cell: number, center: THREE.Vector3, radii: THREE.Vector3) {
    const up = Math.abs(n.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const ax = new THREE.Vector3().crossVectors(up, n).normalize()
    const ay = new THREE.Vector3().crossVectors(n, ax)
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const X = ax.clone().multiplyScalar(cr).addScaledVector(ay, sr)
    const Y = ay.clone().multiplyScalar(cr).addScaledVector(ax, -sr)
    const base = this.pos.length / 3
    const corners: [number, number][] = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]
    for (const [x, y] of corners) {
      const p = c.clone().addScaledVector(X, x * s).addScaledVector(Y, y * s)
      // 樹冠の法線（楕円体の中心からの向き）と、中ほどほど暗い（葉の重なり）
      const q = p.clone().sub(center).divide(radii)
      const depth = Math.min(1, q.length())
      const cn = new THREE.Vector3(q.x / radii.x, q.y / radii.y, q.z / radii.z).normalize()
      this.vert(p, n, cn, 0.6 + 0.4 * depth, x + 0.5, y + 0.5, cell, 1, c)
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  build() {
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('aCrown', new THREE.Float32BufferAttribute(this.crown, 4))
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 4))
    g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.cardC, 3))
    g.setIndex(this.idx)
    return g
  }
}

/**
 * 広葉樹（variant 0 = 丸い樹冠・密な葉、1 = 少し縦長で疎な葉、2 = 楓）。large = 大きな木（葉の板を小さく多くして、葉の大きさをそろえる）
 */
function broadleafGeometry(variant: number, large = false) {
  const w = new TreeWriter(17 + variant * 101)
  // 楓も近くは密な葉の絵（楓の葉の絵は、下から見上げると細かい点の列になるため。遠くの板は楓の絵）
  const cell = variant === 1 ? CELL.sparse : CELL.dense
  const center = new THREE.Vector3(0, variant === 1 ? 0.62 : 0.6, 0)
  const radii = new THREE.Vector3(0.5, variant === 1 ? 0.42 : 0.38, 0.5)
  const trunkTop = new THREE.Vector3(0, 0.55, 0)
  // 幹と、樹冠の中へ伸びる枝
  w.limb(new THREE.Vector3(0, -0.05, 0), trunkTop, 0.045, 0.028, 7, 0, 0.3)
  const branches = 5
  const tips: THREE.Vector3[] = []
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + w.r() * 0.8
    const y0 = 0.36 + w.r() * 0.16
    const tip = new THREE.Vector3(Math.cos(a) * radii.x * 0.62, center.y + (w.r() - 0.2) * radii.y * 0.7, Math.sin(a) * radii.z * 0.62)
    w.limb(new THREE.Vector3(0, y0, 0), tip, 0.02, 0.008, 5, 0.25, 0.8)
    tips.push(tip)
  }
  // 葉の板: 外側ほど多く（樹冠の殻）、枝の先のまわりにかたまりも
  const cards = Math.round((variant === 1 ? 38 : 46) * (large ? 2.6 : 1))
  const cardScale = large ? 0.6 : 1
  for (let i = 0; i < cards; i++) {
    const u = w.r() * 2 - 1
    const t = w.r() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const dir = new THREE.Vector3(s * Math.cos(t), u * 0.85 + 0.1, s * Math.sin(t)).normalize()
    const rr = 0.55 + 0.45 * Math.cbrt(w.r())
    const c = center.clone().add(new THREE.Vector3(dir.x * radii.x, dir.y * radii.y, dir.z * radii.z).multiplyScalar(rr))
    if (i % 6 === 0) c.lerp(tips[i % tips.length], 0.4)
    // 板の向き: 外向きとまぜて、少しばらつかせる
    const n = dir.clone().add(new THREE.Vector3(w.r() - 0.5, w.r() - 0.3, w.r() - 0.5).multiplyScalar(1.2)).normalize()
    const size = (variant === 1 ? 0.4 : 0.42) * (0.8 + 0.45 * w.r()) * cardScale
    // 樹冠の下端より下へ葉を垂らさない（通りの上の並木の下を歩けるように）
    c.y = Math.max(c.y, 0.3 + size * 0.5)
    w.card(c, n, size, w.r() * Math.PI * 2, cell, center, radii)
  }
  return w.build()
}

/** 植え込み・低い木（幹なし。地面から半球の葉のかたまり） */
function shrubGeometry() {
  const w = new TreeWriter(4242)
  const center = new THREE.Vector3(0, 0.35, 0)
  const radii = new THREE.Vector3(0.5, 0.55, 0.5)
  for (let i = 0; i < 26; i++) {
    const u = w.r()
    const t = w.r() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const dir = new THREE.Vector3(s * Math.cos(t), u, s * Math.sin(t)).normalize()
    const rr = 0.45 + 0.55 * Math.cbrt(w.r())
    const c = center.clone().add(new THREE.Vector3(dir.x * radii.x, dir.y * radii.y, dir.z * radii.z).multiplyScalar(rr))
    const n = dir.clone().add(new THREE.Vector3(w.r() - 0.5, w.r() - 0.2, w.r() - 0.5)).normalize()
    w.card(c, n, 0.55 * (0.8 + 0.4 * w.r()), w.r() * Math.PI * 2, CELL.dense, center, radii)
  }
  return w.build()
}

/** 針葉樹（杉・檜・松。円錐の樹冠を、下に垂れた葉の枝の板で作る） */
function coniferGeometry() {
  const w = new TreeWriter(907)
  w.limb(new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(0, 0.98, 0), 0.04, 0.008, 6, 0, 0.6)
  const center = new THREE.Vector3(0, 0.55, 0)
  const radii = new THREE.Vector3(0.5, 0.48, 0.5)
  const tiers = 9
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1)
    const y = 0.18 + t * 0.76
    const rad = 0.5 * (1 - t) + 0.05
    const n = 5 - Math.floor(t * 3)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + k * 0.9 + w.r() * 0.5
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
      const c = new THREE.Vector3(dir.x * rad * 0.55, y, dir.z * rad * 0.55)
      // 板は外へ向けて少し上を向ける（枝の葉の面）
      const nn = dir.clone().multiplyScalar(0.7).add(new THREE.Vector3(0, 0.7, 0)).normalize()
      w.card(c, nn, rad * 1.5 + 0.12, (w.r() - 0.5) * 0.4, CELL.conifer, center, radii)
    }
  }
  return w.build()
}

/** 遠くの木の板（底の中心が原点、幅 1・高さ 1） */
function impostorGeometry() {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/* -------------------------------------------------------------------------- */
/* シェーダー（TSL。WebGPU への移行の第 2 段）                                         */
/* -------------------------------------------------------------------------- */

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>

/** 根元の高さのずれ（ラボの床の標高。前の GLSL の define LAB_FLOOR と同じ値） */
const LAB_FLOOR = Number(LAB.toFixed(2))

/**
 * 葉の影の受け方。葉は光を通して散らすので影の中でも真っ暗にしない。太陽が低い（朝夕）ほど、影の地図の 1 画素が太陽の向きに長く伸びて
 * 樹冠に明るい平行四辺形の縞が出るので、影をならして中くらいの明るさに寄せる（段階 5 の植物の仕上げ）。町の木とドームの中の植物（dome/plants.ts）が使う
 */
export const leafShadow = Fn(([sh]: [F]) => {
  const lowSun = smoothstep(0.04, 0.24, outdoorUniforms.uSunDir.y).oneMinus()
  return mix(mix(0.3, 1.0, sh), 0.55, lowSun.mul(0.85))
})

/** 平らな塗りの葉の色（木の種類・季節の色 vLeaf に掛ける。葉の絵の平均の明るさのかわり） */
const FLAT_LEAF = 0.19

/**
 * 平らな塗りの葉の影の受け方: 太陽が低い（朝夕）ほど、影の地図の縞が樹冠に出るので日なたに寄せる（leafShadow の 2 段の塗りの形）
 */
const flatLeafShadow = (sh: F) => max(sh, smoothstep(0.04, 0.24, outdoorUniforms.uSunDir.y).oneMinus())

/** 葉の絵の読み方（2×2 の絵の番号と、その中の uv）。bias を渡すとミップマップを進めて読む（影の葉の形） */
function foliage(uv: V2, cell: F, bias?: number) {
  const o = vec2(mod(cell, 2.0), floor(cell.div(2.0))).mul(0.5)
  const t = townTextureUniforms.uFoliage.sample(o.add(clamp(uv, 0.002, 0.998).mul(0.5)))
  return bias === undefined ? t : t.bias(float(bias))
}

/**
 * 遠いほど（ミップマップが進むほど）アルファを太らせる（遠くの木がミップマップで消えないように）。k = 0.32（遠くの木）。
 * 近くの木は 0.12（段階 5 の植物の仕上げ。遠くの木と同じだけ太らせると、20〜60m の木の板が葉の形の無い四角に埋まり、夕日で明るい四角の板に見えた。
 * 近くの木は少しだけ太らせ、残りは alphaToCoverage のやわらかい縁にまかせる）
 */
function foliageAlpha(a: F, uv: V2, k: number) {
  const d = fwidth(uv).mul(512.0)
  const lod = max(0.0, log2(max(max(d.x, d.y), 1.0)))
  return a.mul(lod.mul(k).add(1.0))
}

/** 木のシェーダー（近く・遠く）と影の深さだけのシェーダー。uniform（material.uniforms.<名前>.value）は近くと遠くで共有 */
export function createTreeMaterials() {
  const uniforms = {
    uAutumn: uniform(0),
    uSpring: uniform(0),
    uWind: uniform(0.6),
    /** ガラスの温室の中の木だけ（町の木は 0） */
    uExtraAmb: uniform(new THREE.Vector3()),
    uVein: uniform(0),
  }
  const u = outdoorUniforms
  const t = u.uTime

  /* 頂点の共通部分: インスタンスの値（iA = 位置・高さ、iB = 樹冠の半径・種類・色のばらつき・種）と風 */
  const iA = attribute<'vec4'>('iA', 'vec4')
  const iB = attribute<'vec4'>('iB', 'vec4')
  const base = vec3(iA.x, iA.z.sub(0.3).sub(LAB_FLOOR), iA.y.negate())
  /** 風（木ごとに位相をずらす。高い所ほど大きく） */
  const windOffset = (h01: F, scaleH: F, seed: F) => {
    const ph = seed.mul(6.2831).add(base.x.mul(0.05)).add(base.z.mul(0.04))
    const sway = sin(t.mul(1.1).add(ph)).mul(0.6).add(sin(t.mul(2.3).add(ph.mul(1.7))).mul(0.25)).add(sin(t.mul(0.37).add(ph.mul(0.3))).mul(0.5))
    const k = uniforms.uWind.mul(h01).mul(h01).mul(scaleH).mul(0.018)
    return vec3(sway.mul(k), 0.0, sway.mul(k).mul(0.6))
  }
  /**
   * 葉の色（種類・季節・ばらつき）。Fn の中で途中の値を toVar にする（select の分岐の中で初めて組み立てた値を、ほかの分岐で使うと
   * WGSL では代入されていない変数を読むことになるため）
   */
  const leafTint = Fn(([kind, tint]: [F, F]) => {
    const l0 = mix(vec3(0.62, 0.75, 0.5), vec3(0.85, 0.9, 0.62), tint).toVar()
    const l1 = select(kind.greaterThan(2.5), mix(vec3(0.38, 0.5, 0.42), vec3(0.5, 0.6, 0.45), tint), l0).toVar()
    const l2 = select(kind.greaterThan(0.5).and(kind.lessThan(1.5)), mix(l1, mix(vec3(1.6, 0.35, 0.12), vec3(1.5, 0.75, 0.15), tint), uniforms.uAutumn), l1).toVar()
    return select(kind.greaterThan(1.5).and(kind.lessThan(2.5)), mix(l2, vec3(1.45, 1.05, 1.15), uniforms.uSpring), l2)
  })
  const vLeaf = varying(leafTint(iB.y, iB.z))
  const vSeed = varying(iB.w)

  /** ガラスの温室（ガーデンドーム）の中の木だけが使う光（夜の中の灯りの照り返し・葉脈ライティングの光の点）。町の木は 0。画素の Fn の中で呼ぶ */
  const domeGlow = (albedo: V3, ao: F, wp: V3, seed: F, leaf: F) => {
    const c = albedo.mul(uniforms.uExtraAmb).mul(ao.mul(0.4).add(0.6)).mul(1.6).toVar()
    If(uniforms.uVein.greaterThan(0.0).and(leaf.greaterThan(0.5)), () => {
      const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
      // 光の点: 3 次元の升（0.45m）ごとに 1 つ、升の中の決まった所に小さな丸い光（前は升の面がそのまま光って、明るい四角の板に見えた）
      const g = wp.mul(2.2).toVar()
      const cell = floor(g).toVar()
      const hsh = oHash(cell.xz.add(cell.y.mul(17.31)).add(seed.mul(31.0)))
      const ctr = vec3(oHash(cell.xz.add(3.7).add(cell.y)), oHash(cell.zx.add(9.1).add(cell.y)), oHash(cell.xz.mul(1.3).add(5.3).add(cell.y))).mul(0.6).add(0.2)
      const r = length(g.sub(cell).sub(ctr))
      const sp = step(0.8, hsh).mul(smoothstep(0.06, 0.2, r).oneMinus())
      const flow = sin(wp.y.mul(1.4).sub(t.mul(1.1)).add(seed.mul(12.0))).mul(0.45).add(0.55)
      c.addAssign(vec3(0.55, 1.0, 0.32).mul(sp.mul(1.2).mul(flow).add(0.008)).mul(uniforms.uVein).mul(breath))
    })
    return c
  }

  /* ---------------- 近くの木 ---------------- */
  const aCrown = attribute<'vec4'>('aCrown', 'vec4')
  const aUv = attribute<'vec4'>('aUv', 'vec4')
  const aCard = attribute<'vec3'>('aCard', 'vec3')
  /** 浮遊レーンの通り道（iC = 通り道の真ん中の線への法線 xz（幹の側を向く）・幹から線までの距離・幅の半分、iD = 下と上の高さ（シーン）。幅 0 なら無し） */
  const iC = attribute<'vec4'>('iC', 'vec4')
  const iD = attribute<'vec2'>('iD', 'vec2')
  const ang = iB.w.mul(6.2831)
  const cs = cos(ang)
  const sn = sin(ang)
  /** 前の GLSL の mat2(c, s, -s, c) * v */
  const rot = (v: V2, c: F = cs, s: F = sn) => vec2(c.mul(v.x).sub(s.mul(v.y)), s.mul(v.x).add(c.mul(v.y)))
  const scale = vec3(iB.x.mul(2.0), iA.w, iB.x.mul(2.0))
  const nearWorld = Fn(() => {
    const p = positionGeometry
    const pr = rot(p.xz)
    const wp = base.add(vec3(pr.x, p.y, pr.y).mul(scale)).toVar()
    // 風: 幹は根元から曲がり、葉の板は小刻みに震える
    wp.addAssign(windOffset(clamp(p.y, 0.0, 1.2), iA.w, iB.w).mul(mix(0.3, 1.0, aUv.w)))
    const flutter = sin(t.mul(7.0).add(dot(p, vec3(31.0, 17.0, 23.0))).add(iB.w.mul(40.0))).mul(0.012).mul(uniforms.uWind).mul(aUv.w).mul(iA.w)
    wp.addAssign(vec3(0.0, flutter, 0.0))
    // 浮遊レーンの通り道の剪定: 通り道の箱の中の葉・枝の頂点を、板の真ん中のある側の壁まで寄せる（幹は寄せない。town.md §7 の 214）
    const trunk = aUv.z.lessThan(-0.5).and(aUv.w.lessThan(0.31))
    If(iC.w.greaterThan(0.0).and(trunk.not()).and(wp.y.greaterThan(iD.x)).and(wp.y.lessThan(iD.y)), () => {
      const nn = iC.xy
      const sideC = dot(rot(aCard.xz).mul(scale.xz), nn).add(iC.z)
      const sv = dot(wp.xz.sub(base.xz), nn).add(iC.z).toVar()
      const sg = select(sideC.greaterThanEqual(0.0), float(1.0), float(-1.0)).toVar()
      If(sg.mul(sv).lessThan(iC.w), () => {
        const d = nn.mul(sg.mul(iC.w).sub(sv))
        wp.addAssign(vec3(d.x, 0.0, d.y))
      })
    })
    return wp
  })()
  // 形はワールドの位置で計算する（前の GLSL は viewMatrix だけを掛けていた）。ローカルに戻して渡す（木の形は町の原点に置くので、ふつうは単位行列）
  const nearPosition = modelWorldMatrixInverse.mul(vec4(nearWorld, 1.0)).xyz
  // 法線（Fn の中で toVar にして、分岐（select）の両方から同じ値を読めるようにする）
  const vCardN = varying(
    Fn(() => {
      const r = rot(normalGeometry.xz, cos(ang).toVar(), sin(ang).toVar()).toVar()
      return vec3(r.x, normalGeometry.y, r.y)
    })(),
  )
  // 葉は樹冠の丸みの法線を多めに（ふんわりした陰影）、幹はそのまま
  const vNormal = varying(
    Fn(() => {
      const c = cos(ang).toVar()
      const s = sin(ang).toVar()
      const nr = rot(normalGeometry.xz, c, s).toVar()
      const n = vec3(nr.x, normalGeometry.y, nr.y).toVar()
      const cr = rot(aCrown.xz, c, s).toVar()
      const cn = vec3(cr.x, aCrown.y, cr.y).toVar()
      return select(aUv.z.lessThan(-0.5), n, normalize(mix(cn, n, 0.3)))
    })(),
  )
  const vUv = varying(aUv)
  const vAo = varying(aCrown.w)

  const near = unlit('townTreesNear', { side: THREE.DoubleSide, alphaToCoverage: true })
  near.positionNode = nearPosition
  near.colorNode = Fn(() => {
    const flat = paintFlat()
    const wp = positionWorld.toVar()
    const N = normalize(vNormal).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const albedo = vec3(0.0).toVar()
    const ao = vAo.toVar()
    const leaf = vUv.z.greaterThan(-0.5).toVar()
    // 葉の絵は分岐の外で読む（ミップマップの微分が、分岐でばらばらの画素の組でも正しくなるように）
    // 平らな塗り（外の塗り paint.ts の flat）は、葉の形をぼかして太らせ、葉の塊の形にする（細かい穴に輪郭線が細かく出ないように）
    const f = (flat ? foliage(vec2(vUv.x, vUv.y.oneMinus()), vUv.z, 2.0) : foliage(vec2(vUv.x, vUv.y.oneMinus()), vUv.z)).toVar()
    const fa = foliageAlpha(f.a, vUv.xy, flat ? 0.5 : 0.12).toVar()
    // 横から見た板（葉が点の列に見える）は消す
    const facing = abs(dot(normalize(vCardN), V))
    If(leaf.and(fa.mul(smoothstep(0.12, 0.4, facing)).lessThan(0.5)), () => {
      Discard()
    })
    if (flat) {
      // 平らな塗り（外の塗り paint.ts の flat）: 葉は木の種類・季節の色の塊（葉の絵は形だけ）、幹は 1 色
      albedo.assign(select(leaf, vLeaf.mul(FLAT_LEAF), vec3(0.03, 0.024, 0.02)))
      const sh = flatLeafShadow(townShadow(wp, N))
      const col = townLight(albedo, N, ao, sh, 'tree').toVar()
      col.addAssign(domeGlow(albedo, ao, wp, vSeed, select(leaf, float(1.0), float(0.0))))
      col.addAssign(albedo.mul(townLampsEx(wp, N, float(0.0), float(0.45))).mul(0.8).mul(ao))
      return outdoorHaze(col, wp)
    }
    If(leaf.not(), () => {
      // 幹と枝: 樹皮の質感
      const bark = townTextureUniforms.uGndAlb.sample(vec2(vUv.x.mul(2.0), vUv.y)).depth(int(6)).rgb.mul(2.0)
      albedo.assign(vec3(0.075, 0.06, 0.05).mul(pow(max(bark, 0.0), vec3(2.2))))
    }).Else(() => {
      albedo.assign(pow(f.rgb, vec3(2.2)).mul(vLeaf).mul(1.1))
      // 葉のかたまりごとの明るさのばらつき（板ごとに一様な色に見えないように）
      albedo.mulAssign(oNoise(wp.xz.mul(0.9).add(wp.y.mul(0.7)).add(vSeed.mul(13.0))).mul(0.44).add(0.78))
    })
    // 葉は光を通して散らすので、影の中でも真っ暗にならない（影は浅く、空の光をよく受ける）
    const sh = townShadow(wp, N).toVar()
    If(leaf, () => {
      sh.assign(leafShadow(sh))
    })
    const col = townLight(albedo, N, ao, sh).add(albedo.mul(u.uSkyLight).mul(0.45).mul(ao)).toVar()
    // 逆光の葉が透ける
    If(leaf, () => {
      col.addAssign(albedo.mul(u.uSunLight).mul(pow(max(dot(V.negate(), u.uSunDir), 0.0), 3.0)).mul(0.6).mul(sh))
      // 下から見上げた樹冠（段階 5 の植物の仕上げ）: 葉は空と太陽の光を通して黄緑に明るい（前は下を向いた面の暗さだけで、見上げると黒い塊だった）
      const under = smoothstep(0.05, 0.7, V.y.negate())
      const thru = albedo.mul(vec3(1.1, 1.25, 0.6))
      col.addAssign(thru.mul(u.uSkyLight.mul(0.55).add(u.uSunLight.mul(0.3).mul(sh).mul(max(u.uSunDir.y, 0.0)))).mul(under).mul(ao.mul(0.55).add(0.45)))
    })
    col.addAssign(domeGlow(albedo, ao, wp, vSeed, select(leaf, float(1.0), float(0.0))))
    // 夜: 街灯の下の葉（下から照らされる。葉は光を通すので回り込みを大きく）
    col.addAssign(albedo.mul(townLampsEx(wp, N, float(0.0), float(0.45))).mul(0.8).mul(ao))
    return outdoorHaze(col, wp)
  })()

  /* ---------------- 遠くの木（カメラの方を向く板。縦の軸のまわりに回す） ---------------- */
  const toCam = cameraPosition.sub(base).mul(vec3(1.0, 0.0, 1.0))
  const l = length(toCam)
  const fwd = select(l.greaterThan(1e-3), toCam.div(max(l, 1e-3)), vec3(0.0, 0.0, 1.0))
  const right = vec3(fwd.z, 0.0, fwd.x.negate())
  const pg = positionGeometry
  const farWorld = base
    .add(right.mul(pg.x).mul(iB.x.mul(2.25)))
    .add(vec3(0.0, pg.y.mul(iA.w).mul(1.05), 0.0))
    .add(windOffset(pg.y, iA.w, iB.w).mul(0.6))
  const farPosition = modelWorldMatrixInverse.mul(vec4(farWorld, 1.0)).xyz
  const vQuad = varying(vec2(pg.x.add(0.5), pg.y))
  const vRight = varying(right)
  const vToCam = varying(fwd)
  // 絵: 針葉樹・楓・広葉樹（2 つから木ごとに）
  const kind = iB.y
  const vCell = varying(select(kind.greaterThan(2.5), float(3.0), select(kind.greaterThan(0.5).and(kind.lessThan(1.5)), float(2.0), select(fract(iB.w.mul(7.7)).lessThan(0.5), float(0.0), float(1.0)))))

  const far = unlit('townTreesFar', { side: THREE.DoubleSide, alphaToCoverage: true })
  far.positionNode = farPosition
  far.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    // 樹冠は板の上 82%、下は幹
    const cuv = vec2(vQuad.x, vQuad.y.sub(0.18).div(0.82)).toVar()
    If(fract(vSeed.mul(3.1)).lessThan(0.5), () => {
      cuv.assign(vec2(cuv.x.oneMinus(), cuv.y))
    })
    const f = foliage(vec2(cuv.x, cuv.y.oneMinus()), vCell).toVar()
    const a = select(cuv.y.greaterThan(0.0), foliageAlpha(f.a, cuv, 0.32), float(0.0)).toVar()
    const trunk = step(abs(vQuad.x.sub(0.5)), 0.035).mul(step(vQuad.y, 0.3))
    If(a.lessThan(0.5).and(trunk.lessThan(0.5)), () => {
      Discard()
    })
    const albedo = vec3(0.05, 0.04, 0.035).toVar()
    const N = vec3(vToCam).toVar()
    const ao = float(0.6).toVar()
    const leafy = a.greaterThanEqual(0.5).toVar()
    If(leafy, () => {
      albedo.assign(pow(f.rgb, vec3(2.2)).mul(vLeaf).mul(0.95))
      // 樹冠を球とみなした法線（板の位置から）
      const q = vec2(cuv.x.sub(0.5), cuv.y.sub(0.5)).mul(2.0).toVar()
      const z = sqrt(max(0.0, min(1.0, dot(q, q)).oneMinus()))
      N.assign(normalize(vRight.mul(q.x).add(vec3(0.0, 1.0, 0.0).mul(q.y.mul(0.8).add(0.25))).add(vToCam.mul(z.add(0.2)))))
      ao.assign(smoothstep(-0.1, 0.9, cuv.y).mul(0.55).add(0.45))
    })
    if (paintFlat()) {
      // 平らな塗り: 葉の色の塊を、樹冠を球とみなした法線で 3 段に（外の塗りの light）
      albedo.assign(select(leafy, vLeaf.mul(FLAT_LEAF), vec3(0.03, 0.024, 0.02)))
      const col = townLight(albedo, N, ao, flatLeafShadow(townShadow(wp, N)), 'tree').toVar()
      col.addAssign(domeGlow(albedo, ao, wp, vSeed, select(leafy, float(1.0), float(0.0))))
      return outdoorHaze(col, wp)
    }
    const sh = leafShadow(townShadow(wp, N)).toVar()
    const col = townLight(albedo, N, ao, sh).add(albedo.mul(u.uSkyLight).mul(0.45).mul(ao)).toVar()
    const V = normalize(cameraPosition.sub(wp))
    col.addAssign(albedo.mul(u.uSunLight).mul(pow(max(dot(V.negate(), u.uSunDir), 0.0), 3.0)).mul(0.5).mul(sh))
    col.addAssign(domeGlow(albedo, ao, wp, vSeed, select(leafy, float(1.0), float(0.0))))
    return outdoorHaze(col, wp)
  })()

  // 影: 本体と同じ頂点の計算（positionNode を共有）で深さを描き、葉は、ぼかした葉の形（ミップマップを進めた値）で抜く
  // （影の地図の画素より細かい葉が、ざらざらの点の影にならないように）
  const nearDepth = depthMaterial({
    positionNode: nearPosition,
    maskNode: vUv.z.lessThanEqual(-0.5).or(foliage(vec2(vUv.x, vUv.y.oneMinus()), vUv.z, 3.5).a.greaterThanEqual(0.42)),
  })
  const dcuv = vec2(vQuad.x, vQuad.y.sub(0.18).div(0.82))
  const da = select(dcuv.y.greaterThan(0.0), foliage(vec2(dcuv.x, dcuv.y.oneMinus()), vCell, 3.5).a, float(0.0))
  const farDepth = depthMaterial({
    positionNode: farPosition,
    maskNode: da.greaterThanEqual(0.5).or(abs(vQuad.x.sub(0.5)).lessThan(0.035).and(vQuad.y.lessThan(0.3))),
  })
  return { near: withUniforms(near, uniforms), far: withUniforms(far, uniforms), nearDepth, farDepth, uniforms }
}

export type TreeMaterials = ReturnType<typeof createTreeMaterials>

/* -------------------------------------------------------------------------- */
/* 木を置く                                                                      */
/* -------------------------------------------------------------------------- */

interface TreeItem {
  x: number
  y: number
  z: number
  h: number
  r: number
  kind: number
  tint: number
  seed: number
  /** 浮遊レーンの通り道（近くの木。world/walk/laneCorridor.ts）: シーンの法線 xz・幹から線まで・幅の半分・下と上の高さ（シーン） */
  lane?: [number, number, number, number, number, number]
}

function instanced(geo: THREE.InstancedBufferGeometry, list: TreeItem[], material: THREE.Material, depth: THREE.Material, name: string) {
  // インスタンスの値は 1 つの交互の配列にまとめる（iA 4・iB 4・iC 4・iD 2）。WebGPU は 1 つの描画で読める頂点の配列が 8 本までで、
  // 近くの木は形の 5 本（位置・法線・aCrown・aUv・aCard）と別々の 4 本で 9 本になって作れない
  const STRIDE = 14
  const data = new Float32Array(Math.max(1, list.length) * STRIDE)
  list.forEach((t, i) => {
    const o = i * STRIDE
    data.set([t.x, t.y, t.z, t.h, t.r, t.kind, t.tint, t.seed], o)
    if (t.lane) data.set(t.lane, o + 8)
  })
  const buf = new THREE.InstancedInterleavedBuffer(data, STRIDE)
  geo.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 4, 0))
  geo.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 4, 4))
  if (geo.getAttribute('aCard')) {
    geo.setAttribute('iC', new THREE.InterleavedBufferAttribute(buf, 4, 8))
    geo.setAttribute('iD', new THREE.InterleavedBufferAttribute(buf, 2, 12))
  }
  geo.instanceCount = list.length
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  mesh.visible = list.length > 0
  mesh.name = `townTrees:${name}`
  mesh.userData.shadowMaterial = depth
  return mesh
}

/**
 * タイルの木を、近くの木（種類ごとの形 4 つ）と遠くの木（板 1 枚）に分けて描く。center = 細かさの中心（平面座標）
 */
export function treeMeshes(tiles: TownTile[], mats: TreeMaterials, nearDistance: number, share: number, center: [number, number] = [0, 0], adjust?: (x: number, y: number, z: number) => number | null) {
  const near: TreeItem[][] = [[], [], [], [], [], [], []]
  const far: TreeItem[] = []
  let k = 0
  for (const t of tiles) {
    const p = t.sections.t_pos.array as Float32Array
    const a = t.sections.t_attr.array as Uint8Array
    for (let i = 0; i < p.length / 4; i++) {
      // 画質の低いときは間引く（名前のある大木と並木は残す）
      k = (k + 0.618034) % 1
      if (k > share && a[i * 4 + 3] === 0) continue
      const x = p[i * 4]
      const y = p[i * 4 + 1]
      const seed = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1
      // ラボの前のセット: 小道・テラスの上の木は除き、均した地面の高さに置き直す（adjust が null なら置かない）
      const z0 = p[i * 4 + 2]
      const z = adjust ? adjust(x, y, z0) : z0
      if (z === null) continue
      const tree: TreeItem = { x, y, z, h: p[i * 4 + 3], r: a[i * 4] / 10, kind: a[i * 4 + 1], tint: a[i * 4 + 2] / 255, seed }
      const d = Math.hypot(x - center[0], y - center[1])
      if (d < nearDistance) {
        // 浮遊レーンの通り道にかかる樹冠（枝を払う。world/walk/laneCorridor.ts）
        const lane = laneCorridor.near(x, y, tree.r * 1.15 + LANE_CORRIDOR_HALF_W + 0.5, _hit)
        if (lane && lane.z0 < z + tree.h && lane.z1 > z + tree.h * 0.25) tree.lane = [lane.nx, -lane.ny, lane.dist, LANE_CORRIDOR_HALF_W, lane.z0 - LAB, lane.z1 - LAB]
        // 大きな木（樹冠の半径 3m 以上）は葉の板を小さく多くした形
        const big = tree.r >= 3 && tree.kind !== TREE.conifer ? 4 : 0
        const shape = tree.kind === TREE.conifer ? 3 : (tree.kind === TREE.maple ? 2 : seed < 0.5 ? 0 : 1) + big
        near[shape].push(tree)
      } else far.push(tree)
    }
  }
  const geos = [broadleafGeometry(0), broadleafGeometry(1), broadleafGeometry(2), coniferGeometry(), broadleafGeometry(0, true), broadleafGeometry(1, true), broadleafGeometry(2, true)]
  const names = ['near:broad', 'near:broad2', 'near:maple', 'near:conifer', 'near:broadL', 'near:broad2L', 'near:mapleL']
  const meshes = near.map((list, i) => instanced(geos[i], list, mats.near, mats.nearDepth, names[i]))
  // 遠くの木は近い順に（手前を先に描く）
  far.sort((p, q) => Math.hypot(p.x - center[0], p.y - center[1]) - Math.hypot(q.x - center[0], q.y - center[1]))
  meshes.push(instanced(impostorGeometry(), far, mats.far, mats.farDepth, 'far'))
  return meshes
}

/**
 * 決めた木の並び（ガーデンドームの中の木など）を、近くの木の形（種類ごと）で描く。list の kind は TREE（0 広葉樹・1 楓・2 桜・3 針葉樹）、
 * shrub = true の物は植え込みの形
 */
export function treeMeshesFromList(list: (TreeItem & { shrub?: boolean })[], mats: TreeMaterials) {
  const near: TreeItem[][] = [[], [], [], [], [], [], []]
  const shrubs: TreeItem[] = []
  for (const t of list) {
    if (t.shrub) {
      shrubs.push(t)
      continue
    }
    const big = t.r >= 3 && t.kind !== TREE.conifer ? 4 : 0
    const shape = t.kind === TREE.conifer ? 3 : (t.kind === TREE.maple ? 2 : t.seed < 0.5 ? 0 : 1) + big
    near[shape].push(t)
  }
  const geos = [broadleafGeometry(0), broadleafGeometry(1), broadleafGeometry(2), coniferGeometry(), broadleafGeometry(0, true), broadleafGeometry(1, true), broadleafGeometry(2, true)]
  const names = ['near:broad', 'near:broad2', 'near:maple', 'near:conifer', 'near:broadL', 'near:broad2L', 'near:mapleL']
  const meshes = near.map((l, i) => instanced(geos[i], l, mats.near, mats.nearDepth, names[i])).filter((m) => m.visible)
  if (shrubs.length) meshes.push(instanced(shrubGeometry(), shrubs, mats.near, mats.nearDepth, 'shrubs'))
  return meshes
}

export type { TreeItem }

/** 植え込み（ラボの前の斜面など）。list = 平面座標・根元の標高・高さ・幅の半分 */
export function shrubMesh(list: { x: number; y: number; z: number; h: number; r: number; seed: number }[], mats: TreeMaterials) {
  return instanced(shrubGeometry(), list.map((t) => ({ ...t, kind: TREE.broadleaf, tint: t.seed })), mats.near, mats.nearDepth, 'shrubs')
}
