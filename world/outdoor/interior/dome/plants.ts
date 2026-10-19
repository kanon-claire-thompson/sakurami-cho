import * as THREE from 'three/webgpu'
import {
  Discard,
  Fn,
  If,
  abs,
  atan,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  frontFacing,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
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
import { outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../../materials'
import { townLight } from '../../town/facades'
import { depthMaterial, townShadow } from '../../town/shadows'
import type { PlantItem } from './layout'
import { leafShadow } from '../../town/trees'
import { markPaint, paintEmit } from '../../paint'

/**
 * ガーデンドームの新しい形の植物（町の段階 4 の後半）: ヤシ・木生シダ・シダ・オオタニワタリ・アロカシア（大きな葉に葉脈ライティング）・
 * ハマユウ（花）・アシ・苔のかたまり・菊の鉢（秋のレイアウト）・回廊から垂れるつる・マングローブの支柱根。
 *
 * - 形: 葉は「帯」（葉軸に沿った細長い面。羽状の葉は左右の半分を少し立てて V の字に）で作り、葉の形（小葉・切れ込み・ハートの形・葉脈）は
 *   シェーダーが uv から描いて抜く（画像を使わない）。幹・葉柄は先細りの管。所ごとの組（chunkAt）にまとめて 1 回で描く
 * - 光: 町の木と同じ（太陽は町の影の地図・花音のまわりの細かい影、空の光、逆光で透ける葉）。夜は中の灯りの照り返し（uNightAmb）、
 *   夕方からは葉脈が金緑色に光る（外のドームの葉脈ライティングと同じ色と「呼吸」の明滅。uVein）
 * - 風: ドームの中のゆるい空気の流れ（葉先ほど揺れる）
 */

/** 葉の形の番号（aUv.z） */
export const LEAF = { solid: 0, palm: 1, fern: 2, strap: 3, heart: 4, reed: 5, moss: 6, flower: 7, vine: 8, bark: 9 } as const

type V3 = [number, number, number]
type ToScene = (s: number, t: number, h: number) => V3

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _n = new THREE.Vector3()

/** 植物の形を書く（シーンの座標の頂点） */
export class PlantWriter {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  col: number[] = []
  wind: number[] = []
  ao: number[] = []
  idx: number[] = []
  /** 揺れの根元（シーン）と種 */
  pivot: V3 = [0, 0, 0]
  seed = 0
  get count() {
    return this.pos.length / 3
  }
  vert(p: V3, n: V3, u: number, v: number, kind: number, sway: number, c: THREE.Color, glow: number, ao: number) {
    this.pos.push(p[0], p[1], p[2])
    this.nrm.push(n[0], n[1], n[2])
    this.uv.push(u, v, kind, sway)
    this.col.push(c.r, c.g, c.b, glow)
    this.wind.push(this.pivot[0], this.pivot[1], this.pivot[2], this.seed)
    this.ao.push(ao)
    return this.count - 1
  }
  /**
   * 葉の帯: 葉軸の点の列 spine と、点ごとの横の向き side（単位）・半分の幅 w。u = 0（葉軸）〜 ±1（縁）。
   * half = 1 なら右の半分だけ（u 0〜1）、-1 なら左の半分（u 0〜-1… シェーダーは |u|）、0 なら両側（u -1〜1）。lift = 半分の帯を上へ立てる角度。
   * shape（段階 5 の植物の仕上げ）: cols = 葉軸から縁までの分け方・cup = 縁を上（+）・下（-）へ反らす量（半分の幅に対する割合。u² で曲がる）・
   * curl = 法線を縁の方へ倒す量（平らな板でも丸みのある陰影に）・wave = 縁の波打ち（半分の幅に対する割合）
   */
  strip(
    spine: V3[],
    side: V3[],
    w: number[],
    kind: number,
    c: THREE.Color,
    glow: number,
    half: -1 | 0 | 1,
    lift = 0,
    sway0 = 0.3,
    ao0 = 0.6,
    shape: { cols?: number; cup?: number; curl?: number; wave?: number } = {},
  ) {
    const n = spine.length
    const rows: number[][] = []
    const cols = shape.cols ?? 1
    const cup = shape.cup ?? 0
    const curl = shape.curl ?? 0.35
    const wave = shape.wave ?? 0
    const steps = Array.from({ length: cols + 1 }, (_, j) => j / cols)
    const us = half === 0 ? [...steps.slice(1).reverse().map((x) => -x), ...steps] : steps.map((x) => x * half)
    for (let i = 0; i < n; i++) {
      const p = spine[i]
      const tan = _a.set(...spine[Math.min(n - 1, i + 1)]).sub(_b.set(...spine[Math.max(0, i - 1)])).normalize()
      const sd = new THREE.Vector3(...side[i])
      // 立てる: 横の向きを、葉軸のまわりに上へ回す
      const up = new THREE.Vector3().crossVectors(tan, sd).normalize()
      if (up.y < 0) up.negate()
      const v = i / (n - 1)
      const row: number[] = []
      for (const u of us) {
        const dir = sd.clone().multiplyScalar(Math.sign(u) || 1)
        // 立てた向き（dir）と、その面の上の向き（nup）
        const nup = up.clone()
        if (u !== 0 && lift) {
          dir.multiplyScalar(Math.cos(lift)).addScaledVector(up, Math.sin(lift))
          nup.multiplyScalar(Math.cos(lift)).addScaledVector(sd.clone().multiplyScalar(Math.sign(u) || 1), -Math.sin(lift))
        }
        const au = Math.abs(u)
        // 縁の反り（u² の曲がり）と波打ち（葉の先の方ほど）
        const bend = (cup * au * au + wave * au * Math.sin(v * 17 + au * 2 + this.seed * 40) * v) * w[i]
        const q: V3 = [
          p[0] + dir.x * au * w[i] + nup.x * bend,
          p[1] + dir.y * au * w[i] + nup.y * bend,
          p[2] + dir.z * au * w[i] + nup.z * bend,
        ]
        // 法線: 反りの傾き（2 cup u）と、丸みの倒し（curl）で縁の方へ倒す
        _n.copy(nup).addScaledVector(dir, -(2 * cup * au) + curl * au).normalize()
        row.push(this.vert(q, [_n.x, _n.y, _n.z], u, v, kind, sway0 + (1 - sway0) * v, c, glow, ao0 + (1 - ao0) * v))
      }
      rows.push(row)
    }
    for (let i = 0; i + 1 < n; i++)
      for (let j = 0; j + 1 < rows[i].length; j++) {
        const a = rows[i][j]
        const b = rows[i][j + 1]
        const cc = rows[i + 1][j + 1]
        const d = rows[i + 1][j]
        this.idx.push(a, b, cc, a, cc, d)
      }
  }
  /** 先細りの管（幹・葉柄・支柱根）。pts の点の列・半径の列。u = まわり、v = 長さ */
  tube(pts: V3[], r: number[], sides: number, kind: number, c: THREE.Color, sway: [number, number], ao: [number, number], vScale = 1) {
    const n = pts.length
    const base = this.count
    for (let i = 0; i < n; i++) {
      const tan = _a.set(...pts[Math.min(n - 1, i + 1)]).sub(_b.set(...pts[Math.max(0, i - 1)])).normalize()
      const ref = Math.abs(tan.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
      const ux = new THREE.Vector3().crossVectors(tan, ref).normalize()
      const uy = new THREE.Vector3().crossVectors(tan, ux)
      const k = i / (n - 1)
      for (let j = 0; j <= sides; j++) {
        const th = (j / sides) * Math.PI * 2
        const nn = ux.clone().multiplyScalar(Math.cos(th)).addScaledVector(uy, Math.sin(th))
        const p = pts[i]
        this.vert([p[0] + nn.x * r[i], p[1] + nn.y * r[i], p[2] + nn.z * r[i]], [nn.x, nn.y, nn.z], j / sides, k * vScale, kind, sway[0] + (sway[1] - sway[0]) * k, c, 0, ao[0] + (ao[1] - ao[0]) * k)
      }
    }
    for (let i = 0; i + 1 < n; i++)
      for (let j = 0; j < sides; j++) {
        const a = base + i * (sides + 1) + j
        const b = a + 1
        const d = a + sides + 1
        const cc = d + 1
        this.idx.push(a, d, b, b, d, cc)
      }
  }
  /** 平らな四角（花・つるの帯の 1 枚）。中心 c・横 X・縦 Y（半分の長さを含むベクトル） */
  card(c: V3, X: V3, Y: V3, kind: number, col: THREE.Color, glow: number, sway: number, ao: number, uv: [number, number, number, number] = [-1, -1, 1, 1]) {
    const n = new THREE.Vector3(...X).cross(new THREE.Vector3(...Y)).normalize()
    const nn: V3 = [n.x, n.y, n.z]
    const i0 = this.vert([c[0] - X[0] - Y[0], c[1] - X[1] - Y[1], c[2] - X[2] - Y[2]], nn, uv[0], uv[1], kind, sway, col, glow, ao)
    this.vert([c[0] + X[0] - Y[0], c[1] + X[1] - Y[1], c[2] + X[2] - Y[2]], nn, uv[2], uv[1], kind, sway, col, glow, ao)
    this.vert([c[0] + X[0] + Y[0], c[1] + X[1] + Y[1], c[2] + X[2] + Y[2]], nn, uv[2], uv[3], kind, sway, col, glow, ao)
    this.vert([c[0] - X[0] + Y[0], c[1] - X[1] + Y[1], c[2] - X[2] + Y[2]], nn, uv[0], uv[3], kind, sway, col, glow, ao)
    this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3)
  }
  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 4))
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 4))
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 4))
    g.setAttribute('aAo', new THREE.Float32BufferAttribute(this.ao, 1))
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}

