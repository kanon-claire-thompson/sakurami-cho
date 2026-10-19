import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  attribute,
  cos,
  dot,
  float,
  floor,
  frontFacing,
  instanceIndex,
  length,
  mix,
  mod,
  normalGeometry,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
} from 'three/tsl'
import { SITE } from '../../../core/town'
import { oHash, outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { townLight } from './facades'
import { townShadow } from './shadows'
import { townLampsEx } from './lamps'
import { sampleGroundFlat } from './townMaterials'
import { markPaint } from '../paint'

/**
 * 草むら（地面の近くの草の葉。インスタンス、風で揺れる、カメラの近くだけ）。
 *
 * - 草の株（葉 5〜7 枚の形）を、カメラのまわりの世界の格子（近く 0.32m・遠く 0.75m ごと）に 1 株ずつ置く。格子の升ごとの乱数で
 *   位置・向き・大きさを決めるので、カメラが動いても株は動かない（ちらつかない）。株の位置は頂点のシェーダーが決める（CPU は毎コマ何もしない）
 * - 生える所: 地面の補助の画像（植生が多い・舗装でない・水でない）と、CPU で作る小さな高さの画像（1m ごと・96m 四方。高さと、
 *   ラボのセット・小道・中のある建物の中など草を置かない所の印）。カメラが 16m 動いたら作り直す
 * - 色は地面の画像の色（芝の色と合う）に、根元を暗く・先を明るく黄色く。逆光で透ける。町の影と夜の灯りを受ける
 * - 遠い株ほど間引き、半径の縁で小さくして消す
 * - WebGPU への移行（第 2 段）: 材質は TSL（NodeMaterial）。インスタンスの番号は instanceIndex
 */

const LAB = SITE.labFloorElevation
/** 高さの画像の升の数（一辺）と升の大きさ（m） */
const HN = 96
const HCELL = 1

interface Ring {
  spacing: number
  radius: number
  blades: number
  scale: number
}

/** 草の株の形（葉の枚数・高さの目安。原点は根元、y が上（0〜1 の割合を aH に）） */
function tuftGeometry(blades: number, seed: number) {
  let s = seed
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  const pos: number[] = []
  const nrm: number[] = []
  const hh: number[] = []
  const idx: number[] = []
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2
    const r = rnd() * 0.12
    const bx = Math.cos(a) * r
    const bz = Math.sin(a) * r
    const yaw = rnd() * Math.PI * 2
    const lean = 0.15 + rnd() * 0.45
    const h = 0.12 + rnd() * 0.2
    const w = 0.012 + rnd() * 0.01
    const ux = Math.cos(yaw)
    const uz = Math.sin(yaw)
    // 葉は横の向き (ux, uz)、前へ倒れる向きは (-uz, ux)
    const fx = -uz
    const fz = ux
    const base = pos.length / 3
    const seg = 3
    for (let k = 0; k <= seg; k++) {
      const t = k / seg
      const wk = w * (1 - t * 0.92)
      const bend = lean * t * t * h
      const cx = bx + fx * bend
      const cz = bz + fz * bend
      const y = h * t * (1 - 0.15 * lean * t)
      for (const sd of [-1, 1]) {
        pos.push(cx + ux * wk * sd, y, cz + uz * wk * sd)
        // 法線: 葉の面の向き（倒れる向き）と上をまぜる
        nrm.push(fx * 0.6, 0.8, fz * 0.6)
        hh.push(t)
      }
      if (k > 0) {
        const i = base + (k - 1) * 2
        idx.push(i, i + 1, i + 3, i, i + 3, i + 2)
      }
    }
  }
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('aH', new THREE.Float32BufferAttribute(hh, 1))
  g.setIndex(idx)
  return g
}

/** 草の材質の uniform（1 つの輪ごと） */
interface GrassUniforms {
  uGrassCam: THREE.UniformNode<'vec3', THREE.Vector3>
  uSpacing: THREE.UniformNode<'float', number>
  uRadius: THREE.UniformNode<'float', number>
  uScale: THREE.UniformNode<'float', number>
  uGridN: THREE.UniformNode<'float', number>
  uThin: THREE.UniformNode<'float', number>
  uHInfo: THREE.UniformNode<'vec4', THREE.Vector4>
  uWind: THREE.UniformNode<'float', number>
}

/**
 * 草の材質（前の GLSL の VERTEX・FRAGMENT と同じ式）。株の位置は頂点のシェーダー（positionNode）が決める。生えない株は 1 点に潰す
 * （三角形が面積 0 になって描かれない。前の GLSL はクリップの外へ出していた）
 */
