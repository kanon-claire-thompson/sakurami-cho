import * as THREE from 'three/webgpu'
import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  int,
  length,
  max,
  min,
  mix,
  normalWorld,
  normalWorldGeometry,
  normalize,
  positionWorld,
  pow,
  reflect,
  select,
  sign,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uniformArray,
  vec2,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import { DOOR, SHELL } from '../../../core/site'
import { ENTRANCE, ROOM } from '../../../core/lab/plan'
import { townOptions } from '../../townHost'
import { colorUniform, oHash, oNoise, outdoorHaze, outdoorUniforms, skyColor, unlit } from '../materials'
import { paintFlat } from '../paint'
import { townLight } from '../town/facades'
import { townShadow } from '../town/shadows'
import { townTextureUniforms } from '../town/townTextures'

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

/** 仮の 1 画素の画像（打ち放しの質感を読む前・読めないとき）。色の画像は sRGB（読んだ画像と同じ。画像を替えても材質を作り直さないように） */
function solidTexture(rgb: [number, number, number], color: boolean) {
  const t = new THREE.DataTexture(new Uint8Array([...rgb, 255]), 1, 1)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.needsUpdate = true
  return t
}

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
  /** 打ち放しの質感（色・法線。読めるまでは 1 色） */
  uLabCon: texture(solidTexture([104, 104, 104], true)),
  uLabConN: texture(solidTexture([128, 128, 255], false)),
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

/** 打ち放しの質感を読む（読めなければ 1 色のまま）。置き場は地図の引数 assetBase の下の textures/lab_exterior/（初めて読むときに決める） */
let labTexturesRequested = false
function loadLabTextures(anisotropy: number) {
  if (labTexturesRequested) return
  labTexturesRequested = true
  const loader = new THREE.TextureLoader()
  const base = `${townOptions().assetBase}textures/lab_exterior/`
  const setup = (t: THREE.Texture, color: boolean) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.anisotropy = anisotropy
    t.needsUpdate = true
    return t
  }
  loader.load(`${base}concrete-color.webp`, (t) => (siteUniforms.uLabCon.value = setup(t, true)), undefined, () => console.warn('[sakurami-cho] ラボの外壁の質感を読めませんでした（1 色で代わりにします）'))
  loader.load(`${base}concrete-normal.webp`, (t) => (siteUniforms.uLabConN.value = setup(t, false)))
}

const LUMA = vec3(0.2126, 0.7152, 0.0722)
const lum = (c: V3) => dot(c, LUMA)
type Layers = typeof townTextureUniforms.uBldAlb
const layerAlb = (s: Layers, uv: THREE.Node<'vec2'>, layer: number) => pow(max(s.sample(uv).depth(int(layer)).rgb.mul(2.0), 0.0), vec3(2.2))
const layerNrm = (s: Layers, uv: THREE.Node<'vec2'>, layer: number) => s.sample(uv).depth(int(layer)).xyz.mul(2.0).sub(1.0)