/* -------------------------------------------------------------------------- */
/* 植物の形                                                                      */
/* -------------------------------------------------------------------------- */

const col = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k)

/** 弧を描いて垂れる葉軸（根元 p0・水平の向き yaw・はじめの仰角 e0・長さ L・垂れ方 droop・点の数） */
function arcSpine(S: ToScene, s: number, t: number, h: number, yaw: number, e0: number, L: number, droop: number, n: number): { spine: V3[]; side: V3[] } {
  const spine: V3[] = []
  const side: V3[] = []
  let ps = s
  let pt = t
  let ph = h
  const step = L / (n - 1)
  for (let i = 0; i < n; i++) {
    spine.push(S(ps, pt, ph))
    const e = e0 - droop * (i / (n - 1)) * (i / (n - 1))
    const ds = Math.cos(yaw) * Math.cos(e) * step
    const dt = Math.sin(yaw) * Math.cos(e) * step
    const dh = Math.sin(e) * step
    // 横の向き（水平。葉軸の向きの左）
    const a = S(ps, pt, ph)
    const b = S(ps - Math.sin(yaw), pt + Math.cos(yaw), ph)
    side.push([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
    ps += ds
    pt += dt
    ph += dh
  }
  return { spine, side }
}

/** 羽状の葉（左右の半分を V の字に立てる） */
function pinnate(w: PlantWriter, S: ToScene, s: number, t: number, h: number, yaw: number, e0: number, L: number, droop: number, width: number, kind: number, c: THREE.Color, glow: number) {
  const n = 8
  const { spine, side } = arcSpine(S, s, t, h, yaw, e0, L, droop, n)
  const ws = spine.map((_, i) => {
    const v = i / (n - 1)
    return width * Math.min(1, v * 5 + 0.15) * (1 - 0.55 * v * v)
  })
  // 羽片は葉軸から外へ少し垂れ（cup -）、丸みの陰影（curl）
  const shape = { cup: -0.12, curl: 0.55 }
  w.strip(spine, side, ws, kind, c, glow, 1, 0.38, 0.3, 0.6, shape)
  w.strip(spine, side, ws, kind, c, glow, -1, 0.38, 0.3, 0.6, shape)
}

function palm(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  const H = p.size
  const lean = (rnd() - 0.5) * 0.25
  const la = rnd() * Math.PI * 2
  const pts: V3[] = []
  const r: number[] = []
  const n = 8
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1)
    const off = Math.sin(k * 1.5) * lean * H * 0.4
    pts.push(S(p.s + Math.cos(la) * off, p.t + Math.sin(la) * off, p.h - 0.2 + k * H))
    r.push(0.22 - 0.07 * k + (i === 0 ? 0.08 : 0))
  }
  w.pivot = pts[0]
  w.tube(pts, r, 8, LEAF.bark, col('#8a7a62', 0.9 + 0.2 * p.tint), [0, 0.35], [0.55, 0.9], H * 1.4)
  const top = n - 1
  const offTop = Math.sin(1.5) * lean * H * 0.4
  const ts = p.s + Math.cos(la) * offTop
  const tt = p.t + Math.sin(la) * offTop
  const th = p.h - 0.2 + H
  const nf = 14
  const green = col(p.tint < 0.5 ? '#3f6a2c' : '#4f7a34')
  for (let i = 0; i < nf; i++) {
    const yaw = (i / nf) * Math.PI * 2 + rnd() * 0.3
    const e0 = 0.75 - rnd() * 0.55 - (i % 2) * 0.25
    const L = 2.6 + H * 0.18 + rnd() * 0.8
    pinnate(w, S, ts, tt, th, yaw, e0, L, 1.5 + rnd() * 0.5, 0.75, LEAF.palm, green.clone().multiplyScalar(0.85 + rnd() * 0.3), 0.6)
  }
  void top
}

