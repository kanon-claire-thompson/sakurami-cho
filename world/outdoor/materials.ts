import * as THREE from 'three/webgpu'
import {
  Fn,
  abs,
  asin,
  atan,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  instancedBufferAttribute,
  int,
  length,
  max,
  min,
  mix,
  modelViewMatrix,
  modelWorldMatrix,
  normalLocal,
  normalWorld,
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
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { outdoor } from '../environment/daylight'
import { sharedTime } from '../materials/shared'
import { townLight } from './town/facades'
import { townShadow } from './town/shadows'
import { townLamps } from './town/lamps'
import { markPaint, outdoorPaint, paintEmit, paintLampLight } from './paint'

type Node<T = unknown> = THREE.Node<T>

/**
 * 遠景（空・地形・海・建物・木・灯り）の材質。
 *
 * - 部屋のライトは使わない。太陽・空の光・空気遠近は下の共有の uniform（outdoorUniforms）で自前に計算する
 *   （部屋の 20 個を超えるライトを遠景の画素ごとに計算しないため。部屋のライトが遠景を照らすこともない）
 * - ラボの霧（fogExp2）はかけない（fog: false）。遠くほど空の色にかすむのは outdoorHaze()
 * - 値は HDR のリニア。トーンマッピングと sRGB は描画の出力（WebGPURenderer の出力の変換。後処理を入れたら RenderPipeline）がかける
 *
 * WebGPU（WebGPURenderer＋TSL）への移行（第 1 段。kanon-claire-thompson/kanon-stream-video#25）:
 * - 共有の部品は TSL の Fn（oHash・oNoise・outdoorShade・outdoorHaze・skyColor。町の townLight・townShadow・townLamps・質感の TextureNode）
 * - 空・星・構造物・ドーム・灯り・光の筋の 6 つの材質は TSL（NodeMaterial）。前の GLSL の TONE（tonemapping_fragment・colorspace_fragment）は
 *   出力の変換がするので無くした。使う側が毎コマ書く値は、前と同じ material.uniforms.<名前>.value（ノードの uniform）
 * - 1px を超える点（星・町の灯り）は Points ではなく Sprite（PointsNodeMaterial）を count 個（インスタンス）並べ、大きさは sizeNode（WebGPU の
 *   点は 1px だけ）。点ごとの値は InstancedBufferAttribute
 * - 第 2 段: 町・名前のある建物・中・乗り物・ラボのどの材質も TSL になり、GLSL の部品（COMMON・SKY・TONE・TOWN_LIGHT・TOWN_SHADOW・TOWN_LAMPS・
 *   TEXTURE_DECL・GLSL_HASH）と、まだ移していない ShaderMaterial を描かない仮の決まり（materials/unported.ts）は消した
 */

/**
 * 色の uniform（値は THREE.Color。シェーダーの中では vec3。型の上だけ vec3 として扱う（@types/three の TSL は color と vec3 の足し算などを許さないため））
 */
export const colorUniform = (c = new THREE.Color()) => uniform(c) as unknown as THREE.UniformNode<'vec3', THREE.Color>

/** 遠景の材質が共有する uniform（ノード。OutdoorUniforms が毎コマ outdoor から書き込む） */
export const outdoorUniforms = {
  uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
  uSunLight: colorUniform(),
  uSkyLight: colorUniform(),
  uHaze: colorUniform(),
  uHazeDist: uniform(8000),
  uZenith: colorUniform(),
  uMid: colorUniform(),
  uHorizon: colorUniform(),
  uHorizonAnti: colorUniform(),
  uGlow: colorUniform(),
  uSunDisc: colorUniform(),
  uCloudLit: colorUniform(),
  uCloudShade: colorUniform(),
  uCloudCover: uniform(0.3),
  uCityGlow: colorUniform(),
  uWater: colorUniform(),
  uNight: uniform(0),
  uDaylight: uniform(1),
  uTime: sharedTime,
  /** 町の方角（xz の単位ベクトル。夜の地平線の町明かり） */
  uTownDir: uniform(new THREE.Vector2(0, 1)),
}

/** outdoor（時刻から計算した外の状態）を共有 uniform へ写す */
export function syncOutdoorUniforms() {
  const u = outdoorUniforms
  const o = outdoor
  u.uSunDir.value.copy(o.sunDir)
  u.uSunLight.value.copy(o.sunLight)
  u.uSkyLight.value.copy(o.skyLight)
  u.uHaze.value.copy(o.haze)
  u.uHazeDist.value = o.hazeDistance
  u.uZenith.value.copy(o.zenith)
  u.uMid.value.copy(o.mid)
  u.uHorizon.value.copy(o.horizon)
  u.uHorizonAnti.value.copy(o.horizonAnti)
  u.uGlow.value.copy(o.glow)
  u.uSunDisc.value.copy(o.sunDisc)
  u.uCloudLit.value.copy(o.cloudLit)
  u.uCloudShade.value.copy(o.cloudShade)
  u.uCloudCover.value = o.cloudCover
  u.uCityGlow.value.copy(o.cityGlow)
  u.uWater.value.copy(o.water)
  u.uNight.value = o.night
  u.uDaylight.value = o.daylight
}

/** 夜の地平線の町明かりの方角（町の中心の平面座標 [東, 北]。町の地図データの目録から Landscape が入れる） */
export function setTownDirection(x: number, y: number) {
  outdoorUniforms.uTownDir.value.set(x, -y).normalize()
}
setTownDirection(-730, -1170)

/* -------------------------------------------------------------------------- */
/* 共有の部品（TSL）                                                              */
/* -------------------------------------------------------------------------- */

/** 0〜1 のハッシュ（2 次元） */
export const oHash = Fn(([p]: [Node<'vec2'>]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar()
  p3.addAssign(dot(p3, p3.yzx.add(33.33)))
  return fract(p3.x.add(p3.y).mul(p3.z))
})

/** 値のノイズ（2 次元。なめらかな補間） */
export const oNoise = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p).toVar()
  const f = fract(p)
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)).toVar()
  return mix(mix(oHash(i), oHash(i.add(vec2(1.0, 0.0))), u.x), mix(oHash(i.add(vec2(0.0, 1.0))), oHash(i.add(vec2(1.0, 1.0))), u.x), u.y)
})

