import * as THREE from 'three/webgpu'
import type { Outdoor } from '../environment/daylight'

/**
 * ラボのアニメ塗りの配色の表（world/anime/。地図の見た目）。色はどれも「画面に出る sRGB の色」（トーンマッピング・露出のあと。material.ts が ACES の逆に通す）。
 *
 * 1. 役割の下地（ANIME_PALETTE）: 物ごとの塗りの色の元。素材の名前（sakurami-cho のラボの素材と KB-001 の素材。BY_NAME）で役割を引く
 * 2. 時刻の配色（ANIME_TIMES）: 昼・夕方（朝も）・夜・夜中の 4 つ。下地に掛ける色味と明るさ、影の色、光の当たる側の色、光の向き、
 *    ネオンの照り返し・金属の縁の強さ。今の時刻（町の外の状態 outdoor の太陽の高さ・夜・夜中の度合い）から重みを出して、なめらかに混ぜる（timeWeights・mixTime）
 *
 * 夜・夜中は ZZZ の夜の背景のように、下地を暗く・青紫に沈め、光る物（ネオン・画面・ホロ・Qコア。塗りを変えない）と、その照り返し・金属の縁が浮くようにする。
 * 昼は明るい青灰のラボ、夕方は窓からの橙の光と紺〜藍の影
 */

/** 物の役割（配色の表の行） */
export type AnimeRole =
  | 'floor'
  | 'deck'
  | 'wall'
  | 'backing'
  | 'ceiling'
  | 'frame'
  | 'body'
  | 'panel'
  | 'dark'
  | 'steel'
  | 'aluminium'
  | 'chrome'
  | 'white'
  | 'screen'
  | 'glass'
  | 'pcb'
  | 'desk'
  | 'mat'
  | 'soil'
  | 'hazard'
  | 'kbWhite'
  /** 色を物ごと（インスタンス・頂点）に持つ物（植物の葉・ソファ・資料の紙）。下地は明るさだけ（元の色を見せる） */
  | 'tinted'
  /** 張り紙・付箋・額・ステッカー・床の文字（地図の絵をそのまま見せる。下地は明るさだけ） */
  | 'content'
  /** 元の色の色味を生かす物（ヘッドホンの青・ひらき札の裏板の若葉色。autoColor） */
  | 'keep'
  /** 名前の表に無い物（元の色から決める。autoColor。使う側があとから足した物など） */
  | 'auto'

/** 金属の縁のハイライトを入れる役割 */
export const METAL_ROLES: ReadonlySet<AnimeRole> = new Set(['steel', 'aluminium', 'chrome', 'body', 'frame', 'panel'])

/** 役割の下地の色（画面に出る sRGB。夜の配色の明るさ 1 の値。暗いサイバーなラボの紺〜青灰、明るい金属は青みの灰） */
export const ANIME_PALETTE: Record<Exclude<AnimeRole, 'keep' | 'auto'>, string> = {
  floor: '#3d4064',
  deck: '#33365a',
  wall: '#2b3b58',
  backing: '#171b32',
  ceiling: '#1d2240',
  frame: '#22283f',
  body: '#3e4868',
  panel: '#4a5676',
  dark: '#262c44',
  steel: '#8290ac',
  aluminium: '#97a2bc',
  chrome: '#b6c1d6',
  white: '#c6cddc',
  screen: '#121829',
  glass: '#22335a',
  pcb: '#1f4a6e',
  desk: '#38425f',
  mat: '#24466f',
  soil: '#3e3234',
  hazard: '#e0aa2e',
  kbWhite: '#e2e8f2',
  tinted: '#d0d6d0',
  content: '#e6e6e6',
}

/**
 * 素材の名前 → 役割（sakurami-cho の world/materials/labMaterials.ts の欄の名前と、殻・什器がじかに作る素材の名前。KB-001 の素材は src/kb001/KB001.tsx）。
 * 名前の無い素材・この表に無い名前は auto（元の色から）
 */
