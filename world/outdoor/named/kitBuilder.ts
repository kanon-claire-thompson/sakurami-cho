import * as THREE from 'three'
import { THIN_MAX, THIN_RATIO } from '../thin'

/**
 * 名前のある建物の細かい形を、頂点の配列へ直接書いて作る道具（site/builder.ts の GeoBuilder と同じ考えに、環境光の遮りと地面の高さを足したもの）。
 * 頂点: 位置（シーンの座標）・法線・色（リニア）・aMat（x = 質感の種類 NM、y = 種類ごとの値）・aExt（x = 環境光の遮り、y = 地面の高さ（シーンの y）、
 * z = 建物の種、w = 汚れやすさ）・aThin（細い角柱の頂点の、細い向きの中心の線からの差 xyz と断面の半分の幅 w。ほかは 0。outdoor/thin.ts）。
 * 面の表は外向き。シェーダー（namedMaterial.ts）は片面で描く
 */

type V3 = readonly [number, number, number]

const _c = new THREE.Color()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _v = new THREE.Vector3()
const _n = new THREE.Vector3()
const _nm = new THREE.Matrix3()
const _t = new THREE.Vector3()
const NO_THIN: [number, number, number, number] = [0, 0, 0, 0]

/** 単位の箱の 6 面（+x, -x, +y, -y, +z, -z。各面 4 点を表から見て反時計回り） */
const BOX_FACES: { n: V3; v: V3[] }[] = [
  { n: [1, 0, 0], v: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
  { n: [-1, 0, 0], v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
  { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
]

/** 箱の面の選び方（+x, -x, +y, -y, +z, -z の順。false の面は作らない） */
export type Faces = readonly [boolean, boolean, boolean, boolean, boolean, boolean]
export const ALL_FACES: Faces = [true, true, true, true, true, true]
/** 底の面を省く（地面や屋根に乗る物） */
export const NO_BOTTOM: Faces = [true, true, true, false, true, true]

export class KitBuilder {
  pos: number[] = []
  nrm: number[] = []
  col: number[] = []
  mat: number[] = []
  ext: number[] = []
  idx: number[] = []
  /** 細い角柱の頂点の値（aThin。4 つずつ） */
  thin: number[] = []
  /** これから足す頂点の aThin（box が細い角柱の頂点ごとに書く） */
  private thinV: [number, number, number, number] = NO_THIN
  /** これから足す頂点の環境光の遮り（1 = 遮りなし）・地面の高さ（シーンの y）・種・汚れやすさ */
  ao = 1
  groundY = -1000
  seed = 0
  dirt = 0.5

  get vertexCount() {
    return this.pos.length / 3
  }

  vertex(p: V3 | THREE.Vector3, n: V3 | THREE.Vector3, color: THREE.Color, m: number, aux: number) {
    if (Array.isArray(p)) this.pos.push(p[0], p[1], p[2])
    else {
      const v = p as THREE.Vector3
      this.pos.push(v.x, v.y, v.z)
    }
    if (Array.isArray(n)) this.nrm.push(n[0], n[1], n[2])
    else {
      const v = n as THREE.Vector3
      this.nrm.push(v.x, v.y, v.z)
    }
    this.col.push(color.r, color.g, color.b)
    this.mat.push(m, aux)
    this.ext.push(this.ao, this.groundY, this.seed, this.dirt)
    this.thin.push(this.thinV[0], this.thinV[1], this.thinV[2], this.thinV[3])
    return this.vertexCount - 1
  }

  /** 平らな多角形（点を表から見て反時計回り。凸でなくてもよい。法線は Newell の方法） */
  polygon(pts: readonly V3[], color: THREE.ColorRepresentation, m: number, aux = 0) {
    if (pts.length < 3) return
    _c.set(color)
    const n = newell(pts)
    if (pts.length === 3 || pts.length === 4 && isConvex(pts, n)) {
      const i0 = this.vertexCount
      for (const p of pts) this.vertex(p, n, _c, m, aux)
      for (let i = 1; i < pts.length - 1; i++) this.idx.push(i0, i0 + i, i0 + i + 1)
      return
    }
    // 平面に写して三角形に分ける
    const u = new THREE.Vector3()
    const v = new THREE.Vector3()
    basis(n, u, v)
    const flat = pts.map((p) => new THREE.Vector2(p[0] * u.x + p[1] * u.y + p[2] * u.z, p[0] * v.x + p[1] * v.y + p[2] * v.z))
    const tris = THREE.ShapeUtils.triangulateShape(flat, [])
    const i0 = this.vertexCount
    for (const p of pts) this.vertex(p, n, _c, m, aux)
    pushCCW(this.idx, i0, tris, flat)
  }

  /** 穴のある平らな多角形（外形・穴とも平面の 2D の点と、2D → 3D の写し方） */
  polygonWithHoles(outer: THREE.Vector2[], holes: THREE.Vector2[][], to3: (p: THREE.Vector2) => V3, normal: V3, color: THREE.ColorRepresentation, m: number, aux = 0) {
    _c.set(color)
    const tris = THREE.ShapeUtils.triangulateShape(outer, holes)
    const all = [...outer, ...holes.flat()]
    const i0 = this.vertexCount
    for (const p of all) this.vertex(to3(p), normal, _c, m, aux)
    // 2D の反時計回り（表から見て）が、3D の法線の向きの表になるように to3 を作る
    pushCCW(this.idx, i0, tris, all)
  }

  quad(a: V3, b: V3, c: V3, d: V3, color: THREE.ColorRepresentation, m: number, aux = 0) {
    _c.set(color)
    const n = newell([a, b, c, d])
    const i0 = this.vertex(a, n, _c, m, aux)
    this.vertex(b, n, _c, m, aux)
    this.vertex(c, n, _c, m, aux)
    this.vertex(d, n, _c, m, aux)
    this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3)
  }

  tri(a: V3, b: V3, c: V3, color: THREE.ColorRepresentation, m: number, aux = 0) {
    _c.set(color)
    const n = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2])).normalize()
    const i0 = this.vertex(a, n, _c, m, aux)
    this.vertex(b, n, _c, m, aux)
    this.vertex(c, n, _c, m, aux)
    this.idx.push(i0, i0 + 1, i0 + 2)
  }

  /** 箱（中心・大きさ・回転（Y 軸の角度か YXZ のオイラー角）） */
  box(center: V3, size: V3, color: THREE.ColorRepresentation, m: number, aux = 0, rot: number | V3 = 0, faces: Faces = ALL_FACES) {
    if (size[0] <= 1e-5 || size[1] <= 1e-5 || size[2] <= 1e-5) return
    _c.set(color)
    const r = typeof rot === 'number' ? ([0, rot, 0] as const) : rot
    _e.set(r[0], r[1], r[2], 'YXZ')
    _q.setFromEuler(_e)
    _m.compose(_v.set(center[0], center[1], center[2]), _q, new THREE.Vector3(size[0], size[1], size[2]))
    _nm.getNormalMatrix(_m)
    // 細い角柱（断面の 2 つの向きが THIN_MAX 以下で、いちばん長い向きがその THIN_RATIO 倍以上）: 細い向きの差を aThin に（遠くで画素の幅まで太らせる）
    const long = Math.max(size[0], size[1], size[2])
    // 棒（細い向きが 2 つ）だけ。板（細い向きが 1 つ。壁に沿った看板・額縁など）を太らせると、裏の壁へ食い込んだり手前へ浮いたりする
    const thinAxis = size.map((d) => d <= THIN_MAX && long >= d * THIN_RATIO)
    const half = thinAxis.filter(Boolean).length === 2 ? Math.min(...size.filter((_, i) => thinAxis[i])) / 2 : Infinity
    BOX_FACES.forEach((f, fi) => {
      if (!faces[fi]) return
      _n.set(f.n[0], f.n[1], f.n[2]).applyMatrix3(_nm).normalize()
      const i0 = this.vertexCount
      for (const v of f.v) {
        if (Number.isFinite(half)) {
          _t.set(thinAxis[0] ? v[0] * size[0] : 0, thinAxis[1] ? v[1] * size[1] : 0, thinAxis[2] ? v[2] * size[2] : 0).applyQuaternion(_q)
          this.thinV = [_t.x, _t.y, _t.z, half]
        }
        this.vertex(_v.set(v[0], v[1], v[2]).applyMatrix4(_m), _n, _c, m, aux)
      }
      this.thinV = NO_THIN
      this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3)
    })
  }

  /** 縦の円柱（下の中心・半径・高さ・分割。r1 = 上の半径。cap = 上のふた） */
  cylinder(base: V3, r: number, h: number, seg: number, color: THREE.ColorRepresentation, m: number, aux = 0, cap = true, r1 = r, bottom = false) {
    _c.set(color)
    const [bx, by, bz] = base
    const slope = (r - r1) / h
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2
      const a1 = ((i + 1) / seg) * Math.PI * 2
      const n0 = new THREE.Vector3(Math.sin(a0), slope, Math.cos(a0)).normalize()
      const n1 = new THREE.Vector3(Math.sin(a1), slope, Math.cos(a1)).normalize()
      const i0 = this.vertex([bx + Math.sin(a0) * r, by, bz + Math.cos(a0) * r], n0, _c, m, aux)
      this.vertex([bx + Math.sin(a1) * r, by, bz + Math.cos(a1) * r], n1, _c, m, aux)
      this.vertex([bx + Math.sin(a1) * r1, by + h, bz + Math.cos(a1) * r1], n1, _c, m, aux)
      this.vertex([bx + Math.sin(a0) * r1, by + h, bz + Math.cos(a0) * r1], n0, _c, m, aux)
      this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3)
      if (cap && r1 > 1e-4) {
        const t = this.vertex([bx, by + h, bz], [0, 1, 0], _c, m, aux)
        this.vertex([bx + Math.sin(a0) * r1, by + h, bz + Math.cos(a0) * r1], [0, 1, 0], _c, m, aux)
        this.vertex([bx + Math.sin(a1) * r1, by + h, bz + Math.cos(a1) * r1], [0, 1, 0], _c, m, aux)
        this.idx.push(t, t + 1, t + 2)
      }
      if (bottom) {
        const t = this.vertex([bx, by, bz], [0, -1, 0], _c, m, aux)
        this.vertex([bx + Math.sin(a1) * r, by, bz + Math.cos(a1) * r], [0, -1, 0], _c, m, aux)
        this.vertex([bx + Math.sin(a0) * r, by, bz + Math.cos(a0) * r], [0, -1, 0], _c, m, aux)
        this.idx.push(t, t + 1, t + 2)
      }
    }
  }

  /**
   * 回転体（profile = [半径, 高さ] の列を局所の y 軸のまわりに seg で回し、行列で置く）。outward = 外向きの面。
   * a0・a1 = 回す角度の範囲（ラジアン。部分だけの回転体）
   */
  lathe(profile: [number, number][], seg: number, matrix: THREE.Matrix4, color: THREE.ColorRepresentation, m: number, aux = 0, outward = true, a0 = 0, a1 = Math.PI * 2) {
    _c.set(color)
    const nm = new THREE.Matrix3().getNormalMatrix(matrix)
    const ang = (j: number) => a0 + (j / seg) * (a1 - a0)
    const ring = (i: number, j: number) => {
      const a = ang(j)
      const [r, h] = profile[i]
      return new THREE.Vector3(Math.sin(a) * r, h, Math.cos(a) * r)
    }
    const normalAt = (i: number, j: number) => {
      const a = ang(j)
      const p0 = profile[Math.max(0, i - 1)]
      const p1 = profile[Math.min(profile.length - 1, i + 1)]
      const dr = p1[0] - p0[0]
      const dh = p1[1] - p0[1]
      const v = new THREE.Vector3(Math.sin(a) * dh, -dr, Math.cos(a) * dh).normalize()
      return outward ? v : v.negate()
    }
    for (let i = 1; i < profile.length; i++) {
      for (let j = 0; j < seg; j++) {
        const quad = [ring(i - 1, j), ring(i - 1, j + 1), ring(i, j + 1), ring(i, j)]
        const norms = [normalAt(i - 1, j), normalAt(i - 1, j + 1), normalAt(i, j + 1), normalAt(i, j)]
        const order = outward ? [0, 1, 2, 3] : [0, 3, 2, 1]
        const i0 = this.vertexCount
        for (const k of order) this.vertex(quad[k].applyMatrix4(matrix), norms[k].applyMatrix3(nm).normalize(), _c, m, aux)
        this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3)
      }
    }
  }

  /** 2 点を結ぶ角柱（手すり・腕・骨）。thick = 断面の幅 */
  beam(a: V3, b: V3, thick: number, color: THREE.ColorRepresentation, m: number, aux = 0, thickY = thick, roll = 0) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const len = d.length()
    if (len < 1e-4) return
    const yaw = Math.atan2(d.x, d.z)
    const pitch = -Math.asin(THREE.MathUtils.clamp(d.y / len, -1, 1))
    this.box([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [thick, thickY, len], color, m, aux, [pitch, yaw, roll])
  }

  /** 2 点を結ぶ円柱の管（分割 seg） */
  tube(a: V3, b: V3, r: number, seg: number, color: THREE.ColorRepresentation, m: number, aux = 0) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const len = d.length()
    if (len < 1e-4) return
    const mtx = new THREE.Matrix4().compose(new THREE.Vector3(a[0], a[1], a[2]), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1))
    this.lathe(
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

  /** 縦の角柱（平面の外形 pts（シーンの x, z を [x, z] で）を y0 から y1 まで。外形は上から見て反時計回り = シーンで x→-z の回り） */
  prism(ring: readonly (readonly [number, number])[], y0: number, y1: number, color: THREE.ColorRepresentation, m: number, aux = 0, top = true, bottom = false) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const p = ring[i]
      const q = ring[(i + 1) % n]
      this.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], color, m, aux)
    }
    if (top) this.polygon(ring.map((p) => [p[0], y1, p[1]] as const).reverse(), color, m, aux)
    if (bottom) this.polygon(ring.map((p) => [p[0], y0, p[1]] as const), color, m, aux)
  }

  merge(o: KitBuilder) {
    const base = this.vertexCount
    for (let i = 0; i < o.pos.length; i++) this.pos.push(o.pos[i])
    for (let i = 0; i < o.nrm.length; i++) this.nrm.push(o.nrm[i])
    for (let i = 0; i < o.col.length; i++) this.col.push(o.col[i])
    for (let i = 0; i < o.mat.length; i++) this.mat.push(o.mat[i])
    for (let i = 0; i < o.ext.length; i++) this.ext.push(o.ext[i])
    for (let i = 0; i < o.thin.length; i++) this.thin.push(o.thin[i])
    for (let i = 0; i < o.idx.length; i++) this.idx.push(o.idx[i] + base)
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 2))
    g.setAttribute('aExt', new THREE.Float32BufferAttribute(this.ext, 4))
    // 半精度（頂点 1 つ 8 バイト）。Float16BufferAttribute は半精度に直した値を受け取る
    g.setAttribute('aThin', new THREE.Float16BufferAttribute(Uint16Array.from(this.thin, (v) => THREE.DataUtils.toHalfFloat(v)), 4))
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}

