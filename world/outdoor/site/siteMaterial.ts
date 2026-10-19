import * as THREE from 'three/webgpu'
import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  floor,
  length,
  max,
  min,
  normalWorld,
  normalWorldGeometry,
  normalize,
  positionWorld,
  smoothstep,
  sqrt,
  uniform,
  uniformArray,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import { DOOR, SHELL } from '../../../core/site'
import { ENTRANCE, ROOM } from '../../../core/lab/plan'
import { colorUniform, outdoorHaze, unlit } from '../materials'
import { markPaint, outdoorPaint } from '../paint'
import { townLight } from '../town/facades'
import { townShadow } from '../town/shadows'

/**
 * ラボの外観とまわりのセットのシェーダー（町と同じ光の決まり: 太陽の直射・空の光・町の太陽の影・空気遠近。materials.ts の COMMON・townLight）。
 *
 * - 質感の種類（builder.ts の MAT）ごとに、写真の質感（打ち放しはアセットの根の textures/lab_exterior/、ほかは町の質感の層）と法線の凹凸を選ぶ
 * - 打ち放しのコンクリート: 型枠の継ぎ目・P コンの穴・笠木の下からの雨だれ・足元のはね返りと苔（北の面）
 * - 夜の光（siteLight。地面のシェーダーも使う）: 街灯（電球色）・ガラス壁からこぼれるラボの光・ガラス壁の枠のシアンのネオンの照り返し
 * - 鏡面: 太陽のハイライトと、金属・ガラスへの空の映り込み
 *
 * WebGPU（WebGPURenderer＋TSL）への移行（第 2 段）: 材質は TSL（NodeMaterial）。siteUniforms はノードの uniform（value は前のまま読み書きできる。
 * uLamps は配列の uniform で、中身は .array（Vector4 の配列）を書く）
 */

/** 街灯の数の上限（uniform の配列の長さ） */
export const MAX_LAMPS = 40

type V3 = THREE.Node<'vec3'>

export const siteUniforms = {
  /** 街灯の灯具の位置（シーンの座標）と強さ（w）。配列の uniform（.array を書く） */
  uLamps: uniformArray(
    Array.from({ length: MAX_LAMPS }, () => new THREE.Vector4(0, -1000, 0, 0)),
    'vec4',
  ),
  uLampCount: uniform(0, 'int'),
  /** 街灯の点き具合（0〜1。夜の小径の灯りと同じ）と色（明るさ込み） */
  uLampOn: uniform(0),
  uLampColor: colorUniform(new THREE.Color('#ffb46b').multiplyScalar(2.6)),
  /** ガラス壁からこぼれるラボの光（色 × 強さ） */
  uSpill: colorUniform(new THREE.Color(0, 0, 0)),
  /** 外のシアンのネオンの照り返し（強さ） */
  uNeon: uniform(0),
}

const GLASS_X0 = ENTRANCE.glassFrom
const GLASS_X1 = ROOM.halfWidth - 0.4

/** 線分 ab と点 p の距離 */
const segDist = (p: V3, a: THREE.Vector3, b: THREE.Vector3) => {
  const ab = vec3(b.x - a.x, b.y - a.y, b.z - a.z)
  const pa = p.sub(vec3(a.x, a.y, a.z))
  const t = clamp(dot(pa, ab).div(dot(ab, ab)), 0.0, 1.0)
  return length(pa.sub(ab.mul(t)))
}

