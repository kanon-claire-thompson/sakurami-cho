import * as THREE from 'three/webgpu'
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cos,
  cross,
  dFdx,
  dFdy,
  distance,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  int,
  instanceIndex,
  inverseSqrt,
  ivec2,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  select,
  sign,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { SITE } from '../../../core/town'
import { sharedTime } from '../../materials/shared'
import { oHash, oNoise, outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { markPaint, outdoorPaint, paintEmit, paintLampLight } from '../paint'
import { glyph } from '../glyph'
import { bayTarget, dirtOf, facadeType, hasFlag, near, occupancy, townLight, wallLayer, windowHash } from './facades'
import { depthMaterial, townShadow } from './shadows'
import { siteLight } from '../site/siteMaterial'
import { lampUniforms, townLamps, townLampsEx, townLampsMirror } from './lamps'
import type { InstanceSet } from './buildingKit'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/**
 * 町のシェーダー（地面・海と川・建物・遠くの窓明かり）。光と空気遠近は materials.ts の共有 uniform（outdoorUniforms）と
 * outdoorShade()・outdoorHaze() を使うので、空・木・灯りと同じ光で描ける。
 *
 * 地面の色は `pnpm sync:town` が塗った画像（中心 1m/画素・全体 5m/画素。A = 陸か海か）と補助の画像（R 街灯の照り返し・G 植生・B 舗装・A 川・運河・池でないか）。
 * 建物は「型（屋根の形）× インスタンス（大きさ・向き・色・外壁の種類・用途）」で組み立て、窓・外壁の模様・夜の窓明かりはこのシェーダーが描く。
 * 段階 2（質を上げる）で、外壁の型・窓の奥の部屋・汚れをここに足す（docs/design/town.md）。
 *
 * WebGPU（WebGPURenderer＋TSL）への移行（第 2 段）: どの材質も TSL（NodeMaterial）。前の GLSL と同じ式。使う側が書く値は前と同じ
 * material.uniforms.<名前>.value（ノードの uniform）。建物の頂点の計算は positionNode で、影の深さだけの材質と共有する。
 * 遠くの窓明かりは Sprite（PointsNodeMaterial）を 1 棟 16 個並べ、建物のインスタンスの値は浮動小数の画像から読む（createWindowSprites）
 */

const LAB_FLOOR = SITE.labFloorElevation
const LUMA = vec3(0.2126, 0.7152, 0.0722)

/* -------------------------------------------------------------------------- */
/* 地面の画像                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 中身を入れる前の仮の画像（1 画素。読む側の材質を先に組み立てるため）。色の画像は sRGB（あとで入れる画像と同じ。sRGB からの変換は
 * 材質を組み立てるときの画像で決まるので、仮の画像もそろえる）
 */
function placeholder2D(rgba: [number, number, number, number], color: boolean) {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1)
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.needsUpdate = true
  return t
}

/** 地面の画像の uniform（地面・海・草の両方が使う。Landscape が画像（TextureNode の value）と範囲を入れる） */
export const groundUniforms = {
  uGroundC: texture(placeholder2D([60, 70, 40, 255], true)),
  uAuxC: texture(placeholder2D([0, 0, 0, 255], false)),
  uGroundO: texture(placeholder2D([60, 70, 40, 255], true)),
  uAuxO: texture(placeholder2D([0, 0, 0, 255], false)),
  /** 範囲（西端 x・北端 y・東西の幅 m・南北の幅 m） */
  uExtC: uniform(new THREE.Vector4(0, 0, 1, 1)),
  uExtO: uniform(new THREE.Vector4(0, 0, 1, 1)),
}

/**
 * ラボの前のセットで作り直した広場（ひらき見晴らし台）: 地図の広場の石畳（地面の画像に塗ってある）を、作った台の外では芝に戻す。
 * uUnpave = 地図の広場の中心（シーンの x, z）・半径、uKeep = 作った台の中心・半径（Landscape が入れる）
 */
export const siteGroundUniforms = {
  uUnpave: uniform(new THREE.Vector4(0, 0, 0, 0)),
  uKeep: uniform(new THREE.Vector3(0, 0, 0)),
}

const groundUv = (ext: V4, plan: V2) => vec2(plan.x.sub(ext.x).div(ext.z), ext.y.sub(plan.y).div(ext.w))

/**
 * 平面座標の点の地面の色（A = 陸）と補助の値。中心の画像の中は中心、縁は全体の画像とまぜる。全体の外は端の画素。
 * 呼ぶ側の Fn の中で式を組む（前の GLSL の sampleGround。頂点のシェーダーでも使える）
 */
export function sampleGround(plan: V2) {
  const u = groundUniforms
  const uo = clamp(groundUv(u.uExtO, plan), vec2(0.0002), vec2(0.9998)).toVar()
  const g = u.uGroundO.sample(uo).toVar()
  const aux = u.uAuxO.sample(uo).toVar()
  const uc = groundUv(u.uExtC, plan).toVar()
  const e = min(uc, uc.oneMinus())
  const wc = smoothstep(0.0, 0.008, min(e.x, e.y)).toVar()
  If(wc.greaterThan(0.0), () => {
    g.assign(mix(g, u.uGroundC.sample(uc), wc))
    aux.assign(mix(aux, u.uAuxC.sample(uc), wc))
  })
  return { g, aux }
}

/**
 * sampleGround の分岐の無い形（Fn の外で式だけ組む所。草の頂点のシェーダー）。中心の画像の外では中心の画像の重みが 0 なので、同じ値になる
 */
export function sampleGroundFlat(plan: V2) {
  const u = groundUniforms
  const uo = clamp(groundUv(u.uExtO, plan), vec2(0.0002), vec2(0.9998))
  const uc = groundUv(u.uExtC, plan)
  const e = min(uc, uc.oneMinus())
  const wc = smoothstep(0.0, 0.008, min(e.x, e.y))
  return { g: mix(u.uGroundO.sample(uo), u.uGroundC.sample(uc), wc), aux: mix(u.uAuxO.sample(uo), u.uAuxC.sample(uc), wc) }
}

/** 地面の画像のテクスチャ（ImageBitmap から。sRGB の色・A は陸の印。ミップマップと異方性フィルタで遠くの斜めの地面もちらつかない） */
export function groundTexture(image: ImageBitmap, color: boolean, anisotropy: number) {
  const t = new THREE.Texture(image)
  t.flipY = false
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.anisotropy = anisotropy
  t.needsUpdate = true
  return t
}

/* -------------------------------------------------------------------------- */
/* 地面                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 地形を描かない円（シーンの x, z・半径・使うか）。ガラスの温室（ガーデンドーム）の中を作っている間、ドームの中の地形を描かない
 * （中の床・池・地下への階段の穴を、地形の面が隠さないように。interior/interiors.ts が書く）
 */
export const groundHole = uniform(new THREE.Vector4(0, 0, 0, 0))