/** 太陽と空の光（外の塗り paint.ts の light。面の種類 other） */
export const outdoorShade = (albedo: Node<'vec3'>, N: Node<'vec3'>): Node<'vec3'> => outdoorPaint().light(albedo, N, float(1.0), float(1.0), 'other')

/** 空気遠近（遠いほど地平線の空の色に溶け込む。外の塗り paint.ts の haze）。wp = ワールドの位置 */
export const outdoorHaze = (col: Node<'vec3'>, wp: Node<'vec3'>): Node<'vec3'> => outdoorPaint().haze(col, wp)

/** 空の色（方向 d。外の塗り paint.ts の sky。空の球と、ガラス・水・車体の映り込み） */
export const skyColor = (d: Node<'vec3'>): Node<'vec3'> => outdoorPaint().sky(d)

/** 空の色の元（地平線 → 中ほど → 天頂の 3 段のグラデーションと、太陽の側の地平線の光、夜の町明かり。外の塗りの sky がこれを高さの帯で塗り分ける） */
export const skyColorBase = Fn(([d]: [Node<'vec3'>]) => {
  const u = outdoorUniforms
  const h = max(d.y, 0.0).toVar()
  // 地平線の色は、太陽の側（朝夕の橙・桃色）と反対側（青紫）で変える
  const sxz = u.uSunDir.xz
  const dxz = normalize(d.xz.add(1e-5)).toVar()
  const side = dot(dxz, sxz.div(max(length(sxz), 1e-4))).mul(0.5).add(0.5)
  const horizon = mix(u.uHorizonAnti, u.uHorizon, smoothstep(0.1, 0.95, side)).toVar()
  const c = mix(horizon, u.uMid, smoothstep(0.0, 0.32, pow(h, 0.85))).toVar()
  c.assign(mix(c, u.uZenith, smoothstep(0.2, 0.9, h)))
  const sunSide = max(dot(d, u.uSunDir), 0.0).toVar()
  const band = exp(h.mul(-4.0))
  c.addAssign(u.uGlow.mul(pow(sunSide, 3.0).mul(band).mul(1.1).add(pow(sunSide, 16.0).mul(0.9))))
  c.addAssign(u.uCityGlow.mul(smoothstep(0.0, 0.85, dot(dxz, u.uTownDir))).mul(exp(h.mul(-16.0))))
  // 地平線より下（海・地面の向こう）は地平線の色を少し暗く（GLSL の smoothstep(0.0, -0.06, d.y) と同じ値。端の順を正しい向きにした）
  c.assign(mix(c, horizon.mul(0.75), smoothstep(0.0, 0.06, d.y.negate())))
  return c
})

