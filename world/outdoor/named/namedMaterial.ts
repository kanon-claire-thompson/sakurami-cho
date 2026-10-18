import * as THREE from 'three/webgpu'
import {
  Break,
  Continue,
  Discard,
  Fn,
  If,
  Loop,
  abs,
  atan,
  attribute,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  fwidth,
  int,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalLocal,
  normalize,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { outdoor } from '../../environment/daylight'
import { oHash, oNoise, outdoorHaze, outdoorUniforms, skyColor, unlit, withUniforms } from '../materials'
import { roomInterior, townLight } from '../town/facades'
import { townShadow } from '../town/shadows'
import { townTextureUniforms } from '../town/townTextures'
import { townLampsEx } from '../town/lamps'
import { outdoorPaint, paintFlat } from '../paint'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/**
 * 名前のある建物の細かい形のシェーダー（町の建物・ラボの外観と同じ光: 太陽・空の光・町の太陽の影・空気遠近）。
 *
 * - 質感（createNamedMaterial）: 質感の種類（NM）ごとに町の写真の質感（煉瓦・石・漆喰・板・コンクリート・波板・タイル・瓦・スレート）と、
 *   手で描く模様（下見板・縦の板・格子・銅板の継ぎ目と緑青の筋・切石の目地・タイル張り・布の縞・朱塗りのはげ）。足元のはね返りと汚れ、
 *   夜は入口の灯り（いちばん近い MAX_NAMED_LAMPS 個）が壁と地面を照らす
 * - 窓のガラス（createNamedGlassMaterial）: 窓ごとに開口の大きさ・部屋の奥行き・種類（住まい・事務所・店・喫茶・ステンドグラス・障子など）を持ち、
 *   部屋の奥（facades.ts の roomInterior）・カーテン・桟・映り込み。点き方は町の窓明かりと同じ uniform（窓・事務所・店）
 * - 看板（createNamedSignMaterial）: canvas に描いた文字の絵（signs.ts のアトラス）。夜は光る看板・照らされる看板
 * - 光る物（createNamedGlowMaterial）: 灯具・提灯・時計の文字盤の明かり
 *
 * WebGPU（WebGPURenderer＋TSL）への移行（第 2 段）: どの材質も TSL（NodeMaterial）。面の本体（namedSurface）は、中のある建物の中
 * （interior/interiorMaterial.ts）と共有する TSL の部品（呼ぶ側の Fn の中で式を組む関数。中の質感は interior の引数で足す）。
 * 値は HDR のリニアで、トーンマッピングと sRGB は出力の変換がかける
 */

/** 質感の種類（kit の形の aMat.x と同じ番号） */
export const NM = {
  /** 煉瓦（町の質感の煉瓦）。aux = 目地の明るさ（0〜1） */
  brick: 0,
  /** 切石（石の質感と横の目地）。aux = 段の高さ m（0 なら目地なし） */
  stone: 1,
  /** 漆喰・モルタル */
  plaster: 2,
  /** 下見板（横の板の重なりの陰）。aux = 板の幅 m */
  siding: 3,
  /** 縦の板張り（和の家の焦げ茶の板）。aux = 板の幅 m */
  boardV: 4,
  /** コンクリート */
  concrete: 5,
  /** 塗装（木・鉄の枠や柱）。aux = つや 0〜1 */
  paint: 6,
  /** 和瓦（黒瓦・銀鼠・茶色の瓦） */
  kawara: 7,
  /** 洋瓦（赤茶・茶色） */
  tileRoof: 8,
  /** スレート */
  slate: 9,
  /** 銅板の緑青（縦の継ぎ目と雨の筋）。aux = 継ぎ目の間隔 m */
  copper: 10,
  /** 金属の屋根・波板。aux = 波の間隔 m（0 なら平らな瓦棒） */
  metalRoof: 11,
  /** 濃いガラス（遠くの窓・天窓・カーテンウォールの面） */
  glassDark: 12,
  /** 御影石（段・基壇・笠石） */
  granite: 13,
  /** 木（板の床・柱・ベンチ）。aux = 板の向き（0 横・1 縦） */
  wood: 14,
  /** 布（日よけ・暖簾）。aux = 縞の数（0 なら無地） */
  cloth: 15,
  /** 格子（細い縦の桟と暗いすき間）。aux = 桟の間隔 m */
  lattice: 16,
  /** 金色・真鍮 */
  gold: 17,
  /** 葉（蔦・生け垣・植え込み） */
  leaf: 18,
  /** 石畳・敷石 */
  paving: 19,
  /** 屋上の防水 */
  membrane: 20,
  /** 朱塗り（はげ・色あせ） */
  lacquer: 21,
  /** タイル張り（細かい目地）。aux = タイルの大きさ m */
  tileClad: 22,
  /** 土・砂利 */
  soil: 23,
  /** 暗い奥（開口の奥・すき間） */
  dark: 24,
  /** 鉄（黒い鉄・手すり・街灯）。aux = つや */
  iron: 25,
  /** ステンレス・亜鉛めっき・アルミ（手すり・方立て・観測機器） */
  steel: 26,
} as const

/** 入口の灯りの数の上限（uniform の配列） */
export const MAX_NAMED_LAMPS = 48

/**
 * 配列の uniform（value は前の GLSL の uniform と同じ JS の配列。要素を書き換えると、three が毎コマ GPU へ写す。node はシェーダーが読む物）
 */
export function arrayUniform<K extends keyof ArrayValue>(values: ArrayValue[K][], type: K) {
  return { value: values, node: uniformArray(values as never[], type) as unknown as ArrayNode<K> }
}
interface ArrayValue {
  float: number
  vec3: THREE.Vector3
  vec4: THREE.Vector4
}
/** 配列の uniform のノード（要素を読む所だけ） */
interface ArrayNode<K extends keyof ArrayValue> {
  element(i: Node<'int'> | number): Node<K>
}

/** 名前のある建物の共有の uniform（value の読み書きは前のまま。配列は value の要素を書く） */
export const namedUniforms = {
  uNLamps: arrayUniform(Array.from({ length: MAX_NAMED_LAMPS }, () => new THREE.Vector4(0, -1e5, 0, 0)), 'vec4'),
  uNLampC: arrayUniform(Array.from({ length: MAX_NAMED_LAMPS }, () => new THREE.Vector3()), 'vec3'),
  uNLampCount: uniform(0),
  /** 灯りの点き具合（0〜1） */
  uNLampOn: uniform(0),
  /** 町の窓明かり（建物のシェーダーと同じ値） */
  uWindows: uniform(0),
  uOffice: uniform(0),
  uShop: uniform(0),
  /** 店が開いている時間（昼も店の中の灯りが点く。0〜1） */
  uOpen: uniform(0),
  uLightGain: uniform(1),
  /** 時計の文字盤の明かり */
  uClock: uniform(0),
}

/** 毎コマ: 外の時刻の光から uniform を写す */
export function syncNamedUniforms() {
  const o = outdoor
  const u = namedUniforms
  u.uNLampOn.value = o.lights.path
  u.uWindows.value = o.lights.window
  u.uOffice.value = o.lights.office
  u.uShop.value = o.lights.shop
  const h = o.time.hours
  const open = THREE.MathUtils.smoothstep(h, 9.5, 10.2) * (1 - THREE.MathUtils.smoothstep(h, 20.5, 21.2))
  u.uOpen.value = Math.max(open, o.lights.shop)
  u.uLightGain.value = o.lightGain
  u.uClock.value = o.clockFace
}

/** 入口の灯り（照度。albedo を掛ける前） */
export const namedLamps = Fn(([wp, N]: [V3, V3]) => {
  const u = namedUniforms
  const acc = vec3(0.0).toVar()
  If(u.uNLampOn.greaterThanEqual(0.001), () => {
    Loop(MAX_NAMED_LAMPS, ({ i }: { i: Node<'int'> }) => {
      If(i.greaterThanEqual(int(u.uNLampCount)), () => {
        Break()
      })
      const lp = u.uNLamps.node.element(i).toVar()
      const L = lp.xyz.sub(wp).toVar()
      const w = lp.w.toVar()
      const r = abs(w).toVar()
      const d2 = dot(L, L).toVar()
      If(d2.greaterThan(r.mul(r)), () => {
        Continue()
      })
      const d = sqrt(d2).toVar()
      const c = u.uNLampC.node.element(i).toVar()
      const ndl0 = max(dot(N, L.div(max(d, 1e-3))), 0.0).toVar()
      If(w.lessThan(0.0), () => {
        // 投光器（建物の正面を下から照らす。遠くまで届き、光の向きの面だけ）
        acc.addAssign(c.mul(ndl0).mul(smoothstep(r.mul(0.5), r, d).oneMinus()).div(d2.mul(0.012).add(1.0)))
      }).Else(() => {
        const ndl = ndl0.mul(0.85).add(0.15)
        acc.addAssign(c.mul(ndl).mul(smoothstep(r.mul(0.35), r, d).oneMinus()).div(d2.mul(0.45).add(1.0)))
      })
    })
  })
  return acc.mul(u.uNLampOn)
})

/* -------------------------------------------------------------------------- */
/* 面の本体（外観と中のある建物の中が共有する）                                          */
/* -------------------------------------------------------------------------- */

export const LUMA = vec3(0.2126, 0.7152, 0.0722) as Node<'vec3'>
const tex = townTextureUniforms
/** 町の質感の色（sRGB の値を 2 倍してから 2.2 乗。ミップマップの遠くがちょうど 1 倍になるように） */
export const bAlb = (uv: V2, layer: number) => pow(max(tex.uBldAlb.sample(uv).depth(int(layer)).rgb.mul(2.0), 0.0), vec3(2.2))
export const bNrm = (uv: V2, layer: number) => tex.uBldNrm.sample(uv).depth(int(layer)).xyz.mul(2.0).sub(1.0)
export const gAlb = (uv: V2, layer: number) => pow(max(tex.uGndAlb.sample(uv).depth(int(layer)).rgb.mul(2.0), 0.0), vec3(2.2))
export const gNrm = (uv: V2, layer: number) => tex.uGndNrm.sample(uv).depth(int(layer)).xyz.mul(2.0).sub(1.0)
/** 細い線（x < w で 1、画素の幅 fw でなめらかに） */
export const lineAA = (x: F, w: F | number, fw: F) => {
  const wn: F = typeof w === 'number' ? float(w) : w
  return smoothstep(wn.sub(fw), wn.add(fw), x).oneMinus()
}

/** 面の頂点の値（varying）。world = ワールドの位置、normal = ワールドの法線（正規化前）、color = 頂点の色、mat = aMat、ext = aExt */
export interface SurfaceInputs {
  world: V3
  normal: V3
  color: V3
  mat: V2
  ext: V4
}

/** 中の質感（interiorSurface）に渡す、面の途中の値と書き換える変数 */
export interface SurfaceState {
  id: F
  aux: F
  uv: V2
  fw: V2
  px: F
  seed: F
  nk: F
  n1: F
  n2: F
  T: V3
  B: V3
  N: V3
  color: V3
  albedo: V3
  tn: V3
  ao: F
  gloss: F
  metal: F
  emit: F
}

/** 面の頂点の値（varying）を作る。extW を渡すと aExt.w の代わりに使う（中は汚れ 0） */
export function surfaceVaryings(extW?: number): SurfaceInputs {
  const ext = attribute<'vec4'>('aExt', 'vec4')
  return {
    world: positionWorld,
    normal: varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz)),
    color: varying(attribute<'vec3'>('color', 'vec3')),
    mat: varying(attribute<'vec2'>('aMat', 'vec2')),
    ext: extW === undefined ? varying(ext) : varying(vec4(ext.x, ext.y, ext.z, float(extW))),
  }
}