/** 地形（頂点は標高を入れたシーンの座標、法線は高さ画像から）。色は地面の画像 */
export function createGroundMaterial() {
  const uniforms = { uTownGlow: uniform(0), uGroundDetail: uniform(200), uHole: groundHole }
  const m = markPaint(unlit('townGround'), 'light')
  // 法線は頂点のまま（ローカル。地形の物は動かさない）を補間する
  const vNormal = varying(attribute<'vec3'>('normal', 'vec3'))
  m.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    If(uniforms.uHole.w.greaterThan(0.5).and(length(wp.xz.sub(uniforms.uHole.xy)).lessThan(uniforms.uHole.z)), () => {
      Discard()
    })
    const plan = vec2(wp.x, wp.z.negate()).toVar()
    const { g, aux } = sampleGround(plan)
    const elev = wp.y.add(LAB_FLOOR)
    // 海の画素で海面より少し上に出た所は描かない（下の海の面が見える。海岸線は画像の A のなめらかな境で決まる）
    If(g.a.lessThan(0.5).and(elev.lessThan(3.5)), () => {
      Discard()
    })
    // 川・運河・池の所も描かない（地形の格子は川幅より粗いことがあるので、水面の形と岸の壁を見せる）
    If(aux.a.lessThan(0.5), () => {
      Discard()
    })
    const N = normalize(vNormal).toVar()
    const dist = length(wp.sub(cameraPosition)).toVar()
    const veg = aux.g.toVar()
    const albedo = g.rgb.toVar()
    // むら・写真の質感・凹凸は描かず、地面の画像の色と舗装の種類の色の塗り分けにする
    // 作り直した広場: 地図の広場の石畳を、作った台の外では芝に
    const sg = siteGroundUniforms
    If(sg.uUnpave.z.greaterThan(0.0), () => {
      const un = smoothstep(sg.uUnpave.z.sub(3.0), sg.uUnpave.z.add(1.0), length(wp.xz.sub(sg.uUnpave.xy)))
        .oneMinus()
        .mul(smoothstep(sg.uKeep.z, sg.uKeep.z.add(0.8), length(wp.xz.sub(sg.uKeep.xy))))
        .toVar()
      If(un.greaterThan(0.0), () => {
        albedo.assign(mix(albedo, vec3(0.072, 0.098, 0.038), un))
        veg.assign(mix(veg, 0.85, un))
        aux.assign(vec4(aux.xy, aux.z.mul(un.oneMinus()), aux.w))
      })
    })
    // むらは描かない（むらの値は一定）
    const n1 = float(1.0)
    const n2 = float(0.5)
    // 木の無い急な斜面は土と岩
    const steep = smoothstep(0.6, 0.86, N.y).oneMinus()
    albedo.assign(mix(albedo, vec3(0.12, 0.105, 0.085).mul(n2.mul(0.4).add(0.8)), steep.mul(float(0.65).sub(veg.mul(0.35)))))
    const Nd = N.toVar()
    const ao = float(1.0).toVar()
    // 近く: 舗装の所を舗装の種類の色に（縁はくっきり。暗い灰色はアスファルト、明るい・暖かい色は石畳か敷石）
    const dk = smoothstep(uniforms.uGroundDetail.mul(0.6), uniforms.uGroundDetail, dist).oneMinus().toVar()
    {
      const lumG = dot(g.rgb, LUMA).toVar()
      const warmth = g.r.sub(g.b).div(max(lumG, 0.01))
      const paved = smoothstep(0.47, 0.53, aux.b)
      const pavedC = select(lumG.lessThan(0.05), vec3(0.07, 0.07, 0.075), select(warmth.greaterThan(0.35), vec3(0.2, 0.18, 0.15), vec3(0.26, 0.25, 0.23)))
      albedo.assign(mix(albedo, mix(albedo, pavedC, 0.6), paved.mul(dk)))
    }
    const col = townLight(albedo, Nd, ao, townShadow(wp, N), 'ground').toVar()
    // 夜: 街灯が道と広場の地面を暖色に照らす。近くは灯りの表（灯りの位置と向き）で照らし、地面の画像の照り返しはうすめる
    const lampLit = townLampsEx(wp, Nd, float(0.0), float(0.0))
    const lampNear = lampUniforms.uLampInfo.w.mul(smoothstep(lampUniforms.uLampFade.x.mul(0.5), lampUniforms.uLampFade.x, dist).oneMinus())
    // 地面の画像の照り返し（2 段の光だまり）
    const glowR = smoothstep(0.42, 0.46, aux.r).mul(0.18).add(smoothstep(0.68, 0.72, aux.r).mul(0.3))
    col.addAssign(
      vec3(1.0, 0.6, 0.3)
        .mul(glowR)
        .mul(uniforms.uTownGlow)
        .mul(n1.mul(0.25).add(0.75))
        .mul(float(1.0).sub(lampNear.mul(0.75))),
    )
    col.addAssign(paintLampLight(albedo, lampLit))
    // ラボのまわり: 形のある街灯・ガラス壁からこぼれる光・ネオン
    col.addAssign(albedo.mul(siteLight(wp, Nd)))
    return outdoorHaze(col, wp)
  })()
  return withUniforms(m, uniforms)
}

/* -------------------------------------------------------------------------- */
/* 海・川・運河・池                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 水面（空を映す。太陽のきらめき・小さな波）。sea = true は海（水平線までの大きな面。陸の所は描かない）、
 * false は川・運河・池（緑がかった色、波は小さく、町の灯りの照り返し）
 */
export function createWaterMaterial(sea: boolean) {
  const uniforms = { uTownGlow: uniform(0) }
  const m = markPaint(unlit(sea ? 'townSea' : 'townWater'), 'water')
  m.colorNode = Fn(() => {
    const u = outdoorUniforms
    const wp = positionWorld.toVar()
    const plan = vec2(wp.x, wp.z.negate())
    const { g, aux } = sampleGround(plan)
    if (sea) {
      If(g.a.greaterThan(0.5), () => {
        Discard()
      })
    }
    const toCam = cameraPosition.sub(wp).toVar()
    const dist = length(toCam).toVar()
    const V = toCam.div(dist).toVar()
    // 小さな波（遠くほど細かさを落とす）
    const p = wp.xz.mul(sea ? 0.045 : 0.12).toVar()
    const amp = sea ? 1.0 : 0.45
    const fade = smoothstep(800.0, 6000.0, dist).oneMinus().mul(amp).toVar()
    const t = u.uTime
    const w1 = oNoise(p.add(vec2(t.mul(0.05), t.mul(0.03)))).toVar()
    const w2 = oNoise(p.mul(2.7).sub(vec2(t.mul(0.04), t.mul(-0.06)))).toVar()
    const N = normalize(vec3(w1.sub(0.5).mul(0.18).mul(fade).add(w2.sub(0.5).mul(0.1).mul(fade)), 1.0, w2.sub(0.5).mul(0.18).mul(fade))).toVar()
    const R = reflect(V.negate(), N).toVar()
    R.assign(vec3(R.x, abs(R.y), R.z))
    // 水の色・映り・ハイライトは外の塗りの式（paint.ts の water）。灯りの映りは渡す
    const lampNear = lampUniforms.uLampInfo.w.mul(smoothstep(lampUniforms.uLampFade.x.mul(0.5), lampUniforms.uLampFade.x, dist).oneMinus())
    const lamps = townLampsMirror(wp, R)
      .mul(w1.mul(0.5).add(0.75))
      .add(vec3(1.0, 0.62, 0.32).mul(aux.r.mul(aux.r)).mul(uniforms.uTownGlow).mul(0.9).mul(float(1.0).sub(lampNear.mul(0.85))))
    return outdoorHaze(outdoorPaint().water(N, V, wp, sea, lamps), wp)
  })()
  return withUniforms(m, uniforms)
}

/* -------------------------------------------------------------------------- */
/* 建物                                                                         */
/* -------------------------------------------------------------------------- */

/** 小物を形で描く範囲（x, y = 細かさの中心の平面座標、z = 半径 m）。外壁のシェーダーは、この中の建物のベランダの手すりを描かない（props.ts が形で描く） */
export const propsCenter = uniform(new THREE.Vector3(0, 0, 0))

/** 窓・事務所・店の点き具合（建物・形のある建物・遠くの窓明かりの点が同じ値を共有する。使う側はどの材質の uniforms.<名前> に書いてもよい） */
const windowLights = { uWindows: uniform(0), uOffice: uniform(0), uShop: uniform(0) }

const srgbToLinear = (c: V3) => pow(max(c, 0.0), vec3(2.2))

/**
 * 面の中で変わらない値（建物ごとの用途・印・種・町並みの型、面の向きの番号）は、補間しない varying（flat。三角形の最初の頂点の値）で渡す。
 * 補間すると、同じ値の頂点の間でも画素ごとに浮動小数の誤差（1e-7 ほど）が乗り、それを種にした窓の乱数（windowHash）が少しずつずれて、
 * 点いているかの境（step(wh, occ)）に近い窓だけ、点いた窓と消えた窓が画素ごとに混ざる砂嵐になった（灯町の提灯小路の店先・港の煉瓦の建物の窓。
 * アニメ塗りでも前の見た目でも出た）。値はそのまま（見た目の色・形は変わらない）
 */
const flatVarying = <T extends THREE.Node>(node: T) => varying(node).setInterpolation('flat') as unknown as T

/** 0〜255 の値の属性（buildingKit.ts の instancedBuildingMesh が浮動小数で交互に並べた iWall・iRoof・iMeta）を vec4 で読む */
const byteAttr = (name: string) => attribute<'vec4'>(name, 'vec4')

