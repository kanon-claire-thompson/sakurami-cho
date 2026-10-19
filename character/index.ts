/**
 * 入口 character（three + three-vrm: Character。VRM の読み込み・姿勢・手・歩き・道探し・乗り降り・旅程を進める。docs/design/map-split.md §7）。
 *
 * 公開の口（段 6 の終わり 6-7 に決めた。docs/design/map-split.md §10・docs/usage.md の「公開の口」）。選んだ名前だけを出す（export * はしない。
 * 名前がぶつからないように・出す名前が公開の口になるので）。出すのは、例のアプリ（examples/town-walker）が使う物と、通り道を差し替える口（configureNav）・
 * 見た目の既定の値、それらの引数・返り値の型。ここにはコードを書かない（export だけ）。
 * kanon-lab はここからは読まず、深いパス（sakurami-cho/character/…）で読む（index から読むと、使わない物まで先に評価されて、モジュールの評価の順が変わるため）
 */
// キャラクター（Character を作る）と、毎コマの動かし方（drivers）の型
export { createCharacter } from './avatar/createCharacter'
export type { CharacterOptions, CharacterSpawnPoint } from './avatar/createCharacter'
export type { Character, CharacterDriver } from './avatar/character'
// 見た目（VRM と .vrma）・既定の値
export { createCharacterVisual } from './avatar/characterVisual'
export type { CharacterVisual, CharacterVisualClip, CharacterVisualOptions, CharacterVisualStatus } from './avatar/characterVisual'
export { VISUAL_DEFAULTS } from './avatar/visualConfig'
export type { VisualConfig } from './avatar/visualConfig'
// アニメ塗りのラボ・町に立つ VRM の MToon の合わせ（既定の値と、材質ごと・mesh ごとの上書き）
export { configureVrmAnime, VRM_ANIME } from './avatar/vrmAnime'
export type { VrmAnimeLineRule, VrmAnimeMaterialRule, VrmAnimeOverrides } from './avatar/vrmAnime'
// 歩き（毎コマ進める・立ち寄り先へ置く・歩かせる・止める）と通り道（点と障害物を差し替える）
export { goTo, placeAt, stopWalking, updateLocomotion } from './avatar/locomotion'
export { configureNav } from './avatar/nav'
export type { NavConfig } from './avatar/nav'
// 乗り物（乗っている間に人を動かす標準の順・時計を進めてよい人・観覧車に乗る・降りる。乗れない理由は種類と値で、字は wheelProblemText）
export { driveRides } from './ride/drive'
export { setWarpPermit } from './ride/warp'
export type { RideTime } from './ride/warp'
export { advanceWheelTo, beginWheelBoarding, cancelWheelBoarding, requestWheelAlight, WHEEL_EXIT_OPEN_DEG, wheelBoardProblem, wheelProblemText } from './ride/ride'
export type { WheelProblem } from './ride/ride'
// ホバーを呼ぶ（例のアプリの「ホバーを呼ぶ」のために足した部品。#9。乗るのは旅程の via: 'hover'）と、ホバーの様子
export { hoverStatus, summonHover } from './ride/hoverRide'
export type { HoverStatus } from './ride/hoverRide'
// 町の中の移動（旅程。作れない理由は種類と値で、字は travelProblemText）
export { cancelTravel, driveTravel, isTravelProblem, startTravel, traveling, travelProblemText, travelState } from './avatar/travel'
export type { TravelCut, TravelPlan, TravelProblem, TravelRequest, TravelRouteId, TravelTime } from './avatar/travel'
// 人を直接動かす（WASD・クリック。例のアプリのために足した部品。段 6）
export { canStand, directState, driveDirect, pickGround, setDirectInput, stopDirect, walkToPoint } from './avatar/direct'
// 跳ぶ（例のアプリのスペースキーのために足した部品。#8。毎コマ進めるのは updateLocomotion）
export { jump } from './avatar/jump'
// ワープ（例のアプリのために足した部品。段 6）
export { placeAtPoint, teleport, townSpots } from './avatar/teleport'
export type { TownSpot } from './avatar/teleport'