function treeFern(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  const H = p.size
  const pts: V3[] = []
  const r: number[] = []
  const n = 6
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1)
    pts.push(S(p.s + Math.sin(k * 2) * 0.12, p.t, p.h - 0.15 + k * H))
    r.push(0.2 - 0.04 * k + (i === 0 ? 0.08 : 0))
  }
  w.pivot = pts[0]
  w.tube(pts, r, 7, LEAF.bark, col('#3a2c22'), [0, 0.25], [0.5, 0.8], H * 2.2)
  const nf = 13
  const green = col(p.tint < 0.5 ? '#4a7a30' : '#5a8a38')
  for (let i = 0; i < nf; i++) {
    const yaw = (i / nf) * Math.PI * 2 + rnd() * 0.25
    pinnate(w, S, p.s + Math.sin(2) * 0.12, p.t, p.h - 0.15 + H, yaw, 0.95 - rnd() * 0.25, 1.9 + rnd() * 0.6, 1.9, 0.48, LEAF.fern, green.clone().multiplyScalar(0.85 + rnd() * 0.3), 0.5)
  }
}

function fern(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  w.pivot = S(p.s, p.t, p.h)
  const nf = 8
  const green = col(p.tint < 0.4 ? '#3f6a2a' : p.tint < 0.8 ? '#4f7c32' : '#5e8a3a')
  for (let i = 0; i < nf; i++) {
    const yaw = p.rot + (i / nf) * Math.PI * 2 + rnd() * 0.4
    pinnate(w, S, p.s, p.t, p.h + 0.02, yaw, 1.15 - rnd() * 0.25, p.size * (0.8 + rnd() * 0.35), 1.7, p.size * 0.22, LEAF.fern, green.clone().multiplyScalar(0.85 + rnd() * 0.3), 0.45)
  }
}

