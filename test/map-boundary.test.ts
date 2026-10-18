/**
 * 地図のパッケージ sakurami-cho の境目の見張り（docs/design/map-split.md §7。段 5 の終わりに入口ごとの決まりに作り直した（5-10））。
 * 8-4 で、kanon-lab の server/test/map-boundary.test.ts から、パッケージの中（この置き場所の下）だけを見る分をここへ分けた。kanon-lab が地図を使う側の決まり
 * （kanon-lab の src/・shared/・scripts/ の読み方、root の package.json・pnpm workspace・lock、kanon-lab の CI など）は kanon-lab の見張りに残した。
 * パスはどれもパッケージの根（この test/ の 1 つ上）から。
 *
 * 入口ごとの決まり（ENTRY_RULES）:
 *
 *   入口        読んでよい入口                       読まない外のパッケージ
 *   core        core                                 three・@pixiv/*・React・R3F・drei
 *   world       core・world                          @pixiv/*・React・R3F・drei
 *   character   core・world・character               React・R3F・drei
 *   react       core・world・character・react        （無い。React・R3F・drei を使ってよいのはここだけ）
 *   tools       core・world・character・tools        React・R3F・drei（node・bun で動く道具）
 *
 *   - どの入口も、使う側（kanon-lab。相対でパッケージの外・根からのパス /src/…・src/・shared/・server/ のパス・@kanon-lab/*）と Vite の import.meta.env を
 *     読まない。パッケージの中は相対で読む（自分の名前 sakurami-cho/… で読まない）。パッケージのコードは入口の下にだけ置く（assets/ はコードでない。
 *     例のアプリ examples/ とテスト test/ は入口の外）
 *   - 数える import: import … from・export … from・型だけの import・副作用だけの import・動的な import()。コメントの中は数えない。文字列（'…'・"…"）の
 *     中の import() も数えない。テンプレート文字列（`…`）の中の行の頭の import は、前の見張りと同じく数える（world/textures/screens.ts の画面の
 *     コードの字など。どれも読んではいけない所を指さない）
 *   - 道具（tools/）は、さらに: 根を自分の置き場所（import.meta.url・__dirname）から出さず、使う側の置き場所（public/・setting-book・
 *     packages/sakurami-cho）を書かない（--root・--out・--src・--assets で受ける）。パッケージの scripts（sync:town・sync:anim・check:walk）も道具を呼び、
 *     根と書き出し先・読む所（assets/）を渡す（8-4）
 *   - 素材から .vrma を作る変換（tools/anim/convert.mjs。exports の ./tools/anim）は .ts を読まない（使う側が Node で動かすとき、Node は node_modules の
 *     下の .ts を読まない）。待機・歩き・跳ぶの書き出し先は character/avatar/visualConfig.ts の VISUAL_DEFAULTS.animations と同じ値（8-4）
 *   - 書き出したアセット（町の地図データ assets/town/・.vrma の assets/models/animations/）は git に入れる（地図のリポジトリだけで町が出るように。
 *     段 6 の前に決めた。§8）。.gitignore で外さず、git の作業ツリーなら書き出した物が全部 git に入っている（sync で作り直したら差としてコミットする）。
 *     .vrma は出典（assets/models/animations/CREDITS.md）にファイルごとに書く。パッケージに置く .vrma は、パッケージのコードが既定で使う待機（切り替える待機を含む）・歩き・跳ぶまで
 *   - package.json の形（exports・files・peer の範囲・sideEffects を書かない・scripts・devDependencies）と .gitignore、three などが例のアプリとパッケージで
 *     同じ本当の置き場所に解けること
 *   - パッケージの名前は sakurami-cho（段 8 の 8-1 で、前の @kanon のスコープの付いた名前から替えた）。前の名前の字を残さない
 *   - 町の名前は桜見町（8-5d で設定集に合わせて替えた）。前の町の名前（漢字・旧字・ローマ字。替わっていない桜木丘…・SAKURAGI-OKA などは除く）を、
 *     コード・道具・アセット（町の地図データ・タイルの見出し）・README と docs/*.md・例のアプリ・テストに残さない
 *   - 観覧車の口は wheel… の名前（8-2b。前の名前 boardProblem などを残さない）。地図が返す理由（観覧車の WheelProblem・旅程の TravelProblem）は
 *     種類と値で、地図の既定の字（wheelProblemText・travelProblemText）は中立の言葉
 *   - 地図の中に kanon-lab の気配を残さない（8-2a）: console の頭は [sakurami-cho]（前は [kanon-lab]）、kanon-lab の名前の付いた名前
 *     （kanonStand・kanonSeat・stopKanon・KANON_TOWN_SRC と、8-5c で替えた町がついて行く人の中の名前 kanonIn・kanonLight・byKanon・KANON_CORNERS・
 *     _lastKanon）を使わず、使う人に見せる字（コメントの外の文字列）に kanon-lab の名前・命令（kanon.place など）・
 *     命令の引数・pnpm sync:town・「花音が」を書かない（道具の pnpm sync:town の案内は見ない）。コメントの「花音」と設定資料のデータ（「花音の部屋」など）は残す
 *   - 使う人に見える所（README・docs/*.md・LICENSE・package.json と、例のアプリの README・package.json・コードのコメントの外（文字列と JSX の字）・
 *     index.html）にも、kanon-lab の名前・命令・命令の引数・「花音が」を書かない（8-8。このリポジトリだけを見る人向け。pnpm sync:town はこのリポジトリの
 *     script なので見ない）。コードのコメントは作った時の記録として残す
 *   - 入口の index（core・world・character）は選んだ名前を export するだけ（export * もコードも書かない。段 6）。出す名前（公開の口）は決めた一覧
 *     PUBLIC_API だけで、docs/usage.md の「公開の口」の表にどれも書く（足す・消すときは、一覧・設計書 §10・その表を一緒に直す。6-7）
 *   - ライセンス（8-5）: LICENSE は 2 つのライセンスの案内（全部が MIT と読まれないように）、LICENSE-CODE は MIT（株式会社0235）、
 *     LICENSE-DATA は CC BY-NC 4.0 の legal code の全文そのまま。package.json の license は MIT AND CC-BY-NC-4.0 で、files に LICENSE-CODE・LICENSE-DATA（LICENSE は自動で入る）。README の「ライセンス」の表は CC_BY_NC_PATHS と同じで、どのパスもある。
 *     キャラクターの扱いのガイドラインの 1 行がある
 *
 * 例のアプリ（examples/town-walker。段 6。docs/design/map-split.md §8）は入口の外の、パッケージを使う側の 1 つで、上の入口ごとの
 * 決まりの外（EXAMPLE_DIR。packageFiles() に入れない）。例のアプリの決まり:
 *   - パッケージを入口の index（sakurami-cho/core・world・character・react）だけで読む（深いパス・相対では読まない）。読む外のパッケージは
 *     自分の package.json に書いた物と node: だけ
 *   - kanon-lab を読まず、kanon-lab の置き場所（src/・shared/・server/・public/・@kanon-lab/*・花音の VRM と身ぶり）を書かない。相対のパスはパッケージの
 *     外へ出ない（アセットは publicDir でパッケージの assets/ を読む）。コードは src/ の下と vite.config.ts・index.html・walk/index.html だけ
 *   - package.json に kanon-lab を書かず、three などの範囲はパッケージの peer と同じ（同じ本当の置き場所に解ける）。パッケージの files（配る物）・
 *     tsconfig に入れない
 *   - パッケージ（入口・道具）は例のアプリを読まない
 *   - 町と歩く人を作るのは src/town.ts の 1 か所。VRM は使う人が選んだ・落としたファイル（blob: の URL）で読み、VRM のファイルの名前を書かない。
 *     blob: の URL を作るファイルは、取り消し（URL.revokeObjectURL）も書く（6-2）
 *   - 例のアプリのために足した新しい部品（world/followCamera.ts・character/ride/drive.ts・character/avatar/direct.ts など。EXAMPLE_PARTS）は
 *     入口の決まりの中に置く（kanon-lab は読まない。kanon-lab の見張り）
 *   - 歩く人の drivers（乗り物・旅程・WASD とクリック）を入れるのは src/town.ts だけで、旅程が先（driveTravel || driveDirect）。WASD・クリックで動かす
 *     地図の口（setDirectInput・walkToPoint）を呼ぶのは src/walk.ts だけ（押し始めたら旅程を取り消す所を 1 つに）。キーの入力は入力欄では取らず、
 *     窓を離れた・タブを隠したら離したことにする（6-3）
 *   - 旅程と観覧車の口（startTravel・cancelTravel・beginWheelBoarding・cancelWheelBoarding・requestWheelAlight・advanceWheelTo）を呼ぶのは src/travel.ts だけ
 *     （WASD・クリックで歩き出したときの取り消しも、src/travel.ts の stopTravel を通る。様子・取り消しの所を 1 つに）。町の時計を早送り・カットで
 *     進めてよい人（setWarpPermit）を入れるのは src/town.ts だけで、歩く人だけ（6-4）
 *   - ワープの口（teleport・placeAtPoint・townSpots）を読むのは src/teleport.ts だけで、跳ぶ前に旅程を取り消し、跳んだら追うカメラを一度に置く（6-5）
 *   - 町の時刻と日付を変える口（town.setTime・setDate）を呼ぶのは src/clock.ts だけで、旅程の途中・乗っている間・ワープの暗転の間は変えない。画質は
 *     URL の引数から src/quality.ts が決めて町を作るときに渡す。町の地図データの状態は onStatus から聞き、案内は missing・outdated・error だけ（6-6）
 *   - ページは 2 つ（vite.config.ts の build.rolldownOptions.input）: 入口 index.html（/）は HTML と CSS と、VRM を選ぶ小さなスクリプト src/landing.ts
 *     だけで（landing.ts から読むのは src/vrmStore.ts だけ。three・React・地図のパッケージを読まない）、外の CSS・Web フォントを読まない（画は landing/
 *     の物だけ。「入る」は /walk/ と軽い画質の /walk/?quality=low&town=low、「VRM なしで入る」は /walk/?vrm=none）。アプリ walk/index.html（/walk/）は
 *     src/main.tsx を 1 つ読み、読み込み中の進み具合（#loading の段）は src/loading.ts の段と同じ並び。アセットの根（base）は / のまま
 *
 * 許しの一覧は持たない（段 5 で 0 にした）。どうしても例外が要るときは、その見張りに一覧を足し、理由となくす段を書く。
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** パッケージの根（この test/ の 1 つ上） */
const ROOT = join(import.meta.dir, '..')
/** このファイル（見張りの名前の一覧を持つので、名前の見張りでは見ない） */
const SELF = 'test/map-boundary.test.ts'

/* -------------------------------------------------------------------------- */
/* ファイルと import を読む所（kanon-lab の見張りにも同じ物を写した。2 つのリポジトリから共通の物を読ませない）     */
/* -------------------------------------------------------------------------- */

/** dir（パッケージの根からのパス。'' は根）の下の、名前が re に合うファイル（パッケージの根からのパス。skip の名前のディレクトリには入らない） */
function filesUnder(dir: string, re: RegExp, skip: readonly string[] = []): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        if (!skip.includes(name)) walk(p)
      } else if (re.test(name)) out.push(relative(ROOT, p).split('\\').join('/'))
    }
  }
  if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir))
  return out.sort()
}

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')

/**
 * コメントを除いた文。除くのは、行の頭から始まる /* … *\/ と、行の頭か空白のあとの // …（URL の :// は残す）。
 * 行の途中の /* は見ない（行のコメントの中の data/*.geojson などをコメントの始まりと見て、その先の文まで落とさないため）
 */
function codeOf(text: string): string {
  return text.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** 文の i の位置が、同じ行の '…' か "…" の文字列の中か（テンプレート文字列は文として見る） */
function inQuote(code: string, i: number): boolean {
  let q = ''
  for (let k = code.lastIndexOf('\n', i - 1) + 1; k < i; k++) {
    const c = code[k]!
    if (q) {
      if (c === '\\') k++
      else if (c === q) q = ''
    } else if (c === "'" || c === '"') q = c
  }
  return q !== ''
}

/** ファイルの import の先（import・export … from・import type・副作用だけの import・動的な import()。コメントと文字列の中の import() は数えない） */
function importsOf(text: string): string[] {
  const code = codeOf(text)
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)[^'"`;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].filter((m) => !inQuote(code, m.index!)).map((m) => m[1]!),
  ]
}

/**
 * import の先をパッケージの根からのパス（拡張子なし）に直す。パッケージの名前で読む物はパッケージの中のパスに（名前だけなら ''）。
 * 相対でパッケージの外へ出る物は '../…' のまま。ほかのパッケージはそのまま
 */