/** ラボの外観とセットの形のシェーダー（1 つ。質感の種類は頂点の aMat） */
export function createSiteMaterial(anisotropy = 8) {
  loadLabTextures(anisotropy)
  const m = unlit('siteSurfaces')
  const vColor = varying(attribute<'vec3'>('color', 'vec3'))
  const vMat = varying(attribute<'vec2'>('aMat', 'vec2'))
  const tex = townTextureUniforms
  const su = siteUniforms
  m.colorNode = Fn(() => {
    const ou = outdoorUniforms
    const wp = positionWorld.toVar()
    const N = normalize(normalWorld).toVar()
    const id = floor(vMat.x.add(0.5)).toVar()
    const aux = vMat.y.toVar()
    const an = abs(N).toVar()
    const dist = length(cameraPosition.sub(wp)).toVar()
    // 面の向きで平面に投影（上下の面は x・-z、東西の面は z・y、南北の面は x・y）
    const top = an.y.greaterThan(0.7)
    const ew = an.x.greaterThan(an.z)
    const uv = select(top, vec2(wp.x, wp.z.negate()), select(ew, vec2(wp.z.negate().mul(sign(N.x)), wp.y), vec2(wp.x.mul(sign(N.z)), wp.y))).toVar()
    const T = select(top, vec3(1.0, 0.0, 0.0), select(ew, vec3(0.0, 0.0, sign(N.x).negate()), vec3(sign(N.z), 0.0, 0.0))).toVar()
    const B = select(top, vec3(0.0, 0.0, -1.0), vec3(0.0, 1.0, 0.0)).toVar()
    const albedo = vec3(vColor).toVar()
    const tn = vec3(0.0, 0.0, 1.0).toVar()
    const nk = smoothstep(30.0, 140.0, dist).oneMinus().toVar()
    const ao = float(1.0)
    const gloss = float(0.08).toVar()
    const metal = float(0.0).toVar()
    const n1 = oNoise(uv.mul(0.9)).toVar()
    const n2 = oNoise(uv.mul(0.21).add(7.0)).toVar()
    // 外の塗り（paint.ts）の flat: 質感・目地・汚れを省き、頂点の色の平らな塗りに（金属の度合いだけ残す）
    if (paintFlat()) {
      If(id.greaterThan(7.5).and(id.lessThan(8.5)), () => {
        metal.assign(1.0)
      })
    } else {
      If(id.lessThan(0.5), () => {
        // 打ち放し: 写真の質感（4m 四方）を灰色に寄せ、データの色で染める
        const t0 = su.uLabCon.sample(uv.div(4.0)).rgb.toVar()
        const t = mix(vec3(lum(t0)), t0, 0.3).div(0.15)
        albedo.mulAssign(mix(vec3(1.0), t, 0.85))
        tn.assign(su.uLabConN.sample(uv.div(4.0)).xyz.mul(2.0).sub(1.0))
        // 型枠の横の継ぎ目（1.82m ごと）と P コンの穴（横 0.6m・縦 0.45m）
        const fw = max(fwidth(uv.y), 1e-4)
        const seam = smoothstep(0.0, fw.add(0.004), abs(fract(uv.y.div(1.82).add(0.5)).sub(0.5)).mul(1.82)).oneMinus()
        albedo.mulAssign(float(1.0).sub(seam.mul(0.28).mul(nk)))
        const hp = fract(vec2(uv.x.div(0.6), uv.y.sub(0.225).div(0.45))).sub(0.5).mul(vec2(0.6, 0.45)).toVar()
        const hd = length(hp).toVar()
        const hfw = max(fwidth(hd), 1e-4).toVar()
        const ring = smoothstep(hfw.negate().add(0.011), hfw.add(0.011), hd).mul(smoothstep(hfw.negate().add(0.016), hfw.add(0.016), hd).oneMinus()).toVar()
        const plug = smoothstep(hfw.negate().add(0.011), hfw.add(0.011), hd).oneMinus()
        const holeFade = smoothstep(18.0, 40.0, dist).oneMinus().toVar()
        albedo.mulAssign(float(1.0).sub(holeFade.mul(ring.mul(0.45).add(plug.mul(0.12)))))
        tn.addAssign(vec3(normalize(hp.add(1e-5)).mul(holeFade.mul(ring).mul(-0.8)), 0.0))
        // 笠木・窓台（aux = その面の上の水切りの高さ）の下からの雨だれ、上ほど濃い全体のくすみ
        const below = aux.sub(wp.y).toVar()
        const streak = smoothstep(0.45, 0.85, oNoise(vec2(uv.x.mul(3.1), 0.0)).mul(0.75).add(oNoise(vec2(uv.x.mul(11.0), wp.y.mul(0.15))).mul(0.25)))
        const sk = smoothstep(-0.05, 0.25, below).mul(exp(max(below, 0.0).div(-2.6))).toVar()
        albedo.mulAssign(float(1.0).sub(streak.mul(0.38).mul(sk)).sub(sk.mul(0.08)))
        // 白い吹き出し（少し）
        albedo.addAssign(vec3(0.05).mul(smoothstep(0.82, 0.95, oNoise(vec2(uv.x.mul(1.7), wp.y.mul(0.6))))).mul(sk))
        // 足元のはね返りと、北の面の苔
        const foot = smoothstep(-0.4, n2.mul(0.4).add(0.9), wp.y).oneMinus()
        albedo.mulAssign(float(1.0).sub(foot.mul(0.3).mul(n1.mul(0.3).add(0.7))))
        const north = smoothstep(0.3, 0.8, N.z.negate())
          .mul(smoothstep(-0.6, 1.6, wp.y).oneMinus())
          .mul(smoothstep(0.35, 0.7, n2))
        albedo.assign(mix(albedo, albedo.mul(vec3(0.62, 0.78, 0.5)), north.mul(0.7)))
        // 全体の色むら（打ち継ぎ・打設のむら）
        albedo.mulAssign(n2.mul(0.2).add(0.9))
        gloss.assign(0.06)
      })
        .ElseIf(id.lessThan(1.5), () => {
          // なめらかなコンクリート（町の質感のコンクリート）と、目地（aux m ごと）
          albedo.mulAssign(mix(vec3(1.0), vec3(lum(layerAlb(tex.uBldAlb, uv.div(3.2), 4))), 0.75))
          tn.assign(layerNrm(tex.uBldNrm, uv.div(3.2), 4).mul(vec3(0.6, 0.6, 1.0)))
          If(aux.greaterThan(0.01), () => {
            const g = abs(fract(uv.div(aux).add(0.5)).sub(0.5)).mul(aux).toVar()
            const fw = max(fwidth(uv.x), 1e-4).add(0.002)
            const joint = smoothstep(0.003, fw.add(0.003), min(g.x, g.y)).oneMinus()
            albedo.mulAssign(float(1.0).sub(joint.mul(0.4).mul(nk)))
          })
          albedo.mulAssign(n2.mul(0.24).add(0.88))
          // 縦の面は上からの雨の筋
          albedo.mulAssign(float(1.0).sub(smoothstep(0.6, 0.9, oNoise(vec2(uv.x.mul(2.3), 0.0))).mul(0.14).mul(an.y.oneMinus())))
          gloss.assign(0.07)
        })
        .ElseIf(id.lessThan(2.5).or(id.greaterThan(5.5).and(id.lessThan(6.5))), () => {
          // 敷石・石畳
          const slab = id.lessThan(2.5)
          const p = uv.div(select(slab, 1.5, 1.8)).toVar()
          const t = select(slab, layerAlb(tex.uGndAlb, p, 4), layerAlb(tex.uGndAlb, p, 3)).toVar()
          albedo.mulAssign(mix(vec3(1.0), mix(vec3(lum(t)), t, 0.5), 0.85))
          tn.assign(select(slab, layerNrm(tex.uGndNrm, p, 4), layerNrm(tex.uGndNrm, p, 3)))
          albedo.mulAssign(n2.mul(0.3).add(0.85))
          // 道の縁ほど落ち葉と泥
          gloss.assign(0.07)
        })
        .ElseIf(id.lessThan(3.5), () => {
          // 御影石（縁石・笠石・石段の踏み面）
          const t = layerAlb(tex.uBldAlb, uv.div(1.2), 2)
          albedo.mulAssign(mix(vec3(1.0), vec3(lum(t)), 0.6))
          // 細かい粒（黒雲母）
          albedo.mulAssign(oHash(floor(uv.mul(180.0))).mul(0.3).add(0.85))
          tn.assign(layerNrm(tex.uBldNrm, uv.div(1.2), 2).mul(vec3(0.4, 0.4, 1.0)))
          gloss.assign(0.16)
        })
        .ElseIf(id.lessThan(4.5), () => {
          // 砂利
          const t = layerAlb(tex.uGndAlb, uv.div(1.2), 2)
          albedo.mulAssign(mix(vec3(1.0), t, 0.9))
          tn.assign(layerNrm(tex.uGndNrm, uv.div(1.2), 2))
          gloss.assign(0.04)
        })
        .ElseIf(id.lessThan(5.5), () => {
          // アスファルト
          const t = layerAlb(tex.uGndAlb, uv.div(4.0), 5)
          albedo.mulAssign(mix(vec3(1.0), vec3(lum(t)), 0.9))
          tn.assign(layerNrm(tex.uGndNrm, uv.div(4.0), 5).mul(vec3(0.5, 0.5, 1.0)))
          gloss.assign(0.05)
        })
        .ElseIf(id.lessThan(7.5), () => {
          // 塗装した鉄（aux = つや）。端の方は少し錆
          albedo.mulAssign(n1.mul(0.15).add(0.9))
          albedo.assign(mix(albedo, vec3(0.16, 0.08, 0.04), smoothstep(0.72, 0.95, oNoise(uv.mul(3.0).add(2.0))).mul(0.25).mul(aux.oneMinus())))
          gloss.assign(aux.mul(0.5).add(0.15))
        })
        .ElseIf(id.lessThan(8.5), () => {
          // ステンレス・亜鉛めっき
          metal.assign(1.0)
          gloss.assign(0.55)
          albedo.mulAssign(oNoise(uv.mul(14.0)).mul(0.12).add(0.92))
        })
        .ElseIf(id.lessThan(9.5), () => {
          // 木（板の筋）
          const t = layerAlb(tex.uBldAlb, vec2(uv.x.mul(0.6), uv.y.mul(0.6)), 0)
          albedo.mulAssign(mix(vec3(1.0), t, 0.7))
          albedo.mulAssign(oNoise(vec2(uv.x.mul(0.5), uv.y.mul(30.0))).mul(0.3).add(0.85))
          gloss.assign(0.1)
        })
        .ElseIf(id.lessThan(10.5), () => {
          // 屋上の防水シート（継ぎ目と汚れ）
          albedo.mulAssign(mix(vec3(1.0), vec3(lum(layerAlb(tex.uBldAlb, uv.div(3.2), 4))), 0.4))
          const lap = smoothstep(0.0, 0.02, abs(fract(uv.x).sub(0.5)).sub(0.48)).oneMinus()
          albedo.mulAssign(n2.mul(0.3).add(0.8).mul(float(1.0).sub(lap.mul(0.15))))
          gloss.assign(0.1)
        })
        .ElseIf(id.lessThan(11.5), () => {
          // ファンの格子（暗い穴と細い枠）
          const g = abs(fract(uv.mul(28.0)).sub(0.5))
          albedo.mulAssign(mix(0.15, 1.0, step(0.42, max(g.x, g.y))))
          gloss.assign(0.2)
        })
        .ElseIf(id.greaterThan(12.5), () => {
          // はげた白い塗装と錆（aux = 錆の多さ）: 塗装のはげた所は赤茶の錆、その下へ錆の筋
          const pn = oNoise(uv.mul(0.9).add(3.0)).mul(0.55).add(oNoise(uv.mul(3.7)).mul(0.3)).add(oNoise(uv.mul(13.0)).mul(0.15))
          const peel = smoothstep(float(0.74).sub(aux.mul(0.3)), float(0.8).sub(aux.mul(0.3)), pn).toVar()
          const run = smoothstep(0.62, 0.92, oNoise(vec2(uv.x.mul(5.0), uv.y.mul(0.3))))
            .mul(aux)
            .mul(oNoise(uv.mul(2.0)).mul(0.4).add(0.6))
          const rust = mix(vec3(0.12, 0.06, 0.03), vec3(0.24, 0.11, 0.05), oNoise(uv.mul(9.0)))
          // 錆の筋は塗装を茶色く染めるだけ（はげた所ほど濃くない）
          albedo.assign(mix(albedo.mul(n1.mul(0.18).add(0.82)), rust, peel))
          albedo.assign(mix(albedo, albedo.mul(vec3(0.72, 0.55, 0.42)), clamp(run, 0.0, 1.0)))
          gloss.assign(mix(0.18, 0.05, peel))
        })
        .Else(() => {
          // 土
          const t = layerAlb(tex.uGndAlb, uv.div(2.0), 1)
          albedo.mulAssign(mix(vec3(1.0), t, 0.9))
          tn.assign(layerNrm(tex.uGndNrm, uv.div(2.0), 1))
          gloss.assign(0.03)
        })
    }
    // 法線の凹凸（遠くは弱く）
    tn.assign(vec3(tn.xy.mul(nk), tn.z))
    const Nd = normalize(T.mul(tn.x).add(B.mul(tn.y)).add(N.mul(max(tn.z, 0.25)))).toVar()
    const sh = townShadow(wp, N).toVar()
    const col = townLight(albedo.mul(float(1.0).sub(metal.mul(0.7))), paintFlat() ? N : Nd, ao, sh, 'site').toVar()
    if (paintFlat()) {
      // 外の塗り（paint.ts）の flat: 凹凸・照り返し・映り込みを省く
      col.addAssign(albedo.mul(siteLight(wp, N)))
      return outdoorHaze(col, wp)
    }
    // 鏡面: 太陽のハイライトと空の映り込み（金属は強く）
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const H = normalize(V.add(ou.uSunDir))
    const ndh = max(dot(Nd, H), 0.0)
    const pw = mix(8.0, 140.0, gloss).toVar()
    const f0 = mix(0.04, 1.0, metal).toVar()
    const fres = f0.add(f0.oneMinus().mul(pow(clamp(dot(Nd, V).oneMinus(), 0.0, 1.0), 5.0))).toVar()
    col.addAssign(ou.uSunLight.mul(pow(ndh, pw).mul(pw.add(2.0)).div(8.0)).mul(fres).mul(sh).mul(max(dot(Nd, ou.uSunDir), 0.0)).mul(gloss))
    const R = reflect(V.negate(), Nd).toVar()
    R.assign(vec3(R.x, abs(R.y).mul(0.6).add(0.02), R.z))
    col.addAssign(skyColor(normalize(R)).mul(fres).mul(mix(gloss.mul(0.35), 0.85, metal)).mul(mix(vec3(1.0), albedo.mul(2.0), metal)))
    // 夜の光（街灯・窓の光・ネオン）
    col.addAssign(albedo.mul(siteLight(wp, Nd)))
    return outdoorHaze(col, wp)
  })()
  return m
}