/** 帯の葉（オオタニワタリ・ハマユウ・アシ） */
function straps(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number, n: number, kind: number, width: number, e: [number, number], droop: number, c: THREE.Color, glow: number) {
  w.pivot = S(p.s, p.t, p.h)
  for (let i = 0; i < n; i++) {
    const yaw = p.rot + (i / n) * Math.PI * 2 + rnd() * 0.5
    const e0 = e[0] + rnd() * (e[1] - e[0])
    const { spine, side } = arcSpine(S, p.s, p.t, p.h + 0.02, yaw, e0, p.size * (0.75 + rnd() * 0.4), droop, 6)
    const ws = spine.map((_, k) => width * (k === 0 ? 0.35 : 1))
    // 帯の葉は中の筋で折れた樋の形（縁が上へ）・縁がゆるく波打つ
    w.strip(spine, side, ws, kind, c.clone().multiplyScalar(0.85 + rnd() * 0.3), glow, 0, 0, 0.25, 0.55, { cols: 2, cup: 0.22, curl: 0.3, wave: kind === LEAF.strap ? 0.1 : 0 })
  }
}

/** アロカシア（長い葉柄の先に、ハートの形の大きな葉。葉脈が光る） */
function alocasia(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  w.pivot = S(p.s, p.t, p.h)
  const nl = 5
  const green = col(p.tint < 0.5 ? '#3a6a2c' : '#467a32')
  for (let i = 0; i < nl; i++) {
    const yaw = p.rot + (i / nl) * Math.PI * 2 + rnd() * 0.5
    const el = 1.05 + rnd() * 0.35
    const plen = p.size * (0.5 + rnd() * 0.25)
    const tip: [number, number, number] = [p.s + Math.cos(yaw) * Math.cos(el) * plen, p.t + Math.sin(yaw) * Math.cos(el) * plen, p.h + Math.sin(el) * plen]
    w.tube([S(p.s, p.t, p.h), S(...tip)], [0.025, 0.015], 5, LEAF.solid, col('#4a6a34'), [0.1, 0.8], [0.5, 0.8])
    // 葉身: 葉柄の先から外へ下向きに垂れる、少し丸めた面（5 × 3 の格子。u = 横、v = 付け根 → 先）
    const L = p.size * (0.55 + rnd() * 0.2)
    const W = L * 0.42
    const tilt = -0.55 - rnd() * 0.5
    const rows = 6
    const spine: V3[] = []
    const side: V3[] = []
    const ws: number[] = []
    for (let k = 0; k < rows; k++) {
      const v = k / (rows - 1)
      const e = tilt - v * 0.6
      const ds = Math.cos(yaw) * Math.cos(e) * L * v
      const dt = Math.sin(yaw) * Math.cos(e) * L * v
      const dh = Math.sin(e) * L * v
      const c3 = S(tip[0] + ds, tip[1] + dt, tip[2] + dh + Math.sin(v * Math.PI) * 0.04)
      spine.push(c3)
      const a = S(0, 0, 0)
      const b = S(-Math.sin(yaw), Math.cos(yaw), 0)
      side.push([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
      ws.push(W)
    }
    // 左右の半分を少し上へ（葉身のくぼみ）。縁は下へ反って波打つ（大きな葉の重さ）
    const lc = green.clone().multiplyScalar(0.85 + rnd() * 0.3)
    const shape = { cols: 3, cup: -0.18, curl: 0.25, wave: 0.08 }
    w.strip(spine, side, ws, LEAF.heart, lc, 1.0, 1, 0.3, 0.4, 0.7, shape)
    w.strip(spine, side, ws, LEAF.heart, lc, 1.0, -1, 0.3, 0.4, 0.7, shape)
  }
}

function lily(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  straps(w, S, p, rnd, 13, LEAF.strap, p.size * 0.06, [0.5, 1.1], 1.6, col('#4a7a3a'), 0.25)
  // 花茎と白い花（傘の形に開いた花の束）
  const nfl = 1 + Math.floor(rnd() * 2)
  for (let i = 0; i < nfl; i++) {
    const a = rnd() * Math.PI * 2
    const top: [number, number, number] = [p.s + Math.cos(a) * 0.15, p.t + Math.sin(a) * 0.15, p.h + p.size * (0.85 + rnd() * 0.3)]
    w.tube([S(p.s, p.t, p.h), S(...top)], [0.018, 0.012], 5, LEAF.solid, col('#5a8a46'), [0.1, 0.9], [0.6, 0.9])
    for (let k = 0; k < 9; k++) {
      const b = (k / 9) * Math.PI * 2
      const c = S(top[0] + Math.cos(b) * 0.11, top[1] + Math.sin(b) * 0.11, top[2] + 0.04)
      const out = S(top[0] + Math.cos(b) * 0.25, top[1] + Math.sin(b) * 0.25, top[2] + 0.1)
      const X: V3 = [(out[0] - c[0]) * 0.5, (out[1] - c[1]) * 0.5, (out[2] - c[2]) * 0.5]
      const Y: V3 = [0, 0.07, 0]
      w.card(c, X, Y, LEAF.flower, col('#f4f2ea'), 0.2, 0.9, 1)
    }
  }
}

function reed(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  straps(w, S, p, rnd, 11, LEAF.reed, 0.035, [1.25, 1.45], 0.5, col('#6a8a4a'), 0.15)
}

function nestFern(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  straps(w, S, p, rnd, 9, LEAF.strap, p.size * 0.16, [0.75, 1.15], 1.0, col('#5a9a3a'), 0.6)
}

function moss(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  w.pivot = S(p.s, p.t, p.h)
  const n = 10
  const R = p.size * 0.5
  const c = col(p.tint < 0.5 ? '#3e5a26' : '#4e6a2c')
  const ring = (k: number): V3[] => {
    const e = (k / 3) * (Math.PI / 2)
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = (i / n) * Math.PI * 2
      const rr = R * Math.cos(e) * (0.85 + 0.25 * Math.sin(a * 3 + p.rot))
      return S(p.s + Math.cos(a) * rr, p.t + Math.sin(a) * rr, p.h - 0.05 + Math.sin(e) * R * 0.32)
    })
  }
  const rings = [ring(0), ring(1), ring(2), ring(3)]
  const base = w.count
  rings.forEach((rg, k) =>
    rg.forEach((q, i) => {
      const a = (i / n) * Math.PI * 2
      const e = (k / 3) * (Math.PI / 2)
      w.vert(q, [Math.cos(a) * Math.cos(e), Math.sin(e), -Math.sin(a) * Math.cos(e)], i / n, k / 3, LEAF.moss, 0, c, 0.15, 0.7 + 0.1 * k)
    }),
  )
  for (let k = 0; k < 3; k++)
    for (let i = 0; i < n; i++) {
      const a = base + k * (n + 1) + i
      const b = a + 1
      const d = a + n + 1
      w.idx.push(a, b, d + 1, a, d + 1, d)
    }
  void rnd
}