/**
 * 建物の頂点の計算（前の GLSL の BUILDING_VERTEX）。instanced のときは型（屋根の形）の頂点（aV・aK）とインスタンスの値（iPos・iDim・iExt・iWall・iRoof・iMeta）から、
 * そうでないとき（形のある建物）は頂点の値（aFac・aB・aWall・aRoof・aMeta・aTan）をそのまま使う。
 * 型の頂点: position.xz = 幅・奥行きに対する割合（-0.5〜0.5）、aV = (高さの種類, 屋根の高さの割合, 外への張り出し x, z [m])、
 * aK = (中への引っ込み x, z [短い辺の半分に対する割合], 部分, 壁の向き)。
 * 高さの種類: 0 = 基礎の下（地面の下まで）、1 = 軒、2 = 軒 + 割合 ×（棟 - 軒）、3 = 陸屋根の屋上の面（軒 - 0.75m）。
 * 部分: 0 = 壁、1 = 屋根、2 = 妻壁など（壁の色・窓なし）、3 = パラペットの上と内側（壁の色）。
 * 外壁の型・質感の層・汚れやすさ（vKind）と、小物を形で描く範囲の中か（vH.w）は 1 棟ごとにここで決める。
 * position = ローカル（= シーン。建物の物は動かさない）の位置（本体と深さだけの材質の positionNode）
 */
function buildingVertex(instanced: boolean) {
  if (instanced) {
    const aV = attribute<'vec4'>('aV', 'vec4')
    const aK = attribute<'vec4'>('aK', 'vec4')
    const iPos = attribute<'vec4'>('iPos', 'vec4')
    const iDim = attribute<'vec4'>('iDim', 'vec4')
    const iExt = attribute<'vec4'>('iExt', 'vec4')
    const iWall = byteAttr('iWall')
    const iRoof = byteAttr('iRoof')
    const iMeta = byteAttr('iMeta')
    const v = Fn(() => {
      const pos = positionGeometry
      // 重なった建物の同じ面の壁がちらつかない（深度の取り合い）ように、建物ごとに数 cm だけ大きさを変える
      const zf = fract(iMeta.z.add(iMeta.w.mul(256.0)).mul(0.6180339)).mul(0.08).add(0.02)
      const w = iDim.x.add(zf).toVar()
      const d = iDim.y.add(zf).toVar()
      // 高架の下のアーチの店は、店先をアーチの面から少し引っ込める（高架の壁と重ならないように）
      If(abs(iRoof.w.sub(7.0)).lessThan(0.5), () => {
        w.assign(iDim.x.sub(0.5))
        d.assign(iDim.y.sub(0.8))
      })
      const eave = iDim.z
      const ridge = max(iDim.w, eave)
      const m = min(w, d).mul(0.5)
      const sg = sign(pos.xz)
      const l = sg.mul(max(abs(pos.xz).mul(vec2(w, d)).add(aV.zw).sub(aK.xy.mul(m)), 0.0)).toVar()
      const mode = aV.x
      const h = select(mode.lessThan(0.5), iExt.x.add(1.5).negate(), select(mode.lessThan(1.5), eave, select(mode.lessThan(2.5), eave.add(aV.y.mul(ridge.sub(eave))), eave.sub(0.75)))).toVar()
      const c = cos(iPos.w).toVar()
      const s = sin(iPos.w).toVar()
      const p = iPos.xy.add(vec2(c.mul(l.x).sub(s.mul(l.y)), s.mul(l.x).add(c.mul(l.y))))
      return vec3(p.x, iPos.z.add(h).sub(LAB_FLOOR), p.y.negate())
    })
    const position = v()
    // 頂点で 1 回だけ計算する値（varying）
    const zf = fract(iMeta.z.add(iMeta.w.mul(256.0)).mul(0.6180339)).mul(0.08).add(0.02)
    const arch = abs(iRoof.w.sub(7.0)).lessThan(0.5)
    const w = select(arch, iDim.x.sub(0.5), iDim.x.add(zf))
    const d = select(arch, iDim.y.sub(0.8), iDim.y.add(zf))
    const eave = iDim.z
    const ridge = max(iDim.w, eave)
    const m = min(w, d).mul(0.5)
    const pos = positionGeometry
    const l = sign(pos.xz).mul(max(abs(pos.xz).mul(vec2(w, d)).add(aV.zw).sub(aK.xy.mul(m)), 0.0))
    const mode = aV.x
    const h = select(mode.lessThan(0.5), iExt.x.add(1.5).negate(), select(mode.lessThan(1.5), eave, select(mode.lessThan(2.5), eave.add(aV.y.mul(ridge.sub(eave))), eave.sub(0.75))))
    const c = cos(iPos.w)
    const s = sin(iPos.w)
    const side = aK.w
    const roofKind = iRoof.w
    const sideX = side.lessThan(1.5)
    const vFac = varying(vec4(select(sideX, l.x, l.y), h, select(sideX, w, d), side))
    const vSide = flatVarying(side)
    const eaveEff = select(roofKind.lessThan(0.5), max(eave.sub(0.9), 2.2), eave)
    const floors = max(iExt.y, 1.0)
    const vB = varying(vec4(eaveEff, floors, select(abs(side.sub(iExt.z)).lessThan(0.5), 1.0, 0.0), aK.z))
    const wallC = vec4(srgbToLinear(iWall.rgb.div(255.0)), iWall.a)
    const vWallC = varying(wallC)
    const vRoofC = varying(vec4(srgbToLinear(iRoof.rgb.div(255.0)), roofKind))
    const seed = iMeta.z.add(iMeta.w.mul(256.0)).div(65536.0)
    const meta = vec4(iMeta.x, iMeta.y, seed, iExt.w)
    const vMeta = flatVarying(meta)
    // 壁に沿った位置（vFac.x）の増える向き（シーンの座標）
    const tl = select(sideX, vec2(1.0, 0.0), vec2(0.0, 1.0))
    const vTan = varying(vec3(c.mul(tl.x).sub(s.mul(tl.y)), 0.0, s.mul(tl.x).add(c.mul(tl.y)).negate()))
    const vAxis = varying(vec2(c, s.negate()))
    const vH = varying(vec4(eave, ridge, h, select(distance(iPos.xy, propsCenter.xy).lessThan(propsCenter.z), 1.0, 0.0)))
    const type = facadeType(wallC.w, meta.x, meta.y, floors, meta.w, seed)
    const vKind = varying(vec4(type, wallLayer(wallC.w, type, seed), dirtOf(meta.w, seed), fract(seed.mul(53.3))))
    return { position, vFac, vSide, vB, vWallC, vRoofC, vMeta, vKind, vH, vTan, vAxis }
  }
  const aFac = attribute<'vec4'>('aFac', 'vec4')
  const aB = attribute<'vec4'>('aB', 'vec4')
  const aWall = attribute<'vec4'>('aWall', 'vec4')
  const aRoof = attribute<'vec4'>('aRoof', 'vec4')
  const aMeta = attribute<'vec4'>('aMeta', 'vec4')
  const aTan = attribute<'vec4'>('aTan', 'vec4')
  const wallC = vec4(srgbToLinear(aWall.rgb.div(255.0)), aWall.a)
  const floors = aB.y
  const seed = aMeta.z
  const type = facadeType(wallC.w, aMeta.x, aMeta.y, floors, aMeta.w, seed)
  return {
    position: null,
    vFac: varying(aFac),
    vSide: flatVarying(aFac.w),
    vB: varying(aB),
    vWallC: varying(wallC),
    vRoofC: varying(vec4(srgbToLinear(aRoof.rgb.div(255.0)), aRoof.a)),
    vMeta: flatVarying(aMeta),
    vKind: varying(vec4(type, wallLayer(wallC.w, type, seed), dirtOf(aMeta.w, seed), fract(seed.mul(53.3)))),
    vH: varying(vec4(aB.x, aB.x, aFac.y, 0.0)),
    vTan: varying(vec3(aTan.x, 0.0, aTan.y.negate())),
    vAxis: varying(vec2(1.0, 0.0)),
  }
}
type BuildingVaryings = ReturnType<typeof buildingVertex>

/** 建物の頂点の計算（本体と影の深さだけの材質が同じノードを使う。型 × インスタンスか形のある建物かで 1 つずつ） */
const buildingVertexCache = new Map<boolean, BuildingVaryings>()
function buildingVertexOf(instanced: boolean) {
  let v = buildingVertexCache.get(instanced)
  if (!v) buildingVertexCache.set(instanced, (v = buildingVertex(instanced)))
  return v
}

