import * as THREE from 'three/webgpu'
import {
  Discard,
  Fn,
  If,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  modelViewMatrix,
  normalize,
  positionWorld,
  screenDPR,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { oNoise, outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../../materials'
import { markPaint, outdoorPaint, paintEmit } from '../../paint'

/**
 * ガーデンドームの水（池の水面・大滝「天の水」と回廊から落ちる細い滝・滝つぼのしぶき）と、雲霧林の霧（噴霧装置）。
 * どれも自分のシェーダー（空を映す水面、流れ落ちる筋の滝、やわらかい霧の粒）
 */

type V3 = [number, number, number]

/* -------------------------------------------------------------------------- */
/* 水面                                                                         */
/* -------------------------------------------------------------------------- */

/** 水面（空とドームの緑を映す・さざ波・深さの色・滝の落ちる所の白い泡・夜は葉脈の光を映す） */
export function createPoolMaterial() {
  const uniforms = { uVein: uniform(0), uFoam: uniform(new THREE.Vector4(0, 0, 0, 0)), uNightAmb: uniform(new THREE.Vector3()) }
  const u = outdoorUniforms
  const vUv = varying(attribute<'vec2'>('aUv', 'vec2'))
  const m = markPaint(unlit('domePool'), 'water')
  const water = outdoorPaint().water
  // 水面は外の塗り（paint.ts）の水の式（川・池の色。夜の中の灯りと葉脈の光の映りは灯りの映りとして渡す）、泡は形のくっきりした白
  m.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    const p = wp.xz.toVar()
    const t = u.uTime
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
    const lamps = uniforms.uNightAmb.mul(0.6).add(paintEmit(vec3(0.55, 1.0, 0.32).mul(uniforms.uVein).mul(breath).mul(0.12)))
    const col = water(vec3(0.0, 1.0, 0.0), V, wp, false, lamps).toVar()
    // 池の形: 浅い縁（輪の内と外）の明るい水の帯と、葉脈の光の緑の映り（平らな色。灯りの映りの段に届かない弱い光は、塗りの水の式では消えて池が見えなかった）
    const shallow = vUv.y
    const rim = step(0.8, shallow)
    col.assign(mix(col, col.mul(1.5).add(u.uSkyLight.mul(0.12)).add(uniforms.uNightAmb.mul(0.8)), rim))
    col.addAssign(paintEmit(vec3(0.45, 1.0, 0.35).mul(uniforms.uVein).mul(breath.mul(0.5).add(0.5)).mul(mix(0.1, 0.22, step(0.45, shallow)))))
    const df = length(p.sub(uniforms.uFoam.xy))
    const foamK = smoothstep(uniforms.uFoam.w.mul(0.3), uniforms.uFoam.w.mul(1.6), df).oneMinus()
    const foam = step(0.62, oNoise(p.mul(3.0).add(vec2(t.mul(0.9), t.mul(-0.7)))).mul(0.7).add(foamK.mul(0.4))).mul(foamK)
    col.assign(mix(col, vec3(0.75, 0.8, 0.8).mul(u.uSkyLight.mul(1.2).add(u.uSunLight.mul(0.35)).add(uniforms.uNightAmb.mul(2.0)).add(0.02)), foam.mul(0.85)))
    return outdoorHaze(col, wp)
  })()
  return withUniforms(m, uniforms)
}

/** 輪の水面（中心・内と外の半径・高さ。v = 外ほど深い → aUv.y = 浅さ） */
export function poolGeometry(S: (s: number, t: number, h: number) => V3, r0: number, r1: number, h: number, seg = 96, rings = 6) {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= rings; i++) {
    const r = r0 + ((r1 - r0) * i) / rings
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2
      const p = S(Math.cos(a) * r, Math.sin(a) * r, h)
      pos.push(...p)
      const edge = Math.min(i / rings, 1 - i / rings) * 2
      uv.push(j / seg, 1 - edge)
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j
      const b = a + 1
      const d = a + seg + 1
      idx.push(a, d, b, b, d, d + 1)
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeBoundingSphere()
  return g
}

/* -------------------------------------------------------------------------- */
/* 滝                                                                           */
/* -------------------------------------------------------------------------- */