/** 三角形を 2D で反時計回りにそろえて足す */
function pushCCW(idx: number[], i0: number, tris: number[][], pts: THREE.Vector2[]) {
  for (const t of tris) {
    const a = pts[t[0]]
    const b = pts[t[1]]
    const c = pts[t[2]]
    const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    if (cr >= 0) idx.push(i0 + t[0], i0 + t[1], i0 + t[2])
    else idx.push(i0 + t[0], i0 + t[2], i0 + t[1])
  }
}

/** 点の列の法線（Newell の方法。表から見て反時計回り） */
export function newell(ps: readonly V3[]) {
  const n = new THREE.Vector3()
  for (let i = 0; i < ps.length; i++) {
    const p0 = ps[i]
    const p1 = ps[(i + 1) % ps.length]
    n.x += (p0[1] - p1[1]) * (p0[2] + p1[2])
    n.y += (p0[2] - p1[2]) * (p0[0] + p1[0])
    n.z += (p0[0] - p1[0]) * (p0[1] + p1[1])
  }
  return n.lengthSq() > 0 ? n.normalize() : n.set(0, 1, 0)
}

function isConvex(ps: readonly V3[], n: THREE.Vector3) {
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i]
    const b = ps[(i + 1) % ps.length]
    const c = ps[(i + 2) % ps.length]
    const e1 = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const e2 = new THREE.Vector3(c[0] - b[0], c[1] - b[1], c[2] - b[2])
    if (e1.cross(e2).dot(n) < -1e-9) return false
  }
  return true
}

/** 法線 n に直交する 2 つの向き（u × v = n） */
function basis(n: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3) {
  const t = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  u.crossVectors(t, n).normalize()
  v.crossVectors(n, u).normalize()
}