/* -------------------------------------------------------------------------- */
/* 材質の土台                                                                     */
/* -------------------------------------------------------------------------- */

/** 材質に、使う側が毎コマ書く uniform（ノード）の一覧を付ける（前の ShaderMaterial の material.uniforms.<名前>.value と同じ書き方で使える） */
export function withUniforms<M extends THREE.Material, U extends object>(m: M, uniforms: U): M & { readonly uniforms: U } {
  return Object.assign(m, { uniforms })
}

/** 色だけを自前の式で決める、ライトも霧も使わない材質（遠景の材質の土台） */
export function unlit(name: string, params: ConstructorParameters<typeof THREE.MeshBasicNodeMaterial>[0] = {}) {
  const m = new THREE.MeshBasicNodeMaterial({ fog: false, ...params })
  m.name = name
  return m
}

/* -------------------------------------------------------------------------- */
/* 空                                                                           */
/* -------------------------------------------------------------------------- */

/** fbm（5 段の値のノイズ。雲。外の塗りの式からも読める） */
export const fbm = Fn(([p0]: [Node<'vec2'>]) => {
  const p = vec2(p0).toVar()
  const s = float(0).toVar()
  let a = 0.5
  for (let i = 0; i < 5; i++) {
    s.addAssign(oNoise(p).mul(a))
    p.assign(p.mul(2.03).add(vec2(17.1, 9.2)))
    a *= 0.5
  }
  return s.div(0.96875)
})

/** 空のドーム（大きな球の内側）。空の色と雲・太陽・月は外の塗り（paint.ts の sky・skyDome）。深度は書かない */
export function createSkyMaterial() {
  const m = markPaint(unlit('outdoorSky', { side: THREE.BackSide, depthWrite: false }), 'sky')
  const dome = outdoorPaint().skyDome
  m.colorNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition)).toVar()
    return dome(d, skyColor(d))
  })()
  return m
}

/** 星の点ごとの値（位置・明るさ・種）。星の Sprite（count 個）が読む */
export interface StarAttributes {
  position: THREE.InstancedBufferAttribute
  mag: THREE.InstancedBufferAttribute
  seed: THREE.InstancedBufferAttribute
}

/**
 * 星（Sprite を星の数だけ並べる。天の北極のまわりを回す）。昼は消える。
 * 大きさは画素（sizeNode。描画の画素の比は three が掛ける）
 */