/** x が [a, b] の中なら 1（縁は fw の幅でなめらかに） */
const fl = (x: F | number): F => (typeof x === 'number' ? float(x) : x)
const band = (x: F, a: F | number, b: F | number, fw: F) => smoothstep(fl(a).sub(fw), fl(a).add(fw), x).sub(smoothstep(fl(b).sub(fw), fl(b).add(fw), x))
/** 長方形 [o0, o1] の中なら 1 */
const rect = (p: V2, o0: V2, o1: V2, fw: V2) => {
  const a = smoothstep(o0.sub(fw), o0.add(fw), p).sub(smoothstep(o1.sub(fw), o1.add(fw), p))
  return a.x.mul(a.y)
}
/** データの色 × 質感（hue = 質感の色合いを残す割合） */
const tintDetail = (base: V3, det: V3, hue: F | number) => base.mul(mix(vec3(dot(det, LUMA)), det, hue))

interface Surf {
  albedo: V3
  n: V3
  ao: F
  glass: F
  glassCol: V3
  emit: V3
  spec: F
  over: F
  overCol: V3
}

interface BuildingCtx {
  v: BuildingVaryings
  wp: V3
  uInterior: F
  wl: typeof windowLights
}

/** 壁の画素（前の GLSL の wallSurface。呼ぶ側の Fn の中で式を組む） */
function wallSurface(s: Surf, V: V3, dist: F, part: F, ctx: BuildingCtx) {
  const { vFac, vB, vMeta, vKind, vH, vTan, vAxis } = ctx.v
  const wl = ctx.wl
  const u0 = outdoorUniforms
  // 壁の幅（0 で割らないように）
  const span = max(vFac.z, 0.01).toVar()
  const N = s.n.toVar()
  const U = vec3(0.0, 1.0, 0.0)
  // 壁に沿った向き（見て右）。水平の面（パラペットの上など）は建物の軸
  const T = select(abs(N.y).greaterThan(0.9), vec3(vAxis.x, 0.0, vAxis.y), normalize(cross(U, N))).toVar()
  const u = vFac.x.add(span.mul(0.5)).toVar()
  If(dot(vTan, T).lessThan(0.0), () => {
    u.assign(span.sub(u))
  })
  const v = vFac.y.toVar()
  const type = vKind.x.toVar()
  const layer = vKind.y.toVar()
  const use = vMeta.x.toVar()
  const flags = vMeta.y.toVar()
  const seed = vMeta.z.toVar()
  const style = vMeta.w.toVar()
  const nearProps = vH.w.greaterThan(0.5)
  const fwM = max(fwidth(vec2(u, v)), vec2(1e-4)).toVar()
  const px = max(fwM.x, fwM.y).toVar()

  // 外壁の色（質感の写真・汚れ・窓の奥の部屋とカーテン・映り込みは描かない。窓の格子・枠・帯・看板は形のまま）
  const det = vec3(1.0).toVar()
  const tn = vec3(0.0, 0.0, 1.0).toVar()
  const hue = select(near(layer, 3.0), 0.3, select(near(layer, 2.0).or(near(layer, 0.0)), 0.25, 0.0))
  const base = s.albedo.toVar()
  const albedo = tintDetail(base, det, hue).toVar()
  const nk = smoothstep(30.0, 160.0, dist).oneMinus()
  const tnw = vec3(tn.xy.mul(nk).mul(0.9), 1.0).toVar()
  const ao = float(1.0).toVar()

  const floorsN = max(vB.y, 1.0).toVar()
  const floorH = max(vB.x.div(floorsN), 0.6).toVar()
  const front = vB.z.greaterThan(0.5).toVar()
  const shop = hasFlag(flags, 16.0).toVar()
  // 細かい模様（カーテンのひだ・ブラインド・看板の文字）は、画素が粗くなる前に消す（ちらつかない）
  const fine = smoothstep(0.012, 0.035, px).oneMinus().toVar()

  // 窓の格子
  const nb = max(1.0, floor(span.div(bayTarget(type)).add(0.5))).toVar()
  const bayW = span.div(nb).toVar()
  const cu = u.div(bayW).toVar()
  const cv = v.sub(0.15).div(floorH).toVar()
  const bi = floor(cu).toVar()
  const fi = floor(cv).toVar()
  const cell = vec2(fract(cu).mul(bayW), fract(cv).mul(floorH)).toVar()
  const inside = step(0.0, cv).mul(step(cv, floorsN.sub(0.02))).mul(step(0.3, bayW)).mul(select(part.lessThan(0.5), 1.0, 0.0)).toVar()

  // 窓の形（型ごと）: 幅の割合・下端と上端（階の高さに対する割合）・見込み・枠
  const wr = float(0.5).toVar()
  const hs = float(0.3).toVar()
  const he = float(0.8).toVar()
  const reveal = float(0.14).toVar()
  const frameW = float(0.05).toVar()
  const frameC = vec3(0.55, 0.56, 0.57).toVar()
  const arch = float(0.0).toVar()
  const muntin = float(0.0).toVar()
  const office = float(0.0).toVar()
  const roomD = float(4.0).toVar()
  If(type.lessThan(0.5), () => {
    wr.assign(0.52)
    hs.assign(0.3)
    he.assign(0.78)
    reveal.assign(0.08)
    frameC.assign(vec3(0.6, 0.6, 0.6))
  })
    .ElseIf(type.lessThan(1.5), () => {
      wr.assign(0.5)
      hs.assign(0.3)
      he.assign(0.78)
      reveal.assign(0.1)
    })
    .ElseIf(type.lessThan(3.5), () => {
      wr.assign(0.4)
      hs.assign(0.2)
      he.assign(0.8)
      reveal.assign(0.24)
      frameC.assign(vec3(0.75, 0.73, 0.68))
      arch.assign(step(0.45, fract(seed.mul(5.1))).add(select(near(style, 2.0), 1.0, 0.0)))
      muntin.assign(1.0)
    })
    .ElseIf(type.lessThan(4.5), () => {
      wr.assign(0.44)
      hs.assign(0.2)
      he.assign(0.8)
      reveal.assign(0.28)
      frameC.assign(vec3(0.2, 0.2, 0.2))
      muntin.assign(1.0)
    })
    .ElseIf(type.lessThan(5.5), () => {
      wr.assign(0.8)
      hs.assign(0.04)
      he.assign(0.86)
      reveal.assign(0.1)
    })
    .ElseIf(type.lessThan(6.5), () => {
      wr.assign(0.96)
      hs.assign(0.36)
      he.assign(0.94)
      reveal.assign(0.12)
      office.assign(1.0)
      roomD.assign(7.0)
      frameC.assign(vec3(0.35, 0.37, 0.4))
    })
    .ElseIf(type.lessThan(7.5), () => {
      wr.assign(1.0)
      hs.assign(0.2)
      he.assign(1.0)
      reveal.assign(0.04)
      office.assign(1.0)
      roomD.assign(8.0)
      frameW.assign(0.04)
      frameC.assign(vec3(0.3, 0.32, 0.35))
    })
    .ElseIf(type.lessThan(8.5), () => {
      wr.assign(0.82)
      hs.assign(0.72)
      he.assign(0.9)
      reveal.assign(0.06)
      office.assign(1.0)
      roomD.assign(12.0)
    })
    .Else(() => {
      wr.assign(0.92)
      hs.assign(0.3)
      he.assign(0.92)
      reveal.assign(0.12)
      office.assign(1.0)
      roomD.assign(7.0)
    })
  // 工場は最上階の高い窓だけ
  If(type.greaterThan(7.5).and(type.lessThan(8.5)).and(fi.lessThan(floorsN.sub(1.5))), () => {
    inside.assign(0.0)
  })

  const shopFront = shop.and(front).and(fi.lessThan(0.5)).and(inside.greaterThan(0.5)).and(type.lessThan(7.5)).toVar()
  If(shopFront, () => {
    wr.assign(0.88)
    hs.assign(0.04)
    he.assign(0.74)
    reveal.assign(0.12)
    office.assign(1.0)
    roomD.assign(6.0)
    frameC.assign(vec3(0.25, 0.25, 0.26))
    arch.assign(0.0)
    muntin.assign(0.0)
  })

  const W = min(wr.mul(bayW), select(type.lessThan(1.5), 2.6, 99.0)).toVar()
  const o0 = vec2(bayW.sub(W).mul(0.5), hs.mul(floorH)).toVar()
  const o1 = vec2(bayW.add(W).mul(0.5), he.mul(floorH)).toVar()
  const wp = cell.sub(o0).toVar()
  const wsz = o1.sub(o0).toVar()
  const open = rect(cell, o0, o1, fwM).mul(inside).toVar()
  // アーチの窓（上端を半円に）
  If(arch.greaterThan(0.5).and(open.greaterThan(0.0)), () => {
    const r0 = wsz.x.mul(0.5).toVar()
    const q = wp.sub(vec2(r0, wsz.y.sub(r0))).toVar()
    If(q.y.greaterThan(0.0), () => {
      open.mulAssign(smoothstep(r0.sub(fwM.x), r0.add(fwM.x), length(q)).oneMinus())
    })
  })

  const wh = windowHash(bi, fi, ctx.v.vSide, seed).toVar()
  const occ = occupancy(use, flags, fi, front, type, wl.uWindows, wl.uOffice, wl.uShop).toVar()
  const tiny = smoothstep(0.05, 0.16, px).toVar()
  const lit = mix(step(wh, occ), occ, tiny).toVar()
  const warm = oHash(vec2(bi.mul(1.7).add(seed.mul(19.0)), fi.mul(2.3).add(0.5)))
  const lamp = mix(vec3(1.0, 0.68, 0.38), vec3(1.0, 0.86, 0.64), warm).toVar()
  If(office.greaterThan(0.5).and(shopFront.not()), () => {
    lamp.assign(mix(lamp, vec3(0.95, 0.95, 0.92), 0.6))
  })
  const bright = oHash(vec2(fi.mul(3.1).add(seed.mul(7.0)), bi.mul(1.3)))
    .mul(0.5)
    .add(0.55)
    .mul(select(shopFront, 1.8, 1.0))
    .toVar()

  // --- 外壁の帯・装飾（窓の外側）---
  const lev = fract(cv).toVar()
  If(inside.greaterThan(0.5).or(part.lessThan(0.5)), () => {
    If(type.lessThan(1.5).and(part.lessThan(0.5)), () => {
      // 木造・モルタルの家: 雨戸の戸袋（窓の横の箱）と、足元の水切り
      const sideB = step(0.5, fract(seed.mul(3.3).add(bi.mul(0.37))))
      const b0 = select(sideB.greaterThan(0.5), vec2(o1.x.add(0.02), o0.y.sub(0.05)), vec2(o0.x.sub(0.42), o0.y.sub(0.05))).toVar()
      const box = rect(cell, b0, b0.add(vec2(0.4, wsz.y.add(0.2))), fwM)
        .mul(inside)
        .mul(step(0.45, fract(seed.mul(11.0).add(fi.mul(0.3)))))
        .toVar()
      albedo.assign(mix(albedo, vec3(0.32, 0.31, 0.29).mul(select(type.lessThan(0.5), 0.7, 1.0)), box))
      ao.mulAssign(float(1.0).sub(box.mul(0.15)))
      const sill = band(v, 0.22, 0.32, fwM.y)
      albedo.assign(mix(albedo, vec3(0.12, 0.12, 0.12), sill))
    })
      .ElseIf(type.greaterThan(2.5).and(type.lessThan(4.5)), () => {
        // 煉瓦・石造: 窓台と楣（石の帯）、階ごとの帯（上の縁が明るく、下に陰）
        const sillB = rect(cell, vec2(o0.x.sub(0.1), o0.y.sub(0.12)), vec2(o1.x.add(0.1), o0.y), fwM).mul(inside).toVar()
        const lintel = rect(cell, vec2(o0.x.sub(0.1), o1.y), vec2(o1.x.add(0.1), o1.y.add(0.22)), fwM)
          .mul(inside)
          .mul(select(arch.greaterThan(0.5), 0.0, 1.0))
          .toVar()
        If(arch.greaterThan(0.5), () => {
          const r0 = wsz.x.mul(0.5).toVar()
          const q = wp.sub(vec2(r0, wsz.y.sub(r0))).toVar()
          const rr = length(q)
          lintel.assign(step(0.0, q.y).mul(band(rr, r0, r0.add(0.22), fwM.x)).mul(inside))
          const key = rect(wp, vec2(r0.sub(0.1), wsz.y), vec2(r0.add(0.1), wsz.y.add(0.26)), fwM).mul(inside)
          lintel.assign(max(lintel, key))
        })
        const stoneC = mix(base, vec3(0.66, 0.6, 0.5), select(near(type, 3.0), 0.85, 0.35))
          .mul(det.r.mul(0.2).add(0.9))
          .toVar()
        albedo.assign(mix(albedo, stoneC, max(sillB, lintel)))
        tnw.addAssign(vec3(0.0, sillB.mul(0.6), 0.0))
        const course = band(lev, 0.0, float(0.16).div(floorH), fwM.y.div(floorH)).mul(step(0.5, fi)).mul(inside).toVar()
        albedo.assign(mix(albedo, stoneC, course))
        tnw.addAssign(vec3(0.0, course.mul(0.35), 0.0))
        ao.mulAssign(float(1.0).sub(band(lev, -0.04, 0.0, float(0.02)).mul(0.25).mul(step(0.5, fi))))
        If(near(type, 4.0).and(fi.lessThan(0.5)).and(part.lessThan(0.5)), () => {
          // 石造の 1 階の目地（横の溝）
          const g = smoothstep(0.86, 0.96, fract(v.div(0.48))).toVar()
          ao.mulAssign(float(1.0).sub(g.mul(0.35).mul(open.oneMinus())))
          tnw.subAssign(vec3(0.0, g.mul(0.5), 0.0))
        })
        // 窓まわりの石の額縁（石造）
        If(near(type, 4.0), () => {
          const surround = rect(cell, o0.sub(vec2(0.16, 0.12)), o1.add(vec2(0.16, 0.0)), fwM).sub(rect(cell, o0, o1, fwM)).mul(inside)
          albedo.assign(mix(albedo, stoneC.mul(1.08), surround))
        })
      })
      .ElseIf(type.greaterThan(4.5).and(type.lessThan(5.5)).and(front).and(fi.greaterThan(0.5)), () => {
        // 集合住宅の正面: 各階のベランダ（床の縁・手すり・上の床の下の陰）と、2 間ごとの仕切り。近くは小物の形（props.ts）で描くので、ここは陰だけ
        const slabH = float(0.2).div(floorH).toVar()
        const railH = float(1.1).div(floorH).toVar()
        const under = smoothstep(float(1.0).sub(float(0.6).div(floorH)), 1.0, lev).oneMinus()
        ao.mulAssign(mix(0.62, 1.0, under))
        If(nearProps.not(), () => {
          const fwy = fwM.y.div(floorH).toVar()
          const slab = band(lev, -0.01, slabH, fwy).toVar()
          const rail = band(lev, slabH, slabH.add(railH), fwy)
          const kind = fract(seed.mul(23.0)).toVar()
          const slabC = mix(base, vec3(0.7, 0.7, 0.68), 0.6)
          const railC = select(kind.lessThan(0.4), vec3(0.5, 0.55, 0.58), select(kind.lessThan(0.75), mix(base, vec3(0.72), 0.3), vec3(0.18, 0.19, 0.2)))
          const bars = select(kind.greaterThan(0.75), smoothstep(0.35, 0.5, abs(fract(u.div(0.12)).sub(0.5))).mul(fine), 0.0)
          albedo.assign(mix(albedo, slabC, slab))
          tnw.addAssign(vec3(0.0, slab.mul(0.3), 0.0))
          // 手すりの上の布団・植木（たまに）
          const futon = step(0.92, oHash(vec2(bi.mul(3.7).add(seed.mul(13.0)), fi)))
            .mul(band(lev, slabH.add(railH.mul(0.45)), slabH.add(railH.mul(1.05)), fwy))
            .mul(band(fract(cu), 0.2, 0.7, fwM.x.div(bayW)))
            .toVar()
          const futonC = mix(vec3(0.75, 0.72, 0.65), vec3(0.5, 0.6, 0.75), step(0.5, fract(seed.mul(41.0).add(bi))))
          // 手すり（と布団）は窓の前に重ねる
          const railMask = rail.mul(bars.oneMinus())
          s.over.assign(max(railMask, futon))
          s.overCol.assign(mix(railC, futonC, futon))
        })
        const bw2 = bayW.mul(2.0)
        const wall = band(fract(u.div(bw2)), 0.0, 0.04, fwM.x.div(bw2))
        albedo.assign(mix(albedo, base.mul(1.1), wall))
      })
      .ElseIf(type.greaterThan(5.5).and(type.lessThan(6.5)), () => {
        // 事務所: 腰壁（パネル）と、縦の柱形（明るい帯）
        const fwb = fwM.x.div(bayW).toVar()
        const fc = fract(cu).toVar()
        const fin = band(fc, 0.0, 0.06, fwb).add(band(fc, 0.94, 1.0, fwb))
        albedo.assign(mix(albedo, base.mul(1.15), fin.mul(inside)))
        tnw.addAssign(vec3(band(fc, 0.0, 0.03, fwb).sub(band(fc, 0.97, 1.0, fwb)).mul(0.6), 0.0, 0.0))
        const spandrel = band(lev, 0.0, hs, fwM.y.div(floorH)).mul(inside)
        albedo.assign(mix(albedo, base.mul(vec3(0.92, 0.94, 0.97)), spandrel.mul(0.5)))
      })
      .ElseIf(type.greaterThan(6.5).and(type.lessThan(7.5)), () => {
        // カーテンウォール: 腰のガラス（不透明の濃い色）
        const spandrel = band(lev, 0.0, hs, fwM.y.div(floorH)).mul(inside).toVar()
        albedo.assign(mix(albedo, vec3(0.05, 0.07, 0.09), spandrel))
        s.spec.assign(spandrel)
      })
      .ElseIf(type.greaterThan(7.5).and(type.lessThan(8.5)).and(front).and(part.lessThan(0.5)), () => {
        // 工場・倉庫の正面: シャッター（横の筋の金属の板）
        const n = max(1.0, floor(span.div(9.0))).toVar()
        const pitch = span.div(n).toVar()
        const fu2 = fract(u.div(pitch))
        const sh = band(fu2, 0.25, 0.75, fwM.x.div(pitch)).mul(band(v, -0.2, min(4.6, vB.x.mul(0.72)), fwM.y)).toVar()
        const ribs = smoothstep(0.3, 0.7, abs(fract(v.div(0.11)).sub(0.5)).mul(2.0)).mul(0.15).add(0.85)
        albedo.assign(mix(albedo, vec3(0.42, 0.43, 0.42).mul(ribs).mul(mix(1.0, det.g, 0.3)), sh))
        tnw.addAssign(vec3(0.0, sh.mul(smoothstep(0.4, 0.6, fract(v.div(0.11))).sub(0.5)).mul(0.4), 0.0))
        ao.mulAssign(float(1.0).sub(sh.mul(0.2)))
      })
      .ElseIf(type.greaterThan(8.5).and(front).and(fi.greaterThan(0.5)), () => {
        // 学校の正面: 廊下のベランダ（白い手すり壁）
        const under = smoothstep(float(1.0).sub(float(0.5).div(floorH)), 1.0, lev).oneMinus()
        ao.mulAssign(mix(0.6, 1.0, under))
        If(nearProps.not(), () => {
          const rail = band(lev, 0.0, float(1.15).div(floorH), fwM.y.div(floorH))
          s.over.assign(rail)
          s.overCol.assign(mix(base, vec3(0.78, 0.78, 0.76), 0.5))
        })
      })
  })

  // 店先: 看板の帯（ひさしの上）。夜は看板が光る
  If(shopFront, () => {
    const fwy = fwM.y.div(floorH).toVar()
    const signB = band(lev, 0.8, 0.97, fwy).toVar()
    const pal = fract(seed.mul(61.0).add(bi.mul(0.13))).toVar()
    const signC = select(
      pal.lessThan(0.2),
      vec3(0.45, 0.08, 0.06),
      select(pal.lessThan(0.4), vec3(0.08, 0.2, 0.12), select(pal.lessThan(0.6), vec3(0.06, 0.1, 0.25), select(pal.lessThan(0.8), vec3(0.7, 0.66, 0.58), vec3(0.12, 0.11, 0.1)))),
    ).toVar()
    const letterC = select(pal.greaterThan(0.6).and(pal.lessThan(0.8)), vec3(0.1), vec3(0.85, 0.82, 0.72)).toVar()
    {
      // 文字は画を組んだ形（glyph.ts）で、言葉ごとに間を空けて看板の真ん中に並べる。夜は板と文字を分けて光らせる
      // （前は升ごとの白い四角の点で、板の光も文字の上に足していたので、白い四角の並びに見えた）
      const ch = float(0.09).mul(floorH).toVar()
      const cx = u.div(ch.mul(0.95)).toVar()
      const ci = floor(cx).toVar()
      // 3 文字と 1 文字の間を 1 組に（組ごとに、たまに文字の無い組）
      const word = step(0.22, oHash(vec2(floor(ci.div(4.0)).add(seed.mul(9.0)), bi.add(3.0))))
      const space = step(2.5, ci.sub(floor(ci.div(4.0)).mul(4.0))).oneMinus()
      // 文字の画は升の 1 割強の太さなので、消し始めを細かい模様（fine）より遠くに
      const letters = smoothstep(0.03, 0.07, px)
        .oneMinus()
        .mul(glyph(fract(cx), lev.sub(0.84).div(0.09), oHash(vec2(ci, seed.mul(5.0).add(bi))), max(fwM.x.div(ch.mul(0.95)), fwy.div(0.09))))
        .mul(band(lev, 0.84, 0.93, fwy))
        .mul(band(fract(cu), 0.16, 0.84, fwM.x.div(bayW)))
        .mul(word)
        .mul(space)
        .toVar()
      albedo.assign(mix(albedo, mix(signC, letterC, letters), signB))
      s.emit.addAssign(mix(signC.mul(1.6), letterC.mul(select(pal.greaterThan(0.6).and(pal.lessThan(0.8)), 0.4, 1.7)), letters).mul(signB).mul(wl.uShop).mul(0.9))
    }
    ao.mulAssign(float(1.0).sub(band(lev, 0.74, 0.8, fwy).mul(0.3)))
  })

  // 環境光の遮り: 通りの底ほど暗い（向かいの建物で空が狭い）・軒の下
  ao.mulAssign(mix(0.58, 1.0, smoothstep(-0.5, 6.0, v)))
  If(ctx.v.vRoofC.w.greaterThan(0.5).and(part.lessThan(0.5)), () => {
    ao.mulAssign(float(1.0).sub(smoothstep(0.0, 0.9, vH.x.sub(v)).oneMinus().mul(0.3)))
  })

  s.albedo.assign(albedo)
  s.ao.assign(ao)
  s.n.assign(normalize(T.mul(tnw.x).add(U.mul(tnw.y)).add(N.mul(tnw.z))))

  {
    // --- 窓: ガラスの色は外の塗りの window。窓枠・召し合わせ・格子・店のガラスの割りと、閉めた雨戸は形のまま ---
    const paintWindow = outdoorPaint().window
    If(open.greaterThan(0.001), () => {
      const closed = select(type.lessThan(1.5), step(fract(wh.mul(13.7)), u0.uNight.mul(0.3).mul(lit.oneMinus()).add(0.08)), 0.0).toVar()
      const cellUv = clamp(wp.div(max(wsz, vec2(0.01))), 0.0, 1.0)
      const glassCol = paintWindow(lit, lamp.mul(bright), N, V, cellUv, select(shopFront, 1.0, 0.0)).toVar()
      const fr = rect(wp, vec2(frameW), wsz.sub(frameW), fwM).oneMinus()
      const mid = select(office.greaterThan(0.5).and(type.greaterThan(6.5)), 0.0, band(wp.x, wsz.x.mul(0.5).sub(0.03), wsz.x.mul(0.5).add(0.03), fwM.x)).toVar()
      If(muntin.greaterThan(0.5), () => {
        mid.assign(max(mid, band(fract(wp.y.div(wsz.y.div(3.0))), 0.0, float(0.09).div(wsz.y), fwM.y.div(wsz.y))))
      })
      If(shopFront, () => {
        mid.assign(band(fract(wp.x.div(max(1.0, wsz.x.div(3.0)))), 0.0, 0.04, fwM.x))
      })
      const frame = max(fr, mid).mul(tiny.oneMinus())
      glassCol.assign(mix(glassCol, townLight(frameC, N, float(1.0), townShadow(ctx.wp, N), 'frame'), frame))
      If(closed.greaterThan(0.5), () => {
        glassCol.assign(townLight(vec3(0.38, 0.38, 0.37), N, float(0.9), townShadow(ctx.wp, N), 'frame'))
      })
      const area = wsz.x.mul(wsz.y).div(bayW.mul(floorH)).mul(inside)
      s.glass.assign(max(s.glass, mix(open, area, tiny)))
      s.glassCol.assign(glassCol)
    })
  }
}