function resolveSpec(file: string, spec: string): string {
  if (spec === PKG_NAME) return ''
  if (spec.startsWith(`${PKG_NAME}/`)) return spec.slice(PKG_NAME.length + 1)
  if (!spec.startsWith('.')) return spec
  return posix.normalize(posix.join(dirname(file), spec)).replace(/\.(tsx?|js|mjs)$/, '')
}

/** パッケージの根からのパスが、パッケージの外を指すか */
const outside = (path: string) => path === '..' || path.startsWith('../')

/** 先が禁じた所か（ディレクトリ・スコープは '/' で終える。ファイル・パッケージはそのものか、その下） */
function hits(target: string, banned: readonly string[]) {
  return banned.some((b) => (b.endsWith('/') ? target.startsWith(b) || target === b.slice(0, -1) : target === b || target.startsWith(`${b}/`)))
}

/** JSON のファイル（パッケージの根からのパス） */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/* 地図のパッケージと入口ごとの決まり                                              */
/* -------------------------------------------------------------------------- */

/** 地図のパッケージの名前 */
const PKG_NAME = 'sakurami-cho'
/** 前のパッケージの名前（8-1 で PKG_NAME に替えた。このファイルに字のまま書かないよう、つないで作る） */
const OLD_PKG_NAME = ['@kanon', PKG_NAME].join('/')
/**
 * 前の町の名前（8-5d で設定集に合わせて桜見町（桜見）に替えた。このファイルに字のまま書かないよう、つないで作る）。数えるのは、
 * 漢字の前の名前（あとに「丘」が続く物を除く。桜木丘・桜木丘ラボ・桜木丘天文台・桜木丘電波観測所は替わっていない）・旧字の形（間を空けた形も）・
 * ローマ字（大文字小文字を問わず、間を空けた形も。-oka・oka・-lab が続く物（SAKURAGI-OKA・SAKURAGIOKA・sakuragioka の id・
 * LOCAL:SAKURAGI-LAB-ENU）を除く）
 */
const OLD_TOWN = { ja: ['桜', '木'].join(''), old: ['櫻', '木'], roman: ['sakura', 'gi'].join('') }
const OLD_TOWN_RES = [
  new RegExp(`${OLD_TOWN.ja}(?!丘)`, 'g'),
  new RegExp(OLD_TOWN.old.join('[ 　]?'), 'g'),
  new RegExp(`${OLD_TOWN.roman}(?!-?oka|-?lab)`, 'gi'),
  new RegExp(`${[...OLD_TOWN.roman].join(' ')}(?! ?- ?o ?k ?a| ?o ?k ?a| ?- ?l ?a ?b)`, 'gi'),
]
/** 字の中の前の町の名前（見つけた字の並び） */
function oldTownNames(text: string): string[] {
  return OLD_TOWN_RES.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]))
}
/** 入口（core ← world ← character ← react の一方向。並びが向きの順。tools は入口の外の道具で、core・world・character を読める） */
const PKG_ENTRIES = ['core', 'world', 'character', 'react', 'tools'] as const
type PkgEntry = (typeof PKG_ENTRIES)[number]
/** React・R3F・drei（使ってよいのは react/ だけ） */
const REACT_PACKAGES = ['react', 'react-dom', '@react-three/'] as const
/** 入口ごとに、読んでよい入口と読まない外のパッケージ（段 5 の道具 pkgdeps.py と同じ数え方） */
const ENTRY_RULES: Record<PkgEntry, { reads: readonly PkgEntry[]; banned: readonly string[] }> = {
  core: { reads: ['core'], banned: ['three', '@pixiv/', ...REACT_PACKAGES] },
  world: { reads: ['core', 'world'], banned: ['@pixiv/', ...REACT_PACKAGES] },
  character: { reads: ['core', 'world', 'character'], banned: [...REACT_PACKAGES] },
  react: { reads: ['core', 'world', 'character', 'react'], banned: [] },
  tools: { reads: ['core', 'world', 'character', 'tools'], banned: [...REACT_PACKAGES] },
}
/** パッケージが読まない使う側（kanon-lab。名前のまま書いたパス・kanon-lab のパッケージ。相対でパッケージの外と、根からのパス /… も読まない） */
const KANON_LAB_SPECS = ['src/', 'shared/', 'server/', '@kanon-lab/'] as const
/** peer にする物（react・R3F・drei は react/ だけが使うので optional）。型の確かめのために devDependencies にも同じ範囲で書く */
const PKG_PEERS = ['@pixiv/three-vrm', '@pixiv/three-vrm-animation', '@react-three/drei', '@react-three/fiber', 'react', 'three'] as const
const PKG_OPTIONAL_PEERS = ['@react-three/drei', '@react-three/fiber', 'react'] as const

/** 例のアプリ（パッケージの中に置く。入口の外で、パッケージを使う側。§8） */
const EXAMPLES_DIR = 'examples'
const EXAMPLE_DIR = `${EXAMPLES_DIR}/town-walker`
const EXAMPLE_NAME = 'town-walker'
/** テスト（入口の外。配らない） */
const TEST_DIR = 'test'
/**
 * 例のアプリのために足した、パッケージの新しい部品（段 6 の区切りごと。どれも入口の下の新しいファイルで、kanon-lab は読まない）。
 * 6-2: 人を追うカメラ・乗り物に乗っている間に人を動かす標準の順。6-3: 人を直接動かす（WASD・クリックで歩く）。6-5: ワープ先の名前の表・ワープ
 */
const EXAMPLE_PARTS = ['world/followCamera.ts', 'character/ride/drive.ts', 'character/avatar/direct.ts', 'core/spots.ts', 'character/avatar/teleport.ts'] as const

/**
 * 入口の index（core・world・character）の公開の口（6-7 に決めた。docs/design/map-split.md §10・docs/usage.md の「公開の口」の表）。
 * 例のアプリが使う物と、地図の表・差し込み口を差し替える・読む口（立ち寄り先の表・ラボの置き場所の表とアンカー・ラボの差し込み口・通り道・見た目の既定の値）、
 * それらの引数・返り値・欄の型（型も名前で数える）。react の index は 5-8 からの形（export *）のままで、ここでは数えない
 */
const PUBLIC_API: Record<'core' | 'world' | 'character', readonly string[]> = {
  core: [
    ...['configurePlaces', 'TOWN_PLACES', 'townPlaces', 'PlaceAction', 'PlaceId', 'TownPlace', 'TownPlaceId'],
    ...['INTERIOR_ZONES', 'zoneOfPoint', 'InteriorZoneId', 'ZoneId', 'TRAVEL_PLACES', 'TravelPlaceId', 'TRAVEL_ROUTE_IDS', 'TRAVEL_ROUTES', 'SPOT_KINDS', 'SpotKind'],
    ...['parseDate', 'parseTimeOfDay', 'timeOfDayName', 'DateParts', 'LabTime', 'TOWN_DATA', 'TOWN_QUALITY', 'TownQualityName'],
    ...['LAB_PLACEMENTS', 'LabPlacement', 'labAnchor', 'LabAnchorData'],
  ],
  world: [
    ...['createTown', 'Town', 'TownCreateOptions', 'TownClock', 'TownEventMap', 'TownFocus', 'TownFrame', 'TownStatus'],
    ...['PALETTE', 'FONTS', 'configureLab', 'createFollowCamera', 'FollowCamera', 'FollowCameraOptions', 'FollowTarget'],
  ],
  character: [
    ...['createCharacter', 'CharacterOptions', 'CharacterSpawnPoint', 'Character', 'CharacterDriver'],
    ...['createCharacterVisual', 'CharacterVisual', 'CharacterVisualClip', 'CharacterVisualOptions', 'CharacterVisualStatus', 'VISUAL_DEFAULTS', 'VisualConfig'],
    ...['goTo', 'placeAt', 'stopWalking', 'updateLocomotion', 'configureNav', 'NavConfig'],
    ...['driveRides', 'setWarpPermit', 'RideTime', 'advanceWheelTo', 'beginWheelBoarding', 'cancelWheelBoarding', 'requestWheelAlight', 'WHEEL_EXIT_OPEN_DEG', 'wheelBoardProblem', 'wheelProblemText', 'WheelProblem'],
    ...['cancelTravel', 'driveTravel', 'isTravelProblem', 'startTravel', 'traveling', 'travelProblemText', 'travelState', 'TravelCut', 'TravelPlan', 'TravelProblem', 'TravelRequest', 'TravelRouteId', 'TravelTime'],
    ...['canStand', 'directState', 'driveDirect', 'pickGround', 'setDirectInput', 'stopDirect', 'walkToPoint', 'jump', 'placeAtPoint', 'teleport', 'townSpots', 'TownSpot'],
    ...['summonHover', 'hoverStatus', 'HoverStatus'],
  ],
}

/**
 * CC BY-NC 4.0 にするパス（2026-10-11 の持ち主の決め。docs/design/map-split.md §10）。README の「ライセンス」の表と同じ並び。
 * ** はその下の全部、* はファイルの名前の一部。足す・消すときは README の表と一緒に直す
 */
const CC_BY_NC_PATHS = [
  'assets/town/**',
  ...['places', 'labPlan', 'routes', 'interiors', 'cableStations', 'soranowa', 'travel', 'spots'].map((n) => `core/${n}.ts`),
  ...['core/lab/plan.ts', 'core/lab/placements.ts', 'core/lab/kits/*.plan.ts'],
  ...['world/outdoor/interior/briefs/**', 'world/outdoor/named/kits/**', 'world/outdoor/interior/pictures.ts'],
] as const
/** README の「ライセンス」に書く、キャラクターの扱いの 1 行（持ち主の決め） */
const CHARACTER_GUIDELINE = 'キャラクター（花音・クレア・トンプソン）の扱いは株式会社0235 のガイドライン（https://kanon.0235.co.jp/guidelines/ ）に従う'
/**
 * LICENSE-DATA の sha256（https://creativecommons.org/licenses/by-nc/4.0/legalcode.txt を 2026-10-11 に取った物。Last-Modified: 2023-09-11。
 * 公式の本文をそのまま置く。直さない）
 */
const LICENSE_DATA_SHA256 = '41003d4a74749c0220e33dd415042164b5a1093ed401f36277234f772d22d3d0'

/** パスの並び（CC_BY_NC_PATHS の形）に当たるファイル（パッケージの根からのパス） */
function filesOfPattern(pattern: string): string[] {
  if (pattern.endsWith('/**')) return filesUnder(pattern.slice(0, -3), /./)
  if (!pattern.includes('*')) return existsSync(join(ROOT, pattern)) && statSync(join(ROOT, pattern)).isFile() ? [pattern] : []
  const dir = posix.dirname(pattern)
  const name = new RegExp(`^${posix.basename(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  return filesUnder(dir, name).filter((f) => posix.dirname(f) === dir)
}

/** 組み込む人向けの資料（README から移した物）。公開の口の表は docs/usage.md の「## 公開の口」 */
const USAGE_DOC = 'docs/usage.md'
/** 資料（docs/*.md。配る物 files には入れない）。README と同じく、前の名前・kanon-lab の気配の見張りを掛ける */
function docFiles(): string[] {
  return filesUnder('docs', /\.md$/)
}

/** Markdown のファイルの「## 名前」の節（次の ## まで。最後の節なら終わりまで） */
function mdSection(file: string, name: string): string {
  const md = read(file)
  const i = md.indexOf(`\n## ${name}\n`)
  if (i < 0) return ''
  const rest = md.slice(i + 1)
  const j = rest.indexOf('\n## ')
  return j < 0 ? rest : rest.slice(0, j)
}

/** 入口の index が出す名前（export { … } from・export type { … } from の、as の後ろの名前。並べ替えた物） */
function indexNames(text: string): string[] {
  return [...codeOf(text).matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)]
    .flatMap((m) => m[1]!.split(','))
    .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!)
    .filter(Boolean)
    .sort()
}

/** パッケージの中のコード（.ts・.tsx・.mjs。node_modules と assets/ は見ない。例のアプリ examples/ とテスト test/ は入口の決まりの外なので入れない） */
function packageFiles(): string[] {
  return filesUnder('', /\.(tsx?|mjs)$/, ['node_modules', 'assets', '.git']).filter((f) => !f.startsWith(`${EXAMPLES_DIR}/`) && !f.startsWith(`${TEST_DIR}/`))
}

/** テストのコード（このファイルも入る） */
function testFiles(): string[] {
  return filesUnder(TEST_DIR, /\.tsx?$/)
}

