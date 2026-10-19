import type * as THREE from 'three/webgpu'
import { TOWN_PAINT } from '../anime/townPaint'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>
type V3 = Node<'vec3'>

/**
 * 外の塗りの口（町・空・水・地形・建物・木・乗り物・名前のある建物とその中の材質の、光と色の式を使う側が差し替える）。
 *
 * 地図の既定の見た目（リアル寄りの描き方）は変えない: 塗りを入れなければ（configureOutdoorPaint を呼ばない・null）、どの材質も前とまったく同じ
 * 式を組む。入れると、材質を組み立てるとき（シェーダーを作るとき）に、下の式を前の式の代わりに呼ぶ。式は TSL のノードを組む関数（呼んだ所に式が入る）。
 * 配色や時刻の値は、使う側が自分の uniform を作って式の中で読む（地図は使う側の値を持たない）。
 *
 * 入れるのは、材質を作る前（町の口 createTown のあと、描き始める前。kanon-lab は src/townBinding.ts）。描き始めたあとで替えても、
 * 作り終えた材質は変わらない（替えるときは作り直す）。
 *
 * - 面の種類（PaintSurface）: 光の式に、どの物の面かを渡す（配色の表を物ごとに引けるように）
 * - flat: 細かい模様（質感の写真・汚れ・まだらのノイズ・窓の奥の部屋とカーテン・水面の映り込み・つやの照り返し）を省き、平らな色の塗り分けにする。
 *   形の決まった模様（窓の格子・枠・店の看板の帯・棟の帯・ベランダの床）は残す
 */

/** 光の式に渡す面の種類 */
export type PaintSurface =
  /** 地面（芝・土・舗装・道） */
  | 'ground'
  /** 建物の外壁・屋根（名前のない建物） */
  | 'wall'
  | 'roof'
  /** 窓の枠・閉めた雨戸 */
  | 'frame'
  /** 構造物（岸壁・高架・橋・灯台・クレーンなど） */
  | 'structure'
  /** 木と植え込み・草むら */
  | 'tree'
  | 'grass'
  /** 建物の小物（ベランダ・室外機・看板・屋上の物） */
  | 'prop'
  /** 名前のある建物の細かい形 */
  | 'named'
  /** ラボの外観とまわりのセット */
  | 'site'
  /** 乗り物（車両・船・ホバー・ケーブルカー・ゴンドラ）と線路・駅の物 */
  | 'vehicle'
  /** ガーデンドームの骨と中の植物 */
  | 'dome'
  /** そのほか */
  | 'other'

