import * as THREE from 'three/webgpu'
import { thinWidened } from '../thin'
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
  select,
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
import { oHash, oNoise, outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { townLight } from '../town/facades'
import { townShadow } from '../town/shadows'
import { townTextureUniforms } from '../town/townTextures'
import { townLampsEx } from '../town/lamps'
import { markPaint, outdoorPaint, paintEmit, paintLampLight } from '../paint'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/**
 * 名前のある建物の細かい形のシェーダー（町の建物・ラボの外観と同じ光: 太陽・空の光・町の太陽の影・空気遠近）。
 *
 * - 面（createNamedMaterial）: 頂点の色の平らな塗り（質感の写真・目地・汚れは描かない。暗い奥・金属の度合いだけ）。
 *   夜は入口の灯り（いちばん近い MAX_NAMED_LAMPS 個）が壁と地面を照らす
 * - 窓のガラス（createNamedGlassMaterial）: 窓ごとに開口の大きさ・部屋の奥行き・種類（住まい・事務所・店・喫茶・ステンドグラス・障子など）を持ち、
 *   ガラスの色は外の塗りの window（店・喫茶は店の正面のガラス）・ステンドグラス・障子と桟。点き方は町の窓明かりと同じ uniform（窓・事務所・店）
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

  // 質感の写真・目地・むら・汚れは描かず、頂点の色の平らな塗りにする（暗い奥・金属の度合いだけ残す）
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
  emit.assign(0.0)
  if (interior) {
    If(id.greaterThan(26.5), () => {
      interior({ id, aux, uv, fw, px, seed, nk, n1, n2, T, B, N, color: v.color, albedo, tn, ao, gloss, metal, emit })
    })
  }
  // 法線の凹凸（遠くは弱く）
  const tnk = tn.xy.mul(nk)
  const Nd = normalize(T.mul(tnk.x).add(B.mul(tnk.y)).add(N.mul(max(tn.z, 0.3)))).toVar()
  return { N, Nd, albedo, ao, gloss, metal, emit }
}

/** 名前のある建物の細かい形のシェーダー */
export function createNamedMaterial() {
  const m = markPaint(unlit('namedSurfaces', { side: THREE.DoubleSide }), 'light')
  // 格子の桟・手すりなどの細い形を、画素より細くなる遠くで画素の幅まで太らせる（outdoor/thin.ts）
  m.positionNode = thinWidened()
  const v = surfaceVaryings()
  m.colorNode = Fn(() => {
    const wp = v.world
    const s = namedSurface(v)
    const sh = townShadow(wp, s.N).toVar()
    const col = townLight(s.albedo.mul(s.metal.mul(-0.6).add(1.0)), s.Nd, s.ao, sh, 'named').toVar()
    // 照り返し・映り込みは描かない
    col.addAssign(paintLampLight(s.albedo, namedLamps(wp, s.Nd)))
    col.addAssign(paintLampLight(s.albedo, townLampsEx(wp, s.Nd, float(1.0), float(0.08))).mul(s.ao))
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

/** 窓のガラスのシェーダー（部屋の奥・カーテン・桟・映り込み） */
export function createNamedGlassMaterial() {
  const u = outdoorUniforms
  const nu = namedUniforms
  const m = markPaint(unlit('namedGlass'), 'window')
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz))
  const vColor = varying(attribute<'vec3'>('color', 'vec3'))
  const vWin = varying(attribute<'vec4'>('aWin', 'vec4'))
  const vInfo = varying(attribute<'vec4'>('aInfo', 'vec4'))
  const vGrid = varying(attribute<'vec4'>('aGrid', 'vec4'))
  m.colorNode = Fn(() => {
    const flatWindow = outdoorPaint().window
    const wp = positionWorld
    const N = normalize(vNormal).toVar()
    const toCam = cameraPosition.sub(wp).toVar()
    const dist = length(toCam)
    const V = toCam.div(dist).toVar()
    const T = vec3(1.0, 0.0, 0.0).toVar()
    If(abs(N.y).lessThanEqual(0.95), () => {
      T.assign(normalize(cross(vec3(0.0, 1.0, 0.0), N)))
    })
    const p = vWin.xy.toVar()
    const sz = max(vWin.zw, vec2(0.05)).toVar()
    const seed = vInfo.x.toVar()
    const kind = floor(vInfo.y.add(0.5)).toVar()
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
      })
      .ElseIf(kind.greaterThan(4.5).and(kind.lessThan(5.5)), () => {
        room.assign(vec3(0.012, 0.012, 0.014).add(lamp.mul(lit).mul(0.15)))
      })
      .Else(() => {
        // ガラスの色は外の塗りの window（部屋の奥・カーテン・棚は描かない）
        // 店・喫茶のガラス（kind 2・3）は店の正面のガラスとして（中の灯りと棚の影・扉は塗りの側で描く）
        room.assign(flatWindow(lit, lamp.mul(bright), N, V, clamp(p.div(sz), 0.0, 1.0), select(kind.greaterThan(1.5).and(kind.lessThan(3.5)), 1.0, 0.0)))
        return
      })
    // 映り込みときらめきは描かない（ガラスの色は窓の式・ステンドグラス・障子のまま）
    const col = vec3(room).toVar()
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
  const m = markPaint(unlit('namedSigns', { side: THREE.DoubleSide, transparent: false }), 'light')
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
    const col = townLight(albedo, N, float(1.0), sh, 'prop').toVar()
    col.addAssign(albedo.mul(namedLamps(wp, N)))
    const mode = floor(vSign.x.add(0.5)).toVar()
    // 光る分は外の塗りの光る物の色（emit）に通す
    If(mode.greaterThan(0.5).and(mode.lessThan(1.5)), () => {
      col.addAssign(paintEmit(albedo.mul(nu.uShop).mul(2.2).mul(nu.uLightGain)))
    })
      .ElseIf(mode.greaterThan(1.5).and(mode.lessThan(2.5)), () => {
        col.addAssign(paintEmit(albedo.mul(vec3(1.0, 0.82, 0.6)).mul(nu.uShop).mul(0.9)))
      })
      .ElseIf(mode.greaterThan(2.5), () => {
        col.addAssign(paintEmit(albedo.mul(vec3(1.0, 0.93, 0.8)).mul(nu.uClock).mul(1.4)))
      })
    return outdoorHaze(col, wp)
  })()
  return withUniforms(m, uniforms)
}

