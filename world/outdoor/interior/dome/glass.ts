import * as THREE from 'three/webgpu'
import {
  Discard,
  Fn,
  If,
  abs,
  asin,
  atan,
  cameraPosition,
  clamp,
  dot,
  float,
  fract,
  fwidth,
  max,
  mix,
  modelWorldMatrix,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import { oNoise, outdoorHaze, outdoorUniforms, skyColor, unlit, withUniforms } from '../../materials'
import { markPaint, outdoorPaint, paintEmit, paintFlat } from '../../paint'

/**
 * ガーデンドームの透けるガラスの半球（中を作っている間、町の不透明なドームの形の代わり）。
 * 主な骨（大アーチ 16・輪 5）は外観の白い鋼管（named/kits/observatory.ts）が作るので、ここはその間の細い斜めの格子（ダイヤグリッド）と
 * 合わせガラスの継ぎ目、ガラスの映り込み（外から: 空と太陽・中から: 部屋の明るさのうっすらした映り込み）。夕方からは格子が金緑色にほのかに光る
 * （外のドームの葉脈ライティングの骨の光と同じ）。両面・透ける
 */
export function createDomeGlassMaterial(ribs = 16, rings = 5) {
  const uniforms = { uDome: uniform(0), uRibs: uniform(ribs), uRings: uniform(rings), uInner: uniform(new THREE.Vector3()) }
  const o = outdoorUniforms
  // 法線は前と同じく mat3(modelMatrix) で回す（半球は縦と横で大きさが違うが、前の見た目に合わせる）
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalGeometry, 0.0)).xyz))
  const vUnit = varying(positionGeometry)
  const m = markPaint(unlit('domeGlass', { transparent: true, depthWrite: false, side: THREE.DoubleSide }), 'window')
  // 外の塗り（paint.ts）の flat: ガラスは透けるガラスの式（外から）・部屋の明るさの平らな映り（中から）、格子は面の光の式、光は emit。くもり・きらめきは描かない
  const paint = paintFlat() ? outdoorPaint() : null
  m.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    // 基壇（床から 3m）より下と、入口の張り出しの中はガラスが無い（局所: s = x、t = -z、高さ = y × 48 − 0.5）
    const hLocal = vUnit.y.mul(48.0).sub(0.5).toVar()
    const ang = atan(vUnit.z.negate(), vUnit.x).toVar()
    const dS = abs(ang.add(1.5707963))
    const dN = abs(ang.sub(1.5707963))
    const dW = float(3.14159265).sub(abs(ang))
    If(hLocal.lessThan(3.0).or(dS.lessThan(0.095).and(hLocal.lessThan(9.6))).or(dN.lessThan(0.058).or(dW.lessThan(0.058)).and(hLocal.lessThan(5.6))), () => {
      Discard()
    })
    const N = normalize(vNormal).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const outside = dot(N, V).greaterThan(0.0).toVar()
    const Nf = select(outside, N, N.negate()).toVar()
    const az = atan(vUnit.z, vUnit.x).div(6.2831853).mul(uniforms.uRibs).toVar()
    const el = asin(clamp(vUnit.y, 0.0, 1.0)).div(1.5707963).mul(uniforms.uRings.add(1.0))
    // 斜めの格子（外のドームのシェーダーと同じ式。緯度で間隔を広げる）
    const cosEl = sqrt(max(vUnit.y.mul(vUnit.y).oneMinus(), 0.04))
    const gl = el.mul(2.4).div(max(cosEl, 0.35)).toVar()
    const g1 = az.mul(2.0).add(gl).toVar()
    const g2 = az.mul(2.0).sub(gl)
    const wg = fwidth(g1).mul(0.9).add(0.012).toVar()
    const lattice = max(smoothstep(float(0.5).sub(wg), 0.5, abs(fract(g1).sub(0.5))), smoothstep(float(0.5).sub(wg), 0.5, abs(fract(g2).sub(0.5))))
    // 合わせガラスの継ぎ目（格子の間を 2 つに分ける細い線）
    const g3 = az.mul(4.0).toVar()
    const wj = fwidth(g3).mul(0.7).add(0.006)
    const joint = smoothstep(float(0.5).sub(wj), 0.5, abs(fract(g3).sub(0.5))).mul(0.5)
    const fade = smoothstep(0.12, 0.3, fwidth(g1)).oneMinus()
    const bar = max(lattice, joint).mul(fade).toVar()
    // ガラス: 外からは空を映し、中からはうっすらと部屋の明るさ
    const ndv = abs(dot(N, V))
    const fres = pow(clamp(ndv.oneMinus(), 0.0, 1.0), 5.0).mul(0.96).add(0.04).toVar()
    const col = vec3(0.0).toVar()
    const a = float(0.0).toVar()
    if (paint) {
      If(outside, () => {
        const g = (paint.glass ? paint.glass(Nf, V, wp, vec3(0.0)) : vec4(skyColor(vec3(0.0, 0.3, 1.0)).mul(0.6), 0.35)).toVar()
        col.assign(g.rgb)
        a.assign(g.a)
      }).Else(() => {
        col.assign(uniforms.uInner.add(skyColor(V.negate()).mul(0.06)))
        a.assign(0.06)
      })
      const steel = (paint.light ? paint.light(vec3(0.8, 0.8, 0.78), Nf, float(1.0), float(1.0), 'dome') : vec3(0.8, 0.8, 0.78).mul(o.uSkyLight)).add(vec3(0.8, 0.8, 0.78).mul(uniforms.uInner).mul(1.5)).toVar()
      const breath = sin(o.uTime.mul(0.55)).mul(0.38).add(0.62)
      steel.addAssign(paintEmit(vec3(0.7, 0.9, 0.5).mul(uniforms.uDome).mul(0.25).mul(breath)))
      col.assign(mix(col, steel, bar))
      a.assign(mix(a, 1.0, bar))
      return vec4(outdoorHaze(col, wp), a)
    }
    If(outside, () => {
      const R = reflect(V.negate(), Nf).toVar()
      const refl = skyColor(vec3(R.x, max(R.y, 0.02), R.z)).mul(vec3(0.92, 0.97, 1.0))
      const spec = pow(max(dot(R, o.uSunDir), 0.0), 220.0).mul(6.0).mul(smoothstep(-0.02, 0.06, o.uSunDir.y))
      col.assign(refl.add(o.uSunLight.mul(spec)))
      a.assign(clamp(fres.mul(0.9).add(0.07), 0.0, 0.92))
    }).Else(() => {
      col.assign(uniforms.uInner.add(skyColor(V.negate()).mul(0.06)))
      a.assign(clamp(fres.mul(0.45).add(0.03), 0.0, 0.6))
    })
    const smudge = oNoise(vUnit.xz.mul(60.0)).mul(0.5).add(oNoise(vUnit.xz.mul(190.0)).mul(0.5))
    a.addAssign(smudge.mul(0.02))
    // 白い鋼の格子（不透明）。夕方は金緑色にほのかに光る
    const steel = vec3(0.8, 0.8, 0.78).mul(o.uSunLight.mul(max(dot(Nf, o.uSunDir), 0.0)).mul(0.8).add(o.uSkyLight.mul(0.9)).add(uniforms.uInner.mul(1.5))).toVar()
    const breath = sin(o.uTime.mul(0.55)).mul(0.38).add(0.62)
    steel.addAssign(vec3(0.7, 0.9, 0.5).mul(uniforms.uDome).mul(0.25).mul(breath))
    col.assign(mix(col, steel, bar))
    a.assign(mix(a, 1.0, bar))
    return vec4(outdoorHaze(col, wp), a)
  })()
  return withUniforms(m, uniforms)
}

/** 半球の形（単位球の上半分。scale で半径と高さ） */
export function domeGlassGeometry() {
  return new THREE.SphereGeometry(1, 128, 40, 0, Math.PI * 2, 0, Math.PI / 2)
}