/** 外の塗り（式はどれも省ける。省いた式は前の式のまま） */
export interface OutdoorPaint {
  /**
   * 太陽と空の光（前の townLight・outdoorShade の代わり）。albedo = 面の色（リニア）、N = 世界の法線、ao = 環境光の遮り、sh = 太陽の影（1 = 日なた）。
   * 戻り値はトーンマッピングの前の色（HDR のリニア）
   */
  light?: (albedo: V3, N: V3, ao: F, sh: F, surface: PaintSurface) => V3
  /** 空気遠近（前の outdoorHaze の代わり）。col = 色、wp = 世界の位置 */
  haze?: (col: V3, wp: V3) => V3
  /** 空の色（前の skyColor の代わり。空の球のほか、ガラス・水・車体の映り込みも読む）。d = 向き（単位） */
  sky?: (d: V3) => V3
  /** 空の球の雲・太陽（と月など）を描く式（前の雲と太陽の円盤の代わり）。d = 向き、col = sky(d) の色 */
  skyDome?: (d: V3, col: V3) => V3
  /**
   * 窓のガラス（flat のとき。名前のない建物・名前のある建物の窓）。lit = 点いている度合い（0〜1）、lamp = 点いた部屋の灯りの色（明るさ込み）、
   * N = 窓の面の法線、V = 視線（面からカメラへ）、cell = 窓の中の位置（0〜1。左下が 0）、shop = 1 階の店の正面のガラス（ショーウィンドウと扉）か
   * （1 = 店・0 = ほかの窓。渡さない呼び方もある）。戻り値はトーンマッピングの前の色
   */
  window?: (lit: F, lamp: V3, N: V3, V: V3, cell: Node<'vec2'>, shop?: F) => V3
  /**
   * 水面（flat のとき）。N = 波の法線、V = 視線、wp = 世界の位置、sea = 海か（川・運河・池は false）、lamps = 映った灯りの色。
   * 戻り値は空気遠近の前の色
   */
  water?: (N: V3, V: V3, wp: V3, sea: boolean, lamps: V3) => V3
  /**
   * 街灯・提灯・店先の灯りが面を照らす強さの減り方（灯り 1 つごと。前の距離の減衰の代わり）。att = 前の減衰（power ÷ (1 + 0.09 d²) × 縁の消え）、
   * power = 灯りの強さ、d = 灯りまでの距離（m）、R = 届く距離（m）
   */
  lampFalloff?: (att: F, power: F, d: F, R: F) => F
  /**
   * 街灯・提灯・店先の灯りが照らした面の色（前の albedo × 照度の代わり）。albedo = 面の色（リニア）、E = 灯りの照度の和（色込み。lampFalloff を通した後）。
   * 町の建物の壁・地面・名前のある建物・小物・地形が読む（乗り物・木などは前の albedo × 照度のまま）
   */
  lampLight?: (albedo: V3, E: V3) => V3
  /** 光の点（町の灯り・遠くの窓明かり）の形（前の芯とにじみの代わり）。r = 点の中心からの距離（0〜1）、core = 芯の半径（0〜1）。戻り値は明るさの倍率 */
  glow?: (r: F, core: F) => F
  /**
   * 中のある建物の中の光（前の interiorShade の拡散の代わり）。albedo = 面の色、E = 窓・日なた・灯り・まわりの明るさの照度の和、amb = 組（部屋）ごとの
   * まわりの明るさ、N = 法線、ao。戻り値は拡散の色（つやの照り返しは flat のとき足さない）
   */
  interior?: (albedo: V3, E: V3, amb: V3, N: V3, ao: F) => V3
  /**
   * 光る物の色（看板の文字・灯具・信号・前照灯・行き先の表示・LED・ネオン・ドームの葉脈・灯台の光の帯）。col = 前の光の色（HDR のリニア。強さ込み）。
   * 戻り値はトーンマッピングの前の色。flat のときは、地図の側でも光の模様（ゆらぎのノイズ・にじみのぼかし）を省いて、形の決まった光にする
   */
  emit?: (col: V3) => V3
  /**
   * 透けるガラス（flat のとき。乗り物の窓・ショーウィンドウ・ドームと温室のガラス・駅の屋根）。N = 見ている側の面の法線、V = 視線（面からカメラへ）、
   * wp = 世界の位置、room = 向こうの灯りの色（明るさ込み。消えていれば 0）。戻り値は rgb（トーンマッピングの前の色）と透け a（0〜1）
   */
  glass?: (N: V3, V: V3, wp: V3, room: V3) => Node<'vec4'>
  /**
   * 流れ落ちる滝（flat のとき。ガーデンドームの大滝「天の水」・回廊から落ちる細い滝）。u = 幕の横の位置（0〜1）、v = 落ちた割合（0〜1。上の口が 0）、
   * L = 幕の長さ（m）、t = 時刻（秒）、light = 水の白に掛ける光（空・太陽・夜の中の明るさ。HDR のリニア）。
   * 戻り値は rgb（空気遠近の前の色）と不透明度 a（0〜1）。入れなければ地図の flat の筋（2 段の平らな白）
   */
  fall?: (u: F, v: F, L: F, t: F, light: V3) => Node<'vec4'>
  /**
   * 霧・しぶきの粒の形（flat のとき。ガーデンドームの霧の噴霧・滝つぼのしぶき）。r2 = 粒の中心からの距離の 2 乗（0〜1）、spray = しぶきの粒か（1 = しぶき・0 = 霧）。
   * 戻り値は不透明度の倍率（粒ごとの濃さ・漂い方は地図の側で掛ける）。入れなければ地図の flat の丸（縁のくっきりした 2 段のうすさ）
   */
  particle?: (r2: F, spray: F) => F
  /** 細かい模様を省く（上の説明） */
  flat?: boolean
}

/** 入れた外の塗り（undefined = 入れていない。既定の町のアニメ塗り TOWN_PAINT。モジュールの読み込みの順に頼らないよう、読むときに決める） */
let configured: OutdoorPaint | null | undefined

/**
 * 外の塗りを入れる（材質を作る前に 1 回。null で前の見た目に戻す。作り終えた材質は変わらない）
 */
export function configureOutdoorPaint(next: OutdoorPaint | null) {
  configured = next
}

/** 今の外の塗り（既定は町のアニメ塗り world/anime/townPaint.ts の TOWN_PAINT。材質を組み立てるときに読む） */
export function outdoorPaint(): Readonly<OutdoorPaint> | null {
  return configured === undefined ? TOWN_PAINT : configured
}

const paintNow = () => outdoorPaint()

/** 細かい模様を省くか（材質を組み立てるときに読む） */
export const paintFlat = () => paintNow()?.flat === true

/** 光る物の色（外の塗りの emit を入れていれば、それを通す。入れていなければ col のまま） */
export const paintEmit = (col: V3): V3 => {
  const p = paintNow()
  return p?.emit ? p.emit(col) : col
}

/** 灯りが照らした面の色（外の塗りの lampLight を入れていれば、それを通す。入れていなければ albedo × 照度） */
export const paintLampLight = (albedo: V3, E: V3): V3 => {
  const p = paintNow()
  return p?.lampLight ? p.lampLight(albedo, E) : albedo.mul(E)
}

/**
 * 材質に付ける塗りの印の名前（material.userData のキー）。外の塗りを入れているときだけ、塗りの口を通った材質に付ける（使う側の監査が読む。
 * 描き方は変えない）。値は塗りの種類（PaintMarkKind）
 */
export const PAINT_MARK = 'outdoorPaint'

/**
 * 塗りの種類: light（光の式）・flat（平らな色の塗り分け）・window・water・sky・interior・glow（意図して平らに光らせる物。看板の文字・灯り・LED など）・
 * helper（色を書かない・当たりだけの物）
 */
export type PaintMarkKind = 'light' | 'flat' | 'window' | 'water' | 'sky' | 'interior' | 'glow' | 'helper'

/** 材質に塗りの印を付ける（外の塗りを入れていなければ何もしない）。材質を返す */
export function markPaint<M extends { userData: Record<string, unknown> }>(m: M, kind: PaintMarkKind): M {
  if (paintNow()) m.userData[PAINT_MARK] = kind
  return m
}