/** パッケージの中のパスの入口（入口の外とパッケージの外は null） */
function entryOf(path: string): PkgEntry | null {
  if (outside(path)) return null
  const head = path.split('/')[0]
  return (PKG_ENTRIES as readonly string[]).includes(head!) ? (head as PkgEntry) : null
}

/**
 * パッケージのファイル 1 つの、読んではいけない import（「元 -> 先（わけ）」）:
 *   kanon-lab … 相対でパッケージの外（使う側のファイル）を読む、根からのパス（/src/… など）・kanon-lab のパス（src/… など）・
 *              kanon-lab のパッケージ（@kanon-lab/*）を読む
 *   自分の名前 … パッケージの中を sakurami-cho/… で読む（中は相対のまま。別のリポジトリにしても使える）
 *   逆向き … 入口の向き core ← world ← character ← react の逆（上の入口を読む）
 *   読まない入口 … ほかに読んでよいと決めていない入口（入口から tools/ を、tools/ から react/ を読むなど）
 *   入口の外 … パッケージの中の、入口の外（例のアプリ examples/・テスト test/ など）を読む
 *   外 … 入口に許していない外のパッケージ（ENTRY_RULES の banned）
 */
function packageViolations(file: string, text: string): string[] {
  const out: string[] = []
  const from = entryOf(file)
  for (const spec of importsOf(text)) {
    const t = resolveSpec(file, spec)
    const self = spec === PKG_NAME || spec.startsWith(`${PKG_NAME}/`)
    if (spec.startsWith('.') && outside(t)) out.push(`${file} -> ${t}（kanon-lab）`)
    else if (spec.startsWith('/') || hits(spec, KANON_LAB_SPECS)) out.push(`${file} -> ${spec}（kanon-lab）`)
    else if (self) out.push(`${file} -> ${spec}（自分の名前）`)
    if (!from) continue
    const inside = spec.startsWith('.') ? !outside(t) : self
    const to = inside ? entryOf(t) : null
    if (inside && !to && t !== '') out.push(`${file} -> ${t}（入口の外）`)
    if (to && !ENTRY_RULES[from].reads.includes(to)) {
      const order = ['core', 'world', 'character', 'react']
      out.push(`${file} -> ${t}（${order.includes(from) && order.indexOf(to) > order.indexOf(from) ? '逆向き' : '読まない入口'}）`)
    }
    if (!spec.startsWith('.') && !self && hits(spec, ENTRY_RULES[from].banned)) out.push(`${file} -> ${spec}（外）`)
  }
  return [...new Set(out)]
}

/* -------------------------------------------------------------------------- */
/* 道具（tools/）                                                               */
/* -------------------------------------------------------------------------- */

/** 道具（5-9 で kanon-lab の scripts/ から移した）。どれも使う側とパッケージの package.json の script で呼ぶ */
const PKG_TOOLS = ['tools/sync-town.mjs', 'tools/sync-anim.mjs', 'tools/check-walk.mjs'] as const
/**
 * パッケージの package.json の script（8-4）と、呼ぶ道具・必ず渡す引数（根 --root . と、書き出し先 --out か読む所 --assets。どちらもパッケージの assets/）。
 * sync-town の読み元（設定資料の町の地図データ）はパッケージの外なので、script には書かず、環境変数 SAKURAMI_TOWN_SRC か `pnpm sync:town --src <フォルダ>` で渡す
 */
const OWN_TOOL_SCRIPTS: Record<string, { tool: (typeof PKG_TOOLS)[number]; flags: readonly string[]; assets: '--out' | '--assets' }> = {
  'sync:town': { tool: 'tools/sync-town.mjs', flags: ['--root', '--out'], assets: '--out' },
  'sync:anim': { tool: 'tools/sync-anim.mjs', flags: ['--root', '--out'], assets: '--out' },
  'check:walk': { tool: 'tools/check-walk.mjs', flags: ['--root', '--assets'], assets: '--assets' },
}
/** パッケージの scripts の名前（8-4）。git の依存で入れるときに pnpm が走らせる名前（prepare・prepack など）は使わない */
const OWN_SCRIPTS = ['check:walk', 'example:build', 'example:dev', 'sync:anim', 'sync:town', 'test', 'typecheck'] as const
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish', 'postpublish'] as const

/**
 * 道具のファイル 1 つの、使う側の置き場所に頼る所（「元: 何（わけ）」。コメントは見ない）:
 *   置き場所 … 根を道具の置き場所（import.meta.url・__dirname）から出す（根は使う側の作業ディレクトリか --root）
 *   使う側 … 使う側の置き場所（public/・町の地図データの setting-book・kanon-lab の中のパッケージの置き場所 packages/sakurami-cho）を書く（--out・--src などで受ける）
 */