/**
 * 名前のある建物の細かい形の面（質感の種類 NM ごとの色・法線・環境光の遮り・つや・金属）。外観（createNamedMaterial）と、中のある建物の中
 * （interior/interiorMaterial.ts）が使う。呼ぶ側の Fn の中で式を組む。interior を渡すと、id が 26.5 を超える面（中の質感 IM。27 番から）で呼ぶ
 */
export function namedSurface(v: SurfaceInputs, interior?: (s: SurfaceState) => void) {
  const N = normalize(v.normal).mul(faceDirection).toVar()
  const id = floor(v.mat.x.add(0.5)).toVar()
  const aux = v.mat.y.toVar()
  const seed = v.ext.z.toVar()
  const dirt = v.ext.w.toVar()
  const wp = v.world
  const dist = length(cameraPosition.sub(wp)).toVar()
  // 面に沿った座標: 水平の面は x・-z、ほかは水平の向き T（見て右）と、面に沿って上へ B
  const T = vec3(1.0, 0.0, 0.0).toVar()
  const B = vec3(0.0, 0.0, -1.0).toVar()
  const uv = vec2(wp.x, wp.z.negate()).toVar()
  If(abs(N.y).lessThanEqual(0.97), () => {
    T.assign(normalize(cross(vec3(0.0, 1.0, 0.0), N)))
    B.assign(normalize(cross(N, T)))
    uv.assign(vec2(dot(wp, T), dot(wp, B)))
  })
  const fw = max(fwidth(uv), vec2(1e-4)).toVar()
  const px = max(fw.x, fw.y).toVar()
  const albedo = vec3(v.color).toVar()
  const tn = vec3(0.0, 0.0, 1.0).toVar()
  const ao = float(v.ext.x).toVar()
  const gloss = float(0.06).toVar()
  const metal = float(0.0).toVar()
  const emit = float(0.0).toVar()
  const nk = smoothstep(25.0, 150.0, dist).oneMinus().toVar()
  const n1 = oNoise(uv.mul(0.8).add(seed.mul(31.0))).toVar()
  const n2 = oNoise(uv.mul(0.17).add(seed.mul(7.0))).toVar()
  const suv = uv.add(seed.mul(vec2(13.0, 7.0))).toVar()
  const gray = (t: V3) => vec3(dot(t, LUMA))
  const addTn = (x: F | number, y: F | number) => tn.assign(vec3(tn.x.add(x), tn.y.add(y), tn.z))

  // 外の塗り（paint.ts）の flat: 質感の写真・目地・むら・汚れを省き、頂点の色の平らな塗りにする（暗い奥・金属の度合いだけ残す）
  const flat = paintFlat()
  if (flat) {
    If(id.greaterThan(23.5).and(id.lessThan(24.5)), () => {
      albedo.mulAssign(0.25)
      ao.mulAssign(0.5)
    })
      .ElseIf(id.greaterThan(25.5), () => {
        metal.assign(1.0)
      })
      .ElseIf(id.greaterThan(24.5), () => {
        metal.assign(0.4)
      })
  } else {
    If(id.lessThan(0.5), () => {
      // 煉瓦
      const t = bAlb(suv.div(2.0), 3).toVar()
      albedo.mulAssign(mix(gray(t), t, 0.35).mul(1.05))
      tn.assign(bNrm(suv.div(2.0), 3))
      albedo.mulAssign(n2.mul(0.24).add(0.88))
      gloss.assign(0.05)
    })
      .ElseIf(id.lessThan(1.5), () => {
        // 切石（横の目地と、段ごとにずらした縦の目地）
        const t = bAlb(suv.div(2.6), 2).toVar()
        albedo.mulAssign(mix(vec3(1.0), mix(gray(t), t, 0.4), 0.7))
        tn.assign(bNrm(suv.div(2.6), 2).mul(vec3(0.6, 0.6, 1.0)))
        If(aux.greaterThan(0.01), () => {
          const row = floor(uv.y.div(aux)).toVar()
          const ux = uv.x.div(aux.mul(2.2)).add(fract(row.mul(0.5))).toVar()
          const gy = abs(fract(uv.y.div(aux).add(0.5)).sub(0.5)).mul(aux)
          const gx = abs(fract(ux.add(0.5)).sub(0.5)).mul(aux).mul(2.2)
          const joint = max(lineAA(gy, 0.008, fw.y), lineAA(gx, 0.008, fw.x)).mul(smoothstep(0.02, 0.06, px).oneMinus())
          albedo.mulAssign(joint.mul(-0.32).add(1.0))
          const fyw = fw.y.div(aux)
          const fy = fract(uv.y.div(aux))
          addTn(0.0, lineAA(abs(fy.sub(0.02)), 0.02, fyw).sub(lineAA(abs(fy.sub(0.98)), 0.02, fyw)).mul(0.5).mul(nk))
          albedo.mulAssign(oHash(vec2(floor(ux), row).add(seed)).mul(0.12).add(0.94))
        })
        albedo.mulAssign(n2.mul(0.2).add(0.9))
        gloss.assign(0.07)
      })
      .ElseIf(id.lessThan(2.5), () => {
        // 漆喰・モルタル
        const t = bAlb(suv.div(3.0), 1).toVar()
        albedo.mulAssign(mix(vec3(1.0), gray(t), 0.8))
        tn.assign(bNrm(suv.div(3.0), 1).mul(vec3(0.7, 0.7, 1.0)))
        albedo.mulAssign(n2.mul(0.14).add(0.92))
        gloss.assign(0.05)
      })
      .ElseIf(id.lessThan(3.5), () => {
        // 下見板: 板の下端の影（重なり）と、板ごとの色むら
        const bw = max(aux, 0.08).toVar()
        const f = fract(uv.y.div(bw)).toVar()
        const board = floor(uv.y.div(bw)).toVar()
        const lap = smoothstep(0.0, 0.18, f).toVar()
        const h1 = oHash(vec2(board, 1.0)).toVar()
        albedo.mulAssign(mix(0.62, 1.0, lap).mul(oHash(vec2(board, floor(uv.x.div(3.6).add(h1)))).mul(0.1).add(0.94)))
        addTn(0.0, lap.oneMinus().mul(0.9).mul(nk).negate())
        const t = bAlb(vec2(uv.x.div(2.4), f.mul(0.08).add(board.mul(0.13))), 0).toVar()
        albedo.mulAssign(mix(vec3(1.0), gray(t), 0.35))
        // 継ぎ目（縦）
        const j = lineAA(abs(fract(uv.x.div(3.6).add(h1)).sub(0.5)).mul(3.6), 0.006, fw.x)
        albedo.mulAssign(j.mul(0.25).mul(smoothstep(0.02, 0.05, px).oneMinus()).oneMinus())
        gloss.assign(0.1)
      })
      .ElseIf(id.lessThan(4.5), () => {
        // 縦の板張り
        const bw = max(aux, 0.08).toVar()
        const f = fract(uv.x.div(bw)).toVar()
        const plank = floor(uv.x.div(bw)).toVar()
        const t = bAlb(vec2(uv.y.div(2.4), f.mul(0.1).add(plank.mul(0.17))), 0)
        albedo.mulAssign(mix(vec3(1.0), t, 0.6).mul(oHash(vec2(plank, seed)).mul(0.2).add(0.88)))
        const gap = lineAA(abs(f.sub(0.5)).mul(bw), bw.mul(0.5).sub(0.006), fw.x)
        albedo.mulAssign(mix(0.55, 1.0, gap))
        addTn(smoothstep(0.0, 0.12, f).sub(smoothstep(0.88, 1.0, f)).mul(0.4).mul(nk), 0.0)
        gloss.assign(0.06)
      })
      .ElseIf(id.lessThan(5.5), () => {
        // コンクリート
        const t = bAlb(suv.div(3.2), 4).toVar()
        albedo.mulAssign(mix(vec3(1.0), gray(t), 0.8))
        tn.assign(bNrm(suv.div(3.2), 4).mul(vec3(0.6, 0.6, 1.0)))
        albedo.mulAssign(n2.mul(0.2).add(0.9))
        gloss.assign(0.06)
      })
      .ElseIf(id.lessThan(6.5), () => {
        // 塗装（木・鉄）。少しの色むらと、はげ
        albedo.mulAssign(n1.mul(0.12).add(0.92))
        const chip = smoothstep(0.8, 0.9, oNoise(uv.mul(6.0).add(seed.mul(3.0)))).mul(aux.oneMinus()).mul(dirt)
        albedo.assign(mix(albedo, albedo.mul(0.55).add(vec3(0.03, 0.025, 0.02)), chip.mul(0.6)))
        gloss.assign(aux.mul(0.55).add(0.12))
      })
      .ElseIf(id.lessThan(7.5), () => {
        // 和瓦（瓦の列は斜面に沿って。質感の瓦）
        const t = bAlb(suv.div(2.2), 7).toVar()
        albedo.mulAssign(mix(gray(t), t, 0.15))
        tn.assign(bNrm(suv.div(2.2), 7))
        albedo.mulAssign(n2.mul(0.26).add(0.86))
        gloss.assign(0.16)
      })
      .ElseIf(id.lessThan(8.5), () => {
        // 洋瓦
        const t = bAlb(suv.div(2.0), 6).toVar()
        albedo.mulAssign(mix(gray(t), t, 0.3))
        tn.assign(bNrm(suv.div(2.0), 6))
        albedo.mulAssign(n2.mul(0.26).add(0.86))
        gloss.assign(0.1)
      })
      .ElseIf(id.lessThan(9.5), () => {
        // スレート
        const t = bAlb(suv.div(2.0), 8).toVar()
        albedo.mulAssign(mix(gray(t), t, 0.2))
        tn.assign(bNrm(suv.div(2.0), 8))
        albedo.mulAssign(n2.mul(0.22).add(0.88))
        gloss.assign(0.14)
      })
      .ElseIf(id.lessThan(10.5), () => {
        // 銅板の緑青: 縦の継ぎ目（はぜ）、雨の筋、所々の茶色い銅の地
        const sp = max(aux, 0.3).toVar()
        const f = fract(uv.x.div(sp)).toVar()
        const seam = lineAA(abs(f.sub(0.5)).mul(sp), 0.012, fw.x)
        const streak = oNoise(vec2(uv.x.mul(2.7), uv.y.mul(0.12)).add(seed)).mul(0.7).add(oNoise(vec2(uv.x.mul(9.0), uv.y.mul(0.5))).mul(0.3))
        const patina = mix(albedo.mul(0.82), albedo.mul(vec3(1.08, 1.12, 1.05)), smoothstep(0.3, 0.75, streak))
        const bare = smoothstep(0.78, 0.92, oNoise(uv.mul(0.9).add(seed.mul(4.0)))).mul(0.6)
        albedo.assign(mix(patina, vec3(0.16, 0.09, 0.05), bare))
        albedo.mulAssign(seam.mul(-0.25).add(1.0))
        addTn(smoothstep(0.42, 0.5, f).sub(smoothstep(0.5, 0.58, f)).mul(0.8).mul(nk), 0.0)
        gloss.assign(0.12)
      })
      .ElseIf(id.lessThan(11.5), () => {
        // 金属の屋根・波板
        const t = bAlb(suv.div(2.4), 5).toVar()
        albedo.mulAssign(mix(vec3(1.0), gray(t), 0.7))
        tn.assign(bNrm(suv.div(2.4), 5))
        If(abs(aux).greaterThan(0.01), () => {
          // aux > 0 は縦の波（波板の屋根）、aux < 0 は横の筋（シャッター）
          const w = sin(select(aux.greaterThan(0.0), uv.x, uv.y).div(abs(aux)).mul(6.2832)).toVar()
          If(aux.greaterThan(0.0), () => {
            addTn(w.mul(0.5).mul(nk), 0.0)
          }).Else(() => {
            addTn(0.0, w.mul(0.5).mul(nk))
          })
          albedo.mulAssign(w.mul(0.08).add(0.92))
        })
        const rust = smoothstep(0.7, 0.9, oNoise(uv.mul(0.6).add(seed.mul(5.0)))).mul(dirt)
        albedo.assign(mix(albedo, vec3(0.2, 0.1, 0.05), rust.mul(0.5)))
        gloss.assign(0.3)
        metal.assign(0.3)
      })
      .ElseIf(id.lessThan(12.5), () => {
        // 濃いガラス
        albedo.assign(vec3(0.02, 0.025, 0.03))
        gloss.assign(0.9)
        metal.assign(0.0)
      })
      .ElseIf(id.lessThan(13.5), () => {
        // 御影石
        const t = bAlb(suv.div(1.2), 2).toVar()
        albedo.mulAssign(mix(vec3(1.0), gray(t), 0.6))
        albedo.mulAssign(oHash(floor(uv.mul(160.0))).mul(0.28).add(0.86))
        tn.assign(bNrm(suv.div(1.2), 2).mul(vec3(0.4, 0.4, 1.0)))
        gloss.assign(0.18)
      })
      .ElseIf(id.lessThan(14.5), () => {
        // 木（板）
        const wuv = select(aux.greaterThan(0.5), vec2(uv.y, uv.x), uv).toVar()
        const t = bAlb(wuv.div(2.4), 0)
        albedo.mulAssign(mix(vec3(1.0), t, 0.75))
        tn.assign(bNrm(wuv.div(2.4), 0).mul(vec3(0.5, 0.5, 1.0)))
        gloss.assign(0.1)
      })
      .ElseIf(id.lessThan(15.5), () => {
        // 布（縞は面の横の向き）
        If(aux.greaterThan(0.5), () => {
          const st = step(0.5, fract(uv.x.mul(aux).mul(0.5)))
          albedo.assign(mix(albedo, vec3(0.78, 0.76, 0.7), st.mul(0.85)))
        })
        albedo.mulAssign(oNoise(uv.mul(3.0)).mul(0.12).add(0.9))
        // 布の裏から日が透ける
        gloss.assign(0.03)
      })
      .ElseIf(id.lessThan(16.5), () => {
        // 格子（細い縦の桟と暗いすき間）
        const sp = max(aux, 0.03).toVar()
        const f = abs(fract(uv.x.div(sp)).sub(0.5)).mul(sp)
        const bar = lineAA(f, sp.mul(0.32), fw.x).toVar()
        const fade = smoothstep(0.004, 0.02, px).toVar()
        albedo.assign(mix(albedo.mul(mix(0.12, 1.0, bar)), albedo.mul(0.5), fade))
        addTn(select(bar.lessThan(0.5), 0.0, fract(uv.x.div(sp)).sub(0.5).mul(1.2)).mul(fade.oneMinus()), 0.0)
        gloss.assign(0.08)
      })
      .ElseIf(id.lessThan(17.5), () => {
        // 金色・真鍮
        metal.assign(1.0)
        gloss.assign(0.6)
        albedo.mulAssign(n1.mul(0.15).add(0.9))
      })
      .ElseIf(id.lessThan(18.5), () => {
        // 葉（蔦・生け垣）: 葉の粒と、すき間の暗さ
        const l1 = oNoise(uv.mul(7.0).add(seed.mul(9.0)))
        const l2 = oNoise(uv.mul(19.0).add(seed.mul(3.0))).toVar()
        const leaf = smoothstep(0.35, 0.7, l1.mul(0.6).add(l2.mul(0.4))).toVar()
        albedo.assign(mix(albedo.mul(0.35), albedo.mul(l2.mul(0.35).add(0.85)), leaf))
        const d = vec2(oNoise(uv.mul(23.0)), oNoise(uv.mul(23.0).add(5.0))).sub(0.5).mul(1.6).mul(nk).toVar()
        addTn(d.x, d.y)
        ao.mulAssign(leaf.mul(0.25).add(0.75))
        gloss.assign(0.08)
      })
      .ElseIf(id.lessThan(19.5), () => {
        // 石畳
        const t = gAlb(suv.div(1.8), 3).toVar()
        albedo.mulAssign(mix(vec3(1.0), mix(gray(t), t, 0.5), 0.85))
        tn.assign(gNrm(suv.div(1.8), 3))
        gloss.assign(0.08)
      })
      .ElseIf(id.lessThan(20.5), () => {
        // 屋上の防水
        const t = bAlb(suv.div(3.2), 4).toVar()
        albedo.mulAssign(mix(vec3(1.0), gray(t), 0.4))
        const lap = lineAA(abs(fract(uv.x).sub(0.5)), 0.004, fw.x)
        albedo.mulAssign(n2.mul(0.28).add(0.82).mul(lap.mul(-0.12).add(1.0)))
        gloss.assign(0.08)
      })
      .ElseIf(id.lessThan(21.5), () => {
        // 朱塗り（色あせ・はげて白木が見える所）
        const fade = n2.mul(0.5).add(0.25)
        albedo.assign(mix(albedo, albedo.mul(vec3(1.15, 0.85, 0.8)).add(0.03), fade.mul(0.35)))
        const peel = smoothstep(0.78, 0.9, oNoise(uv.mul(4.0).add(seed.mul(6.0)))).mul(dirt)
        albedo.assign(mix(albedo, vec3(0.42, 0.32, 0.22), peel))
        gloss.assign(0.22)
      })
      .ElseIf(id.lessThan(22.5), () => {
        // タイル張り
        const ts = max(aux, 0.05).toVar()
        const cell = vec2(ts.mul(2.0), ts).toVar()
        const g = abs(fract(uv.div(cell).add(0.5)).sub(0.5)).mul(cell).toVar()
        const joint = max(lineAA(g.x, 0.004, fw.x), lineAA(g.y, 0.004, fw.y)).mul(smoothstep(0.01, 0.03, px).oneMinus())
        albedo.mulAssign(oHash(floor(uv.div(cell)).add(seed)).mul(0.16).add(0.9).mul(joint.mul(-0.3).add(1.0)))
        gloss.assign(0.2)
      })
      .ElseIf(id.lessThan(23.5), () => {
        // 土・砂利
        const t = gAlb(suv.div(1.5), 2)
        albedo.mulAssign(mix(vec3(1.0), t, 0.9))
        tn.assign(gNrm(suv.div(1.5), 2))
        gloss.assign(0.03)
      })
      .ElseIf(id.lessThan(24.5), () => {
        // 暗い奥
        albedo.mulAssign(0.25)
        ao.mulAssign(0.5)
      })
      .ElseIf(id.greaterThan(25.5), () => {
        // ステンレス・アルミ
        metal.assign(1.0)
        gloss.assign(0.55)
        albedo.mulAssign(oNoise(uv.mul(14.0)).mul(0.12).add(0.92))
      })
      .Else(() => {
        // 鉄（黒い鉄）
        albedo.mulAssign(n1.mul(0.1).add(0.9))
        const rust = smoothstep(0.75, 0.92, oNoise(uv.mul(3.0).add(seed.mul(2.0)))).mul(dirt)
        albedo.assign(mix(albedo, vec3(0.16, 0.07, 0.03), rust.mul(0.6)))
        gloss.assign(aux.mul(0.4).add(0.2))
        metal.assign(0.4)
      })
  }
  emit.assign(0.0)
  if (interior) {
    If(id.greaterThan(26.5), () => {
      interior({ id, aux, uv, fw, px, seed, nk, n1, n2, T, B, N, color: v.color, albedo, tn, ao, gloss, metal, emit })
    })
  }
  if (!flat) {
    // 汚れ: 足元のはね返り（地面から 0.9m）、まだら、色あせ
    const hg = wp.y.sub(v.ext.y).toVar()
    If(abs(N.y).lessThan(0.9).and(id.notEqual(24.0)), () => {
      const foot = smoothstep(-0.2, n2.mul(0.5).add(0.9), hg).oneMinus()
      albedo.mulAssign(dirt.mul(0.35).mul(foot).mul(n1.mul(0.4).add(0.6)).oneMinus())
      const blot = smoothstep(0.55, 0.85, oNoise(uv.mul(0.35).add(seed.mul(17.0))).mul(0.6).add(n1.mul(0.4)))
      albedo.mulAssign(dirt.mul(0.16).mul(blot).oneMinus())
    })
    albedo.assign(mix(albedo, gray(albedo), dirt.mul(0.12)))
  }
  // 法線の凹凸（遠くは弱く）
  const tnk = tn.xy.mul(nk)
  const Nd = normalize(T.mul(tnk.x).add(B.mul(tnk.y)).add(N.mul(max(tn.z, 0.3)))).toVar()
  return { N, Nd, albedo, ao, gloss, metal, emit }
}

