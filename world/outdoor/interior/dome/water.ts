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
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  modelViewMatrix,
  normalize,
  positionWorld,
  pow,
  reflect,
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
import { oNoise, outdoorHaze, outdoorUniforms, skyColor, unlit, withUniforms } from '../../materials'
import { townShadow } from '../../town/shadows'
import { markPaint, outdoorPaint, paintEmit, paintFlat } from '../../paint'

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
  const water = paintFlat() ? outdoorPaint()?.water : undefined
  if (water) {
    // 外の塗り（paint.ts）の flat: 水面は塗りの水の式（川・池の色。夜の中の灯りと葉脈の光の映りは灯りの映りとして渡す）、泡は形のくっきりした白
    m.colorNode = Fn(() => {
      const wp = positionWorld.toVar()
      const p = wp.xz.toVar()
      const t = u.uTime
      const V = normalize(cameraPosition.sub(wp)).toVar()
      const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
      const lamps = uniforms.uNightAmb.mul(0.6).add(paintEmit(vec3(0.55, 1.0, 0.32).mul(uniforms.uVein).mul(breath).mul(0.12)))
      const col = water(vec3(0.0, 1.0, 0.0), V, wp, false, lamps).toVar()
      const df = length(p.sub(uniforms.uFoam.xy))
      const foamK = smoothstep(uniforms.uFoam.w.mul(0.3), uniforms.uFoam.w.mul(1.6), df).oneMinus()
      const foam = step(0.62, oNoise(p.mul(3.0).add(vec2(t.mul(0.9), t.mul(-0.7)))).mul(0.7).add(foamK.mul(0.4))).mul(foamK)
      col.assign(mix(col, vec3(0.75, 0.8, 0.8).mul(u.uSkyLight.mul(1.2).add(u.uSunLight.mul(0.35)).add(uniforms.uNightAmb.mul(2.0)).add(0.02)), foam.mul(0.85)))
      return outdoorHaze(col, wp)
    })()
    return withUniforms(m, uniforms)
  }
  m.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    const p = wp.xz.toVar()
    const t = u.uTime
    // さざ波の法線（2 方向の流れ）
    const q = p.mul(1.7).add(vec2(t.mul(0.35), t.mul(0.2))).toVar()
    const n0 = oNoise(q).toVar()
    const g = vec2(n0.sub(oNoise(q.add(vec2(0.37, 0.0)))), n0.sub(oNoise(q.add(vec2(0.0, 0.37))))).toVar()
    g.addAssign(vec2(oNoise(p.mul(4.3).sub(vec2(t.mul(0.6), t.mul(-0.4)))).sub(0.5), oNoise(p.mul(4.3).add(vec2(t.mul(0.5), t.mul(0.7))).add(3.1)).sub(0.5)).mul(0.5))
    // 滝の落ちる所（uFoam: x, z = 中心、w = 半径）のまわりは波立つ
    const df = length(p.sub(uniforms.uFoam.xy))
    const foamK = smoothstep(uniforms.uFoam.w.mul(0.3), uniforms.uFoam.w.mul(1.6), df).oneMinus().toVar()
    g.mulAssign(foamK.mul(1.6).add(0.35))
    const N = normalize(vec3(g.x.mul(-0.5), 1.0, g.y.mul(-0.5))).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const ndv = max(dot(N, V), 0.0)
    const fres = pow(clamp(ndv.oneMinus(), 0.0, 1.0), 5.0).mul(0.98).add(0.02).toVar()
    const R = reflect(V.negate(), N).toVar()
    // 映り込み: 上の空と、ドームの中の木々（水平に近いほど濃い緑）
    const sky = skyColor(vec3(R.x, max(R.y, 0.02), R.z))
    const green = vec3(0.025, 0.05, 0.025).mul(u.uDaylight.add(0.6)).add(uniforms.uNightAmb.mul(0.4))
    const refl = mix(green, sky.mul(0.85), smoothstep(0.15, 0.7, R.y))
    const sun = pow(max(dot(R, u.uSunDir), 0.0), 400.0).mul(18.0).mul(townShadow(wp.add(vec3(0.0, 0.2, 0.0)), vec3(0.0, 1.0, 0.0)))
    // 深さの色（底の石が透ける・縁は浅い）
    const shallow = vUv.y
    const deep = mix(vec3(0.012, 0.03, 0.03), vec3(0.04, 0.075, 0.06), shallow).mul(u.uSkyLight.mul(2.0).add(uniforms.uNightAmb.mul(2.0)).add(0.02))
    const col = mix(deep, refl, fres).add(u.uSunLight.mul(sun)).toVar()
    // 葉脈の光の映り込み（夕方から）
    const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
    col.addAssign(vec3(0.55, 1.0, 0.32).mul(uniforms.uVein).mul(breath).mul(0.06).mul(oNoise(p.mul(0.8).add(vec2(0.0, t.mul(0.1)))).mul(0.5).add(0.5)).mul(fres).mul(4.0))
    // 白い泡
    const foam = foamK.mul(smoothstep(0.35, 0.75, oNoise(p.mul(3.0).add(vec2(t.mul(0.9), t.mul(-0.7)))).mul(0.6).add(oNoise(p.mul(9.0).sub(t.mul(1.3))).mul(0.4)).add(foamK.mul(0.3))))
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
  const flat = paintFlat()
  const fallPaint = flat ? outdoorPaint()?.fall : undefined
  m.colorNode = Fn(() => {
    const u = vUv.x.toVar()
    const v = vUv.y.toVar()
    const L = vUv.z
    const t = o.uTime
    if (fallPaint) {
      // 外の塗り（paint.ts）の fall: 滝の色と不透明度は使う側の式（光と葉脈の照りは地図の値を渡す）
      const light = o.uSkyLight.mul(1.1).add(o.uSunLight.mul(0.35)).add(uniforms.uNightAmb.mul(2.5)).add(vec3(0.008))
      const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
      const c = fallPaint(u, v, L, t, light).toVar()
      const col = c.xyz.add(paintEmit(vec3(0.55, 1.0, 0.32).mul(uniforms.uVein).mul(breath).mul(0.08)))
      return vec4(outdoorHaze(col, positionWorld), clamp(c.w, 0.0, 1.0))
    }
    // 下へ流れる筋（縦に長い筋。落ちるほど速く、ほどけて白くなる）
    const y = v.mul(L).toVar()
    const speed = v.mul(2.6).add(1.6).toVar()
    const w1 = u.mul(18.0).add(sin(y.mul(0.7).add(u.mul(5.0))).mul(0.6))
    const s1 = oNoise(vec2(w1, y.mul(0.18).sub(t.mul(speed).mul(0.18))))
    const s2 = oNoise(vec2(u.mul(47.0).add(3.0), y.mul(0.5).sub(t.mul(speed).mul(0.5)))).toVar()
    const s3 = oNoise(vec2(u.mul(110.0).add(7.0), y.mul(1.6).sub(t.mul(speed).mul(1.6))))
    // 外の塗り（paint.ts）の flat: 筋は 2 段の平らな白（細かい筋の 3 つ目は使わない）
    const streak = (flat ? smoothstep(0.5, 0.53, s1.mul(0.65).add(s2.mul(0.35))).mul(0.6).add(smoothstep(0.66, 0.69, s1.mul(0.65).add(s2.mul(0.35))).mul(0.4)) : smoothstep(0.42, 0.9, s1.mul(0.55).add(s2.mul(0.3)).add(s3.mul(0.15)))).toVar()
    const edge = smoothstep(0.0, 0.18, u).mul(smoothstep(0.82, 1.0, u).oneMinus()).toVar()
    const ragged = smoothstep(0.0, 0.35, s2.sub(0.25).add(float(0.5).sub(abs(u.sub(0.5))).mul(1.6)))
    const a = streak.mul(0.7).add(0.12).mul(edge).mul(mix(1.0, ragged, 0.6)).toVar()
    a.assign(mix(a, a.mul(0.7).add(edge.mul(0.15)), v))
    a.mulAssign(smoothstep(0.0, 0.05, v))
    const base = vec3(0.84, 0.9, 0.93)
    const light = o.uSkyLight.mul(1.1).add(o.uSunLight.mul(0.35)).add(uniforms.uNightAmb.mul(2.5)).add(vec3(0.008))
    const col = base.mul(light).mul(streak.mul(0.5).add(0.7)).toVar()
    const breath = sin(t.mul(0.55)).mul(0.38).add(0.62)
    col.addAssign(paintEmit(vec3(0.55, 1.0, 0.32).mul(uniforms.uVein).mul(breath).mul(0.12).mul(streak)))
    return vec4(outdoorHaze(col, positionWorld), clamp(a, 0.0, 0.92))
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
  const flat = paintFlat()
  const particlePaint = flat ? outdoorPaint()?.particle : undefined
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
    // 外の塗り（paint.ts）の flat: 粒は縁のくっきりした丸（2 段のうすさ）
    // 外の塗りの particle を入れていれば、粒の形はその式（しぶき・霧で分ける）
    const shape = particlePaint
      ? particlePaint(r2, select(spray, float(1.0), float(0.0)))
      : flat
        ? smoothstep(0.55, 0.6, r2).oneMinus().mul(0.35).add(smoothstep(0.15, 0.2, r2).oneMinus().mul(0.25))
        : r2.oneMinus().mul(r2.oneMinus())
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
