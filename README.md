# sakurami-cho（桜見町の地図）

架空の港町「桜見町」を、ブラウザの 3D（three.js）で歩ける形にした地図のパッケージ。町の地図データとアセット、町・ラボ・キャラクター
（VRM）を動かす仕組み、React Three Fiber（R3F）の薄い包み、地図データを書き出す道具が入っている。
好きな VRM を読み込んで町じゅうを歩き回れる例のアプリ（`examples/town-walker`）も付いている。

見た目はアニメ塗り（`world/anime/`）: 町・空・水・建物・木・乗り物・名前のある建物とその中は、時刻で配色が変わる平らな塗り（くっきり 2 段の影・帯の空・
形のある雲・平らな窓と水・2 段の光だまり）、ラボは下地と 2 段の影・物が落とす影・ネオンの照り返し・金属の縁、どちらにも輪郭線。読み込んだ VRM の MToon も
ラボと町の光に合わせる（[docs/usage.md](docs/usage.md) の「アニメ塗り」）。前のリアル寄りの見た目は 2026-10-20 に無くした（git の履歴に残る）。

- npm には出していない（下の「自分のアプリに入れる」）
- ライセンスはコードが MIT、町の地図データと設定資料をコードの形で書いた物が CC BY-NC 4.0（下の「ライセンス」）

## 例のアプリを動かす

デモ: https://sakurami-cho.0235.app/ （入口のページから「入る」で開く。PC のブラウザ向け）

clone したリポジトリの根で（Node 24・pnpm 10・Bun 1.3）:

```bash
pnpm install
pnpm example:dev     # 開発（入口は http://localhost:5174/、アプリは /walk/。ビルドは pnpm example:build で、出力は examples/town-walker/dist/）
```

任意の VRM を読んで、WASD・クリック・行き先の一覧（旅程。乗り物にも乗る。ホバーはどこからでも呼んで乗れる）・ワープで町じゅうを動き、町の時刻と画質を変えられる。
操作・URL の引数・`?debug` の口は [examples/town-walker/README.md](examples/town-walker/README.md)。

## 自分のアプリに入れる

使う側の依存に、git のタグで入れる（`<タグ>` はこのリポジトリのタグ）:

```bash
pnpm add github:kanon-claire-thompson/sakurami-cho#<タグ>   # package.json は "sakurami-cho": "github:kanon-claire-thompson/sakurami-cho#<タグ>"
```

three・three-vrm・three-vrm-animation は peer の依存（React・R3F・drei は `sakurami-cho/react` を使うときだけ）なので、使う側が同じ範囲で入れる。
ビルドせず `.ts` のまま読ませるので、使う側は Vite など、`.ts` をそのまま読めるバンドラーで読む。

最小のコード（例のアプリの形）:

```ts
import { createTown } from 'sakurami-cho/world'
import { createCharacter, driveDirect, driveRides, driveTravel, setWarpPermit } from 'sakurami-cho/character'

// 町は 1 ページに 1 つ（2 回目は例外）。アセットの根（docs/usage.md の「assetBase の約束」）と画質・読み込みの状態の知らせ先を渡す
const town = createTown({ assetBase: import.meta.env.BASE_URL, allTiles: true, postEffects: false, onStatus: (status, message) => {} })
// 人は 1 人ずつのインスタンス。乗り物に乗っている間は標準の順、乗っていない間は旅程が先・旅程が無ければ WASD とクリック
const walker = createCharacter({ id: 'walker', spawn: 'front', seed: null })
walker.drivers.motion = driveRides
walker.drivers.travel = (c, t, dt) => driveTravel(c, t, dt) || driveDirect(c, t, dt)
town.setFocus(walker)                          // 細かさ・光の中心・扉を開ける・えきもりの会釈の相手
setWarpPermit((c) => c === walker)             // 町の時計を早送り・カットで進めてよい人
town.on('outsideness', (k) => walker.setRimBlend(k))
```

R3F で描くときは、`sakurami-cho/react` の `<TownView />` がアニメ塗り（ラボの素材の差し替え・時刻の配色・影の地図・注目点の人の VRM の合わせ）を動かす。
後処理を自分で組まないなら、`gl.render` の代わりに `<AnimeRender />` を置く（輪郭線を引いて、トーンマッピングと SMAA をかけて描く。例のアプリの `src/scene/Scene.tsx`）。

アセット（`assets/`）は、使う側が自分の public の根と同じ URL で出し、その URL を `assetBase` に渡す（[docs/usage.md](docs/usage.md) の「assetBase の約束」「アセット」）。

## 中身