/** 屋根の画素（瓦・スレート・金属・陸屋根のコンクリートと屋上緑化。前の GLSL の roofSurface） */
function roofSurface(s: Surf, ctx: BuildingCtx) {
  const { vMeta, vRoofC, vH } = ctx.v
  const N = s.n.toVar()
  const seed = vMeta.z.toVar()
  const style = vMeta.w.toVar()
  const flags = vMeta.y.toVar()
  const flatR = abs(N.y).greaterThan(0.985).toVar()
  const layer = float(4.0).toVar()
  If(flatR.not(), () => {
    const r = fract(seed.mul(17.9)).toVar()
    const tinRoof = near(style, 6.0)
      .or(hasFlag(flags, 32.0))
      .or(near(vRoofC.w, 5.0))
      .or(near(vRoofC.w, 4.0).and(r.lessThan(0.6)))
    If(tinRoof.or(r.lessThan(0.12)), () => {
      layer.assign(5.0)
    })
      .ElseIf(near(style, 1.0).or(near(style, 7.0)).or(near(style, 5.0).and(r.lessThan(0.65))).or(near(vRoofC.w, 6.0)), () => {
        layer.assign(7.0)
      })
      .Else(() => {
        layer.assign(8.0)
      })
  })
  const base = s.albedo.toVar()
  // 平らな色（質感・むら・汚れは描かない）。棟の帯・屋上緑化は平らな色で
  const albedo = base.mul(select(layer.greaterThan(4.5).and(layer.lessThan(5.5)), 0.95, 1.0)).toVar()
  If(flatR.not(), () => {
    const tr = vH.z.sub(vH.x).div(max(vH.y.sub(vH.x), 0.01)).toVar()
    const fwT = fwidth(tr).toVar()
    const ridgeB = smoothstep(float(0.965).sub(fwT), float(0.985).add(fwT), tr).mul(step(vH.x.add(0.5), vH.y))
    albedo.assign(mix(albedo, albedo.mul(0.7), ridgeB))
  }).ElseIf(hasFlag(flags, 4.0), () => {
    albedo.assign(mix(albedo, vec3(0.07, 0.11, 0.04), 0.75))
  })
  s.albedo.assign(albedo)
}