function toolMisuses(file: string, text: string): string[] {
  const code = codeOf(text)
  const out: string[] = []
  for (const m of code.matchAll(/\bimport\.meta\.(?:url|dirname|filename)\b|\b__(?:dirname|filename)\b/g)) out.push(`${file}: ${m[0]}（置き場所）`)
  if (/\bpublic(?=\/|['"`])/.test(code)) out.push(`${file}: public/（使う側）`)
  for (const m of code.matchAll(/setting-book|packages\/sakurami-cho/g)) out.push(`${file}: ${m[0]}（使う側）`)
  return [...new Set(out)]
}

/** 素材から .vrma を作る変換（exports の ./tools/anim）と、そこから相対でたどって読むファイル（パッケージの根からのパス） */
function animToolFiles(): string[] {
  const seen = new Set<string>()
  const visit = (f: string) => {
    if (seen.has(f)) return
    seen.add(f)
    if (!/\.m?js$/.test(f)) return
    for (const spec of importsOf(read(f))) if (spec.startsWith('.')) visit(posix.normalize(posix.join(dirname(f), spec)))
  }
  visit('tools/anim/convert.mjs')
  return [...seen].sort()
}

/* -------------------------------------------------------------------------- */
/* 地図の中の kanon-lab の気配（8-2a）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 観覧車の口の前の名前（8-2b で wheelBoardProblem・beginWheelBoarding・cancelWheelBoarding・requestWheelAlight・advanceWheelTo・WHEEL_EXIT_OPEN_DEG に替えた。
 * ?debug の __ride の同じ名前の口も）。この見張りのファイルのほかには書かない（見張りは自分のファイルを見ない）
 */
const OLD_WHEEL_NAMES = ['boardProblem', 'beginBoarding', 'cancelBoarding', 'requestAlight', 'advanceTo', 'RIDE_EXIT_OPEN_DEG'] as const
/** console の頭（地図のパッケージの名前。前は kanon-lab の名前だった） */
const PKG_LOG_TAG = `[${PKG_NAME}]`
/**
 * kanon-lab の気配の名前（8-2a で替えた: 乗る人の立つ所・座る所 stand・seat、乗る人を止めるか stopRider、町の地図データの読み元の環境変数 SAKURAMI_TOWN_SRC。
 * 8-5c で替えた: 町がついて行く人（TownFocus）が建物の中にいる度合い focusIn・その人の部屋の光 focusRoomLight・その人が扉を開けるか byFocus
 * （world/outdoor/interior/interiors.ts）、外にいるその人のまわりの影の箱 FOCUS_CORNERS・前に箱を合わせた位置 _lastFocus（world/outdoor/outdoorLighting.ts））。
 * interiors.ts の this.focus・update の引数 focus（前は kanon）は、語 kanon がコメントの kanon-lab や設定資料のデータ（花音の部屋の id 'kanon'・kanonRoom）
 * と同じ語なので、ここでは数えない
 */
const KANON_TRACE_NAMES = ['kanonStand', 'kanonSeat', 'stopKanon', 'KANON_TOWN_SRC', 'kanonIn', 'kanonLight', 'byKanon', 'KANON_CORNERS', '_lastKanon'] as const
/**
 * 地図が使う人に見せる字（コメントの外の文字列）に書かない kanon-lab の言葉: kanon-lab の名前・命令（kanon.place・kanon.goto・kanon.alight など）・
 * 命令の引数（ignore_hours）と引数の書き方（route=auto・via=auto。地図の口では TravelRequest の route・via。8-5b）・kanon-lab の script（pnpm sync:town）・
 * 「花音が」。道具（tools/）は使う側の script から呼ぶので、pnpm sync:town の案内は見ない
 */
const KANON_TRACE_WORDS = /kanon-lab|\bkanon\.[a-z_]+|\bignore_hours\b|\b(?:route|via)=|pnpm sync:town|花音が/g
/** コメントの外の文字列（'…'・"…"・`…`） */
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g

/**
 * ファイル 1 つの kanon-lab の気配（「ファイル: 字（わけ）」）:
 *   頭 … console などの頭に kanon-lab の名前（[kanon-lab]）。コメントの中も数える
 *   名前 … KANON_TRACE_NAMES の名前（語として。コメントの中も数える）
 *   字 … 使う人に見せる字（コメントの外の文字列）に KANON_TRACE_WORDS（words が false の道具では見ない）
 */
function kanonTraces(file: string, text: string, words = true): string[] {
  const out: string[] = []
  if (text.includes('[kanon-lab]')) out.push(`${file}: [kanon-lab]（頭）`)
  for (const n of KANON_TRACE_NAMES) if (new RegExp(`\\b${n}\\b`).test(text)) out.push(`${file}: ${n}（名前）`)
  if (words) for (const s of codeOf(text).matchAll(STRING_LITERAL)) for (const m of s[0].matchAll(KANON_TRACE_WORDS)) out.push(`${file}: ${m[0]}（字）`)
  return [...new Set(out)]
}

/**
 * 使う人に見える所に書かない kanon-lab の言葉（8-8）: kanon-lab の名前（大文字小文字・間の - や空白を問わない）・命令（kanon.place など）・命令の引数
 * （ignore_hours）と引数の書き方（route=・via=）・「花音が」。pnpm sync:town はこのリポジトリの script（docs/tools.md）なので数えない
 */
const VISIBLE_TRACE_WORDS = /kanon[- _]?lab|\bkanon\.[a-z_]+|\bignore_hours\b|\b(?:route|via)=|花音が/gi

/**
 * 使う人に見える所のファイル 1 つの kanon-lab の言葉（「ファイル: 字」）。コード（.ts・.tsx・.mjs・.js）はコメント（/* … *\/・JSX の {/* … *\/}・行の // …）の
 * 外を全部（文字列も JSX の字も）、HTML は <!-- … --> の外、ほか（Markdown・JSON・LICENSE）は全部を見る
 */
function visibleTraces(file: string, text: string): string[] {
  const body = /\.(?:tsx?|mjs|js)$/.test(file)
    ? text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
    : file.endsWith('.html')
      ? text.replace(/<!--[\s\S]*?-->/g, '')
      : text
  return [...new Set([...body.matchAll(VISIBLE_TRACE_WORDS)].map((m) => `${file}: ${m[0]}`))]
}

/* -------------------------------------------------------------------------- */
/* 例のアプリ（examples/town-walker）                                            */
/* -------------------------------------------------------------------------- */

/** 例のアプリが読んでよいパッケージの口（入口の index だけ） */
const EXAMPLE_ENTRIES = ['core', 'world', 'character', 'react'].map((e) => `${PKG_NAME}/${e}`)
/** 例のアプリのコードの置き場所（src/ の下と、根の vite.config.ts・index.html（入口のページ）・walk/index.html（アプリのページ）だけ） */
const EXAMPLE_ROOT_FILES = ['vite.config.ts', 'index.html', 'walk/index.html'] as const

/** 例のアプリのコードと HTML（node_modules・dist は見ない） */
function exampleFiles(): string[] {
  return filesUnder(EXAMPLE_DIR, /\.(?:tsx?|mjs|js|html)$/, ['node_modules', 'dist'])
}

/** 外のパッケージの名前（'@a/b/c' → '@a/b'、'a/b' → 'a'） */
const packageNameOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')

/**
 * 例のアプリのファイル 1 つの、読み方・書き方の誤り（「元 -> 先（わけ）」か「元: 何（わけ）」。コメントは見ない）:
 *   深いパス … パッケージを入口の index でない名前（sakurami-cho/core/town・react/TownView など）で読む
 *   相対で外 … 相対のパスで例のアプリの外（パッケージの中のファイル・kanon-lab）を読む
 *   kanon-lab … 根からのパス（/src/… など）・kanon-lab のパス・kanon-lab のパッケージ（@kanon-lab/*）を読む
 *   書いていない依存 … 自分の package.json に書いていない外のパッケージを読む（kanon-lab の root にだけある postprocessing など）
 *   kanon-lab の置き場所 … 文に src/・shared/・server/・public/・@kanon-lab/・花音の VRM（kanon.vrm）・身ぶり（gesture-*.vrma）・声（audio/）を書く
 *     （walk/index.html の自分の入口 /src/main.tsx のほか）
 *   パッケージの外 … 文の相対のパス（'../…'）がパッケージの外を指す（publicDir の ../../assets はパッケージの中なのでよい）
 *   VRM のファイルの名前 … 文に VRM のファイルの名前（xxx.vrm。試しに使った VRM の試料など）を書く（VRM は使う人が選んだ・落としたファイルで読む。
 *     accept=".vrm" のような拡張子だけはよい。kanon.vrm は上の kanon-lab の置き場所で数える。6-2）
 */
function exampleMisuses(file: string, text: string, deps: ReadonlySet<string>): string[] {
  const out: string[] = []
  const html = file.endsWith('.html')
  const code = html ? text.replace(/<!--[\s\S]*?-->/g, '') : codeOf(text)
  if (!html) {
    for (const spec of importsOf(text)) {
      const t = resolveSpec(file, spec)
      if (spec === PKG_NAME || spec.startsWith(`${PKG_NAME}/`)) {
        if (!EXAMPLE_ENTRIES.includes(spec)) out.push(`${file} -> ${spec}（深いパス）`)
      } else if (spec.startsWith('.')) {
        if (!t.startsWith(`${EXAMPLE_DIR}/`)) out.push(`${file} -> ${t}（相対で外）`)
      } else if (spec.startsWith('/') || hits(spec, KANON_LAB_SPECS)) out.push(`${file} -> ${spec}（kanon-lab）`)
      else if (!spec.startsWith('node:') && !deps.has(packageNameOf(spec))) out.push(`${file} -> ${spec}（書いていない依存）`)
    }
  }
  const body = html ? code.replace(/<script type="module" src="\/src\/(?:main\.tsx|landing\.ts)"><\/script>/, '') : code
  for (const m of body.matchAll(/(?<![\w.$-])(?:src|shared|server|public)\/|(?<![\w$-])public(?=['"`])|@kanon-lab\/|kanon\.vrm\b|gesture-[a-z_]+\.vrma|(?<![\w-])audio\//g)) {
    out.push(`${file}: ${m[0]}（kanon-lab の置き場所）`)
  }
  // 文字列・パスの中の名前（'xxx.vrm'・models/xxx.vrm。visual.vrm のようなプロパティは数えない）
  for (const m of body.matchAll(/(?<=['"`/])[\w-]+\.vrm(?![\w-])/g)) if (m[0] !== 'kanon.vrm') out.push(`${file}: ${m[0]}（VRM のファイルの名前）`)
  // import の先は上で見た（相対で外）。ここでは import のほかの文字列（publicDir の new URL('../../assets', import.meta.url) など）
  const specs = new Set(html ? [] : importsOf(text))
  for (const m of code.matchAll(/['"`]((?:\.\.\/)+[^'"`]*)['"`]/g)) {
    if (specs.has(m[1]!)) continue
    const t = posix.normalize(posix.join(dirname(file), m[1]!))
    if (outside(t)) out.push(`${file}: ${m[1]}（パッケージの外）`)
  }
  return [...new Set(out)]
}

/**
 * 入口の index の、export のほかの文（「ファイル: 文」）。core・world・character は選んだ名前の export { … } from './…' と export type だけ（まだ出さない入口は export {}）
 * （export * はしない。名前がぶつからないように・出す名前が公開の口になるので）。react は 5-8 からの export * from './…' と登録の import './…' も
 */
function indexExtras(entry: string, text: string): string[] {
  // 名前をまだ出していない入口は export {}（モジュールにするだけ）
  let rest = codeOf(text).replace(/export\s+(?:type\s+)?\{[^}]*\}\s+from\s+'\.\/[^']+'\s*;?/g, '').replace(/^export\s*\{\s*\}\s*;?$/gm, '')
  if (entry === 'react') rest = rest.replace(/export\s+\*\s+from\s+'\.\/[^']+'\s*;?/g, '').replace(/^import\s+'\.\/[^']+'\s*;?$/gm, '')
  return rest
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${entry}/index.ts: ${l}`)
}

/** 本当の置き場所（spec を from（パッケージの根からのパス）から Bun で解いた先） */
const real = (spec: string, from: string) => realpathSync(Bun.resolveSync(spec, join(ROOT, from)))

/* -------------------------------------------------------------------------- */
/* 見張り                                                                        */
/* -------------------------------------------------------------------------- */

describe('地図のパッケージ（入口ごとの決まり）', () => {
  test('見張る物がある: 入口ごとのコード・道具。パッケージのコードは入口の下にだけ置く（例のアプリ examples/ とテスト test/ は入口の外で、例のアプリは下の「例のアプリ」で見る）', () => {
    const files = packageFiles()
    for (const e of PKG_ENTRIES) expect(files.filter((f) => entryOf(f) === e).length).toBeGreaterThan(e === 'react' ? 2 : 10)
    expect(files.filter((f) => entryOf(f) === null)).toEqual([])
    expect(files).toEqual(expect.arrayContaining([...['core', 'world', 'character', 'react'].map((e) => `${e}/index.ts`), ...PKG_TOOLS, ...EXAMPLE_PARTS]))
    expect(testFiles()).toContain(SELF)
  })

  test('入口ごとに: kanon-lab（src/・shared/・server/）を読まず、中は相対で読み、読んでよい入口と外のパッケージだけを読む（React・R3F・drei は react/ だけ）', () => {
    expect(packageFiles().flatMap((f) => packageViolations(f, read(f)))).toEqual([])
  })

  test('パッケージは Vite の import.meta.env を読まない（アセットの置き場は createTown の assetBase で受ける）', () => {
    expect(packageFiles().filter((f) => /\bimport\.meta\.env\b/.test(codeOf(read(f))))).toEqual([])
  })

  test('器: 入口ごとの index.ts・パッケージの tsconfig は入口だけ（pnpm workspace と kanon-lab からの読み方は kanon-lab の見張り）', () => {
    for (const e of ['core', 'world', 'character', 'react']) expect(existsSync(join(ROOT, e, 'index.ts'))).toBe(true)
    // パッケージの型の確かめ（kanon-lab の root の tsc -b の references にも入る）は入口だけ（例のアプリは自分の tsconfig で、例のアプリの build で確かめる。
    // テストは test/tsconfig.json で確かめる）
    const tsconfig = read('tsconfig.json')
    expect(/"include":\s*(\[[^\]]*\])/.exec(tsconfig)?.[1]).toBe('["core", "world", "character", "react"]')
  })

  test('パッケージの名前は sakurami-cho（8-1）。前の名前の字（正規表現の \\/ の形も）が、パッケージのコード・package.json・README・アセットの出典などに残っていない', () => {
    const text = /\.(?:tsx?|mjs|cjs|js|json|md|ya?ml|html|css|txt)$/
    const files = filesUnder('', text, ['node_modules', 'dist', '.git', '.cache'])
    // 見る物がある（場所を移したら、ここも直す）
    expect(files).toEqual(expect.arrayContaining(['package.json', 'README.md', ...docFiles(), `${EXAMPLE_DIR}/package.json`, `${EXAMPLE_DIR}/README.md`, 'assets/textures/CREDITS.md', 'core/index.ts', SELF]))
    const forms = [OLD_PKG_NAME, OLD_PKG_NAME.replace('/', '\\/')]
    expect(files.filter((f) => forms.some((w) => read(f).includes(w)))).toEqual([])
  })

  test('町の名前は桜見町（8-5d）。前の町の名前（漢字・旧字・ローマ字。桜木丘などは除く）が、パッケージのコード・道具・アセット（町の地図データとタイルの見出しも）・README・例のアプリ・テストに残っていない', () => {
    const text = /\.(?:tsx?|mjs|cjs|js|json|md|ya?ml|html|css|txt)$/
    const files = filesUnder('', text, ['node_modules', 'dist', '.git', '.cache'])
    // 見る物がある（名前を替えた所・書き出した町の地図データ。場所を移したら、ここも直す）
    expect(files).toEqual(
      expect.arrayContaining(['README.md', ...docFiles(), 'core/routes.ts', 'tools/town/transit.mjs', 'world/outdoor/named/kits/index.ts', 'world/outdoor/named/kits/station.ts', 'world/outdoor/interior/pictures.ts', 'assets/town/named.json', 'assets/town/infra.json', 'assets/town/manifest.json', 'assets/town/walk.json', `${EXAMPLE_DIR}/src/main.tsx`, SELF]),
    )
    const hits = files.flatMap((f) => oldTownNames(read(f)).map((w) => `${f}: ${w}`))
    // タイル（gzip した入れ物）の見出しの JSON の名前（名前のある建物の id・名前）
    const tiles = filesUnder('assets/town/tiles', /\.bin$/)
    expect(tiles.length).toBeGreaterThan(0)
    for (const f of tiles) {
      const b = gunzipSync(readFileSync(join(ROOT, f)))
      hits.push(...oldTownNames(b.subarray(12, 12 + b.readUInt32LE(8)).toString('utf8')).map((w) => `${f}: ${w}`))
    }
    expect(hits).toEqual([])
    // 替わっていない名前は残っている（見張りが広すぎない）
    expect(read('world/outdoor/named/kits/observatory.ts')).toContain(`${OLD_TOWN.ja}丘天文台`)
  })

  test('地図の中に kanon-lab の気配が無い（8-2a・8-5c）: console の頭は [sakurami-cho]、kanonStand・kanonSeat・stopKanon・KANON_TOWN_SRC・kanonIn などを使わず、使う人に見せる字に kanon-lab の名前・命令・pnpm sync:town を書かない', () => {
    const files = packageFiles()
    // 見る物がある（console の頭を替えたファイル・名前を替えたファイル）
    expect(files).toEqual(expect.arrayContaining(['core/clock.ts', 'world/outdoor/town/townData.ts', 'character/avatar/characterVisual.ts', 'core/soranowa.ts', 'tools/sync-town.mjs', 'world/outdoor/interior/interiors.ts', 'world/outdoor/outdoorLighting.ts']))
    expect(read('world/outdoor/town/townData.ts')).toContain(`${PKG_LOG_TAG} 町の地図データ`)
    // 道具（tools/）の pnpm sync:town などの案内は見ない（使う側の script から呼ぶ。8-4 でパッケージにも script を置いた）。README・docs/*.md・package.json は名前だけ
    expect(docFiles()).toEqual(expect.arrayContaining([USAGE_DOC, 'docs/tools.md']))
    const traces = [...files.flatMap((f) => kanonTraces(f, read(f), entryOf(f) !== 'tools')), ...['README.md', ...docFiles(), 'package.json'].flatMap((f) => kanonTraces(f, read(f), false))]
    // 観覧車・旅程の理由の字（8-2b で「種類と値」にした）も、地図の既定の字は中立の言葉（kanon-lab の字は kanon-lab の src/kanon/reasons.ts が作る）
    expect(traces).toEqual([])
  })

  test('使う人に見える所に kanon-lab の言葉が無い（8-8）: README・docs/*.md・LICENSE・package.json と、例のアプリの README・package.json・コードのコメントの外（文字列と JSX の字）・入口とアプリの HTML', () => {
    const files = ['README.md', ...docFiles(), 'LICENSE', 'package.json', `${EXAMPLE_DIR}/README.md`, `${EXAMPLE_DIR}/package.json`, ...exampleFiles()]
    // 見る物がある（資料・町の地図データの案内・例のアプリの説明）
    expect(files).toEqual(expect.arrayContaining([USAGE_DOC, 'docs/tools.md', `${EXAMPLE_DIR}/src/ui/TownNotice.tsx`, `${EXAMPLE_DIR}/src/App.tsx`, `${EXAMPLE_DIR}/index.html`, `${EXAMPLE_DIR}/walk/index.html`, `${EXAMPLE_DIR}/src/loading.ts`]))
    expect(files.flatMap((f) => visibleTraces(f, read(f)))).toEqual([])
  })

  test('観覧車の口は wheel… の名前（8-2b）。前の名前（boardProblem など）が、地図・例のアプリ・テストのコードと README・docs/*.md に残っていない（kanon-lab の側は kanon-lab の見張り）', () => {
    const files = [...packageFiles(), ...exampleFiles(), ...testFiles().filter((f) => f !== SELF), 'README.md', ...docFiles(), `${EXAMPLE_DIR}/README.md`]
    // 見る物がある（観覧車の口を呼ぶ所・公開の口の表）
    expect(files).toEqual(expect.arrayContaining(['character/ride/ride.ts', 'character/index.ts', `${EXAMPLE_DIR}/src/travel.ts`, USAGE_DOC]))
    expect(read('character/ride/ride.ts')).toMatch(/export function wheelBoardProblem\(/)
    const old = new RegExp(`\\b(?:${OLD_WHEEL_NAMES.join('|')})\\b`, 'g')
    expect(files.flatMap((f) => [...read(f).matchAll(old)].map((m) => `${f}: ${m[0]}`))).toEqual([])
  })

  test('入口の index（core・world・character）は選んだ名前の export だけ（export * もコードも書かない）。react は 5-8 からの形のまま', () => {
    expect(['core', 'world', 'character', 'react'].flatMap((e) => indexExtras(e, read(`${e}/index.ts`)))).toEqual([])
  })

  test('入口の index（core・world・character）の公開の口は決めた名前だけ。docs/usage.md の「公開の口」の表に、どの名前も書いてある（6-7）', () => {
    for (const e of ['core', 'world', 'character'] as const) expect(indexNames(read(`${e}/index.ts`))).toEqual([...PUBLIC_API[e]].sort())
    // 表は docs/usage.md の「## 公開の口」の節（次の ## まで）。名前は `名前` で書く
    const section = mdSection(USAGE_DOC, '公開の口')
    expect(section.length).toBeGreaterThan(0)
    expect(Object.values(PUBLIC_API).flatMap((names) => names.filter((n) => !section.includes(`\`${n}\``)))).toEqual([])
  })

  test('package.json の形: exports は入口の index と深いパス（react は index だけ）、files は入口・道具・アセット（例のアプリ・テストを配らない）、sideEffects は書かない、peer は devDependencies にも同じ範囲で', () => {
    const pkg = readJson('package.json')
    expect(pkg.name).toBe(PKG_NAME)
    expect(pkg.type).toBe('module')
    expect(pkg.private).toBe(true)
    // 読み込みの時の登録・init()・extend があるので、sideEffects を書かない（false にすると使わない import を落とされる）
    expect('sideEffects' in pkg).toBe(false)
    expect(pkg.exports).toEqual({
      './core': './core/index.ts',
      './core/*': './core/*.ts',
      './world': './world/index.ts',
      './world/*': './world/*.ts',
      './character': './character/index.ts',
      './character/*': './character/*.ts',
      './react': './react/index.ts',
      // 素材から .vrma を作る変換（使う側の道具が自分の .vrma を作るときに読む。6-0b）。道具そのもの（sync-*.mjs）は出さない
      './tools/anim': './tools/anim/convert.mjs',
    })
    // 配る物（pnpm pack・publish・git の依存）。例のアプリ（examples/）とテスト（test/）は入れない（6-1・8-4）。LICENSE-CODE・LICENSE-DATA は自動では入らないので書く（8-5）
    expect(pkg.files).toEqual(['core', 'world', 'character', 'react', 'tools', 'assets', 'README.md', 'LICENSE-CODE', 'LICENSE-DATA'])
    const peers = pkg.peerDependencies as Record<string, string>
    const dev = pkg.devDependencies as Record<string, string>
    expect(Object.keys(peers).sort()).toEqual([...PKG_PEERS])
    // 型の確かめのために、パッケージの devDependencies にも同じ範囲で（範囲が kanon-lab の root と同じことは kanon-lab の見張り）
    for (const p of PKG_PEERS) expect(dev[p]).toBe(peers[p]!)
    const meta = pkg.peerDependenciesMeta as Record<string, { optional?: boolean }>
    expect(Object.keys(meta).filter((k) => meta[k]!.optional).sort()).toEqual([...PKG_OPTIONAL_PEERS])
  })

  test('パッケージの器（8-4）: scripts は道具・テスト・型の確かめ・例のアプリだけで、道具には根（--root .）と assets/ を渡す。devDependencies に typescript と @types/bun。.gitignore', () => {
    const pkg = readJson('package.json')
    const scripts = pkg.scripts as Record<string, string>
    expect(Object.keys(scripts).sort()).toEqual([...OWN_SCRIPTS])
    // git の依存で入れるときに pnpm が走らせる名前は使わない
    expect(LIFECYCLE_SCRIPTS.filter((n) => n in scripts)).toEqual([])
    for (const [name, { tool, flags, assets }] of Object.entries(OWN_TOOL_SCRIPTS)) {
      const cmd = scripts[name] ?? ''
      expect(cmd).toContain(` ${tool} `)
      for (const flag of flags) expect(new RegExp(`\\s${flag}\\s+[^-\\s]`).test(cmd)).toBe(true)
      expect(cmd).toMatch(/\s--root\s+\.(?:\s|$)/)
      expect(cmd).toMatch(new RegExp(`\\s${assets}\\s+assets(?:\\s|$)`))
      // 使う側の置き場所（読み元の設定資料など）を書かない
      expect(toolMisuses(`package.json の ${name}`, `const c = '${cmd}'`)).toEqual([])
    }
    // テストは Bun（test/ の下）。型の確かめはパッケージの tsconfig（入口）とテストの tsconfig
    expect(scripts.test).toBe('bun test test/')
    expect(scripts.typecheck).toBe('tsc -p tsconfig.json && tsc -p test/tsconfig.json')
    expect(existsSync(join(ROOT, 'test', 'tsconfig.json'))).toBe(true)
    expect(scripts['example:dev']).toBe(`pnpm --filter ${EXAMPLE_NAME} dev`)
    expect(scripts['example:build']).toBe(`pnpm --filter ${EXAMPLE_NAME} build`)
    const dev = pkg.devDependencies as Record<string, string>
    for (const n of ['typescript', '@types/bun']) expect(dev[n]).toBeDefined()
    // .gitignore（パッケージだけのリポジトリでも、入れた依存・ビルドの出力・素材の置き場を git に入れない）
    const ignore = read('.gitignore')
      .split('\n')
      .map((l) => l.trim())
    for (const l of ['node_modules', 'dist', '*.local', '.cache/']) expect(ignore).toContain(l)
  })

  test('ライセンス（8-5）: LICENSE は 2 つのライセンスの案内、LICENSE-CODE は MIT（株式会社0235）、LICENSE-DATA は CC BY-NC 4.0 の legal code そのまま。package.json の license・version・files。README の「ライセンス」の表のパスが全部あり、ガイドラインの 1 行がある', () => {
    // LICENSE は案内（MIT の全文を置かない。GitHub などが全部を MIT と見分けないように）。2 つのライセンスと置き場所・ガイドラインを書く
    const guide = read('LICENSE')
    expect(guide).not.toContain('Permission is hereby granted')
    for (const w of ['CC BY-NC 4.0', 'LICENSE-DATA', 'MIT', 'LICENSE-CODE', '株式会社0235', 'README.md', 'https://kanon.0235.co.jp/guidelines/']) expect(guide).toContain(w)
    const mit = read('LICENSE-CODE')
    expect(mit.startsWith('MIT License\n\nCopyright (c) 2026 株式会社0235\n\n')).toBe(true)
    for (const w of ['Permission is hereby granted, free of charge, to any person obtaining a copy', 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND']) expect(mit).toContain(w)
    const data = readFileSync(join(ROOT, 'LICENSE-DATA'))
    expect(new Bun.CryptoHasher('sha256').update(data).digest('hex')).toBe(LICENSE_DATA_SHA256)
    expect(data.toString('utf8').startsWith('Attribution-NonCommercial 4.0 International\n')).toBe(true)
    const pkg = readJson('package.json')
    expect(pkg.license).toBe('MIT AND CC-BY-NC-4.0')
    expect(pkg.version).toBe('0.1.0')
    for (const f of ['LICENSE-CODE', 'LICENSE-DATA']) expect(pkg.files).toContain(f)
    // README の「ライセンス」: 表のパス（| `パス` | の行）は決めた並びと同じで、どれも 1 つ以上のファイルに当たる
    const section = mdSection('README.md', 'ライセンス')
    expect([...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1])).toEqual([...CC_BY_NC_PATHS])
    expect(CC_BY_NC_PATHS.filter((p) => filesOfPattern(p).length === 0)).toEqual([])
    for (const w of ['CC BY-NC 4.0', '(LICENSE-DATA)', 'MIT', '(LICENSE-CODE)', '(LICENSE)', '株式会社0235', 'assets/textures/', 'assets/models/animations/', 'world/lab/shell/floor.ts']) expect(section).toContain(w)
    expect(section).toContain(CHARACTER_GUIDELINE)
    // 他の人の素材の出典がある
    for (const f of ['assets/textures/CREDITS.md', 'assets/models/animations/CREDITS.md']) expect(existsSync(join(ROOT, f))).toBe(true)
  })

  test('three・three-vrm・React・R3F は、例のアプリからもパッケージと同じ本当の置き場所に解ける（2 つ読まれない）。例のアプリでパッケージの名前は入口の index に解ける', () => {
    for (const p of PKG_PEERS) expect(real(p, EXAMPLE_DIR)).toBe(real(p, '.'))
    for (const e of ['core', 'world', 'character', 'react']) expect(real(`${PKG_NAME}/${e}`, EXAMPLE_DIR)).toBe(realpathSync(join(ROOT, e, 'index.ts')))
  })

  test('道具（tools/）: 根を自分の置き場所から出さず、使う側の置き場所を書かない（使う側の script が根と書き出し先を渡すことは、使う側の見張り）', () => {
    const tools = packageFiles().filter((f) => entryOf(f) === 'tools')
    expect(tools.length).toBeGreaterThan(PKG_TOOLS.length)
    expect(tools.flatMap((f) => toolMisuses(f, read(f)))).toEqual([])
  })

  test('素材から .vrma を作る変換（tools/anim/convert.mjs。sakurami-cho/tools/anim）は .ts を読まない（Node は node_modules の下の .ts を読まない。8-4）。待機・歩き・跳ぶの書き出し先は VISUAL_DEFAULTS.animations と同じ値', async () => {
    const files = animToolFiles()
    expect(files).toEqual(expect.arrayContaining(['tools/anim/convert.mjs']))
    expect(files.filter((f) => !/\.m?js$/.test(f))).toEqual([])
    // 外のパッケージは three と node: だけ（three の .js の例の部品も）
    const specs = files.flatMap((f) => importsOf(read(f)).filter((s) => !s.startsWith('.')))
    expect(specs.filter((s) => !s.startsWith('node:') && packageNameOf(s) !== 'three')).toEqual([])
    // 値を 2 か所に書くので、食い違ったら落とす（.ts の側が元。道具の側は写し）
    const load = async <T>(path: string): Promise<T> => (await import(join(ROOT, path))) as T
    const convert = await load<{ IDLE_OUTPUT: { dest: string }; IDLE_VARIANT_OUTPUTS: { dest: string }[]; WALK_OUTPUT: { dest: string }; JUMP_OUTPUTS: { dest: string }[] }>('tools/anim/convert.mjs')
    const { VISUAL_DEFAULTS } = await load<{ VISUAL_DEFAULTS: { animations: { idle: string; idleVariants: readonly string[]; walk: string; jump: { start: string; loop: string; land: string } } } }>('character/avatar/visualConfig.ts')
    expect(convert.IDLE_OUTPUT.dest).toBe(VISUAL_DEFAULTS.animations.idle)
    expect(convert.IDLE_VARIANT_OUTPUTS.map((o) => o.dest)).toEqual([...VISUAL_DEFAULTS.animations.idleVariants])
    expect(convert.WALK_OUTPUT.dest).toBe(VISUAL_DEFAULTS.animations.walk)
    const jump = VISUAL_DEFAULTS.animations.jump
    expect(convert.JUMP_OUTPUTS.map((o) => o.dest)).toEqual([jump.start, jump.loop, jump.land])
  })

  test('書き出したアセット（町の地図データ・.vrma）は git に入っていて（sync で作り直したら差としてコミットする）、.vrma の出典がファイルごとにある。パッケージの .vrma は待機（切り替える待機を含む）・歩き・跳ぶまで', () => {
    const town = 'assets/town'
    const anim = 'assets/models/animations'
    for (const f of ['manifest.json', 'walk.json', 'named.json', 'infra.json']) expect(existsSync(join(ROOT, town, f))).toBe(true)
    const pkgVrma = filesUnder(anim, /\.vrma$/)
    const written = [...filesUnder(town, /./), ...pkgVrma]
    expect(written.length).toBeGreaterThan(100)
    // パッケージに置く .vrma は、パッケージのコードが既定で使う待機（切り替える待機を含む）・歩き・跳ぶまで。花音の身ぶり（gesture-*）を地図へ戻さない・見比べる用の物を置かない
    expect(pkgVrma.map((f) => posix.basename(f)).sort()).toEqual(['idle-2.vrma', 'idle-3.vrma', 'idle-4.vrma', 'idle.vrma', 'jump-land.vrma', 'jump-loop.vrma', 'jump-start.vrma', 'walk.vrma'])
    // パッケージの .gitignore で書き出した物を外さない（前の決め（5-9）はパッケージの .gitignore で外していた）
    const ignores = filesUnder('', /^\.gitignore$/, ['node_modules', '.git'])
    expect(ignores).toContain('.gitignore')
    const ignoring = ignores.flatMap((f) =>
      read(f)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && /assets|town|animations|\.vrma|^\*\.(?:bin|json|png)$/.test(l))
        .map((l) => `${f}: ${l}`),
    )
    expect(ignoring).toEqual([])
    // git の作業ツリーなら、書き出した物が全部 git に入っている（写しの木など git の外では見ない。ls-files はパッケージの根からのパスで出す）
    const git = Bun.spawnSync(['git', '-C', ROOT, 'ls-files', '-z', '--', town, anim])
    if (git.exitCode === 0) {
      const tracked = new Set(git.stdout.toString().split('\0').filter(Boolean))
      expect(written.filter((f) => !tracked.has(f))).toEqual([])
    }
    // .vrma の出典: 置いてある .vrma が全部、同じ所の CREDITS.md の「ファイルと素材」の表に行（| `名前` …）があり、MIT（StayStill）の全文と CC0（Quaternius）がある
    const credits = read(`${anim}/CREDITS.md`)
    expect(pkgVrma.filter((f) => !credits.split('\n').some((l) => l.startsWith(`| \`${posix.basename(f)}\``)))).toEqual([])
    for (const w of ['StayStill', 'Eneko Atxa Landa', 'Permission is hereby granted', 'THE SOFTWARE IS PROVIDED "AS IS"', 'Quaternius', 'CC0']) expect(credits).toContain(w)
    // パッケージの出典は kanon-lab を書かない（花音の身ぶりの行を残さない）
    expect(credits).not.toMatch(/gesture-|kanon|花音/)
    expect(existsSync(join(ROOT, 'assets/textures/CREDITS.md'))).toBe(true)
  })
})

describe('例のアプリ（examples/town-walker。段 6）', () => {
  const pkg = () => readJson(`${EXAMPLE_DIR}/package.json`)
  const deps = () => {
    const p = pkg()
    return new Set([...Object.keys((p.dependencies ?? {}) as object), ...Object.keys((p.devDependencies ?? {}) as object)])
  }

  test('見張る物がある。コードは src/ の下と vite.config.ts・index.html・walk/index.html だけ', () => {
    const files = exampleFiles()
    const parts = ['index.html', 'walk/index.html', 'vite.config.ts', 'src/main.tsx', 'src/town.ts', 'src/App.tsx', 'src/debug.ts', 'src/scene/Scene.tsx']
    // 6-2: VRM・歩く人・追うカメラ・VRM のつまみ
    parts.push('src/vrm.ts', 'src/scene/Walker.tsx', 'src/scene/FollowCam.tsx', 'src/ui/VrmPanel.tsx')
    // 6-3: WASD・クリックで歩く
    parts.push('src/walk.ts', 'src/input/keys.ts', 'src/input/click.ts', 'src/scene/Controls.tsx', 'src/ui/WalkNotice.tsx')
    // 6-4: 行き先の一覧と旅程
    parts.push('src/travel.ts', 'src/ui/TravelPanel.tsx')
    // 6-5: ワープ（一覧・暗転）
    parts.push('src/teleport.ts', 'src/ui/WarpList.tsx', 'src/ui/WarpFade.tsx')
    // 6-6: 時刻のつまみ・画質・町の地図データの案内
    parts.push('src/clock.ts', 'src/quality.ts', 'src/ui/TownPanel.tsx', 'src/ui/TownNotice.tsx')
    // 入口のページと読み込み中の進み具合
    parts.push('src/loading.ts')
    // #1: 町の地図（ミニマップと全体の地図）
    parts.push('src/mapData.ts', 'src/mapDraw.ts', 'src/townMap.ts', 'src/ui/MiniMap.tsx', 'src/ui/TownMap.tsx')
    expect(files).toEqual(expect.arrayContaining(parts.map((f) => `${EXAMPLE_DIR}/${f}`)))
    expect(files.filter((f) => !f.startsWith(`${EXAMPLE_DIR}/src/`) && !(EXAMPLE_ROOT_FILES as readonly string[]).includes(f.slice(EXAMPLE_DIR.length + 1)))).toEqual([])
    // examples/ の下は例のアプリだけ（ほかの例を足したら、ここと EXAMPLE_DIR を一覧にする）
    expect(readdirSync(join(ROOT, EXAMPLES_DIR))).toEqual([EXAMPLE_NAME])
  })

  test('パッケージを入口の index だけで読み、kanon-lab を読まず・置き場所を書かず、相対でパッケージの外へ出ない。外のパッケージは自分の package.json に書いた物だけ', () => {
    const d = deps()
    expect(exampleFiles().flatMap((f) => exampleMisuses(f, read(f), d))).toEqual([])
  })

  test('アセットは publicDir でパッケージの assets/ を読み（写さない）、three・React・R3F を 1 つだけ読む（dedupe）', () => {
    const vite = codeOf(read(`${EXAMPLE_DIR}/vite.config.ts`))
    expect(vite).toMatch(/publicDir: fileURLToPath\(new URL\('\.\.\/\.\.\/assets', import\.meta\.url\)\)/)
    expect(posix.normalize(posix.join(EXAMPLE_DIR, '../../assets'))).toBe('assets')
    expect(vite).toMatch(/dedupe: \['three', 'react', 'react-dom', '@react-three\/fiber'\]/)
    // アセットの置き場は createTown の assetBase に Vite の base を渡す（町を作るのは src/town.ts の 1 か所）
    const calls = exampleFiles().filter((f) => /(?<![\w$.])createTown\s*\(/.test(codeOf(read(f))))
    expect(calls).toEqual([`${EXAMPLE_DIR}/src/town.ts`])
    expect(read(`${EXAMPLE_DIR}/src/town.ts`)).toMatch(/^\s*assetBase: import\.meta\.env\.BASE_URL,$/m)
  })

  test('歩く人を作るのは src/town.ts だけ。VRM の blob: の URL を作るファイルは取り消しも書く（6-2）', () => {
    expect(exampleFiles().filter((f) => /(?<![\w$.])createCharacter\s*\(/.test(codeOf(read(f))))).toEqual([`${EXAMPLE_DIR}/src/town.ts`])
    const blobs = exampleFiles().filter((f) => /\bURL\.createObjectURL\s*\(/.test(codeOf(read(f))))
    expect(blobs.length).toBeGreaterThan(0)
    expect(blobs.filter((f) => !/\bURL\.revokeObjectURL\s*\(/.test(codeOf(read(f))))).toEqual([])
  })

  test('VRM を入れ替えるときは、地図の見た目の dispose() で片付ける（自前で VRM を deepDispose せず、縁の光の素材の一覧 rim.tuned を書き換えない。数を見るのはよい。8-3）', () => {
    // 地図の見た目の型に片付けの口がある
    expect(codeOf(read('character/avatar/characterVisual.ts'))).toMatch(/^\s+dispose\(\): void$/m)
    expect(exampleFiles().filter((f) => /\bdeepDispose\b|\.rim\.tuned(?:\.(?:splice|push|pop|shift|unshift|length\s*=(?!=))|\s*=(?!=))|\btuned\.splice\b/.test(codeOf(read(f))))).toEqual([])
    expect(codeOf(read(`${EXAMPLE_DIR}/src/vrm.ts`))).toMatch(/\.dispose\(\)/)
  })

  test('歩く人の drivers を入れるのは src/town.ts だけで、旅程が先（driveTravel || driveDirect）。WASD・クリックの口を呼ぶのは src/walk.ts だけ。キーは入力欄で取らず、窓を離れたら止める（6-3）', () => {
    const town = `${EXAMPLE_DIR}/src/town.ts`
    expect(exampleFiles().filter((f) => /\.drivers\.(?:motion|travel)\s*=/.test(codeOf(read(f))))).toEqual([town])
    expect(codeOf(read(town))).toMatch(/\.drivers\.travel = \(c, t, dt\) => driveTravel\(c, t, dt\) \|\| driveDirect\(c, t, dt\)/)
    expect(exampleFiles().filter((f) => /(?<![\w$.])(?:setDirectInput|walkToPoint)\s*\(/.test(codeOf(read(f))))).toEqual([`${EXAMPLE_DIR}/src/walk.ts`])
    const keys = codeOf(read(`${EXAMPLE_DIR}/src/input/keys.ts`))
    for (const re of [/\.addEventListener\('blur'/, /\.addEventListener\('visibilitychange'/, /isContentEditable/, /'INPUT'/, /'TEXTAREA'/]) expect(keys).toMatch(re)
  })

  test('旅程と観覧車の口を呼ぶのは src/travel.ts だけ。町の時計を進めてよい人を入れるのは src/town.ts だけで、歩く人だけ（6-4）', () => {
    const travel = `${EXAMPLE_DIR}/src/travel.ts`
    const calls = /(?<![\w$.])(?:startTravel|cancelTravel|beginWheelBoarding|cancelWheelBoarding|requestWheelAlight|advanceWheelTo)\s*\(/
    expect(exampleFiles().filter((f) => calls.test(codeOf(read(f))))).toEqual([travel])
    // WASD・クリックで歩き出したら旅程を取り消す（walk.ts は travel.ts の stopTravel を呼ぶ）
    expect(codeOf(read(`${EXAMPLE_DIR}/src/walk.ts`))).toMatch(/\bstopTravel\('キーで歩く'\)/)
    const town = `${EXAMPLE_DIR}/src/town.ts`
    expect(exampleFiles().filter((f) => /(?<![\w$.])setWarpPermit\s*\(/.test(codeOf(read(f))))).toEqual([town])
    expect(codeOf(read(town))).toMatch(/setWarpPermit\(\(c\) => c === ch\)/)
  })

  test('ワープの口（teleport・placeAtPoint・townSpots）を呼ぶのは src/teleport.ts だけで、跳ぶ前に旅程を stopTravel で取り消す。跳んだら追うカメラを一度に置く（6-5）', () => {
    const teleport = `${EXAMPLE_DIR}/src/teleport.ts`
    // 地図の口を読む（import する）のが teleport.ts だけ（例のアプリはパッケージを入口の index だけで読む。上の見張り）。__walker.teleport などの名前は数えない
    const reads = /\bimport\s*(?:type\s*)?\{[^}]*\b(?:teleport|placeAtPoint|townSpots)\b[^}]*\}\s*from\s*'sakurami-cho\/character'/
    expect(exampleFiles().filter((f) => reads.test(codeOf(read(f))))).toEqual([teleport])
    const code = codeOf(read(teleport))
    expect(code).toMatch(/\bstopTravel\('ワープ'\)/)
    // 跳ぶ口は 1 か所（jump）で、旅程を取り消してから（warpTo）
    expect([...code.matchAll(/(?<![\w$.])teleport\s*\(/g)].length).toBe(1)
    expect(code.indexOf("stopTravel('ワープ')")).toBeLessThan(code.indexOf('jump(spot)'))
    // 追うカメラは歩く人の 'place' で一度に置く（ワープ・置き直す・旅程のカット）
    expect(codeOf(read(`${EXAMPLE_DIR}/src/scene/FollowCam.tsx`))).toMatch(/walker\.on\('place', \(\) => cam\.snap\(\)\)/)
  })

  test('町の時刻と日付を変える口（town.setTime・town.setDate）を呼ぶのは src/clock.ts だけ。画質は URL の引数から src/quality.ts が決めて、町を作るときに渡す。町の地図データの状態は onStatus から聞き、ワープの一覧は毎コマ見直さない（6-6）', () => {
    const clock = `${EXAMPLE_DIR}/src/clock.ts`
    expect(exampleFiles().filter((f) => /\.(?:setTime|setDate)\s*\(/.test(codeOf(read(f))))).toEqual([clock])
    // 旅程の途中・乗っている間・ワープの暗転の間は変えない
    const c = codeOf(read(clock))
    for (const re of [/\btraveling\(walker\)/, /\bwalker\.ride\.phase !== 'none'/, /\bwarpUi\(\)\.fade !== 'none'/]) expect(c).toMatch(re)
    // 画質: 町を作る所（src/town.ts）で URL の引数から決めた物を渡す。URL の引数を読むのは quality.ts（kanon-lab と同じ名前 quality・town）
    const town = codeOf(read(`${EXAMPLE_DIR}/src/town.ts`))
    expect(town).toMatch(/^\s*quality: QUALITY\.lab,$/m)
    expect(town).toMatch(/^\s*townQuality: QUALITY\.town,$/m)
    expect(exampleFiles().filter((f) => /\.get\('(?:quality|town)'\)/.test(codeOf(read(f))))).toEqual([`${EXAMPLE_DIR}/src/quality.ts`])
    // 町の地図データの状態: onStatus（src/town.ts）から聞く。ワープの一覧は状態が変わったときに作り直す（前の 1 秒ごとの見直しをしない）
    expect(town).toMatch(/onStatus: \(status, message\) => \{/)
    const teleport = codeOf(read(`${EXAMPLE_DIR}/src/teleport.ts`))
    expect(teleport).toMatch(/\bonTownStatus\(/)
    expect(exampleFiles().filter((f) => /\bupdateWarpList\b/.test(codeOf(read(f))))).toEqual([])
    // 案内を出すのは、地図データが無い・形の版が合わない・読めないときだけ（.vrma の案内は作らない）
    const notice = codeOf(read(`${EXAMPLE_DIR}/src/ui/TownNotice.tsx`))
    expect(notice).toMatch(/status !== 'missing' && status !== 'outdated' && status !== 'error'/)
    expect([...new Set([...notice.matchAll(/'(idle|loading|ready|missing|outdated|error)'/g)].map((m) => m[1]))].sort()).toEqual(['error', 'missing', 'outdated'])
    expect(exampleFiles().filter((f) => /\.vrma\b/.test(codeOf(read(f))))).toEqual([])
  })

  test('ページは 2 つ: 入口 index.html（/）は HTML と CSS と VRM を選ぶ小さなスクリプト src/landing.ts だけ（three・React・地図のパッケージ・外の CSS・Web フォントを読まない。画は landing/ の物）、アプリ walk/index.html（/walk/）は src/main.tsx を 1 つ読み、進み具合の段は src/loading.ts と同じ並び。base は / のまま', () => {
    const vite = codeOf(read(`${EXAMPLE_DIR}/vite.config.ts`))
    expect(vite).toMatch(
      /rolldownOptions: \{\s*input: \{\s*index: fileURLToPath\(new URL\('\.\/index\.html', import\.meta\.url\)\),\s*walk: fileURLToPath\(new URL\('\.\/walk\/index\.html', import\.meta\.url\)\),\s*\},/,
    )
    // アセットの根は / のまま（/walk/ のページも町の地図データを /town/… から読む。画質を変えて読み込み直す URL も今のページ /walk/ のまま）
    expect(vite).not.toMatch(/\bbase\s*:/)
    expect(codeOf(read(`${EXAMPLE_DIR}/src/quality.ts`))).toMatch(/const url = new URL\(location\.href\)/)

    // 入口: スクリプトは VRM を選ぶ src/landing.ts の 1 つだけで、そこから読むのは src/vrmStore.ts だけ（three・React・地図のパッケージを読まない）。
    // 外の CSS・Web フォントを読まない。読む物は landing/ の画だけ（共有の画像も）。数十 KB まで
    const landingRaw = read(`${EXAMPLE_DIR}/index.html`)
    expect(Buffer.byteLength(landingRaw)).toBeLessThan(30_000)
    const landingAll = landingRaw.replace(/<!--[\s\S]*?-->/g, '')
    expect([...landingAll.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script type="module" src="/src/landing.ts">'])
    const landing = landingAll.replace('<script type="module" src="/src/landing.ts"></script>', '')
    expect(landing).not.toMatch(/rel="(?:stylesheet|preload|modulepreload|prefetch|preconnect)"|@import|@font-face|fonts\.googleapis|\/src\//)
    const landingScripts = new Set<string>()
    const visitLanding = (f: string) => {
      if (landingScripts.has(f)) return
      landingScripts.add(f)
      for (const spec of importsOf(read(f))) {
        expect(spec.startsWith('./')).toBe(true)
        visitLanding(`${posix.normalize(posix.join(dirname(f), spec))}.ts`)
      }
    }
    visitLanding(`${EXAMPLE_DIR}/src/landing.ts`)
    expect([...landingScripts].sort()).toEqual([`${EXAMPLE_DIR}/src/landing.ts`, `${EXAMPLE_DIR}/src/vrmStore.ts`])
    const local = [...landing.matchAll(/\b(?:src|srcset)="([^"]+)"|<meta (?:property="og:image"|name="twitter:image") content="([^"]+)"/g)].map((m) => m[1] ?? m[2]!)
    expect(local.length).toBeGreaterThanOrEqual(3)
    expect(local.filter((u) => !u.startsWith('./landing/'))).toEqual([])
    for (const u of new Set(local)) {
      const f = `${EXAMPLE_DIR}/${u.slice(2)}`
      expect(existsSync(join(ROOT, f))).toBe(true)
      // 画は 1 枚 200KB まで
      expect(statSync(join(ROOT, f)).size).toBeLessThan(200_000)
    }
    // 「入る」2 つと「VRM なしで入る」・共有のカード・リポジトリ・ライセンスの案内
    expect(landing).toContain('href="/walk/"')
    expect(landing).toContain('href="/walk/?quality=low&amp;town=low"')
    expect(landing).toContain('href="/walk/?vrm=none"')
    for (const m of ['property="og:title"', 'property="og:description"', 'property="og:url" content="https://sakurami-cho.0235.app/"', 'name="twitter:card" content="summary_large_image"']) expect(landing).toContain(m)
    for (const w of ['https://github.com/kanon-claire-thompson/sakurami-cho', 'CC BY-NC 4.0', 'MIT', 'https://kanon.0235.co.jp/guidelines/']) expect(landing).toContain(w)

    // アプリ: src/main.tsx を 1 つ読み、#root と進み具合（#loading）がある
    const walk = read(`${EXAMPLE_DIR}/walk/index.html`).replace(/<!--[\s\S]*?-->/g, '')
    expect([...walk.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1])).toEqual(['/src/main.tsx'])
    expect(walk).toMatch(/<div id="root"><\/div>/)
    expect(walk).toMatch(/<div id="loading" /)
    // 進み具合の段は src/loading.ts の STEP_LABELS と同じ名前・並び・字
    const loading = codeOf(read(`${EXAMPLE_DIR}/src/loading.ts`))
    const labels = [...(loading.match(/const STEP_LABELS: Record<StepId, string> = \{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+): '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(labels.length).toBe(7)
    const rows = [...walk.matchAll(/data-step="(\w+)"[^>]*>\s*<span class="step-name">([^<]+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(rows).toEqual(labels)
    // 引き継ぐ所: main.tsx が読み（フォントの段・描き始め）、準備の合図（scene/Scene.tsx）が消す
    expect(codeOf(read(`${EXAMPLE_DIR}/src/main.tsx`))).toMatch(/import \{ loadingFonts, loadingRender \} from '\.\/loading'/)
    expect(codeOf(read(`${EXAMPLE_DIR}/src/scene/Scene.tsx`))).toMatch(/walkerState\.ready = true[\s\S]{0,120}loadingReady\(\)/)
  })

  test('package.json: 名前・private・パッケージは workspace:*、kanon-lab を書かない、three などの範囲はパッケージと同じ。scripts は dev・build・preview', () => {
    const p = pkg()
    expect(p.name).toBe(EXAMPLE_NAME)
    expect(p.private).toBe(true)
    expect(p.type).toBe('module')
    const dep = p.dependencies as Record<string, string>
    const dev = p.devDependencies as Record<string, string>
    expect(dep[PKG_NAME]).toBe('workspace:*')
    expect(Object.keys({ ...dep, ...dev }).filter((n) => n === 'kanon-lab' || n.startsWith('@kanon-lab/'))).toEqual([])
    // パッケージの peer は同じ範囲で書く（2 つ読まれないように）。ほかの依存も、パッケージの devDependencies にある物は同じ範囲（@types・typescript など）
    const own = readJson('package.json')
    const peers = own.peerDependencies as Record<string, string>
    for (const n of PKG_PEERS) expect(dep[n]).toBe(peers[n]!)
    const ownDev = own.devDependencies as Record<string, string>
    expect(Object.entries({ ...dep, ...dev }).filter(([n, r]) => ownDev[n] !== undefined && ownDev[n] !== r)).toEqual([])
    expect(Object.keys(p.scripts as object).sort()).toEqual(['build', 'dev', 'preview'])
    // パッケージの tsconfig（入口だけ）には入れない
    expect(read('tsconfig.json')).not.toContain('examples')
  })

  test('パッケージ（入口・道具）は例のアプリを読まない（kanon-lab が読まないことは kanon-lab の見張り）', () => {
    const readers = packageFiles().flatMap((f) =>
      importsOf(read(f))
        .filter((spec) => spec === EXAMPLE_NAME || spec.startsWith(`${EXAMPLE_NAME}/`) || resolveSpec(f, spec).startsWith(`${EXAMPLES_DIR}/`))
        .map((spec) => `${f} -> ${spec}`),
    )
    expect(readers).toEqual([])
  })
})

describe('見張りの仕組みそのもの', () => {
  test('数える import: 型だけ・副作用だけ・export … from・動的な import() を数え、コメントと文字列の中は数えない（テンプレート文字列の行の頭は数える）', () => {
    const text = [
      "import type { A } from '../../../../src/stream/direction'",
      "import '../../../../src/state/labStore'",
      'const m = await import("../../../../src/kanon/index")',
      "export { C } from '../../world/walk/townWalk.ts'",
      "// import { D } from 'react'",
      '/*',
      "import { E } from 'react'",
      '*/',
      "/** 例: await import('react') */",
      "const s = \"await import('react')\"",
      'const code = `',
      "import { Servo } from './hardware'",
      '`',
    ].join('\n')
    expect(importsOf(text).sort()).toEqual(['../../../../src/kanon/index', '../../../../src/stream/direction', '../../../../src/state/labStore', '../../world/walk/townWalk.ts', './hardware'].sort())
    // URL の :// はコメントと見ない。行の途中の // のあとは数えない
    expect(importsOf("const u = 'https://x/'; const m = await import('three') // import('react')")).toEqual(['three'])
  })

  test('パッケージの読み方の誤りを、わけごとに取り違えない', () => {
    const world = [
      "import { a } from './lab/plan'",
      "import type { B } from '../core/town'",
      "import { C } from '../character/avatar/body'",
      "import { D } from '../../../src/config/layout'",
      "import { E } from 'sakurami-cho/core/town'",
      "import { F } from '@kanon-lab/shared'",
      "import * as THREE from 'three'",
      "import { VRM } from '@pixiv/three-vrm'",
      'const m = await import("@react-three/fiber")',
      "import '/src/main'",
      "import { G } from 'src/config/layout'",
      "import { H } from '../tools/args.mjs'",
      "import { I } from '../examples/town-walker/src/town'",
    ].join('\n')
    expect(packageViolations('world/x.ts', world).sort()).toEqual(
      [
        'world/x.ts -> character/avatar/body（逆向き）',
        'world/x.ts -> ../../src/config/layout（kanon-lab）',
        'world/x.ts -> src/config/layout（kanon-lab）',
        'world/x.ts -> sakurami-cho/core/town（自分の名前）',
        'world/x.ts -> @kanon-lab/shared（kanon-lab）',
        'world/x.ts -> @pixiv/three-vrm（外）',
        'world/x.ts -> @react-three/fiber（外）',
        'world/x.ts -> /src/main（kanon-lab）',
        'world/x.ts -> tools/args（読まない入口）',
        'world/x.ts -> examples/town-walker/src/town（入口の外）',
      ].sort(),
    )
    // キャラクターの側: 型だけ・副作用だけ・動的な import で kanon-lab を読むのも数える。似た名前は取り違えない
    const character = [
      "import type { A } from '../../../../src/stream/direction'",
      "import '../../../../src/state/labStore'",
      'const m = await import("../../../../src/kanon/index")',
      "import { B } from '../ride/x'",
      "import { C } from 'react-something'",
      "import { D } from 'react-dom/client'",
    ].join('\n')
    expect(packageViolations('character/avatar/x.ts', character).sort()).toEqual(
      [
        'character/avatar/x.ts -> ../../src/stream/direction（kanon-lab）',
        'character/avatar/x.ts -> ../../src/state/labStore（kanon-lab）',
        'character/avatar/x.ts -> ../../src/kanon/index（kanon-lab）',
        'character/avatar/x.ts -> react-dom/client（外）',
      ].sort(),
    )
    // core は three も読まない（three-stdlib などの似た名前は別）。react は React・R3F を読んでよく、下の入口はどれも読める
    expect(packageViolations('core/x.ts', "import { Vector3 } from 'three/webgpu'\nimport { S } from 'three-stdlib'")).toEqual(['core/x.ts -> three/webgpu（外）'])
    expect(packageViolations('react/x.tsx', "import { useFrame } from '@react-three/fiber'\nimport { A } from '../character/a'\nimport { B } from '../core/b'")).toEqual([])
    // 道具: core・world・character は読めるが、react/ と React は読まない。kanon-lab を読まない
    expect(packageViolations('tools/sync.mjs', "import { T } from '../core/town.ts'\nimport { L } from '../../../src/config/layout'\nimport { R } from '../react/index.ts'\nimport 'react'").sort()).toEqual(
      ['tools/sync.mjs -> ../../src/config/layout（kanon-lab）', 'tools/sync.mjs -> react/index（読まない入口）', 'tools/sync.mjs -> react（外）'].sort(),
    )
    expect(hits('src/config/runtime', ['src/config/runtime'])).toBe(true)
    expect(hits('src/config/runtimeX', ['src/config/runtime'])).toBe(false)
  })

  test('地図の中の kanon-lab の気配を、わけごとに取り違えない（頭と名前はコメントの中も、字はコメントの外の文字列だけ。8-2a）', () => {
    const text = [
      "// kanon.place で置いた（コメントは作った時の記録なので数えない）",
      '/** route=auto のときの乗り物（via=hover など。コメントは数えない） */',
      '/** 花音が乗る。pnpm sync:town の案内 */',
      "console.warn(`[sakurami-cho] ${id} は別の場所です。placeAt で置いてください`)",
      'const ride = kanon.ride // 文字列の外のコードは数えない',
      "const a = '[kanon-lab] 読めません'",
      'return `花音が乗り場にいません。先に kanon.place soranowa-front で`',
      'const b = "ignore_hours=on"',
      "const d = `夜中は route=auto か via=auto`",
      "const e = 'route を auto に' // 地図の口の言葉（route・via の値）はよい",
      'function reset(stopKanon: boolean) {}',
      '// 環境変数 KANON_TOWN_SRC（コメントの中でも名前は数える）',
      "const c = 'kanonStandX' // 語の一部は数えない",
      'let kanonIn = 0 // 8-5c の前の名前',
      'const _lastKanon = new THREE.Vector3()',
      'const room = kanonRoom(f, w) // 設定資料のデータ（花音の部屋を作る関数）は数えない',
      "const lamp = { id: 'kanon-led', room: 'kanon' } // データの id も数えない",
      'const kanonInside = true // 語の一部は数えない',
    ].join('\n')
    expect(kanonTraces('x.ts', text).sort()).toEqual(
      ['x.ts: [kanon-lab]（頭）', 'x.ts: stopKanon（名前）', 'x.ts: KANON_TOWN_SRC（名前）', 'x.ts: kanonIn（名前）', 'x.ts: _lastKanon（名前）', 'x.ts: kanon-lab（字）', 'x.ts: 花音が（字）', 'x.ts: kanon.place（字）', 'x.ts: ignore_hours（字）', 'x.ts: route=（字）', 'x.ts: via=（字）'].sort(),
    )
    // 道具（words = false）は字を見ない。頭と名前は見る
    expect(kanonTraces('t.mjs', "console.error('先に pnpm sync:town で書き出してください')\nconst src = process.env.KANON_TOWN_SRC", false)).toEqual(['t.mjs: KANON_TOWN_SRC（名前）'])
    expect(kanonTraces('ok.ts', "console.info(`[sakurami-cho] 町を組み立てました`)\nconst label = '花音の部屋の作業机'")).toEqual([])
  })

  test('使う人に見える所の kanon-lab の言葉を、コメントの外（文字列・JSX の字）と資料の全部で数える（8-8）', () => {
    const tsx = [
      '// kanon-lab の案内を写した（コメントは数えない）',
      '/** kanon.place で置く（コメントは数えない） */',
      '      {/* kanon-lab と同じ霧（JSX のコメントも数えない） */}',
      '      <p>書き出し直すのは道具（kanon-lab の根なら <code>pnpm sync:town</code>）</p>',
      "const a = 'https://example.com/x' // URL の // は文字列の中。このコメントは数えない: kanon-lab",
      'const b = `花音が乗っています`',
      "const c = 'route=auto'",
      '      <p>書き出し直すのは <code>pnpm sync:town</code>（このリポジトリの script はよい）</p>',
    ].join('\n')
    expect(visibleTraces('x.tsx', tsx)).toEqual(['x.tsx: kanon-lab', 'x.tsx: 花音が', 'x.tsx: route='])
    expect(visibleTraces('i.html', '<!-- kanon-lab と同じ -->\n<title>town-walker</title>')).toEqual([])
    expect(visibleTraces('README.md', '使う側の例: KANON LAB\nガイドライン（https://kanon.0235.co.jp/guidelines/ ）')).toEqual(['README.md: KANON LAB'])
    expect(visibleTraces('package.json', '{ "description": "Kanon_Lab のコードを読まない" }')).toEqual(['package.json: Kanon_Lab'])
  })

  test('道具が使う側の置き場所に頼る所を、わけごとに取り違えない', () => {
    // 道具: 根を自分の置き場所から出す・使う側の置き場所を書く（コメントの中は数えない。URL の :// は残す）
    const tool = [
      "// 前は resolve(dirname(fileURLToPath(import.meta.url)), '..') の public/town に書いた",
      "const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')",
      "const dest = resolve(root, 'public', 'town')",
      "const dest2 = join(root, 'public/models/animations')",
      "const src = process.env.SAKURAMI_TOWN_SRC ?? '../kanon/setting-book/town'",
      "const here = __dirname + '/packages/sakurami-cho/core'",
      "const ok = 'https://zenodo.org/records/1' // public/ と書いても数えない",
    ].join('\n')
    expect(toolMisuses('t.mjs', tool).sort()).toEqual(
      ['t.mjs: import.meta.url（置き場所）', 't.mjs: __dirname（置き場所）', 't.mjs: public/（使う側）', 't.mjs: setting-book（使う側）', 't.mjs: packages/sakurami-cho（使う側）'].sort(),
    )
    expect(toolMisuses('t.mjs', "const dest = resolve(root, 'public', TOWN_DATA.dir)")).toEqual(['t.mjs: public/（使う側）'])
    // 行のコメントの中の /* は、コメントの始まりと見ない（その先の文を落とさない）
    expect(toolMisuses('t.mjs', "// 町の地図データ（data/*.geojson）を読む\nexport const OUT = 'public/town'\n/** 層ごとに分ける */")).toEqual(['t.mjs: public/（使う側）'])
    expect(toolMisuses('t.mjs', "const { at } = toolArgs('sync:town', '使い方', {}, ['out'])\nconst dest = resolve(at(values.out), TOWN_DATA.dir)")).toEqual([])
  })

  test('例のアプリの読み方・書き方の誤りと、入口の index の export のほかの文を、わけごとに取り違えない', () => {
    const f = `${EXAMPLE_DIR}/src/x.ts`
    const deps = new Set(['three', '@react-three/fiber', 'sakurami-cho'])
    const app = [
      "import { createTown } from 'sakurami-cho/world'",
      "import { TownView } from 'sakurami-cho/react'",
      "import { TOWN_DATA } from 'sakurami-cho/core/town'",
      "import { TownRoot } from 'sakurami-cho/react/TownView'",
      "import { a } from '../../../core/town'",
      "import { k } from '../../../../../src/kanon'",
      "import { s } from '@kanon-lab/shared'",
      "import '/src/main'",
      "import { Effects } from 'postprocessing'",
      "import * as THREE from 'three/webgpu'",
      "import { fileURLToPath } from 'node:url'",
      "import { b } from './scene/b'",
      "const vrm = 'models/kanon.vrm'",
      "const dir = new URL('../../../../../public', import.meta.url)",
      "const ok = new URL('../../../assets', import.meta.url) // public/ と書いても数えない",
      "const sample = 'three-vrm-girl.vrm'",
      "const avatar = loaded.vrm ?? `models/${name}.vrm` // 拡張子だけ・プロパティは数えない",
      '<input type="file" accept=".vrm" />',
    ].join('\n')
    expect(exampleMisuses(f, app, deps).sort()).toEqual(
      [
        `${f} -> sakurami-cho/core/town（深いパス）`,
        `${f} -> sakurami-cho/react/TownView（深いパス）`,
        `${f} -> core/town（相対で外）`,
        `${f} -> ../../src/kanon（相対で外）`,
        `${f} -> @kanon-lab/shared（kanon-lab）`,
        `${f} -> /src/main（kanon-lab）`,
        `${f} -> postprocessing（書いていない依存）`,
        `${f}: @kanon-lab/（kanon-lab の置き場所）`,
        `${f}: src/（kanon-lab の置き場所）`,
        `${f}: kanon.vrm（kanon-lab の置き場所）`,
        `${f}: public（kanon-lab の置き場所）`,
        `${f}: ../../../../../public（パッケージの外）`,
        `${f}: three-vrm-girl.vrm（VRM のファイルの名前）`,
      ].sort(),
    )
    // ページは自分の入口 /src/main.tsx・/src/landing.ts だけ書ける（import は数えない。どのページがどれを読むかはページの見張り）
    const html = '<script type="module" src="/src/main.tsx"></script>\n<!-- ../../src/ と書いても数えない -->\n<link href="/public/x.css" />'
    expect(exampleMisuses(`${EXAMPLE_DIR}/index.html`, html, deps)).toEqual([`${EXAMPLE_DIR}/index.html: public/（kanon-lab の置き場所）`])
    const landingHtml = '<script type="module" src="/src/landing.ts"></script>\n<script type="module" src="/src/other.ts"></script>'
    expect(exampleMisuses(`${EXAMPLE_DIR}/index.html`, landingHtml, deps)).toEqual([`${EXAMPLE_DIR}/index.html: src/（kanon-lab の置き場所）`])
    // 入口の index: 選んだ名前の export（複数行・型も）と export {} はよく、export *・コード・ほかの import は数える。react は export * と登録の import もよい
    const index = "/** 入口 */\nexport { a, b } from './a'\nexport type {\n  C,\n  D,\n} from './c'\nexport {}\nexport * from './e'\nimport './f'\nconst x = 1"
    expect(indexExtras('world', index)).toEqual(["world/index.ts: export * from './e'", "world/index.ts: import './f'", 'world/index.ts: const x = 1'])
    expect(indexExtras('react', index)).toEqual(['react/index.ts: const x = 1'])
    // 公開の口の名前: 型も・複数行も・as の後ろの名前。export * とコメントの中は数えない
    expect(indexNames("// export { z } from './z'\nexport { b, a as c } from './a'\nexport type {\n  D,\n  type E,\n} from './d'\nexport * from './f'")).toEqual(['D', 'E', 'b', 'c'])
  })

  test('前の町の名前（8-5d）: 漢字・旧字（間を空けた形も）・ローマ字（大文字小文字・間を空けた形も）を数え、桜木丘・SAKURAGI-OKA・SAKURAGIOKA・sakuragioka・SAKURAGI-LAB を数えない', () => {
    const ja = OLD_TOWN.ja
    const roman = OLD_TOWN.roman
    const R = roman.toUpperCase()
    const spaced = [...R].join(' ')
    // 数える
    for (const s of [`${ja}町駅`, `${ja}高専`, `ルミエール${ja}`, `${ja}`, OLD_TOWN.old.join(''), OLD_TOWN.old.join(' '), OLD_TOWN.old.join('　'), `building.ekimae.${roman}cho-station`, `bridge.${roman}gawa`, `${R}CHO STATION`, `sub: '${R}'`, `${R} 1872`, spaced, `vol2_${roman}cho_guide.md`, `${roman[0]!.toUpperCase()}${roman.slice(1)} Cherry`]) {
      expect([s, oldTownNames(s).length]).toEqual([s, 1])
    }
    // 数えない（替わっていない名前と、新しい名前）
    for (const s of [`${ja}丘`, `${ja}丘ラボ`, `${ja}丘天文台`, `${ja}丘電波観測所`, `${R}-OKA`, `${R}OKA OBSERVATORY`, `building.${roman}oka.lab`, `LOCAL:${R}-LAB-ENU`, `${spaced}-OKA`, '桜見町駅', '桜見', 'SAKURAMI STATION', '櫻見', '櫻 見', 'S A K U R A M I', 'sakurami-cho']) {
      expect([s, oldTownNames(s)]).toEqual([s, []])
    }
  })

  test('import.meta.env はコメントの中なら数えない', () => {
    const env = /\bimport\.meta\.env\b/
    expect(env.test(codeOf('/** kanon-lab は import.meta.env.BASE_URL */\nconst a = 1 // import.meta.env も'))).toBe(false)
    expect(env.test(codeOf("const u = 'http://x/' + import.meta.env.BASE_URL"))).toBe(true)
  })
})
