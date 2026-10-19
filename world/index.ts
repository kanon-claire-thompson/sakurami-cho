/**
 * 入口 world（three: 町・ラボ・名前のある建物・中のある建物・公共交通・えきもり・町の音・町の口 createTown。docs/design/map-split.md §7）。
 *
 * 公開の口（段 6 の終わり 6-7 に決めた。docs/design/map-split.md §10・docs/usage.md の「公開の口」）。選んだ名前だけを出す（export * はしない。
 * 名前がぶつからないように・出す名前が公開の口になるので）。出すのは、例のアプリ（examples/town-walker）が使う物と、ラボの差し込み口（configureLab）、
 * 町の口の引数・毎コマの段・注目点・出来事の型。ここにはコードを書かない（export だけ）。
 * kanon-lab はここからは読まず、深いパス（sakurami-cho/world/…）で読む
 * （読み込みの時に形や素材を作る物・RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())・registerLabAnchor などがあり、index から読むと評価の順が変わるため）
 */
// 町の口（1 ページに 1 つ）と、その引数・毎コマの段（begin・update・view の TownFrame）・注目点・出来事・時計・読み込みの状態の型
export { createTown } from './createTown'
export type { Town, TownCreateOptions } from './createTown'
export type { TownClock, TownEventMap, TownFocus, TownFrame, TownStatus } from './townHost'
// 背景と霧の色・ラボの看板と画面のフォント
export { PALETTE } from './palette'
export { FONTS } from './textures/canvas'
// ラボの差し込み口（什器の入力の値・差し込み口の中身・画面）
export { configureLab } from './lab/labHost'
// 人を追うカメラ（例のアプリのために足した部品。段 6）
export { createFollowCamera } from './followCamera'
export type { FollowCamera, FollowCameraOptions, FollowTarget } from './followCamera'