export function createStarsMaterial(a: StarAttributes) {
  const uStars = uniform(0)
  const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false })
  m.name = 'outdoorStars'
  markPaint(m, 'glow')
  const pos = instancedBufferAttribute(a.position, 'vec3' as const)
  const mag = instancedBufferAttribute(a.mag, 'float' as const)
  const seed = instancedBufferAttribute(a.seed, 'float' as const)
  m.positionNode = pos
  const wp = modelWorldMatrix.mul(vec4(pos, 1.0)).xyz
  const d = normalize(wp.sub(cameraPosition))
  // 地平線の近くは町の明かりで見えにくい
  const horizon = smoothstep(0.02, 0.3, d.y)
  const twinkle = sin(sharedTime.mul(seed.mul(3.1).add(1.3)).add(seed.mul(61.0))).mul(0.22).add(0.78)
  const b = uStars.mul(mag).mul(horizon).mul(twinkle).toVar()
  m.sizeNode = select(b.greaterThan(0.003), mag.mul(1.7).add(1.3), 0.0)
  const vB = varying(b)
  const vTint = varying(mix(vec3(1.0, 0.86, 0.72), vec3(0.78, 0.86, 1.0), fract(seed.mul(7.3))))
  const c = uv().mul(2.0).sub(1.0)
  const r2 = dot(c, c)
  m.colorNode = vec4(vTint.mul(vB).mul(exp(r2.mul(-3.0))).mul(1.6).mul(step(r2, 1.0)), 1.0)
  return withUniforms(m, { uStars })
}

/* -------------------------------------------------------------------------- */
/* 構造物                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * ランドマークの建物（駅・灯台・クレーン・テラス・柵・ケーブルカーの線路・つづら道など）。頂点の色 + aEmit（rgb = 夜に光る色、a = 光の種類）。
 * 光の種類: 1 = 駅の時計（uClock）、2 = 窓明かり（uWindows）、3 = ケーブルカーの車内（uCable）、4 = 小径・石段の足元灯（uPath。town/townStairsMesh.ts）
 */
export function createStructureMaterial() {
  const uniforms = { uClock: uniform(0), uWindows: uniform(0), uCable: uniform(0), uPath: uniform(0), uLightGain: uniform(1) }
  // 両面を描く（岸壁・線路・橋などの面の向きをそろえなくてよいように）。法線は見ている側へ向ける
  const m = markPaint(unlit('outdoorStructures', { side: THREE.DoubleSide }), 'light')
  m.colorNode = Fn(() => {
    const wp = positionWorld.toVar()
    const N = normalize(normalWorld).toVar() // 両面: normalWorld は裏の面で反転済み（MeshBasicNodeMaterial の setupNormal）
    const color = attribute<'vec3'>('color', 'vec3' as const)
    const emit = attribute<'vec4'>('aEmit', 'vec4')
    // 頂点の色の平らな塗り
    const albedo = vec3(color).toVar()
    const col = townLight(albedo, N, float(1.0), townShadow(wp, N), 'structure').toVar()
    col.addAssign(paintLampLight(albedo, townLamps(wp, N)))
    const k = select(
      emit.w.lessThan(0.5),
      0.0,
      select(emit.w.lessThan(1.5), uniforms.uClock, select(emit.w.lessThan(2.5), uniforms.uWindows, select(emit.w.lessThan(3.5), uniforms.uCable, uniforms.uPath))),
    )
    col.addAssign(paintEmit(emit.xyz.mul(k).mul(uniforms.uLightGain)))
    return outdoorHaze(col, wp)
  })()
  return withUniforms(m, uniforms)
}

/* -------------------------------------------------------------------------- */
/* ガーデンドーム                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * ガーデンドーム（半球。position は単位球の上半分）。白い鋼管のリブ（放射状 16 本・水平 5 本）・空を映すガラス・中の木々の緑、
 * 夕方からは葉脈ライティング（金緑色。ゆっくり明滅して「ドームが呼吸している」ように見える）
 */
export function createDomeMaterial(ribs: number, rings: number) {
  const uniforms = { uDome: uniform(0), uRibs: uniform(ribs), uRings: uniform(rings) }
  const m = markPaint(unlit('outdoorDome'), 'light')
  m.colorNode = flatDome(uniforms)
  return withUniforms(m, uniforms)
}

/**
 * ガーデンドームの式: 骨は面の光の式（'dome'）、ガラスは外の塗りの透けるガラスを中の木々の 2 段の緑の上に、葉脈ライティングは形のはっきりした筋（2 段）を
 * 光る物の色の式（emit）に通す。ガラスの細かい葉のまだら・太陽の照り返しは描かない
 */