/** 名前のある建物の細かい形のシェーダー */
export function createNamedMaterial() {
  const u = outdoorUniforms
  const m = unlit('namedSurfaces', { side: THREE.DoubleSide })
  const v = surfaceVaryings()
  m.colorNode = Fn(() => {
    const wp = v.world
    const s = namedSurface(v)
    const sh = townShadow(wp, s.N).toVar()
    const col = townLight(s.albedo.mul(s.metal.mul(-0.6).add(1.0)), s.Nd, s.ao, sh, 'named').toVar()
    if (paintFlat()) {
      // 平らな塗り: 照り返し・映り込みを省く
      col.addAssign(s.albedo.mul(namedLamps(wp, s.Nd)))
      col.addAssign(s.albedo.mul(townLampsEx(wp, s.Nd, float(1.0), float(0.08))).mul(s.ao))
      return outdoorHaze(col, wp)
    }
    // 鏡面: 太陽のハイライトと空の映り込み
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const H = normalize(V.add(u.uSunDir))
    const pw = mix(8.0, 160.0, s.gloss).toVar()
    const f0 = mix(0.04, 0.7, s.metal).toVar()
    // pow の底は clamp する（正面から見た画素では内積がわずかに 1 を超え、負の底の pow は NaN になって Bloom で大きな黒い四角に広がる）
    const fres = f0.add(f0.oneMinus().mul(pow(clamp(dot(s.Nd, V).oneMinus(), 0.0, 1.0), 5.0))).toVar()
    col.addAssign(
      u.uSunLight.mul(pow(max(dot(s.Nd, H), 0.0), pw).mul(pw.add(2.0)).div(8.0).mul(fres).mul(sh).mul(max(dot(s.Nd, u.uSunDir), 0.0)).mul(s.gloss)),
    )
    const R = reflect(V.negate(), s.Nd).toVar()
    const env = u.uSkyLight.mul(0.18).add(u.uSunLight.mul(0.03)).toVar()
    If(R.y.greaterThan(0.0), () => {
      env.assign(skyColor(normalize(R)).mul(u.uNight.mul(-0.6).add(1.0)))
    })
    col.addAssign(env.mul(fres).mul(mix(s.gloss.mul(0.4), 0.9, s.metal)).mul(mix(vec3(1.0), s.albedo.mul(2.5), s.metal)).mul(s.ao))
    // 夜の入口の灯り
    col.addAssign(s.albedo.mul(namedLamps(wp, s.Nd)))
    // 町の街灯・店先の灯り（灯りの表。名前のある建物の灯具は namedLamps で照らすので除く）
    col.addAssign(s.albedo.mul(townLampsEx(wp, s.Nd, float(1.0), float(0.08))).mul(s.ao))
    return outdoorHaze(col, wp)
  })()
  return m
}

