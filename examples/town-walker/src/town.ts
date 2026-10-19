import { createTown, type Town, type TownStatus } from 'sakurami-cho/world'
import { createCharacter, driveDirect, driveRides, driveTravel, setWarpPermit, stopDirect, type Character } from 'sakurami-cho/character'
import { QUALITY } from './quality'

/**
 * 町（地図）と歩く人を作る所（ここ 1 か所。kanon-lab の src/townBinding.ts と src/kanon/index.ts に当たる、例のアプリの町の口の入れ方）。
 * main.tsx がいちばん先に読む（地図のモジュールが引数を使うのは描き始めてからなので、その前に入る）。
 * 形（ラボ・外の光・遠景）を作るのと毎コマの段は、scene/Scene.tsx が R3F の包み（sakurami-cho/react）に town を渡して呼ぶ。
 *
 * - アセットの置き場（assetBase）: Vite の base（import.meta.env.BASE_URL）。publicDir を地図のパッケージの assets/ に向けている（vite.config.ts）
 * - allTiles: 町じゅうを動くので、全部のタイルを初めから読む（kanon-lab の撮影モードと同じ）
 * - postEffects: 後処理の段は地図の AnimeRender（アニメ塗りの輪郭線・トーンマッピング・SMAA。scene/Scene.tsx）だけで、使う側が組む後処理は無い
 * - 画質（quality・townQuality）: URL の引数 ?quality=low・?town=low|high から（quality.ts）。町を作るときに決まるので、変えるときはページごと読み込み直す
 * - 町の地図データの読み込みの状態（onStatus）: townState に写し、聞いている所（onTownStatus。地図データの案内 ui/TownNotice.tsx・ワープの一覧 teleport.ts）へ知らせる
 * - 確かめ用の URL の引数: ?debug（地図のデバッグの道具と window.__walker。debug.ts）。町の時刻と日付（?time=HH:MM・?date=YYYY-MM-DD と、時刻のつまみ）は clock.ts
 *
 * 歩く人（walker。地図の Character の 1 つ）:
 * - 立つ所は立ち寄り先の表の front（ラボの見学エントランスの前。南の町を向く）
 * - 乗り物に乗っている間は、地図の標準の順（driveRides: 観覧車 → ケーブル → 緑電 → 運河バス → ホバー）で動かす
 * - 乗っていない間は、町の中の移動（旅程。driveTravel。行き先の一覧は 6-4）が先、旅程が無ければ WASD・クリックで歩く（driveDirect。walk.ts）。
 *   置き直されたら（'place'。ワープ（teleport.ts）・旅程のカットなど）WASD・クリックの歩きをやめる
 * - 町の注目点（細かさ・光の中心・扉を開ける・えきもりの会釈の相手）は歩く人。町の時計を早送り・カットで進めてよいのも歩く人だけ
 * - 外にいる度合い → 歩く人の縁の光（VRM の MToon のリム）
 * - 見た目（VRM）は vrm.ts が付ける（落としたファイルを読む。無ければ scene/Walker.tsx の仮の体）
 */

const params = new URLSearchParams(location.search)

/** ?debug（地図のデバッグの表示・道具と、window.__walker） */
export const DEBUG = params.has('debug')

/** 町の地図データの読み込みの状態（onStatus が書く。準備の合図・?debug の __walker・案内が読む） */
export const townState: { status: TownStatus; message: string } = { status: 'idle', message: '' }

const statusListeners = new Set<(status: TownStatus, message: string) => void>()

/** 町の地図データの読み込みの状態が変わったら呼ぶ（地図の onStatus。やめる関数を返す） */
export function onTownStatus(fn: (status: TownStatus, message: string) => void): () => void {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

/** 町の地図データの状態（useSyncExternalStore 用: 状態の字と、変わったら呼ぶ口） */
export const townStatus = () => townState.status
export const subscribeTownStatus = (fn: () => void) => onTownStatus(fn)

/** 町の地図データが無い・形の版が合わない・読めなかった（町の道・乗り物・中のある建物が無く、ラボとそのまわりだけ） */
export const townUnavailable = () => townState.status === 'missing' || townState.status === 'outdated' || townState.status === 'error'

/**
 * 町は 1 ページに 1 つ（createTown の 2 回目は例外）。このファイルを書き換えたときは、作った町と歩く人をそのまま使ってモジュールを差し替え、
 * ページごと読み込み直す（下の import.meta.hot）
 */
export const town: Town =
  (import.meta.hot?.data.town as Town | undefined) ??
  createTown({
    assetBase: import.meta.env.BASE_URL,
    debug: DEBUG,
    allTiles: true,
    postEffects: false,
    quality: QUALITY.lab,
    townQuality: QUALITY.town,
    onStatus: (status, message) => {
      townState.status = status
      townState.message = message
      for (const fn of statusListeners) fn(status, message)
    },
  })

/** 歩く人の立ち寄り先（最初に立つ所。仮: ラボの前） */
const START_PLACE = 'front'

/** 歩く人（町じゅうを動く 1 人） */
export const walker: Character = (import.meta.hot?.data.walker as Character | undefined) ?? createWalker()

function createWalker() {
  const ch = createCharacter({ id: 'walker', spawn: START_PLACE, seed: null })
  ch.drivers.motion = driveRides
  ch.drivers.travel = (c, t, dt) => driveTravel(c, t, dt) || driveDirect(c, t, dt)
  ch.on('place', () => stopDirect(ch))
  town.setFocus(ch)
  setWarpPermit((c) => c === ch)
  town.on('outsideness', (k) => ch.setRimBlend(k))
  return ch
}

if (import.meta.hot) {
  import.meta.hot.data.town = town
  import.meta.hot.data.walker = walker
  import.meta.hot.accept(() => location.reload())
}