function flatDome(uniforms: { uDome: Node<'float'>; uRibs: Node<'float'>; uRings: Node<'float'> }) {
  const u = outdoorUniforms
  const paint = outdoorPaint()
  const shade = (a: Node<'vec3'>, N: Node<'vec3'>) => paint.light(a, N, float(1.0), float(1.0), 'dome')
  return Fn(() => {
    const wp = positionWorld.toVar()
    const unit = positionGeometry.toVar()
    const N = normalize(normalWorld).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const az = atan(unit.z, unit.x).div(6.2831853).mul(uniforms.uRibs).toVar()
    const el = asin(clamp(unit.y, 0.0, 1.0)).div(1.5707963).mul(uniforms.uRings.add(1.0)).toVar()
    const fa = abs(fract(az).sub(0.5))
    const fe = abs(fract(el).sub(0.5))
    const wa = fwidth(az).mul(1.2).add(0.012)
    const we = fwidth(el).mul(1.2).add(0.02)
    const rib = max(smoothstep(float(0.5).sub(wa), 0.5, fa), smoothstep(float(0.5).sub(we), 0.5, fe).mul(step(0.5, el))).toVar()
    const cosEl = sqrt(max(unit.y.mul(unit.y).oneMinus(), 0.04))
    const g = el.mul(2.4).div(max(cosEl, 0.35))
    const g1 = az.mul(2.0).add(g).toVar()
    const g2 = az.mul(2.0).sub(g)
    const wg = fwidth(g1).mul(0.8).add(0.006)
    const lattice = max(smoothstep(float(0.5).sub(wg), 0.5, abs(fract(g1).sub(0.5))), smoothstep(float(0.5).sub(wg), 0.5, abs(fract(g2).sub(0.5))))
    const latticeFade = smoothstep(0.08, 0.25, fwidth(g1)).oneMinus()
    rib.assign(max(rib, lattice.mul(0.75).mul(latticeFade)))
    // 中の木々: 大きな塊の 2 段の緑
    const leaves = smoothstep(0.48, 0.52, oNoise(unit.xz.mul(5.0).add(unit.y.mul(2.0)))).toVar()
    const inside = shade(mix(vec3(0.03, 0.07, 0.03), vec3(0.08, 0.14, 0.05), leaves), vec3(0.0, 1.0, 0.0)).mul(0.8).toVar()
    const col = vec3(inside).toVar()
    const gl = paint.glass(N, V, wp, vec3(0.0)).toVar()
    col.assign(mix(inside, gl.rgb, gl.a))
    col.assign(mix(col, shade(vec3(0.8, 0.8, 0.78), N), rib.mul(0.9)))
    // 葉脈ライティング（金緑色。ゆっくり呼吸するように明滅。筋は形のはっきりした 2 段）
    const breath = sin(u.uTime.mul(0.55)).mul(0.38).add(0.62).toVar()
    const vn = oNoise(unit.xz.mul(16.0).add(vec2(u.uTime.mul(0.05), 0.0))).toVar()
    const veins = smoothstep(0.7, 0.72, vn).mul(0.6).add(smoothstep(0.82, 0.84, vn).mul(0.4))
    const glow = vec3(0.55, 1.0, 0.32).mul(leaves.mul(0.3).add(0.45)).mul(breath).add(vec3(0.9, 1.0, 0.45).mul(veins).mul(breath).mul(1.2))
    col.addAssign(paintEmit(glow.mul(uniforms.uDome).mul(rib.mul(-0.7).add(1.0)).mul(1.6)))
    col.addAssign(paintEmit(vec3(0.7, 0.9, 0.5).mul(rib).mul(uniforms.uDome).mul(0.25).mul(breath)))
    return outdoorHaze(col, wp)
  })()
}

/* -------------------------------------------------------------------------- */
/* 夜の灯り・灯台の光                                                             */
/* -------------------------------------------------------------------------- */