/** 菊の鉢（秋のレイアウト）: 素焼きの鉢と、花のかたまり */
function mum(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  w.pivot = S(p.s, p.t, p.h)
  const pr = p.size * 0.42
  const pts: V3[] = [S(p.s, p.t, p.h), S(p.s, p.t, p.h + p.size * 0.5)]
  w.tube(pts, [pr * 0.8, pr], 10, LEAF.solid, col('#a8603a'), [0, 0], [0.7, 0.9])
  const cs = ['#f2c83a', '#f4f0e6', '#c84a6a', '#e88a2a']
  const cc = col(cs[Math.floor(p.tint * cs.length) % cs.length])
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2
    const r = Math.sqrt(rnd()) * pr * 1.25
    const hh = p.h + p.size * 0.5 + 0.08 + (1 - r / (pr * 1.3)) * p.size * 0.35
    const c = S(p.s + Math.cos(a) * r, p.t + Math.sin(a) * r, hh)
    const o = S(p.s + Math.cos(a) * (r + 0.1), p.t + Math.sin(a) * (r + 0.1), hh + 0.06)
    const X: V3 = [(o[0] - c[0]) * 0.55, (o[1] - c[1]) * 0.55, (o[2] - c[2]) * 0.55]
    const up = new THREE.Vector3(...X).cross(new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.07)
    w.card(c, X, [up.x, up.y, up.z], LEAF.flower, cc.clone().multiplyScalar(0.85 + rnd() * 0.3), 0.3, 0.6, 0.95)
  }
  // 葉（花のかたまりの下の濃い緑）
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rnd()
    const c = S(p.s + Math.cos(a) * pr * 0.9, p.t + Math.sin(a) * pr * 0.9, p.h + p.size * 0.55)
    const o = S(p.s + Math.cos(a) * pr * 1.5, p.t + Math.sin(a) * pr * 1.5, p.h + p.size * 0.6)
    const X: V3 = [(o[0] - c[0]) * 0.5, (o[1] - c[1]) * 0.5, (o[2] - c[2]) * 0.5]
    const up = new THREE.Vector3(...X).cross(new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.09)
    w.card(c, X, [up.x, up.y, up.z], LEAF.strap, col('#2e5a26'), 0.2, 0.4, 0.8, [-1, 0, 1, 1])
  }
}