/* -------------------------------------------------------------------------- */
/* 窓のガラス                                                                    */
/* -------------------------------------------------------------------------- */

/** 窓の種類（GlassBuilder の kind） */
export const GLASS = {
  /** 住まい（カーテン・レース） */
  house: 0,
  /** 事務所（ブラインド・天井の照明の列） */
  office: 1,
  /** 店のショーウィンドウ（明るい棚） */
  shop: 2,
  /** 喫茶・食堂（電球色のペンダント） */
  cafe: 3,
  /** ステンドグラス（色の小片と鉛の線） */
  stained: 4,
  /** 奥の見えないガラス（倉庫・階段室） */
  dark: 5,
  /** 障子（紙と組子。夜は光る） */
  shoji: 6,
  /** すりガラス（浴室・銭湯） */
  frosted: 7,
  /** 工房・工場（高い天井と蛍光灯） */
  workshop: 8,
} as const

/** 窓の明かりの決め方（GlassBuilder の cls）: 0 住まいの窓・1 事務所・2 店（開いている時間は昼も）・3 夜はいつも・4 点かない */
export const LIGHT_CLASS = { window: 0, office: 1, shop: 2, night: 3, none: 4 } as const

/** ガラスに映る空と町（上向きは空、地平線の近くと下向きは町の暗い色） */
const envRefl = Fn(([R]: [V3]) => {
  const u = outdoorUniforms
  const town = u.uSkyLight.mul(0.16).add(u.uSunLight.mul(0.035)).toVar()
  const c = vec3(town).toVar()
  If(R.y.greaterThan(0.0), () => {
    c.assign(mix(skyColor(R), town.mul(1.4), smoothstep(0.02, 0.35, R.y).oneMinus().mul(0.7)))
  })
  return c.mul(u.uNight.mul(-0.6).add(1.0))
})