/**
 * 外から見たガラス（南のガラス壁・ハイサイドの窓の外の面）。空を映す（フレネル）。中は透けて見える。
 * 部屋の中からは裏なので描かない（片面）
 */
export function createSiteGlassMaterial() {
  const m = unlit('siteGlass', { transparent: true, depthWrite: false })
  const ou = outdoorUniforms
  const col = Fn(() => {
    const wp = positionWorld.toVar()
    // 両面で使う所がある（中のある建物の扉・大庇）。normalWorld は裏の面で反転済みなので、裏の判定は反転していない幾何の法線で
    const N = normalize(normalWorldGeometry).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    // 両面のガラス（中のある建物の開く扉・大庇）の裏から見るときは、裏の面の向きで（前は裏が真っ白な映り込みになっていた）
    const back = select(dot(N, V).lessThan(0.0), 1.0, 0.0).toVar()
    If(back.greaterThan(0.5), () => {
      N.assign(N.negate())
    })
    const ndv = max(dot(N, V), 0.0)
    const fres = pow(clamp(ndv.oneMinus(), 0.0, 1.0), 5.0).mul(0.95).add(0.05).toVar()
    const R = reflect(V.negate(), N).toVar()
    // 地平線より下の映り込みは、地面と町の暗い色（遠くの町は空の色に溶ける）
    const below = mix(skyColor(vec3(R.x, 0.02, R.z)).mul(0.45), ou.uSkyLight.mul(0.25).add(ou.uSunLight.mul(0.03)), smoothstep(0.0, 0.25, R.y.negate()))
    const refl = select(R.y.greaterThan(0.0), skyColor(R), below)
    const spec = pow(max(dot(R, ou.uSunDir), 0.0), 900.0).mul(30.0).mul(smoothstep(-0.02, 0.05, ou.uSunDir.y))
    const c = refl.add(ou.uSunLight.mul(spec)).toVar()
    // ほこり・指紋のくもり（少し）
    const smudge = oNoise(wp.xy.mul(2.3).add(wp.z)).mul(0.5).add(oNoise(wp.xy.mul(9.0)).mul(0.5))
    const a = clamp(fres.mul(mix(0.9, 0.6, back)).add(mix(0.08, 0.04, back)).add(smudge.mul(0.04)), 0.0, 0.92).toVar()
    c.mulAssign(mix(1.0, 0.7, back))
    return vec4(outdoorHaze(c, wp), a)
  })()
  m.colorNode = col.xyz
  m.opacityNode = col.w
  return m
}

/** 光る物（外のネオン・街灯の灯具・足元灯）の色。strength は毎コマ変える（夜に強く） */
export function createSiteGlowMaterial(color: THREE.ColorRepresentation) {
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false })
  m.userData.base = new THREE.Color(color)
  return m
}

/** 扉の外の位置（夜にガラス壁の光が強く見えるかの目安などで使う） */
export const DOOR_OUTSIDE = new THREE.Vector3(DOOR.x, 0, SHELL.portalZ + 0.5)