/** 夜の光（街灯・ラボの窓の光・ネオンの照り返し）。返り値は照度（albedo を掛ける前。TSL の Fn。前の GLSL の SITE_LIGHT） */
export const siteLight = Fn(([wp, N]: [V3, V3]) => {
  const u = siteUniforms
  const acc = vec3(0.0).toVar()
  If(wp.x.greaterThanEqual(-120.0).and(wp.x.lessThanEqual(200.0)).and(wp.z.greaterThanEqual(-120.0)).and(wp.z.lessThanEqual(200.0)), () => {
    If(u.uLampOn.greaterThan(0.001), () => {
      Loop(MAX_LAMPS, ({ i }: { i: THREE.Node<'int'> }) => {
        If(i.greaterThanEqual(u.uLampCount), () => {
          Break()
        })
        const lamp = (u.uLamps.element(i) as unknown as THREE.Node<'vec4'>).toVar()
        const L = lamp.xyz.sub(wp).toVar()
        const d2 = dot(L, L).toVar()
        If(d2.greaterThan(484.0), () => {
          Continue()
        })
        const d = sqrt(d2).toVar()
        const ndl = max(dot(N, L.div(d)), 0.0).mul(0.85).add(0.15)
        acc.addAssign(u.uLampColor.mul(lamp.w).mul(ndl).mul(smoothstep(9.0, 22.0, d).oneMinus()).div(d2.mul(0.28).add(1.0)))
      })
      acc.mulAssign(u.uLampOn)
    })
    // ラボの窓の光: ガラス壁（南の面）を面の光とみなし、いちばん近い点からの光（ガラスの前の面だけ）
    const gz = SHELL.glassZ
    If(wp.z.greaterThan(gz - 0.05).and(dot(u.uSpill, u.uSpill).greaterThan(1e-6)), () => {
      const q = vec3(clamp(wp.x, GLASS_X0 + 0.2, GLASS_X1 - 0.2), clamp(wp.y, 0.4, 4.8), gz)
      const L = q.sub(wp).toVar()
      const d2 = max(dot(L, L), 0.04).toVar()
      const d = sqrt(d2).toVar()
      const facing = clamp(wp.z.sub(gz).div(d), 0.0, 1.0)
      acc.addAssign(u.uSpill.mul(max(dot(N, L.div(d)), 0.0).mul(0.8).add(0.2)).mul(facing.mul(0.65).add(0.35)).div(d2.mul(0.22).add(1.0)))
    })
    // 外のネオン（ガラス壁の枠と屋上の縁）の照り返し
    If(u.uNeon.greaterThan(0.001), () => {
      const cyan = vec3(0.1, 0.75, 1.0)
      const z = SHELL.portalZ - 0.02
      const x0 = GLASS_X0 + 0.06
      const x1 = GLASS_X1 - 0.06
      const dn = min(
        min(segDist(wp, new THREE.Vector3(x0, 0.05, z), new THREE.Vector3(x0, 6.4, z)), segDist(wp, new THREE.Vector3(x1, 0.05, z), new THREE.Vector3(x1, 6.4, z))),
        segDist(wp, new THREE.Vector3(x0, 6.42, z), new THREE.Vector3(x1, 6.42, z)),
      ).toVar()
      acc.addAssign(cyan.mul(u.uNeon).div(dn.mul(dn).mul(9.0).add(1.0)))
    })
  })
  return acc
})

/** ラボの外観とセットの形のシェーダー（1 つ。質感の種類は頂点の aMat） */
export function createSiteMaterial() {
  const m = markPaint(unlit('siteSurfaces'), 'light')
  const vColor = varying(attribute<'vec3'>('color', 'vec3'))
  const vMat = varying(attribute<'vec2'>('aMat', 'vec2'))
  m.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    const N = normalize(normalWorld).toVar()
    const id = floor(vMat.x.add(0.5)).toVar()
    const dist = length(cameraPosition.sub(wp)).toVar()
    // 面の向きで平面に投影（上下の面は x・-z、東西の面は z・y、南北の面は x・y）
    const albedo = vec3(vColor).toVar()
    const tn = vec3(0.0, 0.0, 1.0).toVar()
    const nk = smoothstep(30.0, 140.0, dist).oneMinus().toVar()
    const ao = float(1.0)
    const metal = float(0.0).toVar()
    // 質感・目地・汚れは描かず、頂点の色の平らな塗りに（金属の度合いだけ残す）
    If(id.greaterThan(7.5).and(id.lessThan(8.5)), () => {
      metal.assign(1.0)
    })
    // 法線の凹凸（遠くは弱く）
    tn.assign(vec3(tn.xy.mul(nk), tn.z))
    const sh = townShadow(wp, N).toVar()
    const col = townLight(albedo.mul(float(1.0).sub(metal.mul(0.7))), N, ao, sh, 'site').toVar()
    // 凹凸・照り返し・映り込みは描かない
    col.addAssign(albedo.mul(siteLight(wp, N)))
    return outdoorHaze(col, wp)
  })()
  return m
}

/**
 * 外から見たガラス（南のガラス壁・ハイサイドの窓の外の面）。空を映す（フレネル）。中は透けて見える。
 * 部屋の中からは裏なので描かない（片面）
 */
export function createSiteGlassMaterial() {
  const m = markPaint(unlit('siteGlass', { transparent: true, depthWrite: false }), 'window')
  const glass = outdoorPaint().glass
  // 透けるガラスは外の塗り（paint.ts）の glass（映り込み・太陽のきらめき・くもりは描かない）
  const g = Fn(() => {
    const wp = positionWorld.toVar()
    const N = normalize(normalWorldGeometry).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    If(dot(N, V).lessThan(0.0), () => {
      N.assign(N.negate())
    })
    const c = glass(N, V, wp, vec3(0.0)).toVar()
    return vec4(outdoorHaze(c.rgb, wp), c.a)
  })()
  m.colorNode = g.xyz
  m.opacityNode = g.w
  return m
}

/** 光る物（外のネオン・街灯の灯具・足元灯）の色。strength は毎コマ変える（夜に強く） */
export function createSiteGlowMaterial(color: THREE.ColorRepresentation) {
  const m = markPaint(new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false }), 'glow')
  m.userData.base = new THREE.Color(color)
  return m
}

/** 扉の外の位置（夜にガラス壁の光が強く見えるかの目安などで使う） */
export const DOOR_OUTSIDE = new THREE.Vector3(DOOR.x, 0, SHELL.portalZ + 0.5)