/** 建物のシェーダー（instanced = 型 × インスタンス、false = 形のある建物） */
export function createTownBuildingMaterial(instanced: boolean) {
  const uniforms = { ...windowLights, uLightGain: uniform(1), uInterior: uniform(1), uPropsCenter: propsCenter }
  const m = markPaint(unlit(instanced ? 'townBuildings' : 'townCustomBuildings'), 'light')
  const v = buildingVertexOf(instanced)
  if (v.position) m.positionNode = v.position
  // 位置は頂点で 1 回（シーンの座標。形のある建物は物の行列を掛けた位置）
  const vWorld = varying(v.position ?? positionWorld)
  m.colorNode = Fn(() => {
    const u = outdoorUniforms
    const wp = vWorld.toVar()
    const ctx: BuildingCtx = { v, wp, uInterior: uniforms.uInterior, wl: windowLights }
    // 面の向きは画面の微分から。細い三角形の縁などで 0 の長さになったら（normalize(0) は NaN）上向きにする
    const cN = cross(dFdx(wp), dFdy(wp)).toVar()
    const cl = dot(cN, cN).toVar()
    const N = select(cl.greaterThan(1e-24), cN.mul(inverseSqrt(max(cl, 1e-30))), vec3(0.0, 1.0, 0.0)).toVar()
    const toCam = cameraPosition.sub(wp).toVar()
    const dist = length(toCam).toVar()
    const V = toCam.div(dist).toVar()
    If(dot(N, V).lessThan(0.0), () => {
      N.assign(N.negate())
    })
    const part = v.vB.w.toVar()
    const isRoof = part.greaterThan(0.5).and(part.lessThan(1.5)).toVar()
    const seed = v.vMeta.z.toVar()
    const albedo = select(isRoof, v.vRoofC.rgb, v.vWallC.rgb).toVar()
    // データの色は「色の名前」の鮮やかな値なので、実際の外壁・屋根の明るさと彩度に寄せる（屋根は少しくすませ、白い壁は眩しすぎないように）
    const lum = dot(albedo, LUMA).toVar()
    albedo.assign(select(isRoof, mix(vec3(lum), albedo, 0.68).mul(0.72), mix(vec3(lum), min(albedo, vec3(0.62)), 0.8).mul(0.92)))
    // 建物ごとの色のばらつき（色相も少し。隣同士が同じにならないように）
    const v1 = fract(seed.mul(13.7))
    const v2 = fract(seed.mul(29.3))
    albedo.mulAssign(v1.mul(0.3).add(0.84).mul(mix(vec3(1.0), vec3(1.06, 1.0, 0.92), v2.sub(0.3))))
    // 明るい外壁は、生成り・ベージュ・薄い灰色・薄茶のタイル・淡い桃色などにばらつかせる（白い箱の集まりに見えないように）
    If(isRoof.not().and(lum.greaterThan(0.25)), () => {
      const pick = fract(seed.mul(71.3)).toVar()
      const tone = select(
        pick.lessThan(0.22),
        vec3(1.04, 0.98, 0.86),
        select(
          pick.lessThan(0.4),
          vec3(0.94, 0.84, 0.7),
          select(pick.lessThan(0.58), vec3(0.9, 0.93, 0.97), select(pick.lessThan(0.72), vec3(1.0, 0.95, 0.9), select(pick.lessThan(0.82), vec3(1.04, 0.92, 0.88), select(pick.lessThan(0.92), vec3(0.72, 0.62, 0.52), vec3(0.8, 0.82, 0.8))))),
        ),
      )
      albedo.mulAssign(mix(vec3(1.0), tone, 0.75))
    })
    const s: Surf = {
      albedo: albedo,
      n: N.toVar(),
      ao: float(1.0).toVar(),
      glass: float(0.0).toVar(),
      glassCol: vec3(0.0).toVar(),
      emit: vec3(0.0).toVar(),
      spec: float(0.0).toVar(),
      over: float(0.0).toVar(),
      overCol: vec3(0.0).toVar(),
    }
    If(isRoof.not(), () => {
      wallSurface(s, V, dist, part, ctx)
    }).Else(() => {
      roofSurface(s, ctx)
    })
    const sh = townShadow(wp, N).toVar()
    // 外の塗り（paint.ts）の light には、屋根か外壁かを渡す（照り返し・映り込みは描かない）
    const col = select(isRoof, townLight(s.albedo, s.n, s.ao, sh, 'roof'), townLight(s.albedo, s.n, s.ao, sh, 'wall')).toVar()
    // 夜: 街灯・店先の灯りが壁を照らす（灯りの表。近くだけ）
    col.addAssign(paintLampLight(s.albedo, townLamps(wp, s.n)).mul(s.ao))
    col.assign(mix(col, s.glassCol, s.glass))
    col.assign(mix(col, townLight(s.overCol, N, s.ao, sh, 'prop'), s.over))
    col.assign(outdoorHaze(col, wp))
    col.addAssign(paintEmit(s.emit.mul(uniforms.uLightGain)).mul(exp(dist.negate().div(u.uHazeDist.mul(1.5)))))
    return col
  })()
  return withUniforms(m, uniforms)
}