/** つる（回廊の縁から垂れる帯。小さな葉の列） */
function vine(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  const len = p.len ?? 3
  const a = p.rot
  w.pivot = S(p.s, p.t, p.h)
  const n = 7
  const spine: V3[] = []
  const side: V3[] = []
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1)
    const sway = Math.sin(k * 3 + p.tint * 6) * 0.32 * k
    spine.push(S(p.s + Math.cos(a + Math.PI / 2) * sway, p.t + Math.sin(a + Math.PI / 2) * sway, p.h - k * len))
    const b0 = S(0, 0, 0)
    const b1 = S(Math.cos(a + Math.PI / 2 + 0.3 * k), Math.sin(a + Math.PI / 2 + 0.3 * k), 0)
    side.push([b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]])
  }
  const c = col(p.tint < 0.5 ? '#3a6a2a' : '#4a7a30')
  w.strip(spine, side, spine.map(() => 0.26), LEAF.vine, c, 0.35, 0, 0, 0.1, 0.65)
  // 直角にもう 1 枚（横から見ても葉が見えるように）
  const side2: V3[] = spine.map((_, i) => {
    const k = i / (n - 1)
    const b0 = S(0, 0, 0)
    const b1 = S(Math.cos(a + 0.3 * k), Math.sin(a + 0.3 * k), 0)
    return [b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]]
  })
  w.strip(spine, side2, spine.map(() => 0.22), LEAF.vine, c.clone().multiplyScalar(0.9), 0.35, 0, 0, 0.1, 0.65)
  // 斜めにもう 1 枚（3 枚で、どの向きから見ても葉のかたまりに。帯の板に見えないように）
  const side3: V3[] = spine.map((_, i) => {
    const k = i / (n - 1)
    const b0 = S(0, 0, 0)
    const b1 = S(Math.cos(a + Math.PI / 4 - 0.4 * k), Math.sin(a + Math.PI / 4 - 0.4 * k), 0)
    return [b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]]
  })
  w.strip(spine, side3, spine.map((_, i) => 0.2 * (1 - 0.3 * (i / (n - 1)))), LEAF.vine, c.clone().multiplyScalar(1.08), 0.35, 0, 0, 0.1, 0.65)
  void rnd
}

/** マングローブの支柱根と幹（樹冠は町の木の仕組み） */
function mangrove(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  w.pivot = S(p.s, p.t, p.h)
  const trunkTop = p.h + p.size * 0.45
  w.tube([S(p.s, p.t, p.h + 1.2), S(p.s, p.t, trunkTop)], [0.16, 0.11], 7, LEAF.bark, col('#5a4a3a'), [0, 0.1], [0.6, 0.8], 3)
  const nr = 9
  for (let i = 0; i < nr; i++) {
    const a = (i / nr) * Math.PI * 2 + rnd() * 0.4
    const R = 1.3 + rnd() * 0.8
    const pts: V3[] = []
    for (let k = 0; k <= 5; k++) {
      const u = k / 5
      const rr = u * R
      const hh = p.h + 1.6 * (1 - u * u) + 0.05
      pts.push(S(p.s + Math.cos(a) * rr, p.t + Math.sin(a) * rr, hh))
    }
    w.tube(pts, pts.map((_, k) => 0.06 - k * 0.006), 5, LEAF.bark, col('#5a4a3a'), [0, 0], [0.55, 0.75], 2)
  }
}

/** 植物を書く */
export function writePlant(w: PlantWriter, S: ToScene, p: PlantItem, rnd: () => number) {
  w.seed = rnd()
  switch (p.kind) {
    case 'palm':
      return palm(w, S, p, rnd)
    case 'treeFern':
      return treeFern(w, S, p, rnd)
    case 'fern':
      return fern(w, S, p, rnd)
    case 'nestFern':
      return nestFern(w, S, p, rnd)
    case 'alocasia':
      return alocasia(w, S, p, rnd)
    case 'lily':
      return lily(w, S, p, rnd)
    case 'reed':
      return reed(w, S, p, rnd)
    case 'moss':
      return moss(w, S, p, rnd)
    case 'mum':
      return mum(w, S, p, rnd)
    case 'vine':
      return vine(w, S, p, rnd)
    case 'mangrove':
      return mangrove(w, S, p, rnd)
  }
}

/* -------------------------------------------------------------------------- */
/* シェーダー（TSL。WebGPU への移行の第 2 段）                                         */
/* -------------------------------------------------------------------------- */

type V4 = Node<'vec4'>

const PI = 3.14159