/** 滝（流れ落ちる白い筋・透ける縁・下の泡。aUv = (横 0〜1, 落ちた割合 0〜1, 長さ m)） */
export function createFallMaterial() {
  const uniforms = { uNightAmb: uniform(new THREE.Vector3()), uVein: uniform(0) }
  const o = outdoorUniforms
  const vUv = varying(attribute<'vec3'>('aUv', 'vec3'))
  const m = markPaint(unlit('domeFalls', { transparent: true, depthWrite: false, side: THREE.DoubleSide }), 'water')
  const fallPaint = outdoorPaint().fall
  m.colorNode = Fn(() => {
    const u = vUv.x.toVar()
    const v = vUv.y.toVar()
    const L = vUv.z
    const t = o.uTime
    // 滝の色と不透明度は外の塗り（paint.ts）の fall（光と葉脈の照りを渡す）
    const light = o.uSkyLight.mul(1.1).add(o.uSunLight.mul(0.35)).add(uniforms.uNightAmb.mul(2.5)).add(vec3(0.008))
    const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
    const c = fallPaint(u, v, L, t, light).toVar()
    const col = c.xyz.add(paintEmit(vec3(0.55, 1.0, 0.32).mul(uniforms.uVein).mul(breath).mul(0.08)))
    return vec4(outdoorHaze(col, positionWorld), clamp(c.w, 0.0, 1.0))
  })()
  return withUniforms(m, uniforms)
}

/**
 * 滝の幕（上の口から下へ、外へ少し張り出して落ちる）。center = 核の中心（局所）・a = 角度・r0 = 口の距離・w = 幅・h0 → h1（上 → 下）。
 * 局所の点の列で書いて S で変える
 */
export function fallCurtain(out: { pos: number[]; uv: number[]; idx: number[] }, S: (s: number, t: number, h: number) => V3, cx: number, cy: number, a: number, r0: number, w: number, h0: number, h1: number, throwOut: number) {
  const nu = 6
  const nv = 10
  const base = out.pos.length / 3
  const L = h0 - h1
  for (let j = 0; j <= nv; j++) {
    const v = j / nv
    const r = r0 + throwOut * Math.sqrt(v) + 0.2 * v
    const h = h0 - L * v
    const ww = w * (1 + 0.25 * v)
    for (let i = 0; i <= nu; i++) {
      const u = i / nu
      const da = ((u - 0.5) * ww) / Math.max(r, 0.5)
      const p = S(cx + Math.cos(a + da) * r, cy + Math.sin(a + da) * r, h)
      out.pos.push(...p)
      out.uv.push(u, v, L)
    }
  }
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const p = base + j * (nu + 1) + i
      out.idx.push(p, p + 1, p + nu + 2, p, p + nu + 2, p + nu + 1)
    }
}

/** 平らな幕の滝（回廊の縁から下へまっすぐ。p = 上の口の中心（局所）・along = 幅の向き（局所の角度）） */
export function fallSheet(out: { pos: number[]; uv: number[]; idx: number[] }, S: (s: number, t: number, h: number) => V3, s: number, t: number, along: number, outward: number, w: number, h0: number, h1: number) {
  const nu = 3
  const nv = 10
  const base = out.pos.length / 3
  const L = h0 - h1
  for (let j = 0; j <= nv; j++) {
    const v = j / nv
    const off = 0.5 * Math.sqrt(v)
    for (let i = 0; i <= nu; i++) {
      const u = i / nu
      const d = (u - 0.5) * w * (1 + 0.6 * v)
      const p = S(s + Math.cos(along) * d + Math.cos(outward) * off, t + Math.sin(along) * d + Math.sin(outward) * off, h0 - L * v)
      out.pos.push(...p)
      out.uv.push(u, v, L)
    }
  }
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const p = base + j * (nu + 1) + i
      out.idx.push(p, p + 1, p + nu + 2, p, p + nu + 2, p + nu + 1)
    }
}

export function fallGeometry(out: { pos: number[]; uv: number[]; idx: number[] }) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3))
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(out.uv, 3))
  g.setIndex(out.idx)
  g.computeBoundingSphere()
  return g
}

/* -------------------------------------------------------------------------- */
/* 霧・しぶき（やわらかい粒）                                                      */
/* -------------------------------------------------------------------------- */