/** 光る物（灯具・提灯・行灯・星の看板ランプ）。頂点の色 × 強さ。aMat.x = 点き方（0 夜の灯り・1 店の時間・2 窓の明かり・3 時計）、aMat.y = 強さ（kit の glow） */
export function createNamedGlowMaterial() {
  const nu = namedUniforms
  const m = markPaint(unlit('namedGlow'), 'glow')
  const paint = outdoorPaint()
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz))
  const vColor = varying(attribute<'vec3'>('color', 'vec3'))
  const vGlow = varying(attribute<'vec2'>('aMat', 'vec2'))
  m.colorNode = Fn(() => {
    const k = floor(vGlow.x.add(0.5)).toVar()
    const on = select(k.lessThan(0.5), nu.uNLampOn, select(k.lessThan(1.5), nu.uShop, select(k.lessThan(2.5), nu.uWindows, nu.uClock)))
    const N = normalize(vNormal)
    // 昼は乳白のガラス・紙の色（空の光）、夜は光る
    const day = paint.light(vColor.mul(0.55), N, float(1.0), float(1.0), 'prop')
    const col = mix(day, paintEmit(vColor.mul(vGlow.y).mul(nu.uLightGain)), on)
    return outdoorHaze(col, positionWorld)
  })()
  return m
}