export const BY_NAME: Record<string, AnimeRole> = {
  // 共有の素材
  wallPanel: 'wall',
  darkMetal: 'body',
  blackMetal: 'frame',
  steel: 'steel',
  aluminium: 'aluminium',
  chrome: 'chrome',
  whitePaint: 'white',
  rubber: 'dark',
  plasticDark: 'dark',
  plasticGrey: 'panel',
  glass: 'glass',
  tintedGlass: 'glass',
  screenOff: 'screen',
  perforated: 'panel',
  pcb: 'pcb',
  benchTop: 'desk',
  // 殻（床・壁・天井・中二階・扉・見学エントランス）
  labFloorReflector: 'floor',
  labFloor: 'floor',
  floorSeam: 'backing',
  floorStencil: 'content',
  wallBacking: 'backing',
  ceiling: 'ceiling',
  mezzanineFloor: 'deck',
  exteriorGlass: 'glass',
  visionGlass: 'glass',
  doorMat: 'deck',
  enamelSign: 'content',
  signBacking: 'keep',
  sofaFabric: 'tinted',
  archivePaper: 'tinted',
  framedPicture: 'content',
  // 什器
  coreGlassShell: 'glass',
  dangerLine: 'hazard',
  cuttingMat: 'mat',
  assemblyMat: 'mat',
  drawerAcrylic: 'glass',
  drawerLabel: 'white',
  floorMarking: 'content',
  keycap: 'dark',
  chairFabric: 'dark',
  deskMat: 'dark',
  headphoneBlue: 'keep',
  mugCeramic: 'white',
  pottingSoil: 'soil',
  leaf: 'tinted',
  sticker: 'content',
  stickyNote: 'content',
  // KB-001（src/kb001/KB001.tsx）
  kbArmor: 'kbWhite',
  kbScreen: 'screen',
  kbLine: 'dark',
  kbMechGrey: 'steel',
  kbMechDark: 'body',
  kbBezel: 'frame',
}

/** 時刻の配色の名前 */
export type AnimeTimeName = 'day' | 'dusk' | 'night' | 'deep'

/** 時刻の配色の 1 行 */
export interface AnimeTime {
  /** 下地に掛ける色味と明るさ（下地 × tint × value） */
  tint: string
  value: number
  /** 影の色の倍率（下地に掛ける。暗く・青紫寄り） */
  shade: string
  /** 光の当たる側の色の倍率（下地に掛ける。夕方は橙） */
  key: string
  /**
   * 光の向き（世界の座標。光が来る方向。ラボの奥 −z を向いて +x が右、+z が手前（南のガラス壁））。
   * sun が 1 なら、太陽の向き（高さは keyElevation の範囲に収める）へ寄せる
   */
  keyDir: [number, number, number]
  sun: number
  /** ネオンの照り返しの強さ・金属の縁の強さ（0〜1） */
  neon: number
  rim: number
}

/**
 * 時刻の配色の表（仮の決め: 2026-10-18。世界観の色は setting-book の桜見町・ラボの描写から。夜のラボは「暗い中に装置の光」）
 * - day   … 昼（太陽が 10° より高い）。明るい青灰。光は窓の太陽寄り、影は薄紫
 * - dusk  … 夕方・朝（太陽の高さ −6°〜10°）。下地を少し暖かく、光の当たる側を橙に、影を藍（紺寄りの紫）に。
 *            前は下地を桃色・影を赤紫にしていたが、ラボの下地の紺と重なって、工作台など室内が紫一色になった（2026-10-18 に直した）
 * - night … 夜（太陽 −10° より低い）。下地を暗い紺へ沈め、影は深い藍。ネオンの照り返しと金属の縁を強く
 * - deep  … 夜中（0〜3 時）。夜よりさらに暗く、青紫へ
 */
export const ANIME_TIMES: Record<AnimeTimeName, AnimeTime> = {
  day: { tint: '#f4f6ff', value: 1.18, shade: '#7c76c4', key: '#fffaf2', keyDir: [0.55, 0.75, 0.38], sun: 0.6, neon: 0.45, rim: 0.65 },
  dusk: { tint: '#f8dccc', value: 1.2, shade: '#585a9e', key: '#ffae78', keyDir: [0.55, 0.6, 0.58], sun: 0.85, neon: 0.7, rim: 0.85 },
  night: { tint: '#b4bce8', value: 0.6, shade: '#4a4796', key: '#d2deff', keyDir: [0.45, 0.85, 0.28], sun: 0, neon: 1, rim: 1 },
  deep: { tint: '#a4a0dc', value: 0.4, shade: '#3c3684', key: '#c4cfff', keyDir: [0.4, 0.88, 0.26], sun: 0, neon: 1.1, rim: 1 },
}

/** 太陽の向きへ寄せるときの、光の高さ（度）の範囲（低すぎる太陽で影が部屋じゅうに伸びないように） */
const KEY_ELEVATION: [number, number] = [28, 62]

const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b)