| 置き場 | 中身 |
|---|---|
| `core/` | three を読まない: 座標・地名・立ち寄り先・道順・歩く道のグラフと経路探索・時刻表・町の時計・ラボの間取りのデータ |
| `world/` | three: 町・ラボ（殻・什器のキット・照明・素材）・名前のある建物・中のある建物・公共交通・町の音。口は `world/createTown.ts` |
| `character/` | three + three-vrm: キャラクター（VRM・姿勢・歩き・道探し・乗り降り・旅程・ホバーを呼ぶ） |
| `react/` | R3F の薄い包み（React・R3F を使ってよいのはここだけ） |
| `tools/` | 地図データ・アニメーションを書き出す道具（Node・bun で動かす。[docs/tools.md](docs/tools.md)） |
| `assets/` | アセット（[docs/usage.md](docs/usage.md) の「アセット」） |
| `examples/town-walker/` | 例のアプリ（上の「例のアプリを動かす」。配る物 `files` には入れない） |
| `test/` | テスト（Bun）と境目の見張り `map-boundary.test.ts`（配る物には入れない） |
| `LICENSE`・`LICENSE-CODE`・`LICENSE-DATA` | ライセンスの案内と、MIT・CC BY-NC 4.0 の全文（下の「ライセンス」） |

## 開発

clone したリポジトリの根で（`pnpm install` のあと）:

```bash
pnpm test            # テスト（bun test test/。境目の見張り test/map-boundary.test.ts も）
pnpm typecheck       # 型の確かめ（入口とテスト）
pnpm check:walk      # 町の歩く道のグラフの確かめ（道具は docs/tools.md）
```

CI（GitHub Actions）が push と pull request のたびに、型の確かめ・テスト・例のアプリのビルド・`check:walk` を流す。
例のアプリは Cloudflare Workers に静的なページとして出す（設定は `wrangler.jsonc`。`npx wrangler deploy` がビルドしてから出す）。

## 資料

- [docs/usage.md](docs/usage.md): 組み込む人向け。公開の口の表・アニメ塗り（町の塗り・ラボの塗り・輪郭線・VRM の合わせ）・毎コマの順・フォント・落とした VRM・カメラ・直接の操作・ワープの部品・データの形の版・assetBase の約束・アセットの並び
- [docs/tools.md](docs/tools.md): 地図データ・アニメーションを書き出す道具の引数・素材から `.vrma` を作る変換・`package.json` の script

## ライセンス

2 つのライセンスでできている（案内は [LICENSE](LICENSE)）。

- 下の表のパスは **CC BY-NC 4.0**（[LICENSE-DATA](LICENSE-DATA)。Creative Commons Attribution-NonCommercial 4.0 International の legal code の全文）
- それ以外のコードは **MIT**（[LICENSE-CODE](LICENSE-CODE)。Copyright (c) 2026 株式会社0235）
- 他の人の素材は、その出典（CREDITS）のライセンス: `assets/textures/` は CC0（[assets/textures/CREDITS.md](assets/textures/CREDITS.md)）、
  `assets/models/animations/` は MIT・CC0（[assets/models/animations/CREDITS.md](assets/models/animations/CREDITS.md)）

CC BY-NC 4.0 にする物（町の地図データと、設定資料をコードの形で書いた物）:

| パス | 中身 |
|---|---|
| `assets/town/**` | 町の地図データ（`tools/sync-town.mjs` が設定資料の町の地図データから書き出した物） |
| `core/places.ts` | 町の立ち寄り先の表 |
| `core/labPlan.ts` | 設定資料の間取り（ラボの部屋・ゾーン・入口・外形） |
| `core/routes.ts` | 道順（区間と目印） |
| `core/interiors.ts` | 中のある建物のゾーンと部屋 |
| `core/cableStations.ts` | ケーブルカーの駅 |
| `core/soranowa.ts` | 観覧車ソラノワ |
| `core/travel.ts` | 町の行き先とゾーンの出入口 |
| `core/spots.ts` | ワープ先の名前の表 |
| `core/lab/plan.ts` | ラボの間取りのデータ |
| `core/lab/placements.ts` | ラボの什器の置き場所の表 |
| `core/lab/kits/*.plan.ts` | 什器のキットの形と寸法 |
| `world/outdoor/interior/briefs/**` | 中のある建物の設定（部屋と家具） |
| `world/outdoor/named/kits/**` | 名前のある建物の形 |
| `world/outdoor/interior/pictures.ts` | 設定資料の字から描く絵 |

MIT のコードも、既定の表（上の CC BY-NC 4.0 の物）を読んで動く。表を自分の物に差し替えずに使うときは、CC BY-NC 4.0 の条件（非営利・表示など）も掛かる。

キャラクター（花音・クレア・トンプソン）の扱いは株式会社0235 のガイドライン（https://kanon.0235.co.jp/guidelines/ ）に従う。