/** 葉の形（uv から。透け抜き a と、葉脈 vein）。呼ぶ側の Fn の中で式を組む（前の GLSL の out の引数を返すため） */
function leafShape(uv: V4) {
  const vein = float(0.0).toVar()
  const a = float(1.0).toVar()
  const kind = uv.z.toVar()
  const u = uv.x.toVar()
  const v = uv.y.toVar()
  const au = abs(u).toVar()
  If(kind.lessThan(0.5).or(kind.greaterThan(5.5).and(kind.lessThan(6.5))).or(kind.greaterThan(8.5)), () => {
    a.assign(1.0)
  })
    .ElseIf(kind.lessThan(1.5), () => {
      // ヤシの羽状の葉: 斜めの小葉の列（先が尖る）。葉軸
      const env = smoothstep(0.0, 0.12, v).mul(v.mul(v).mul(0.6).oneMinus())
      const g = fract(v.mul(34.0).sub(au.mul(2.6))).toVar()
      const duty = pow(au, 1.6).oneMinus().mul(0.52).toVar()
      const leaflet = step(g, duty).mul(step(au, env)).toVar()
      vein.assign(smoothstep(0.0, 0.05, au).oneMinus().add(smoothstep(0.0, 0.08, abs(g.sub(duty.mul(0.5)))).oneMinus().mul(leaflet).mul(0.5)))
      a.assign(max(leaflet, step(au, 0.05)))
    })
    .ElseIf(kind.lessThan(2.5), () => {
      // シダの葉: 羽片の列と、羽片の縁の切れ込み
      const env = pow(sin(clamp(v, 0.0, 1.0).mul(PI)), 0.6).toVar()
      const g = fract(v.mul(22.0).sub(au.mul(1.4)))
      const lobe = sin(fract(au.mul(9.0)).mul(PI)).mul(0.25).add(0.75)
      const duty = pow(au.div(max(env, 0.01)), 2.0).oneMinus().mul(0.62).mul(lobe)
      const pinna = step(g, duty).mul(step(au, env))
      vein.assign(smoothstep(0.0, 0.05, au).oneMinus())
      a.assign(max(pinna, step(au, 0.04)))
    })
    .ElseIf(kind.lessThan(3.5), () => {
      // 帯の葉: 先の尖った細長い葉（縁がゆるく波打つ）・中の筋
      const W = pow(max(v, 0.0), 2.6).oneMinus().mul(min(1.0, v.mul(7.0).add(0.2))).mul(sin(v.mul(38.0)).mul(0.07).add(0.93))
      vein.assign(smoothstep(0.0, 0.08, au).oneMinus())
      a.assign(step(au, W))
    })
    .ElseIf(kind.lessThan(4.5), () => {
      // ハートの形の葉（アロカシア）: 付け根の切れ込み・尖った先・中の筋と斜めの葉脈（光る）
      const W = pow(sin(clamp(v.mul(0.9).add(0.1), 0.0, 1.0).mul(PI)), 0.55).mul(pow(max(v, 0.0), 5.0).oneMinus()).toVar()
      const notch = step(v, float(0.16).sub(au.mul(0.42)))
      const d = fract(v.sub(au.mul(0.42)).mul(7.0)).toVar()
      const lat = smoothstep(0.0, 0.06, min(d, d.oneMinus())).oneMinus().mul(step(0.06, au)).mul(step(au, W.mul(0.92)))
      vein.assign(max(smoothstep(0.0, 0.035, au).oneMinus(), lat))
      a.assign(step(au, W).mul(notch.oneMinus()))
    })
    .ElseIf(kind.lessThan(5.5), () => {
      // アシの葉
      vein.assign(0.0)
      a.assign(step(au, v.mul(0.95).oneMinus()))
    })
    .ElseIf(kind.lessThan(7.5), () => {
      // 花（放射の花びら）
      const r = length(vec2(u, v)).toVar()
      const th = atan(v, u)
      const petal = abs(cos(th.mul(7.0))).mul(0.45).add(0.55)
      vein.assign(smoothstep(0.0, 0.25, r).oneMinus())
      a.assign(step(r, petal))
    })
    .Else(() => {
      // つる: ゆれる茎と、大きさも向きもばらばらの小さな葉（ハートの形）。ところどころ葉が無い
      const stemU = sin(v.mul(23.0).add(uv.w.mul(3.0))).mul(0.18).toVar()
      const leaf = float(0.0).toVar()
      for (let i = -1; i <= 1; i++) {
        const k = floor(v.mul(18.0)).add(i).toVar()
        const h1 = fract(sin(k.mul(12.9898).add(uv.w.mul(4.1))).mul(43758.5453)).toVar()
        const h2 = fract(sin(k.mul(78.233).add(1.7)).mul(24634.6345)).toVar()
        const cv = k.add(0.5).add(h1.sub(0.5).mul(0.6)).div(18.0)
        const sideU = select(h2.lessThan(0.5), float(0.42), float(-0.42)).add(stemU)
        const sz = h1.mul(0.5).add(0.65).toVar()
        const qx = u.sub(sideU).div(sz.mul(0.55)).toVar()
        const qy = v.sub(cv).mul(18.0).div(sz.mul(1.1)).add(abs(qx).mul(0.35))
        const q = vec2(qx, qy)
        leaf.assign(max(leaf, step(dot(q, q), 1.0).mul(step(0.18, h2.mul(1.3).sub(0.1)))))
      }
      a.assign(max(leaf, step(abs(u.sub(stemU)), 0.05)))
    })
  return { a, vein }
}