/** 時刻の配色の重み（足すと 1）。太陽の高さ（度）・夜中の度合いから */
export function timeWeights(o: Pick<Outdoor, 'sun' | 'deepNight'>, out: Record<AnimeTimeName, number>): Record<AnimeTimeName, number> {
  const alt = o.sun.altitude
  const day = smooth(4, 14, alt)
  const night = 1 - smooth(-11, -4, alt)
  const dusk = Math.max(0, 1 - day - night)
  const deep = night * THREE.MathUtils.clamp(o.deepNight, 0, 1)
  out.day = day
  out.dusk = dusk
  out.night = night - deep
  out.deep = deep
  return out
}

/** 混ぜた時刻の配色（material.ts の uniform に書く値。色はリニアに直さず、画面の sRGB の値のまま混ぜる） */
export interface AnimeTimeMix {
  base: THREE.Vector3
  shade: THREE.Vector3
  key: THREE.Vector3
  keyDir: THREE.Vector3
  neon: number
  rim: number
}

export function createTimeMix(): AnimeTimeMix {
  return { base: new THREE.Vector3(), shade: new THREE.Vector3(), key: new THREE.Vector3(), keyDir: new THREE.Vector3(0, 1, 0), neon: 0, rim: 0 }
}

const _c = new THREE.Color()
const _v = new THREE.Vector3()
const _sun = new THREE.Vector3()
/** 色を「画面に出る値」のリニア（three の Color は sRGB の文字列をリニアにする）で返す */
const lin = (hex: string) => (_c.set(hex), _v.set(_c.r, _c.g, _c.b))

/** 重みで時刻の配色を混ぜる。sunDir はラボから太陽へ向かう向き（outdoor.sunDir） */
export function mixTime(w: Record<AnimeTimeName, number>, sunDir: THREE.Vector3, out: AnimeTimeMix): AnimeTimeMix {
  out.base.set(0, 0, 0)
  out.shade.set(0, 0, 0)
  out.key.set(0, 0, 0)
  out.keyDir.set(0, 0, 0)
  out.neon = 0
  out.rim = 0
  // 太陽の向き（高さを KEY_ELEVATION に収める。地平線の下なら真上寄り）
  const h = Math.hypot(sunDir.x, sunDir.z)
  const el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(Math.atan2(sunDir.y, Math.max(h, 1e-6))), ...KEY_ELEVATION))
  if (h > 1e-4) _sun.set((sunDir.x / h) * Math.cos(el), Math.sin(el), (sunDir.z / h) * Math.cos(el))
  else _sun.set(0, 1, 0)
  for (const name of Object.keys(ANIME_TIMES) as AnimeTimeName[]) {
    const k = w[name]
    if (k <= 0) continue
    const t = ANIME_TIMES[name]
    out.base.addScaledVector(lin(t.tint), k * t.value)
    out.shade.addScaledVector(lin(t.shade), k)
    out.key.addScaledVector(lin(t.key), k)
    _v.set(...t.keyDir).normalize().lerp(_sun, t.sun).normalize()
    out.keyDir.addScaledVector(_v, k)
    out.neon += t.neon * k
    out.rim += t.rim * k
  }
  if (out.keyDir.lengthSq() < 1e-8) out.keyDir.set(0, 1, 0)
  out.keyDir.normalize()
  return out
}

const _hsl = { h: 0, s: 0, l: 0 }

/** 元の色から下地を決める（名前で決まらない物。暗い色を中間の暗さへ持ち上げ、色味は残す。灰色は紺寄りの灰に） */
export function autoColor(source: THREE.Color): THREE.Color {
  source.getHSL(_hsl, THREE.SRGBColorSpace)
  const grey = _hsl.s < 0.15
  const h = grey ? 0.63 : _hsl.h
  const s = grey ? 0.24 : Math.min(0.7, Math.max(0.3, _hsl.s))
  const l = 0.17 + _hsl.l * 0.62
  return new THREE.Color().setHSL(h, s, Math.min(0.82, l), THREE.SRGBColorSpace)
}

/** 役割を素材の名前で引く（無ければ auto） */
export function roleOf(name: string): AnimeRole {
  return BY_NAME[name] ?? 'auto'
}

/** 役割の下地の色（keep・auto は元の色から） */
export function roleColor(role: AnimeRole, source: THREE.Color): THREE.Color {
  if (role === 'keep' || role === 'auto') return autoColor(source)
  return new THREE.Color(ANIME_PALETTE[role])
}