/** 窓のガラスのシェーダー（部屋の奥・カーテン・桟・映り込み） */
export function createNamedGlassMaterial() {
  const u = outdoorUniforms
  const nu = namedUniforms
  const m = unlit('namedGlass')
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz))
  const vColor = varying(attribute<'vec3'>('color', 'vec3'))
  const vWin = varying(attribute<'vec4'>('aWin', 'vec4'))
  const vInfo = varying(attribute<'vec4'>('aInfo', 'vec4'))
  const vGrid = varying(attribute<'vec4'>('aGrid', 'vec4'))
  const vRoom = varying(attribute<'vec4'>('aRoom', 'vec4'))
  m.colorNode = Fn(() => {
    const flatWindow = paintFlat() ? outdoorPaint()?.window : undefined
    const wp = positionWorld
    const N = normalize(vNormal).toVar()
    const toCam = cameraPosition.sub(wp).toVar()
    const dist = length(toCam)
    const V = toCam.div(dist).toVar()
    const T = vec3(1.0, 0.0, 0.0).toVar()
    If(abs(N.y).lessThanEqual(0.95), () => {
      T.assign(normalize(cross(vec3(0.0, 1.0, 0.0), N)))
    })
    const U = normalize(cross(N, T)).toVar()
    const p = vWin.xy.toVar()
    const sz = max(vWin.zw, vec2(0.05)).toVar()
    const seed = vInfo.x.toVar()
    const kind = floor(vInfo.y.add(0.5)).toVar()
    const D = vInfo.z.toVar()
    const cls = floor(vInfo.w.add(0.5)).toVar()
    const fwp = max(fwidth(p), vec2(1e-4)).toVar()
    const px = max(fwp.x, fwp.y).toVar()
    // 点いているか
    const occ = select(
      cls.lessThan(0.5),
      nu.uWindows,
      select(cls.lessThan(1.5), nu.uOffice, select(cls.lessThan(2.5), nu.uOpen, select(cls.lessThan(3.5), max(nu.uShop, nu.uWindows), 0.0))),
    ).toVar()
    const wh = oHash(vec2(seed.mul(97.0), seed.mul(13.0).add(3.1)))
    const lit = select(cls.greaterThan(1.5).and(cls.lessThan(3.5)), occ, step(wh, occ)).toVar()
    const warm = fract(seed.mul(7.7))
    const lamp = mix(vec3(1.0, 0.66, 0.36), vec3(1.0, 0.84, 0.62), warm).toVar()
    If(kind.greaterThan(0.5).and(kind.lessThan(1.5)), () => {
      lamp.assign(mix(lamp, vec3(0.95, 0.95, 0.92), 0.6))
    })
    If(kind.greaterThan(7.5), () => {
      lamp.assign(vec3(0.92, 0.95, 1.0))
    })
    const bright = fract(seed.mul(3.3)).mul(0.5).add(0.75).toVar()
    If(kind.greaterThan(1.5).and(kind.lessThan(3.5)), () => {
      bright.assign(1.6)
    })
    const rd = vec3(dot(V.negate(), T), dot(V.negate(), U), max(dot(V, N), 0.0)).toVar()
    const R = reflect(V.negate(), N).toVar()
    const fres = pow(clamp(dot(N, V).oneMinus(), 0.0, 1.0), 5.0).mul(0.96).add(0.04).toVar()
    const refl = envRefl(R).toVar()
    const sh = townShadow(wp, N).toVar()
    const room = vec3(0.0).toVar()
    If(kind.greaterThan(3.5).and(kind.lessThan(4.5)), () => {
      // ステンドグラス: 色の小片（昼は外から暗く、点くと透けて光る）
      const cellSz = vec2(sz.x.div(6.0), 0.35).toVar()
      const cell = floor(p.div(cellSz))
      const h = oHash(cell.add(seed.mul(11.0))).toVar()
      const tint = select(
        h.lessThan(0.25),
        vec3(0.55, 0.12, 0.1),
        select(h.lessThan(0.5), vec3(0.12, 0.22, 0.55), select(h.lessThan(0.7), vec3(0.62, 0.5, 0.15), select(h.lessThan(0.85), vec3(0.16, 0.42, 0.22), vec3(0.7, 0.68, 0.6)))),
      ).toVar()
      const g = abs(fract(p.div(cellSz)).sub(0.5)).toVar()
      const lead = step(max(g.x, g.y), 0.44).oneMinus()
      room.assign(mix(tint.mul(dot(u.uSkyLight, LUMA).mul(0.04).add(0.06)).add(tint.mul(lamp).mul(lit).mul(1.4)), vec3(0.02), lead))
    })
      .ElseIf(kind.greaterThan(5.5).and(kind.lessThan(7.5)), () => {
        // 障子・すりガラス: 紙の白さ（昼は外の光、夜は中の灯りで光る）と組子
        const paper = select(kind.lessThan(6.5), vec3(0.78, 0.74, 0.64), vec3(0.55, 0.62, 0.6)).toVar()
        room.assign(paper.mul(u.uSkyLight.mul(0.35).add(u.uSunLight.mul(0.05).mul(sh))).add(paper.mul(lamp).mul(lit).mul(0.9)))
        If(kind.lessThan(6.5), () => {
          const g = abs(fract(p.div(vec2(0.3, 0.28))).sub(0.5)).mul(vec2(0.3, 0.28)).toVar()
          // 前の GLSL の k（1 − (…) × 0.0）はいつも 1 なので省いた
          const kumiko = max(smoothstep(0.007, fwp.x.add(0.007), g.x).oneMinus(), smoothstep(0.007, fwp.y.add(0.007), g.y).oneMinus())
          room.assign(mix(room, vec3(0.16, 0.11, 0.07).mul(u.uSkyLight.mul(0.6).add(lamp.mul(lit).mul(0.4))), kumiko))
        })
        fres.mulAssign(0.3)
      })
      .ElseIf(kind.greaterThan(4.5).and(kind.lessThan(5.5)), () => {
        room.assign(vec3(0.012, 0.012, 0.014).add(lamp.mul(lit).mul(0.15)))
      })
      .Else(() => {
        if (flatWindow) {
          // 平らな塗り: ガラスの色は外の塗りの window（部屋の奥・カーテン・棚は描かない）
          room.assign(flatWindow(lit, lamp.mul(bright), N, V, clamp(p.div(sz), 0.0, 1.0)))
          return
        }
        const office = select(kind.greaterThan(0.5).and(kind.lessThan(1.5)).or(kind.greaterThan(7.5)), 1.0, 0.0)
        const ri = roomInterior(p, sz, rd, 0.03, vRoom.x, vRoom.y, D, fract(seed.mul(5.31)), lit, lamp.mul(bright), office)
        room.assign(ri.color)
        If(ri.hitR.greaterThan(0.5), () => {
          room.assign(vColor.mul(0.4).mul(u.uSkyLight.mul(0.5).add(u.uSunLight.mul(0.1))))
        })
        // 店・喫茶: 奥の棚の明るい点（商品・瓶・時計）と、ペンダントの灯り
        If(kind.greaterThan(1.5).and(kind.lessThan(3.5)), () => {
          const q = p.add(rd.xy.mul(float(1.2).div(max(rd.z, 0.05)))).toVar()
          const shelf = step(0.55, fract(q.y.div(0.42))).mul(step(0.15, q.y)).mul(step(q.y, sz.y.mul(0.85)))
          const qc = floor(q.mul(vec2(6.0, 2.4))).toVar()
          const items = step(0.45, oHash(qc.add(seed.mul(5.0)))).mul(shelf)
          const itemC = mix(vec3(0.7, 0.55, 0.35), vec3(0.6, 0.62, 0.66), oHash(qc.add(3.0)))
          room.addAssign(itemC.mul(items).mul(lamp.mul(lit).mul(0.5).add(u.uSkyLight.mul(0.08))))
          If(kind.greaterThan(2.5), () => {
            // 喫茶: 窓の近くの天井から下がる電球
            const bp = vec2(fract(p.x.div(1.6)).mul(1.6).sub(0.8), p.y.sub(sz.y.mul(0.82)))
            const q2 = bp.add(rd.xy.mul(float(0.9).div(max(rd.z, 0.05)))).toVar()
            const bulb = exp(dot(q2, q2).mul(-60.0))
            room.addAssign(lamp.mul(bulb).mul(lit).mul(3.0))
          })
        })
        // 住まい: カーテン・レース
        If(kind.lessThan(0.5), () => {
          const pc = p.add(rd.xy.mul(float(0.08).div(max(rd.z, 0.05)))).toVar()
          const cv = fract(seed.mul(31.7)).toVar()
          const curtainC = mix(vec3(0.72, 0.68, 0.58), mix(vec3(0.45, 0.52, 0.6), vec3(0.6, 0.45, 0.36), fract(seed.mul(3.0))), step(0.6, fract(seed.mul(9.1))))
          const cl = fract(seed.mul(4.1)).mul(0.3).add(0.12)
          const cr = fract(seed.mul(6.7)).mul(0.3).add(0.12)
          const sideC = step(cl.mul(sz.x), pc.x).mul(step(pc.x, sz.x.mul(cr.oneMinus()))).oneMinus()
          const clothLit = curtainC
            .mul(sin(pc.x.mul(28.0).add(seed.mul(10.0))).mul(0.5).add(0.5).mul(-0.15).add(1.0))
            .mul(u.uSkyLight.mul(0.3).add(u.uSunLight.mul(0.04)).add(lamp.mul(lit).mul(bright).mul(0.75)))
          const a = select(cv.lessThan(0.6), sideC, select(cv.lessThan(0.8), 0.55, 0.0))
          const lace = vec3(0.8, 0.79, 0.76).mul(u.uSkyLight.mul(0.35).add(lamp.mul(lit).mul(0.6)))
          room.assign(mix(room, select(cv.lessThan(0.6).or(cv.greaterThanEqual(0.8)), clothLit, lace), a))
        }).ElseIf(kind.greaterThan(0.5).and(kind.lessThan(1.5)).and(fract(seed.mul(17.3)).lessThan(0.5)), () => {
          // 事務所: ブラインド
          const pc = p.add(rd.xy.mul(float(0.06).div(max(rd.z, 0.05)))).toVar()
          const level = sz.y.mul(fract(seed.mul(2.3)).mul(0.7).add(0.3))
          const slat = smoothstep(0.2, 0.5, abs(fract(pc.y.div(0.04)).sub(0.5))).mul(0.2).mul(smoothstep(0.01, 0.03, px).oneMinus()).oneMinus()
          room.assign(mix(room, vec3(0.7, 0.71, 0.7).mul(slat).mul(u.uSkyLight.mul(0.35).add(lamp.mul(lit).mul(0.6))), step(sz.y.sub(level), pc.y)))
        })
      })
    // ガラスの映り込みと太陽のきらめき（事務所・工房の大きなガラスは少し青灰色に染めて、浅い角度でも空が透けて見えないように）
    If(kind.greaterThan(0.5).and(kind.lessThan(1.5)).or(kind.greaterThan(7.5)), () => {
      refl.mulAssign(vec3(0.62, 0.68, 0.72))
    })
    // 平らな塗りは映り込みときらめきを省く（ガラスの色は窓の式・ステンドグラス・障子のまま）
    const col = (flatWindow ? vec3(room) : mix(room, refl.mul(0.75), clamp(fres.mul(0.75).add(0.05), 0.0, 0.8))).toVar()
    if (!flatWindow) col.addAssign(u.uSunLight.mul(pow(max(dot(R, u.uSunDir), 0.0), 400.0)).mul(2.5).mul(sh))
    // 桟（縦 cols・横 rows の格子と枠。アーチの所は放射の桟）
    const cols = vGrid.x.toVar()
    const rows = vGrid.y.toVar()
    const bar = vGrid.z.toVar()
    const archV = vGrid.w.toVar()
    const frame = float(0.0).toVar()
    /** 1 − smoothstep(w − px, w + px, x)（細い桟） */
    const barAA = (w: F, x: F) => smoothstep(w.sub(px), w.add(px), x).oneMinus()
    If(bar.greaterThan(0.0), () => {
      const edge = min(min(p.x, sz.x.sub(p.x)), min(p.y, sz.y.sub(p.y)))
      frame.assign(barAA(bar.mul(1.2), edge))
      If(archV.greaterThan(0.0).and(p.y.greaterThan(archV)), () => {
        const c = vec2(sz.x.mul(0.5), archV)
        const d = p.sub(c).toVar()
        const ang = atan(d.y, d.x)
        const spokes = max(cols, 2.0).add(1.0)
        const a = abs(fract(ang.div(3.14159).mul(spokes)).sub(0.5)).mul(3.14159).div(spokes).mul(length(d))
        frame.assign(max(frame, barAA(bar.mul(0.5), a)))
        const rr = abs(length(d).sub(sz.x.mul(0.5).mul(0.45)))
        frame.assign(max(frame, barAA(bar.mul(0.5), rr)))
      }).Else(() => {
        If(cols.greaterThan(1.5), () => {
          const cw = sz.x.div(cols)
          const fx = abs(fract(p.x.div(cw).add(0.5)).sub(0.5)).mul(cw)
          frame.assign(max(frame, barAA(bar.mul(0.5), fx)))
        })
        const top = select(archV.greaterThan(0.0), archV, sz.y).toVar()
        If(rows.greaterThan(1.5), () => {
          const rh = top.div(rows)
          const fy = abs(fract(p.y.div(rh).add(0.5)).sub(0.5)).mul(rh)
          frame.assign(max(frame, barAA(bar.mul(0.5), fy).mul(step(p.y, top.add(bar)))))
        })
        If(archV.greaterThan(0.0), () => {
          frame.assign(max(frame, barAA(bar.mul(0.6), abs(p.y.sub(archV)))))
        })
      })
      frame.mulAssign(smoothstep(0.03, 0.08, px).oneMinus())
    })
    col.assign(mix(col, townLight(vColor, N, float(0.9), sh, 'frame'), frame))
    return outdoorHaze(col, wp)
  })()
  return m
}