/** 霧の粒の点ごとの値（位置 3・aMist 4 = 大きさ m, 種, 濃さ, 種類 0 = 霧・1 = しぶき） */
export interface MistAttributes {
  position: THREE.InstancedBufferAttribute
  aMist: THREE.InstancedBufferAttribute
}

/**
 * 霧の粒（Sprite を粒の数だけ並べる。WebGPU の点は 1px だけなので、1px を超える点は PointsNodeMaterial の sizeNode）。
 * 大きさは uPx（描き先の画素。画面の高さから）。sizeNode は CSS の px で three が画素の比を掛けるので、画素の比で割って渡す
 */
export function createMistMaterial(attrs: MistAttributes) {
  const uniforms = { uPx: uniform(600), uNightAmb: uniform(new THREE.Vector3()), uMist: uniform(1) }
  const o = outdoorUniforms
  const pos = instancedBufferAttribute(attrs.position, 'vec3' as const)
  const aMist = instancedBufferAttribute(attrs.aMist, 'vec4' as const)
  const t = o.uTime
  // 頂点の値は Fn の中で toVar にしてから分岐（select）で使う（分岐の中で初めて組み立てた値を、ほかの分岐で読まないように）
  const spray = aMist.w.greaterThanEqual(0.5)
  const p = Fn(() => {
    const ph = aMist.y.mul(6.2831).toVar()
    const k = fract(t.mul(0.25).add(aMist.y)).toVar()
    // 漂う（霧は横へゆっくり・しぶきは上へ舞う）
    const drift = vec3(sin(t.mul(0.07).add(ph)).mul(1.6), sin(t.mul(0.11).add(ph)).mul(0.4), cos(t.mul(0.05).add(ph.mul(1.3))).mul(1.6)).toVar()
    const rise = vec3(sin(ph).mul(k).mul(1.2), k.mul(2.2), cos(ph).mul(k).mul(1.2)).toVar()
    return pos.add(select(spray, rise, drift))
  })()
  const depth = Fn(() => modelViewMatrix.mul(vec4(p, 1.0)).z.negate())()
  const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false, fog: false })
  m.name = 'domeMist'
  markPaint(m, 'flat')
  const particlePaint = outdoorPaint().particle
  m.positionNode = p
  m.sizeNode = clamp(aMist.x.mul(uniforms.uPx).div(max(depth, 0.5)), 1.0, 900.0).div(screenDPR)
  const vA = varying(
    Fn(() => {
      const ph = aMist.y.mul(6.2831).toVar()
      const k = fract(t.mul(0.25).add(aMist.y)).toVar()
      const d = modelViewMatrix.mul(vec4(p, 1.0)).z.negate().toVar()
      const pulse = select(spray, k.oneMinus(), sin(t.mul(0.18).add(ph)).mul(0.4).add(0.6))
      return aMist.z.mul(pulse).mul(smoothstep(0.8, 6.0, d))
    })(),
  )
  m.colorNode = Fn(() => {
    const q = uv().mul(2.0).sub(1.0)
    const r2 = dot(q, q).toVar()
    If(r2.greaterThan(1.0), () => {
      Discard()
    })
    // 粒の形は外の塗り（paint.ts）の particle（しぶき・霧で分ける）
    const shape = particlePaint(r2, select(spray, float(1.0), float(0.0)))
    const a = shape.mul(vA).mul(uniforms.uMist)
    const col = vec3(0.86, 0.9, 0.92).mul(o.uSkyLight.mul(1.1).add(o.uSunLight.mul(0.25)).add(uniforms.uNightAmb.mul(2.2)).add(0.01))
    return vec4(outdoorHaze(col, positionWorld), a)
  })()
  return withUniforms(m, uniforms)
}

/** 霧の粒の Sprite（粒の数だけ並べた物）。pos = 位置の列（3 つずつ）、mist = aMist の列（4 つずつ） */
export function createMistSprite(pos: number[], mist: number[]) {
  const material = createMistMaterial({ position: new THREE.InstancedBufferAttribute(new Float32Array(pos), 3), aMist: new THREE.InstancedBufferAttribute(new Float32Array(mist), 4) })
  const sprite = new THREE.Sprite(material)
  sprite.count = pos.length / 3
  return sprite as THREE.Sprite & { material: typeof material }
}