/** 建物の影の深さだけの材質（頂点の計算は建物と同じ positionNode） */
export function createTownBuildingDepthMaterial(instanced: boolean) {
  return depthMaterial({ positionNode: buildingVertexOf(instanced).position })
}

/* -------------------------------------------------------------------------- */
/* 遠くの窓明かり（光の点）                                                        */
/* -------------------------------------------------------------------------- */

/** 1 棟あたりの点の数（壁 4 面 × 2 × 2） */
const SPRITES_PER_BUILDING = 16
/** 建物のインスタンスの値の画像の幅（画素。1 棟 = 6 画素: iPos・iDim・iExt・iWall・iRoof・iMeta） */
const INSTANCE_TEX_W = 4096
const INSTANCE_FIELDS = ['iPos', 'iDim', 'iExt', 'iWall', 'iRoof', 'iMeta'] as const

/** 点の頂点 aP = (壁の向き, 壁に沿った割合, 高さの割合, 順番)。順番は、小さい建物でも 4 面に散るように並べる（前の windowSpriteGeometry の aP） */
const SPRITE_SLOTS = Array.from({ length: SPRITES_PER_BUILDING }, (_, k) => new THREE.Vector4(k % 4, [0.3, 0.7, 0.15, 0.85][Math.floor(k / 4)]!, [0.35, 0.75, 0.9, 0.15][Math.floor(k / 4)]!, k))