/** 灯りの種類の数（town/lights.ts の LIGHT_KIND） */
export const LIGHT_KINDS = 12

/** 町の灯りの点ごとの値（town/lights.ts の lightsGeometry の属性を InstancedBufferAttribute にした物） */
export interface LightAttributes {
  position: THREE.InstancedBufferAttribute
  aColor: THREE.InstancedBufferAttribute
  aSize: THREE.InstancedBufferAttribute
  aPower: THREE.InstancedBufferAttribute
  aSeed: THREE.InstancedBufferAttribute
  aKind: THREE.InstancedBufferAttribute
}

/**
 * 町の灯り（Sprite を灯りの数だけ並べる）。aKind ごとの点いている割合 uOn[種類] より aSeed が小さい灯りだけ点く。
 * 大きさは m で決め、遠くでは画面の最小の大きさで描く（遠い灯りも消えない）。uOn・uKindGain は数の配列（uniforms.uOn.array を書く）
 */
export function createLightsMaterial(a: LightAttributes) {
  const uniforms = {
    uOn: uniformArray(new Array<number>(LIGHT_KINDS).fill(0), 'float' as const),
    uKindGain: uniformArray(new Array<number>(LIGHT_KINDS).fill(1), 'float' as const),
    uGain: uniform(1),
    uPx: uniform(500),
    uPixelRatio: uniform(1),
  }
  const u = uniforms
  const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false })
  m.name = 'outdoorLights'
  markPaint(m, 'glow')
  const pos = instancedBufferAttribute(a.position, 'vec3' as const)
  const aColor = instancedBufferAttribute(a.aColor, 'vec3' as const)
  const aSize = instancedBufferAttribute(a.aSize, 'float' as const)
  const aPower = instancedBufferAttribute(a.aPower, 'float' as const)
  const aSeed = instancedBufferAttribute(a.aSeed, 'float' as const)
  const aKind = instancedBufferAttribute(a.aKind, 'float' as const)
  m.positionNode = pos
  const t = sharedTime
  const k = int(aKind.add(0.5)).toVar()
  const on = u.uOn.element(k).toVar()
  const kindGain = u.uKindGain.element(k).toVar()
  const lit = select(k.equal(10), on, smoothstep(aSeed, aSeed.add(0.03), on)).toVar()
  const mv = modelViewMatrix.mul(vec4(pos, 1.0))
  const d = max(mv.z.negate(), 1.0).toVar()
  // 光の芯の大きさ（画面の px）。遠くて小さい灯りも、2px の芯で描く（そのぶん少し暗くする）
  const px = aSize.mul(u.uPx).div(d).toVar()
  const minPx = u.uPixelRatio.mul(2.0)
  const core = max(px, minPx).toVar()
  const energy = select(px.lessThan(minPx), mix(1.0, sqrt(px.div(minPx)), 0.6), 1.0)
  const sprite = min(core.mul(2.6), 110.0).toVar()
  const haze = exp(d.negate().div(outdoorUniforms.uHazeDist.mul(1.4)))
  const twinkle = sin(t.mul(aSeed.mul(5.0).add(2.0)).add(aSeed.mul(80.0))).mul(0.12).mul(smoothstep(1500.0, 4000.0, d)).add(1.0)
  // 航空障害灯は 1 秒ごとに点滅、港の灯台の灯（赤・緑）は 4 秒に 1 回の閃光（灯台ごとに位相をずらす）
  const beat = fract(t.mul(0.25).add(aSeed))
  // 浮遊レーンのレーン灯は 2 秒ごとにゆっくり点滅（レーンに沿って光が流れるように、種で位相をずらす）
  const blink = select(
    k.equal(6),
    step(0.5, fract(t.mul(0.5).add(aSeed))),
    select(
      k.equal(9),
      smoothstep(0.0, 0.03, beat).mul(smoothstep(0.1, 0.16, beat).oneMinus()),
      select(k.equal(10), smoothstep(0.55, 0.9, sin(t.mul(3.14159).sub(aSeed.mul(25.0))).mul(0.5).add(0.5)).mul(0.75).add(0.25), 1.0),
    ),
  )
  // 大きさは描画の画素（sizeNode は CSS の px で、three が画素の比を掛ける）
  m.sizeNode = select(lit.greaterThan(0.001).and(kindGain.greaterThan(0.001)), sprite.div(u.uPixelRatio), 0.0)
  const vCol = varying(aColor.mul(aPower).mul(u.uGain).mul(kindGain).mul(lit).mul(energy).mul(haze).mul(twinkle).mul(blink))
  const vCoreR = varying(core.div(sprite))
  const c = uv().mul(2.0).sub(1.0)
  const r = length(c).toVar()
  // 芯（後処理の bloom でにじむ明るさ）と輪の形（外の塗り paint.ts の glow）
  const glow = outdoorPaint().glow
  m.colorNode = vec4(vCol.mul(glow(r, vCoreR)).mul(step(r, 1.0)), 1.0)
  return withUniforms(m, uniforms)
}