function createGrassMaterial(name: string, u: GrassUniforms, height: THREE.Texture) {
  const m = markPaint(unlit(name, { side: THREE.DoubleSide }), 'light')
  const uHeight = texture(height)
  const aH = attribute<'float'>('aH', 'float')
  // 格子の升（カメラの近くの升から順に、インスタンスの番号で）
  const n = u.uGridN
  const id = float(instanceIndex)
  const cellBase = floor(u.uGrassCam.xz.div(u.uSpacing))
  const cell = cellBase.add(vec2(mod(id, n), floor(id.div(n)))).sub(floor(n.mul(0.5)))
  const h1 = oHash(cell)
  const h2 = oHash(cell.add(17.31))
  const h3 = oHash(cell.add(51.7))
  const xz = cell.add(vec2(h1, h2).mul(0.9)).add(0.05).mul(u.uSpacing)
  const dist = length(xz.sub(u.uGrassCam.xz))
  // 遠いほど間引く・縁で小さく
  const keep = step(h3, float(1.0).sub(u.uThin.mul(smoothstep(u.uRadius.mul(0.35), u.uRadius, dist))))
  const edge = smoothstep(u.uRadius.mul(0.8), u.uRadius, dist).oneMinus()
  // 地面の補助の画像: 植生・舗装・水
  const plan = vec2(xz.x, xz.y.negate())
  const { g, aux } = sampleGroundFlat(plan)
  const grassy = smoothstep(0.38, 0.6, aux.g).mul(smoothstep(0.3, 0.5, aux.b).oneMinus()).mul(step(0.5, aux.a)).mul(step(0.5, g.a))
  // 高さの画像（CPU）: r = 高さ（シーンの y）、g = 置いてよいか
  const huv = xz.sub(u.uHInfo.xy).div(u.uHInfo.z.mul(HN))
  const hv = uHeight.sample(huv)
  const inside = step(0.0, huv.x).mul(step(huv.x, 1.0)).mul(step(0.0, huv.y)).mul(step(huv.y, 1.0))
  const sc = keep.mul(edge).mul(grassy).mul(inside).mul(smoothstep(0.5, 0.9, hv.g)).mul(u.uScale).mul(oHash(cell.add(3.3)).mul(0.7).add(0.65))
  const yaw = h1.mul(6.2831853)
  const c = cos(yaw)
  const sn = sin(yaw)
  const p0 = positionGeometry.mul(sc)
  // 風: 上ほど大きく、株ごとに位相をずらし、ゆっくりした大きな波と小刻みな震え
  const t = outdoorUniforms.uTime
  const wave = sin(dot(xz, vec2(0.21, 0.17)).sub(t.mul(1.6))).mul(0.6).add(sin(t.mul(4.3).add(h2.mul(20.0))).mul(0.18))
  const bendAmt = aH.mul(aH).mul(sc).mul(0.22).mul(u.uWind).mul(wave.mul(0.4).add(0.6))
  const p = vec3(c.mul(p0.x).sub(sn.mul(p0.z)).add(bendAmt.mul(0.8)), p0.y, sn.mul(p0.x).add(c.mul(p0.z)).add(bendAmt.mul(0.45)))
  const wp = vec3(xz.x, hv.r.add(u.uHInfo.w).sub(0.03), xz.y).add(p)
  // 草の物は動かさないので、ローカルの位置 = シーンの位置
  m.positionNode = select(sc.lessThan(0.05), vec3(0.0, -1.0e5, 0.0), wp)
  const nn = normalGeometry
  const vNormal = varying(normalize(vec3(c.mul(nn.x).sub(sn.mul(nn.z)), nn.y, sn.mul(nn.x).add(c.mul(nn.z)))))
  // 地面の画像の色（テクスチャは sRGB なので読んだ値はリニア）を株ごとにばらつかせる
  const vColor = varying(g.rgb.mul(h3.mul(0.35).add(0.85)).mul(mix(vec3(1.0), vec3(1.08, 1.05, 0.8), oHash(cell.add(9.1)).mul(0.6))))
  const vH = varying(aH)
  const vWorld = varying(wp)
  m.colorNode = Fn(() => {
    const wpos = vWorld.toVar()
    const N = normalize(vNormal).toVar()
    If(frontFacing.not(), () => {
      N.assign(vec3(N.x.negate(), N.y, N.z.negate()))
    })
    // 根元と先の 2 段の色を、草の光の式（'grass'）で。逆光の透け・空の光の足しは省く
    const a = vColor.mul(mix(0.7, 1.08, smoothstep(0.45, 0.55, vH)))
    const col = townLight(a, N, float(1.0), townShadow(wpos, vec3(0.0, 1.0, 0.0)), 'grass').toVar()
    col.addAssign(a.mul(townLampsEx(wpos, N, float(0.0), float(0.5))))
    return outdoorHaze(col, wpos)
  })()
  return withUniforms(m, u)
}

export interface GrassOptions {
  radius: number
  /** その点に草を置いてよいか（平面座標）・地面の高さ */
  allowed: (x: number, y: number) => boolean
  heightAt: (x: number, y: number) => number
}