/* -------------------------------------------------------------------------- */
/* 看板・光る物                                                                   */
/* -------------------------------------------------------------------------- */

/** 看板の文字の絵（signs.ts のアトラス）を貼る面。aSign.x = 光り方（0 光らない・1 内から光る（店の時間）・2 夜は上から照らす・3 時計の文字盤） */
export function createNamedSignMaterial(atlas: THREE.Texture) {
  const nu = namedUniforms
  const uniforms = { uAtlas: texture(atlas) }
  const m = unlit('namedSigns', { side: THREE.DoubleSide, transparent: false })
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz))
  const vUv = varying(attribute<'vec2'>('aUv', 'vec2'))
  const vSign = varying(attribute<'vec2'>('aSign', 'vec2'))
  m.colorNode = Fn(() => {
    const wp = positionWorld
    const N = normalize(vNormal).mul(faceDirection).toVar()
    const t = uniforms.uAtlas.sample(vUv).toVar()
    If(t.a.lessThan(0.5), () => {
      Discard()
    })
    const albedo = pow(max(t.rgb, 0.0), vec3(2.2)).mul(0.9).toVar()
    const sh = townShadow(wp, N)
    const col = townLight(albedo, N, float(1.0), sh).toVar()
    col.addAssign(albedo.mul(namedLamps(wp, N)))
    const mode = floor(vSign.x.add(0.5)).toVar()
    If(mode.greaterThan(0.5).and(mode.lessThan(1.5)), () => {
      col.addAssign(albedo.mul(nu.uShop).mul(2.2).mul(nu.uLightGain))
    })
      .ElseIf(mode.greaterThan(1.5).and(mode.lessThan(2.5)), () => {
        col.addAssign(albedo.mul(vec3(1.0, 0.82, 0.6)).mul(nu.uShop).mul(0.9))
      })
      .ElseIf(mode.greaterThan(2.5), () => {
        col.addAssign(albedo.mul(vec3(1.0, 0.93, 0.8)).mul(nu.uClock).mul(1.4))
      })
    return outdoorHaze(col, wp)
  })()
  return withUniforms(m, uniforms)
}