/**
 * 町の灯り（Sprite を灯りの数だけ並べた物）。g は town/lights.ts の lightsGeometry（点の属性は InstancedBufferAttribute に写す）
 */
export function createLightsSprite(g: THREE.BufferGeometry) {
  const attr = (name: string) => {
    const a = g.getAttribute(name) as THREE.BufferAttribute
    return new THREE.InstancedBufferAttribute(a.array, a.itemSize)
  }
  const material = createLightsMaterial({ position: attr('position'), aColor: attr('aColor'), aSize: attr('aSize'), aPower: attr('aPower'), aSeed: attr('aSeed'), aKind: attr('aKind') })
  const sprite = new THREE.Sprite(material)
  sprite.count = g.getAttribute('position').count
  return sprite as THREE.Sprite & { material: typeof material }
}

/** 灯台の光の帯（灯台から水平に伸びる細い円錐。加算合成で、灯台に近いほど・光の芯ほど明るい） */
export function createBeamMaterial() {
  const uniforms = { uBeam: uniform(0) }
  const m = markPaint(unlit('outdoorBeam', { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), 'glow')
  // 法線は頂点で世界の向きにして、正規化しないまま補間する（細い帯の縁の画素では補間した法線が 0 の長さになることがあり、正規化すると NaN）
  const vNormal = varying(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz)
  m.colorNode = Fn(() => {
    const along = uv().y.oneMinus().toVar()
    const toCam = cameraPosition.sub(positionWorld).toVar()
    const d = length(toCam).toVar()
    const V = toCam.div(max(d, 1e-3))
    // 横から見たとき、帯の中ほど（光の中を通る長さが長い所）ほど明るい
    const nl = length(vNormal).toVar()
    const thick = select(nl.greaterThan(1e-6), pow(abs(dot(vNormal.div(max(nl, 1e-6)), V)), 1.5), 0.0)
    const fall = exp(along.mul(-3.2)).mul(smoothstep(0.0, 0.02, along))
    const haze = exp(d.negate().div(outdoorUniforms.uHazeDist.mul(1.6)))
    // カメラの近く（ラボのまわり）を通る帯の殻は描かない。帯がラボの方へ回ってくるとき、近くの殻が町の上に大きな灰色の膜になって
    // 見えるため（ラボの方を向く前後は帯ごと消す。landscape.ts）
    const nearFade = smoothstep(400.0, 2500.0, d)
    // 帯の明るさを 2 段の平らな光に（芯と外側。縁はくっきり）
    const q = thick.mul(fall).toVar()
    const level = smoothstep(0.12, 0.14, q).mul(0.45).add(smoothstep(0.42, 0.45, q).mul(0.55))
    return paintEmit(vec3(0.85, 0.9, 1.0).mul(level).mul(haze).mul(nearFade).mul(uniforms.uBeam).mul(0.3))
  })()
  return withUniforms(m, uniforms)
}