export class Grass {
  readonly group = new THREE.Group()
  private tex: THREE.DataTexture
  private data: Uint16Array
  private info = new THREE.Vector4(0, 0, HCELL, 0)
  private last = new THREE.Vector2(1e9, 1e9)
  private mats: ReturnType<typeof createGrassMaterial>[] = []
  private opt: GrassOptions

  constructor(opt: GrassOptions, layer: number) {
    this.opt = opt
    this.data = new Uint16Array(HN * HN * 4)
    this.tex = new THREE.DataTexture(this.data, HN, HN, THREE.RGBAFormat, THREE.HalfFloatType)
    this.tex.minFilter = THREE.LinearFilter
    this.tex.magFilter = THREE.LinearFilter
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping
    this.tex.needsUpdate = true
    this.group.name = 'grass'
    if (opt.radius <= 0) return
    const r = opt.radius
    const rings: Ring[] = [
      { spacing: 0.26, radius: Math.min(12, r), blades: 7, scale: 1 },
      { spacing: 0.6, radius: r, blades: 6, scale: 1.25 },
    ]
    rings.forEach((ring, i) => {
      const n = Math.ceil((ring.radius * 2) / ring.spacing)
      const geo = tuftGeometry(ring.blades, 1234 + i * 77)
      geo.instanceCount = n * n
      const mat = createGrassMaterial(`townGrass${i}`, {
        uGrassCam: uniform(new THREE.Vector3()),
        uSpacing: uniform(ring.spacing),
        uRadius: uniform(ring.radius),
        uScale: uniform(ring.scale),
        uGridN: uniform(n),
        uThin: uniform(i === 0 ? 0.35 : 0.7),
        uHInfo: uniform(this.info),
        uWind: uniform(1),
      }, this.tex)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.frustumCulled = false
      mesh.layers.set(layer)
      mesh.renderOrder = 11
      mesh.name = `grass:${i}`
      this.mats.push(mat)
      this.group.add(mesh)
    })
  }

  /** 作り直しの途中（行ごとに進める。終わったら画像を差し替える） */
  private job: Generator<void> | null = null
  private staging = new Uint16Array(HN * HN * 4)

  /** 高さの画像を作り直す（中心 = シーンの x, z）。16 行ごとに yield し、最後に差し替える */
  private *rebuildSteps(cx: number, cz: number): Generator<void> {
    const ox = Math.round(cx - (HN * HCELL) / 2)
    const oz = Math.round(cz - (HN * HCELL) / 2)
    // 高さは画像の中心の地面からの差（半精度の浮動小数でも cm まで）
    const base = this.opt.heightAt(cx, -cz) - LAB
    const d = this.staging
    for (let j = 0; j < HN; j++) {
      for (let i = 0; i < HN; i++) {
        const x = ox + (i + 0.5) * HCELL
        const z = oz + (j + 0.5) * HCELL
        const h = this.opt.heightAt(x, -z) - LAB
        const ok = this.opt.allowed(x, -z) ? 1 : 0
        const k = (j * HN + i) * 4
        d[k] = THREE.DataUtils.toHalfFloat(h - base)
        d[k + 1] = THREE.DataUtils.toHalfFloat(ok)
        d[k + 2] = 0
        d[k + 3] = THREE.DataUtils.toHalfFloat(1)
      }
      if (j % 16 === 15) yield
    }
    this.data.set(d)
    this.tex.needsUpdate = true
    this.info.set(ox, oz, HCELL, base)
    this.last.set(cx, cz)
  }

  update(camera: THREE.Camera, wind: number) {
    if (!this.mats.length) return
    const p = camera.position
    // カメラが高い（地面から 40m 以上）ときは描かない
    const ground = this.opt.heightAt(p.x, -p.z) - LAB
    // ラボの中のカメラ（配信の画）では描かない（窓の外の斜面の草は窓から見えるほど近くない）
    const inLab = Math.abs(p.x) < 9 && p.z > -10.6 && p.z < 6.5 && p.y < 7
    this.group.visible = p.y - ground < 40 && !inLab
    if (!this.group.visible) return
    // カメラが 12m 動いたら作り直し始め、1 コマに 16 行ずつ進める（町の中を歩く間、1 コマに作り直すと 50ms ほどかかった。§7 の 152）。
    // 遠くへ跳んだ（24m より。カット）ときは同じコマで全部
    const moved = Math.hypot(p.x - this.last.x, p.z - this.last.y)
    if (moved > 24) {
      this.job = this.rebuildSteps(p.x, p.z)
      while (!this.job.next().done);
      this.job = null
    } else if (!this.job && moved > 12) this.job = this.rebuildSteps(p.x, p.z)
    if (this.job && this.job.next().done) this.job = null
    for (const m of this.mats) {
      m.uniforms.uGrassCam.value.set(p.x, p.y, p.z)
      m.uniforms.uWind.value = wind
    }
  }
}