/** 建物のインスタンスの値を、浮動小数の画像に並べる（1 棟 = 横に 6 画素。点の頂点のシェーダーが load で読む） */
function instanceTexture(all: InstanceSet) {
  const n = Math.max(1, all.count)
  const texels = n * INSTANCE_FIELDS.length
  const h = Math.max(1, Math.ceil(texels / INSTANCE_TEX_W))
  const data = new Float32Array(INSTANCE_TEX_W * h * 4)
  for (let i = 0; i < all.count; i++) {
    INSTANCE_FIELDS.forEach((name, f) => {
      const a = all.attrs[name]!.array
      const o = (i * INSTANCE_FIELDS.length + f) * 4
      for (let c = 0; c < 4; c++) data[o + c] = a[i * 4 + c]!
    })
  }
  const t = new THREE.DataTexture(data, INSTANCE_TEX_W, h, THREE.RGBAFormat, THREE.FloatType)
  t.minFilter = THREE.NearestFilter
  t.magFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

/**
 * 遠くの建物の窓明かりを光の点でも描く（夜の町の灯りのきらめき。近くは建物のシェーダーの窓で足りるので、遠いほど出す）。
 * 建物のインスタンスの値をそのまま使い、点 aP = (壁の向き, 壁に沿った割合, 高さの割合, 順番) を、いちばん近い窓の中心へ寄せる。
 * 点くかどうかは建物のシェーダーと同じ決め方（facades.ts の facadeType・occupancy・windowHash）。
 *
 * WebGPU の点は 1px なので、Sprite（PointsNodeMaterial）を 1 棟 16 個（count = 棟の数 × 16）並べる。番号 instanceIndex の点は
 * instanceIndex / 16 番目の建物の、instanceIndex % 16 番目の点。建物の値は浮動小数の画像（instanceTexture）から読む。
 * 大きさは描画の画素（sizeNode は CSS の px で、three が画素の比を掛けるので uPixelRatio で割る）
 */
export function createWindowSprites(all: InstanceSet) {
  const uniforms = { ...windowLights, uLightGain: uniform(1), uPx: uniform(500), uPixelRatio: uniform(1), uTime: sharedTime, uHazeDist: outdoorUniforms.uHazeDist }
  const u = uniforms
  const data = texture(instanceTexture(all))
  const slots = uniformArray(SPRITE_SLOTS, 'vec4')
  const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false })
  m.name = 'townWindowSprites'
  markPaint(m, 'glow')

  const idx = int(instanceIndex)
  const b = idx.div(SPRITES_PER_BUILDING).toVar()
  const k = idx.sub(b.mul(SPRITES_PER_BUILDING))
  const aP = slots.element(k) as unknown as V4
  const field = (f: number) => {
    const t = b.mul(INSTANCE_FIELDS.length).add(f)
    const row = t.div(INSTANCE_TEX_W)
    return data.load(ivec2(t.sub(row.mul(INSTANCE_TEX_W)), row))
  }
  const iPos = field(0)
  const iDim = field(1)
  const iExt = field(2)
  const iWall = field(3)
  const iRoof = field(4)
  const iMeta = field(5)

  const w = iDim.x
  const d = iDim.y
  const eave = iDim.z
  const roofKind = iRoof.w
  const eaveEff = select(roofKind.lessThan(0.5), max(eave.sub(0.9), 2.2), eave)
  const floorsN = max(iExt.y, 1.0)
  const floorH = eaveEff.div(floorsN)
  const side = aP.x
  const span = select(side.lessThan(1.5), w, d)
  const facade = iWall.w
  const use = iMeta.x
  const flags = iMeta.y
  const seed = iMeta.z.add(iMeta.w.mul(256.0)).div(65536.0)
  // 建物の大きさに合わせて点の数を変える（順番 aP.w がこれより小さい点だけ）
  const perimeter = w.add(d).mul(2.0)
  const count = clamp(floorsN.mul(perimeter).div(36.0), 1.0, 16.0)
  const type = facadeType(facade, use, flags, floorsN, iExt.w, seed)
  const nb = max(1.0, floor(span.div(bayTarget(type)).add(0.5)))
  const bayW = span.div(nb)
  const bi = min(nb.sub(1.0), floor(aP.y.mul(nb)))
  const fi = min(floorsN.sub(1.0), floor(aP.z.mul(floorsN)))
  const front = abs(side.sub(iExt.z)).lessThan(0.5)
  const occ = occupancy(use, flags, fi, front, type, u.uWindows, u.uOffice, u.uShop)
  // 工場は最上階の窓だけ
  const factoryLow = near(type, 8.0).and(fi.lessThan(floorsN.sub(1.5)))
  const lit = select(factoryLow, 0.0, step(windowHash(bi, fi, side, seed), occ).mul(step(aP.w, count.sub(0.5))).mul(step(0.3, bayW)))
  // 窓の中心（局所）と壁の外向き
  const along = bi.add(0.5).mul(bayW).sub(span.mul(0.5))
  const up = fi.add(0.55).mul(floorH).add(0.15)
  const l = select(
    side.lessThan(0.5),
    vec2(along, d.mul(0.5).add(0.15)),
    select(side.lessThan(1.5), vec2(along, d.mul(-0.5).sub(0.15)), select(side.lessThan(2.5), vec2(w.mul(0.5).add(0.15), along), vec2(w.mul(-0.5).sub(0.15), along))),
  )
  const n = select(side.lessThan(0.5), vec2(0.0, 1.0), select(side.lessThan(1.5), vec2(0.0, -1.0), select(side.lessThan(2.5), vec2(1.0, 0.0), vec2(-1.0, 0.0))))
  const c = cos(iPos.w)
  const s = sin(iPos.w)
  const p = iPos.xy.add(vec2(c.mul(l.x).sub(s.mul(l.y)), s.mul(l.x).add(c.mul(l.y))))
  const nw = vec2(c.mul(n.x).sub(s.mul(n.y)), s.mul(n.x).add(c.mul(n.y)))
  const world = vec3(p.x, iPos.z.add(up).sub(LAB_FLOOR), p.y.negate())
  // 点の位置はシーンの座標（点の物は動かさない）
  m.positionNode = world
  const mv = cameraViewMatrix.mul(vec4(world, 1.0))
  const dd = max(mv.z.negate(), 1.0)
  // カメラの側を向いた壁の窓だけ。近くは出さない（建物のシェーダーの窓がある）
  const toCam = normalize(cameraPosition.sub(world))
  const facing = smoothstep(0.0, 0.25, dot(vec3(nw.x, 0.0, nw.y.negate()), toCam))
  const far = smoothstep(350.0, 900.0, dd)
  const px = u.uPx.mul(1.1).div(dd)
  const minPx = u.uPixelRatio.mul(1.6)
  const core = max(px, minPx)
  const energy = select(px.lessThan(minPx), mix(1.0, sqrt(px.div(minPx)), 0.55), 1.0)
  const sprite = min(core.mul(2.4), 24.0)
  const warm = oHash(vec2(bi.mul(1.7).add(seed.mul(19.0)), fi.mul(2.3).add(0.5)))
  const lamp = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.86, 0.66), warm)
  const haze = exp(dd.negate().div(u.uHazeDist.mul(1.4)))
  const twinkle = sin(u.uTime.mul(seed.mul(4.0).add(1.5)).add(bi.mul(3.0)).add(fi.mul(7.0))).mul(0.1).add(1.0)
  const kk = lit.mul(facing).mul(far)
  m.sizeNode = select(kk.greaterThan(0.01), sprite.div(u.uPixelRatio), 0.0)
  const vCol = varying(lamp.mul(kk).mul(energy).mul(haze).mul(twinkle).mul(u.uLightGain).mul(0.75))
  const vCoreR = varying(core.div(sprite))
  const cc = uv().mul(2.0).sub(1.0)
  const r = length(cc).toVar()
  // 点の形は外の塗り（paint.ts）の glow
  const glow = outdoorPaint().glow
  m.colorNode = vec4(vCol.mul(glow(r, vCoreR)).mul(step(r, 1.0)), 1.0)

  const material = withUniforms(m, uniforms)
  const sprites = new THREE.Sprite(material)
  sprites.count = all.count * SPRITES_PER_BUILDING
  sprites.frustumCulled = false
  sprites.name = 'townWindowSprites'
  return sprites as THREE.Sprite & { material: typeof material }
}