/** 光る物（灯具・提灯・行灯・星の看板ランプ）。頂点の色 × 強さ。aMat.x = 点き方（0 夜の灯り・1 店の時間・2 窓の明かり・3 時計）、aMat.y = 強さ（kit の glow） */
export function createNamedGlowMaterial() {
  const u = outdoorUniforms
  const nu = namedUniforms
  const m = unlit('namedGlow')
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz))
  const vColor = varying(attribute<'vec3'>('color', 'vec3'))
  const vGlow = varying(attribute<'vec2'>('aMat', 'vec2'))
  m.colorNode = Fn(() => {
    const k = floor(vGlow.x.add(0.5)).toVar()
    const on = select(k.lessThan(0.5), nu.uNLampOn, select(k.lessThan(1.5), nu.uShop, select(k.lessThan(2.5), nu.uWindows, nu.uClock)))
    const N = normalize(vNormal)
    // 昼は乳白のガラス・紙の色（空の光）、夜は光る
    const day = vColor.mul(0.55).mul(u.uSkyLight.mul(0.7).add(u.uSunLight.mul(0.12).mul(max(dot(N, u.uSunDir), 0.0))).add(0.02))
    const col = mix(day, vColor.mul(vGlow.y).mul(nu.uLightGain), on)
    return outdoorHaze(col, positionWorld)
  })()
  return m
}