/** 植物のシェーダー（と、影の深さだけのシェーダー。頂点の計算（風）は positionNode を共有し、葉の形で抜く） */
export function createPlantMaterials(nightAmb: THREE.Vector3) {
  const uniforms = { uWind: uniform(0.35), uNightAmb: uniform(nightAmb), uVein: uniform(0) }
  const u = outdoorUniforms
  const t = u.uTime
  const aUv = attribute<'vec4'>('aUv', 'vec4')
  const aCol = attribute<'vec4'>('aCol', 'vec4')
  const aWind = attribute<'vec4'>('aWind', 'vec4')
  const aAo = attribute<'float'>('aAo', 'float')
  const p = positionGeometry
  const sway = aUv.w
  const h = max(0.0, p.y.sub(aWind.y))
  const ph = aWind.w.mul(6.2831).add(aWind.x.mul(0.07)).add(aWind.z.mul(0.05))
  const w = vec2(sin(t.mul(0.8).add(ph)).add(sin(t.mul(1.9).add(ph.mul(1.3))).mul(0.45)), cos(t.mul(0.63).add(ph.mul(0.8))).add(sin(t.mul(1.4).add(ph)).mul(0.3)))
    .mul(0.02)
    .mul(uniforms.uWind)
    .mul(sway)
    .mul(h.mul(0.6).add(0.4))
  const fl = sin(t.mul(4.0).add(dot(p, vec3(3.1, 1.7, 2.3))).add(aWind.w.mul(30.0))).mul(0.02).mul(uniforms.uWind).mul(sway)
  const positionNode = p.add(vec3(w.x, fl, w.y))
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalGeometry, 0.0)).xyz))
  const vUv = varying(aUv)
  const vCol = varying(aCol)
  const vAo = varying(aAo)
  const vSeed = varying(aWind.w)

  const material = markPaint(unlit('domePlants', { side: THREE.DoubleSide, alphaToCoverage: true }), 'light')
  material.positionNode = positionNode
  material.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    const shape = leafShape(vUv)
    If(shape.a.lessThan(0.5), () => {
      Discard()
    })
    const vein = shape.vein
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const N = normalize(vNormal).toVar()
    const kind = vUv.z.toVar()
    const leafy = kind.greaterThan(0.5).and(kind.lessThan(8.5)).and(kind.lessThan(5.5).or(kind.greaterThan(6.5))).toVar()
    // 葉は薄い板: 見ている側の面の向きにする（頂点の法線は葉の表 = 上の側）。back = 葉の裏が見えている
    const back = float(0.0).toVar()
    If(leafy, () => {
      back.assign(select(dot(N, V).lessThan(0.0), float(1.0), float(0.0)))
      If(back.greaterThan(0.5), () => {
        N.assign(N.negate())
      })
    }).ElseIf(frontFacing.not(), () => {
      N.assign(N.negate())
    })
    const albedo = vCol.rgb.toVar()
    const ao = vAo.toVar()
    // 葉は付け根と先の 2 段の色・葉脈の形（明るい筋）だけ、幹と苔は平らな色。まだら・凹凸・透ける光・つやは描かない。
    // 光は木の光の式（'tree'。3 段）、葉脈ライティングは形のくっきりした筋を光る物の色の式（emit）に
    const veinQ = smoothstep(0.45, 0.55, vein).toVar()
    // 光る葉脈は細い筋なので、光る所は広めに切る（前は 0.45〜0.55 で切った細い筋に弱い光で、夕方の葉脈ライティングがほとんど見えなかった）
    const veinG = step(0.22, vein).toVar()
    If(leafy, () => {
      // 葉の色を持ち上げる（暗くなるほど強く。前は夕方の中の植物がほぼ黒い塊だった）
      albedo.mulAssign(mix(1.25, 1.8, u.uNight))
      albedo.mulAssign(mix(0.82, 1.05, smoothstep(0.45, 0.55, vUv.y)))
      albedo.assign(mix(albedo, albedo.mul(vec3(1.25, 1.3, 0.95)), veinQ.mul(0.5)))
      albedo.assign(mix(albedo, albedo.mul(vec3(1.3, 1.25, 1.0)), back.mul(0.6)))
      If(kind.greaterThan(6.5).and(kind.lessThan(7.5)), () => {
        albedo.assign(mix(albedo.mul(1.1), vec3(0.9, 0.7, 0.2), veinQ.mul(0.6)))
      })
    }).Else(() => {
      albedo.mulAssign(0.85)
    })
    const sh0 = townShadow(wp, N)
    const col = townLight(albedo, N, ao, select(leafy, leafShadow(sh0), sh0), 'tree').toVar()
    // 空の光と中の灯りの照り返し（前の塗りの空の光・透ける光の分の代わり。平らに足す。前は省いていたので、夕方の中の植物がほぼ黒い塊だった）
    col.addAssign(albedo.mul(u.uSkyLight.mul(0.8).add(uniforms.uNightAmb.mul(3.0))).mul(ao))
    const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
    // 流れる光は 2 段（明るい所と、ほのかな所）
    const flow = step(0.0, sin(vUv.y.mul(9.0).sub(t.mul(1.3)).add(vSeed.mul(20.0)))).mul(0.5).add(0.5)
    const glow = mix(vec3(0.45, 1.0, 0.3), vec3(0.85, 1.0, 0.45), veinQ)
    col.addAssign(paintEmit(glow.mul(veinG.mul(1.5).mul(flow).add(0.01)).mul(vCol.a).mul(uniforms.uVein).mul(breath.mul(0.5).add(0.5)).mul(select(leafy, float(1.0), float(0.0)))))
    return outdoorHaze(col, wp)
  })()
  const depth = depthMaterial({ positionNode, maskNode: Fn(() => leafShape(vUv).a.greaterThanEqual(0.5))(), side: THREE.DoubleSide })
  return { material: withUniforms(material, uniforms), depth, uniforms }
}
