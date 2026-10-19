# 組み込む人向けの資料

`sakurami-cho` を自分のアプリに組み込むときに引く資料。入れ方と最小のコードは根の [README](../README.md) の「自分のアプリに入れる」、道具は [tools.md](tools.md)。

依存の向きは core ← world ← character ← react の一方向。パッケージは使う側のファイルを読まない（使う側の物は、下の「公開の口」の差し込み口と表の差し替えで渡す）。

入るのは `files` の物（`core`・`world`・`character`・`react`・`tools`・`assets`・README・LICENSE・LICENSE-CODE・LICENSE-DATA）。例のアプリとテストは入らない。
ビルドせず `.ts` のまま読ませる（`exports` の深いパス `sakurami-cho/core/…`・`world/…`・`character/…` と、入口の index。react は入口の index だけ）。

コードのコメントにある `docs/design/*.md`・`§…` は、作った時の設計メモを指す（このリポジトリには入れていない）。

## 公開の口

使う側は入口の index（`sakurami-cho/core`・`world`・`character`・`react`）から読む。core・world・character の index は、選んだ名前だけを出す
（`export *` はしない。名前がぶつからないように・出す名前が公開の口になるので）。出すのは、例のアプリ（[examples/town-walker](../examples/town-walker/README.md)）が使う物と、地図の表・
差し込み口を差し替える・読む口、それらの引数・返り値・欄の型（この表と index の一致は `test/map-boundary.test.ts` が見る。足す・消すときは、
index・この表・見張りの一覧 `PUBLIC_API` を一緒に直す）。

深いパス（`sakurami-cho/core/…`・`world/…`・`character/…`）も読めるが、公開の口ではない。名前・形・置き場所は変わることがあり、ファイルを動かしたら
minor の版を上げる。

| 入口 | 名前 | 中身 |
|---|---|---|
| core | `TOWN_PLACES`・`townPlaces`・`configurePlaces`・型 `TownPlace`・`PlaceId`・`TownPlaceId`・`PlaceAction` | 立ち寄り先の表（地図の既定の 42 か所・今の表・使う側が欄を足した表に差し替える） |
| core | `INTERIOR_ZONES`・`zoneOfPoint`・型 `InteriorZoneId`・`ZoneId` | 中のある建物のゾーンの表と、点がどのゾーンか |
| core | `TRAVEL_PLACES`・型 `TravelPlaceId`・`TRAVEL_ROUTES`・`TRAVEL_ROUTE_IDS` | 町の中の移動の行き先（立ち寄り先のほか）と道順 A〜G |
| core | `SPOT_KINDS`・型 `SpotKind` | ワープ先の種類と一覧の組の名前 |
| core | `parseTimeOfDay`・`parseDate`・`timeOfDayName`・型 `DateParts`・`LabTime` | 時刻（`HH:MM`）と日付（`YYYY-MM-DD`）を読む・時間帯の名前。町の時刻 `town.sun.time` の形 |
| core | `TOWN_DATA`・`TOWN_QUALITY`・型 `TownQualityName` | 町の地図データの形の版（下の「データの形の版」）・町の画質の段（low・high・film・final） |
| core | `LAB_PLACEMENTS`・型 `LabPlacement`・`labAnchor`・型 `LabAnchorData` | ラボの置き場所の表（地図の既定。使う側が足した表を react の `TownRoot` の `placements` に渡す）とアンカーを引く |
| world | `createTown`・型 `Town`・`TownCreateOptions`・`TownStatus`・`TownClock`・`TownFocus`・`TownFrame`・`TownEventMap` | 町の口（1 ページに 1 つ。根の [README](../README.md) の「自分のアプリに入れる」）と、その引数・読み込みの状態・時計・注目点・毎コマの段（`begin`・`update`・`view` の引数）・出来事 |
| world | `PALETTE`・`FONTS` | 背景と霧の色・ラボの看板と画面のフォント（下の「フォント」） |
| world | `configureLab` | ラボの差し込み口（什器の入力の値・差し込み口の中身・画面の描き方） |
| world | `createFollowCamera`・型 `FollowCamera`・`FollowCameraOptions`・`FollowTarget` | 人を追うカメラ（下の「カメラ・直接の操作・ワープ」） |
| character | `createCharacter`・型 `Character`・`CharacterOptions`・`CharacterSpawnPoint`・`CharacterDriver` | キャラクター（1 人ずつのインスタンス）と、毎コマ動かす所（`ch.drivers.motion`・`travel`）の型 |
| character | `createCharacterVisual`・型 `CharacterVisual`・`CharacterVisualOptions`・`CharacterVisualStatus`・`CharacterVisualClip`・`VISUAL_DEFAULTS`・型 `VisualConfig` | 見た目（VRM と待機・歩き・跳ぶ・身ぶりの `.vrma`）と既定の値。`CharacterVisual` の `start()`・`stop()`・`update()`・片付ける `dispose()` |
| character | `configureVrmAnime`・`VRM_ANIME`・型 `VrmAnimeOverrides`・`VrmAnimeMaterialRule`・`VrmAnimeLineRule` | アニメ塗りのラボ・町に立つ VRM の MToon の合わせの既定の値と、材質ごと・mesh ごとの上書き（下の「アニメ塗り」） |
| character | `updateLocomotion`・`placeAt`・`goTo`・`stopWalking`・`configureNav`・型 `NavConfig` | 歩きを毎コマ進める・立ち寄り先へ置く・歩かせる・止める・ラボのまわりの通り道（点と障害物）を差し替える |
| character | `driveRides`・`setWarpPermit`・型 `RideTime`・`wheelBoardProblem`・`beginWheelBoarding`・`cancelWheelBoarding`・`requestWheelAlight`・`advanceWheelTo`・`WHEEL_EXIT_OPEN_DEG`・型 `WheelProblem`・`wheelProblemText` | 乗り物に乗っている間に人を動かす標準の順・町の時計を早送り・カットで進めてよい人・観覧車ソラノワに乗る・降りる。乗れない理由は種類（`code`）と値で返し、`wheelProblemText` が地図の既定の字を作る（使う側は種類ごとに自分の字にしてよい） |
| character | `startTravel`・`driveTravel`・`cancelTravel`・`traveling`・`travelState`・型 `TravelRequest`・`TravelPlan`・`TravelTime`・`TravelCut`・`TravelRouteId`・型 `TravelProblem`・`isTravelProblem`・`travelProblemText` | 町の中の移動（旅程: ゾーンを出て町の道を歩き、乗り物にも乗る）を始める・毎コマ進める・取り消す・様子。作れない理由は種類（`code`）と値で返し（`isTravelProblem` で分ける）、`travelProblemText` が地図の既定の字を作る |
| character | `setDirectInput`・`driveDirect`・`walkToPoint`・`pickGround`・`canStand`・`stopDirect`・`directState` | 人を直接動かす（WASD・クリック。下の「カメラ・直接の操作・ワープ」） |
| character | `jump` | 跳ぶ（例のアプリのスペースキー。下の「カメラ・直接の操作・ワープ」） |
| character | `summonHover`・`hoverStatus`・型 `HoverStatus` | ホバーを呼ぶ・ホバーの様子（例のアプリの「ホバーを呼ぶ」。乗るのは旅程の `via: 'hover'`。下の「カメラ・直接の操作・ワープ」） |
| character | `townSpots`・`teleport`・`placeAtPoint`・型 `TownSpot` | ワープ（下の「カメラ・直接の操作・ワープ」） |
| react | `TownClock`・`TownRoot`・`TownView`・`TownExposure`・`LabAtmosphere`・`LabSlot`・`CharacterView`・`RideDriver`・`AnimeRender`・`LabAnimeView`・`useLab` などの hooks | R3F の薄い包み（`export *`。`AnimeRender` はアニメ塗りの輪郭線を引いて描く。下の「アニメ塗り」） |

## 基地局の入力の値（`configureLab` の `channels.baseStation`）

基地局（XW-08）の光り方は、使う側が入力の値（`BaseStationChannels`）で決める。値は読むたびに見る（getter の付いた物を渡せば、使う側の値をそのまま読む）。
渡さない名前は既定の値のまま。

| 名前 | 値（既定） | 効く所 |
|---|---|---|
| `ring` | 0〜1（0） | リングの加速（回る速さが 1 + 5 × ring 倍） |
| `ringBoost` | 0〜1（0） | リングの一気の加速（回る速さに 14 × ringBoost を足し、管の流れも速く） |
| `link` | 0〜1（0） | 通信のグリーン（管の色・コアの明るさ・画面の LINK ESTABLISHED） |
| `flash` | 0〜1（0） | 接続が確立した瞬間のフラッシュ |
| `pulse` | 0〜1（0） | 演出の脈 |
| `core` | 0〜1（1） | コアの明るさ。コアの球・光る殻・まわりのエネルギーリング・支柱とハウジングの緑の線・にじみと、照明のコアの光に掛ける。0 で消灯 |
| `amber` | 0〜1（0） | 琥珀の混ぜ具合。コアの緑と外周リングの表示灯（区切りの表示灯 24 個と縁の光の線（ふだんはシアン）、中間リングのエミッタ 12 個（ふだんは青）。白く飛ばないよう琥珀のぶん少し暗く）の色、照明のコアの光の色を琥珀（`PALETTE.amber`）へ寄せる |

`core`・`amber` は、設定（vol6 3-8）の状態の表示を外から作るための値。たとえば STANDBY（淡い緑の呼吸光）は `core` を 0.2〜0.45 くらいでゆっくり上下させる、
LOST（消灯し、外周の表示灯が琥珀色）は `core: 0`・`amber: 1`。呼吸・明滅の形（時間の動き）は地図では決めず、使う側が毎コマの値で作る。
既定の 1・0 では前と同じ見た目（反射用の環境の光る板は、コアの明るさで変えない）。

## アニメ塗り

地図の見た目はアニメ塗りだけ（前のリアル寄りの見た目と、町の塗りを差し替える口 `configureOutdoorPaint`・ラボの床の映り込み `floorReflection` は
2026-10-20 に無くした）。置き場は `world/anime/`（町とラボ）・`character/avatar/vrmAnime.ts`（VRM）・`react/AnimeView.tsx`（R3F の包み）。
R3F の包みを使えば、使う側がすることは `<AnimeRender />` を置くかどうか（下の「輪郭線」）と、VRM の材質ごとの上書き（任意）だけ。

### 町の塗り（`world/anime/townPaint.ts`）

町・空・水・地形・建物・木・乗り物・名前のある建物とその中・ラボの外観の材質は、材質を組み立てるとき（シェーダーを作るとき）に外の塗り
（`world/outdoor/paint.ts` の `outdoorPaint()` が返す `TOWN_PAINT`）の式を呼ぶ。太陽・空の光・空気の色は `outdoorUniforms`（時刻で連続に変わる）を元に、
それを次のように描き替える（HDR の色のまま。外へ出たときの自動露出・ラボの窓からの明るさの釣り合いのため）:

- 光（`light`）: 光の当たる側（太陽 × keyGain + 空の光 × skyGain。夜は月の光）と影（光の当たる側 × 青紫・藍の影の色）の 2 段。境目は面の向きと町の太陽の影の地図。
  木と草は 3 段。面の色は彩度を上げる。面の種類 `PaintSurface`（`ground`・`wall`・`roof`・`frame`・`structure`・`tree`・`grass`・`prop`・`named`・`site`・`vehicle`・`dome`・`other`）を受ける
- 空（`sky`・`skyDome`）: 空の色の元（`world/outdoor/materials.ts` の `skyColorBase`）を高さの帯で塗り分け、雲は形のはっきりした塊（夕方は縁が金）、太陽と月は平らな円（月は満ち欠け）
- 空気遠近（`haze`）・窓（`window`。昼は空の色の平らなガラスと斜めの帯、夜は点いた窓の暖色、1 階の店はショーウィンドウ）・水（`water`。平らな色と空の帯の映り・形の決まった帯）・
  滝と霧（`fall`・`particle`）・灯りが照らす面（`lampFalloff`・`lampLight`。2 段の光だまり）・光の点（`glow`）・中のある建物の中（`interior`。照度を 2 段）・
  光る物（`emit`）・透けるガラス（`glass`）
- 細かい模様は描かない（質感の写真・汚れ・まだら・窓の奥の部屋とカーテン・映り込み・つやの照り返し）。形の決まった模様（窓の格子・枠・店の看板の帯・棟の帯・ベランダの床）は残す。
  看板の文字は画を組んだ文字の形（`world/outdoor/glyph.ts`。夜は板と文字を分けて光らせる）、観覧車の LED はスポークを流れる琥珀の帯と外周の潮位の帯、
  停留所の屋根の下の灯りの板は金属の天井板と丸い灯りの並び

時刻の配色（`TOWN_TIMES`: 昼・朝・夕・宵・夜・夜中。重みは太陽の高さと夜中の度合いから `townWeights`）は、毎コマ `updateTownPaint(outdoor)` が混ぜて
`townPaintUniforms` に書く（react の `TownView` の中の `LabAnimeView` が呼ぶ）。CPU で町の光を読む口: `townKeyDisplay`（町の光の当たる側と影の色。画面のリニア）・
`interiorKeyDisplay`（中のある建物の部屋の光）・`acesDisplay`（three の ACES を CPU で）。町に連れ歩く物の塗りを町に合わせるのに使う（kanon-stream-video の KB-001）。

町の灯りの照度を CPU で読む口: `world/outdoor/town/lamps.ts` の `lampLightAt(x, y, z, 色, 向き)`（灯りの表の升の灯りの照度の和と、灯りへの向き。
VRM の合わせが人に町の灯りの色を乗せるのに使う）。

材質には塗りの印を付ける（`material.userData` の `PAINT_MARK`（`'outdoorPaint'`）に、塗りの種類 `light`・`flat`・`window`・`water`・`sky`・`interior`・
`glow`（意図して平らに光らせる物）・`helper`。`world/outdoor/paint.ts` の `markPaint`）。描き方は変えない。使う側は場面の材質を巡って、印の無い物を見つけられる
（kanon-stream-video の `src/scene/anime/audit.ts`）。

### ラボの塗り（`world/anime/labAnime.ts`・`material.ts`・`palette.ts`）

ラボの殻と什器は、素材の表（`MeshStandardMaterial`・`MeshPhysicalMaterial`。色・金属の度合い・透け・名前だけ。質感の写真は持たない）で作り、描くときに
アニメ塗りの素材（光の計算をしない `MeshBasicNodeMaterial`）に差し替える（`labAnime()`。ページに 1 つ）:

- 下地は素材の名前で役割を引く（`palette.ts` の `BY_NAME`・`ANIME_PALETTE`。名前の無い・表に無い物は元の色から）。素材の名前は `world/materials/labMaterials.ts` の欄の名前
  （`wallPanel`・`darkMetal`・`steel` など）と、殻と什器がじかに作る物の役割の名前（`wallBacking`・`ceiling`・`labFloor` など。`test/lab-kits.test.ts` が名前の無い素材が無いことを確かめる）
- 時刻の配色（`ANIME_TIMES`: 昼・夕・夜・夜中）× 下地、キーライトの向きとの 2 段の影、物が落とす影（`keyShadow.ts`。動かない物は向きが変わったときだけ・動く物は毎コマ）、
  ネオンの照り返し（`neon.ts`。ラボの照明の色の付いた光を拾う）、金属の縁。色は画面に出る色で書き、ACES の逆に通す
- 差し替えた物には輪郭線の層（`OUTLINE_LAYER`）と影を落とす物の層を足す。差し込み口（`slot:`）の中は触らない
- 使う側の物も同じく塗れる: `labAnime().convertMesh(mesh, 動く物か, 色の式?)`（色の式を渡せば配色を自分の値に。kanon-stream-video は KB-001 を町の光に合わせる）。
  `labAnime().auto = false` で時刻の配色を書かない（手で値を書いて確かめる）

### VRM の合わせ（`character/avatar/vrmAnime.ts`）

町の注目点の人（`town.setFocus` に渡した `Character`）の VRM の MToon を、読み込んだあとに合わせる（`LabAnimeView` が `applyVrmAnime`。VRM のファイルは変えない）。
どの VRM にも既定の値（`VRM_ANIME`）で効く:

- 明暗の向き: 光ごとの向きでなく 1 つの向き（ラボではラボのキーライト、町では町の光の向き。中のある建物の中は部屋の灯りと窓）で分ける。光ごとの向きは明るさにだけ効かせる
- 外にいる間は、近くの町の灯りの照度の和（`lampLightAt`）をその色のまま足す。光の色の鮮やかさ・光の和の膝（knee）・時刻ごとの露出と夜の外の露出・光の当たる側の時刻の色の照り
- 影の色を青紫へ寄せ、明暗の境をくっきり。縁の光を弱く。MToon の outline は太さ 0（後処理の線を引く）。ライトの影の地図を受けない
- 輪郭線の層と、部位の推定（材質の名前から: 目・眉・まつ毛・レンズは合わせず線も引かない、肌・顔・口・髪は顔の線（内側の折れなし）・縁の光なし・肌は弱く合わせる、
  ほかは材質ごとに部位の番号を振って境目に線を引く。推定のときは、どの VRM の影の色が暗くても夜に沈まないよう、影の色を「色 × 0.75」へ 0.6 だけ寄せ、肌のほかも
  6 割の強さで合わせる。VRoid の名前（`N00_000_00_EyeIris_00_EYE` など）と、よくある名前）
- 材質ごと・mesh ごとの上書き: `configureVrmAnime({ material: (名前) => ({ keep, weight, shift, shadeLift, noRim }), line: (mesh, 名前) => ({ none, face, id }) })`
  （VRM を読み込む前に。返さなければ推定。kanon-stream-video の花音は材質の名前で決めた表を入れる）

光の値（明暗の向き・灯り・露出）はページに 1 組（注目点の人に合わせる）。

### 輪郭線（`world/anime/outline.ts`）

後処理の線: ラボの物と人（層 `OUTLINE_LAYER` の物）は、層だけを法線と深さで描き直して外形と折れの線、町（層の外 = 窓の外・外の町）は場面の深さだけで外形と角の線
（`townLineEdge`。遠くほど細く薄く・光る物には引かない）。線の色は面の色を暗くして色味を付けた色。値は `OUTLINE`。

- 後処理を組まないアプリ: react の `<AnimeRender antialias? />` を `gl.render` の代わりに置く（場面 → 輪郭線 → レンダラのトーンマッピングと露出 → SMAA。優先度 1）
- 後処理を組むアプリ: `animeOutline(色, 場面の viewZ, 場面の深さ, scene, camera, 画素の比)` を自分の RenderPipeline の中に入れる（毎コマ `update(camera)`。kanon-stream-video の `src/scene/Effects.tsx`）

### 細かい模様・細い形

細かい模様は 1 画素の幅で平均する（カメラが動いてもチカチカしないように。kanon-stream-video の `scripts/flicker-check.mjs` で見つけた物）:
看板の文字の画（`glyph` の `fw`）、乗り物の行き先の表示の橙の点と文字の升（`transit/transitMaterial.ts`。点・升が画素より細かくなる遠くでは平均の明るさ）、
窓・店のガラスの線と棚・光の点（`townPaint.ts` の `cover`・`glow`）。模様の線・点を `step` で切ると、数 m 先から画素の間に落ちたり乗ったりする。

細い形は、画素より細くなる遠くで画素の幅まで太らせる（`world/outdoor/thin.ts`）: 名前のある建物の細い角柱（格子の桟・手すりの子柱・細い腕。
断面が 6cm 以下で長さがその 3 倍以上の箱。`named/kitBuilder.ts` の `box` が頂点に `aThin` = 細い向きの中心の線からの差と断面の半分の幅を書き、
`namedMaterial.ts` の頂点の式 `thinWidened` が中心の奥行きでの 1 画素の大きさまで広げる）・小物の細い箱（ベランダの手すりの子柱・アンテナ。`town/props.ts` の
`thinSize`）・小物の手すりの塗りで抜く格子（`barHalfWidth`）。広げるのは断面が画素より細い所だけ（8 倍まで）で、近くは前と同じ形。三角形が画素より細いと、
画素の中心に乗ったり外れたりして線が切れたり出たりする（塗りの式では平均できない）。

形を捨てるときは `world/dispose.ts` の `disposeGeometries`（Sprite の形は捨てない。three の全部の Sprite が 1 つの形を共有するので、1 つを捨てると
ほかの Sprite が壊れたバッファで描き続けて、WebGPU の送りが毎コマ捨てられる）。

## 毎コマの順

毎コマの順（R3F の `useFrame` の優先度。小さい方が先。例のアプリの `src/scene/Scene.tsx`）: 町の時計 `<TownClock>`（−90）→ 乗る仕組み `<RideDriver>`（−79）→
歩きを進める `updateLocomotion(ch, t, min(dt, 0.1))`（−58）→ 遠景と外の光 `<TownView>` の `town.update`（−50）→ アニメ塗り `<TownView>` の中の `<LabAnimeView>`
（−45。ラボの塗りの見直し・ラボと町の時刻の配色・注目点の人の VRM の合わせと光）→ 追うカメラ `cam.update(ch, 目の高さ, dt)`（−1）→
ラボ・殻・什器 `<TownView>` の `town.view` と見た目 `<CharacterView>`（0）→ 露出 `<TownExposure>`（0.95）→ キーライトの影の地図 `<LabAnimeView>`（0.98）→
描く（1。0 より大きい優先度の購読があると R3F は自分で描かないので、使う側が `<AnimeRender />` を置くか、自分の後処理で描く）。ラボの形はテクスチャを読み終えてから `<Suspense>` の中の `<TownRoot town={town}>` が作る（`placements` を省けば地図の既定の置き場所の表）。
`town.frame(f)`（4 つの段を続けて呼ぶ）は人を動かさない使い方だけ（乗る仕組みと歩きは `begin` と `update` の間、カメラは `view` の前でないといけないため）。

## 描く物を減らす仕組み（WebGPU）

WebGPURenderer は描く物 1 つごとの CPU の仕事が重いので、ラボは場面に付けるときに描く物を減らす（kanon-claire-thompson/kanon-stream-video#25 の第 3 段）。
使う側がすることは無い（`<TownView>` と `town.attach`・`town.view` がする）が、次の決まりがある:

- `town.attach` のあと（最初に描く前）、`lab.mergeStatic()` が殻と什器の動かない mesh を、素材・影の設定・レイヤー・頂点の並びごとに 1 つの形へ合わせ、
  動かない物の行列を固める（`matrixAutoUpdate = false`。`world/staticMerge.ts`）。作ったあとで位置・回転・大きさ・見え隠れを変える物は、作るときに
  `markDynamic(物)` で印を付ける（付け忘れると、その物は合わさって動かなくなる）。差し込み口（`slot:` の群）の中は触らない
- 什器と空気は、見えないコマだけ隠す（`lab.cull`。`world/lab/labCull.ts`）。カメラがラボの箱の外で、箱が視野の外か、GPU の遮蔽のクエリで 3 回続けて
  ほかの物の陰のとき。箱の `lab.cull.proxy` は `<TownView>` が場面に置く（何も描かない）。毎コマ `town.view` が `lab.cull.update(camera)` を呼ぶ
- 1,024 個以下の InstancedMesh は、入れ物を 1,025 個以上で作って `count` で減らす（`world/instancing.ts` の `instancedMesh`。同じ素材の物がパイプラインを共有する）
- 何度も描き直す Canvas は `createCanvas2D(w, h, { dynamic: true })`（CPU の側の Canvas。テクスチャへ写すのが速い）
- 場面の根（R3F の `scene`）の行列を固めてよい（`matrixAutoUpdate = false`。例のアプリの `src/App.tsx`）。`matrixWorldAutoUpdate = false` にするなら、
  描く前に使う側が `scene.updateMatrixWorld()` を呼ぶ（床の映り込みはその場合、撮る前に自分で呼ぶ）

## フォント

ラボの看板・画面は Canvas に字を描く（`FONTS` の Orbitron・Share Tech Mono・Noto Sans JP が頭のフォント）。Web フォントは字の範囲（unicode-range）ごとに届き、
Canvas に描いても範囲は読み込まれないので、使う側がフォントを読み込んで（`document.fonts.load(フォント, 描く字)`）から描き始める（一度だけ描くラベルは
代わりのフォントのまま残る）。例のアプリは `walk/index.html` で Google Fonts を読み、`src/main.tsx` がラボで描く字（ラボの字を変えたら数え直す）と
Orbitron の 500・700・900 を最大 3 秒待つ。町の看板・名前のある建物・中のある建物の絵の字は、頭のフォントが OS の `"Noto Sans CJK JP"` なので待たない。

## 落とした VRM（blob:）

キャラクターの見た目の `url` に、使う人が選んだ・落としたファイルの `blob:` の URL（`URL.createObjectURL`）をそのまま渡せる（絶対の URL には `assetBase` を付けず、
`blob:`・`data:` は HEAD で確かめずに読む）。`stop()` は読んだ VRM を片付けないので、入れ替えるときは使う側が、前の見た目の `dispose()` を呼んで
（`stop()` をして、読んだ VRM の形・素材・テクスチャを片付け（`VRMUtils.deepDispose`）、縁の光の素材の一覧 `ch.rim.tuned` から外す。読み込みの途中なら、
あとで届いた VRM もすぐ片付ける）、前の `blob:` の URL を取り消す（例のアプリの `src/vrm.ts`）。

## カメラ・直接の操作・ワープ

例のアプリのように、使う人が町を自由に動き回るための部品:

| 部品 | 中身 |
|---|---|
| `world/followCamera.ts` | 人を追うカメラ `createFollowCamera(camera, { distance, minDistance, maxDistance, yaw, pitch, labObstacles })`。毎コマ `update(人, 目の高さ, dt)`（人の位置が決まったあと・町の `view` の前）。注視点は足元 ＋ 目の高さ、町の建物・木・擁壁・中のある建物の壁や家具・部屋の無い建物（楓坂駅の上屋とホーム）の外形の線・ラボの壁と家具と殻・地面と草むらにさえぎられたら手前へ寄せ、すぐ近くなら上から見下ろす向きへ逃がす。地面・床の 0.3m 上より下へ行かず、草むらの生える地形の上では地形の 0.65m 上より下へ行かない（土手に埋まったホームの上のように、カメラの床より少し上に地形があれば地形を床にする）。追う物の `ride`（Character をそのまま渡す）が車室の中なら、カメラを車室の壁・天井・床の内に収め（狭ければ向きも回す）、車室と一緒に運ぶ。`snap()`（次のコマで一度に置く。人の `'place'` で呼ぶ）・`orbit`・`zoom`・`connect(要素)`（ドラッグで回す・ホイールで寄る）。乗り物の車体はさえぎる物に入れていない |
| `character/ride/drive.ts` | 乗り物に乗っている間に人を動かす標準の順 `driveRides`（観覧車 → ケーブル → 緑電 → 運河バス → ホバー。`ch.drivers.motion = driveRides`） |
| `character/avatar/direct.ts` | 人を直接動かす（WASD・クリック）。`ch.drivers.travel = (c, t, dt) => driveTravel(c, t, dt) \|\| driveDirect(c, t, dt)`（旅程が先）。`setDirectInput(ch, 世界の向き \| null, 走る)`（カメラの向きから直すのは使う側）・`pickGround(線)`（地面・床の高さの関数でたどって拾う。建物・壁に当たれば null）・`walkToPoint(ch, x, z, y?)`（今いる所のグラフの中で道を作る。ゾーンをまたぐ・立てない所なら理由の字）・`canStand(ch, x, z, y?)`・`stopDirect`・`directState`。歩けるのは道・石段・橋・広場・ホームと乗り場・ラボの中と敷地・中のある建物の今の階の床と段・ゾーンの出入口の間で、建物・木の幹・擁壁で止まって沿ってすべる（段は 0.45m まで）。状態は Character ごとにこの中に持つ |
| `character/avatar/jump.ts` | 跳ぶ。`jump(ch)`（跳び始めたら null、跳べなければ理由の字で何もしない。呼ばなければ跳ばない）。踏み切る前に 0.14 秒しゃがみ、足元の地面から上へ跳んで重さ（9.8m/s²）で落ち、着いて 0.3 秒しゃがむ。高さは踏み切ったときの横の速さで決め、止まって・歩いて 0.45m、走って 0.6m（間はなめらかに。`jumpHeightFor`。遠くへは空中の時間が延びる分だけ伸びる）。毎コマ進めるのは `updateLocomotion`（段階と高さは `ch.motion.jump`）。天井の低い所（ラボの扉・中のある建物の部屋と扉と段・橋の下）では、頭（VRM の実測の身長 + 6cm）が天井に当たらない高さまで。横の動きは跳んでいないときと同じ決まりで、立てるかは足元の地面から見る（段・壁・柵・擁壁を越えず、着くのは歩いて行ける所だけ）。跳んでいる間は上がれる段の高さの決まり（小さな段の体のなめらかな上げ下げ）を使わず、WASD の間は踏み切ったときの速さと向きを保ち（手を離しても落とさない）、入力の向きへ地面より弱く（1.6m/s²。地面の加速の半分）速さを足して少しだけ向きと速さを変えられる（速さの上限は踏み切ったときの速さと歩きの速さの大きい方。止まって跳んでから少し前へずらすこともできる）。クリックで歩く道の途中は道に沿って進む。乗り物に乗っている・座っている・旅程の途中・旅程の早送りの途中・扉をくぐる途中は跳ばず、跳んでいる途中に乗り物・旅程が動き出した・置き直されたら地面に戻す。見た目は跳ぶ `.vrma`（踏み切り・跳んでいる間・着く）を段階に合わせて重ね、無ければコードの姿勢（しゃがむ → 伸びる → 着いてしゃがむ） |
| `character/avatar/turnStep.ts`・`turnStepPose.ts`・`limbIk.ts` | その場で向きを変える足踏み。着いて向きを合わせる（`turnEnd`）・歩き出す前に向く（`turnStart`）・見る先へ体ごと向き直る（`policy.faceToward`）・旅程の歩き出す前と着いた後は、体を回しながら足を滑らせず、1 歩ずつ回る（`stepTurn`。回る側の足から交互に、軸足を床に置いたまま、もう片方の足を持ち上げて回る先へ置く。体は足が宙にある間に回る。20° ほどは 1 歩、90° は 2 歩、180° は 4 歩ほど。回り終えて 0.42rad より遅れた足はそろえる）。状態は `ch.motion.step`（足ごとの床に置いた向き・持ち上げている足）。見た目は、床の足をその場に留め、持ち上げた足を弧を描いて運び（`turnStepPose.ts`。2 本の骨の IK `solveTwoBone`。届かなければ体を下げる・持ち上げる間は体重を軸足へ）、歩き出す・乗る・座る・跳ぶ・置き直すと外す。素材の足踏みの `.vrma` は無い（コードの足踏み） |
| 姿勢の層の `adjust`・`steady`（`character/avatar/layers.ts`） | `adjust(f)`: 首・視線まで入れた後、表情と `vrm.update` の前に正規化ボーンを直す段（使う側の IK など。`limbIk.ts` の `solveTwoBone`・`setWorldQuaternion` が使える）。`steady(f)`: 待機の体の揺れを弱める強さ（0〜1。腰から上の画で足す）。見た目は、頭が画の縦に占める割合（`VISUAL_DEFAULTS.steady.headFraction`）が大きい寄りの画（顔のアップ）で、待機の `.vrma` の腰・背骨・首・脚をクリップの平均の姿勢へ `steady.amount` まで寄せる。引きの画はそのまま |
| `core/places.ts` の `activityFits`・`ACTIVITY_NEEDS` | 前に物の要る行動（holo・work・type・pet・sit）を、立ち寄り先（外なら null）でできるか。holo はホロテーブル、work・type は作業台・机、pet は KB-001 のドック、sit は椅子（`seat`）のある所 |
| `core/spots.ts` | ワープ先の名前の表（座標は写さない）: 種類 `SpotKind` と一覧の組の名前 `SPOT_KINDS`（建物・ケーブルの駅・観覧車・緑電の停留所・運河バスの乗り場）、立ち寄り先の手前 `PLACE_SPOTS`（ラボの前・中のある建物 4 つの前・ケーブルの 3 駅の前・ソラノワの乗り場の前）。ホバーは乗り場が無い（どこからでも呼べる）ので入れない |
| `character/avatar/teleport.ts` | ワープ（コードでは teleport。warp は時刻の早送り・カットの名前）。`townSpots()`（名前の表の 9 と、町を組み立てたあとの地図データの緑電の停留所 37（ホームの上。地形に埋まっていない・木などにかからない所）・運河バスの乗り場 18（石段の上の陸の側の敷石）。位置・向き・ゾーン・足元の高さの目安）・`teleport(ch, spot)`（旅程の取り消し → 乗り物の早送り・カットをやめる → 旅程の早送りの倍率と歩幅を戻す → WASD・クリックの歩きをやめる → 立ち寄り先なら `placeAt`、点なら `placeAtPoint`。乗っている途中でもよく、乗る仕組みが次のコマで降りたことにする（ホバーは飛ぶ途中なら、その下の地面に下ろして置く））・`placeAtPoint(ch, x, z, heading, refY?)`（点へすぐ置く。`placeSerial` を増やして `'place'`） |
| `character/ride/hoverRide.ts` | ホバーの一人乗り（乗り場は無い。#9）。`summonHover(ch)`（呼んだら null、呼べなければ理由の字で何もしない）: 呼んだ人の近くの歩ける所（道・広場。ラボ・中のある建物の中なら、そのゾーンの外の出入口の前）を探し、ホバーが今いる所から飛んで来て、横に下りて待つ。今いる所から 100m より遠い・まだ一度も呼んでいないときは、すぐ横に現れる。`hoverStatus()`（`phase`: none・coming・parked・riding、今の所と向き・呼んだ人・来るまでの秒）。乗るのは旅程（`startTravel` の `via: 'hover'`）: 区間の始めで呼んで（来る途中・8m の内で待っているならそのまま）横から乗り、町の道のグラフ（`walk.json`）の上だけを地面から 0.6m の高さ・12 m/s で、坂・石段・橋は地面に沿って飛び、行き先（ゾーンの出入口・町の行き先の点）の近くの歩ける所に下りて降り、そこから歩く。地下の道・町の道の外（水の上・草地）は飛ばない。広い道は進む向きの左に寄り、建物・木・石段のわきの擁壁・街灯の柱・ほかの乗る人・緑電の線路（編成の幅）から横へよけ、線路を横切る所は編成のいない時刻に出る。乗っていない間は最後に下りた所に置いておく（次に呼ぶとそこから来る）。`via: 'auto'` で乗るのは、ケーブルの止まっている夜中に歩くより十分に早いときだけ |

## データの形の版（今は 10）

町の地図データ（`assets/town/`）の形の版は `core/town.ts` の `TOWN_DATA.format`（今は **10**）。これがパッケージと地図データの約束:

- `tools/sync-town.mjs` は書き出す目録（`town/manifest.json`）の `format` にこの版を書く
- 町（`world/outdoor/town/townData.ts`）は、目録の版が違うデータを読まずに、状態を `outdated` にする（使う側が書き出し直しの案内を出す）
- 書き出す形を変えたら版を上げる（版ごとの中身は `TOWN_DATA.format` のコメント）

## assetBase の約束

アセットは「アセットの根」（Web の public の根に当たる所）の下に、いつも同じ並びで置く:

```
<アセットの根>/
  town/                 町の地図データ（manifest.json・walk.json・named.json・infra.json・terrain/・ground/・tiles/）
  textures/             町・ラボのテクスチャ（town/・perforated_metal/）
  models/animations/    待機・歩き・跳ぶ .vrma（使う側の身ぶりなどの .vrma も、使う側のアセットの根のここに置ける）
```

- 町は `createTown({ assetBase, … })` で、アセットの根に当たる URL を受ける（末尾は `/`。既定は `'/'`）。読むのは `${assetBase}town/…`・`${assetBase}textures/…`
  （置き場は初めて使うときに 1 回決めて覚える。描き始める前に 1 回渡す）
- キャラクターの見た目（`createCharacterVisual`）の `assetBase` は別の引数（キャラクターは町の口を読まずに使えるように）。`.vrma` と VRM の `url` はその下からの相対パス
  （`character/avatar/visualConfig.ts` の `animations` は `models/animations/idle.vrma` など）。絶対の URL（`blob:`・`data:`・`http(s):`・`/` で始まる物）なら `assetBase` を付けない
- パッケージは Vite の `import.meta.env` を読まない。Vite のアプリなら `import.meta.env.BASE_URL` を渡す
- アセットの根はページの置き場所と別でよい。例のアプリは、アプリのページを `/walk/`（`walk/index.html`）に置き、Vite の base（アセットの根）は `/` のまま
  （`/walk/` のページも `/town/…`・`/textures/…` を読む）

## アセット

`assets/` はアセットの根と同じ並び。使う側が自分の public の根と同じ URL で出す（Vite のアプリなら、例のアプリのように `publicDir` をここに向けるか、
開発ではここから出してビルドでは出力へ写す）。

どれも git に入れてある（このリポジトリだけで町が出るように）。書き出す物（`town/`・`models/animations/`）は、道具で書き出し直したら差としてコミットする。

| 置き場 | git | 作り方 |
|---|---|---|
| `assets/textures/` | 入れる | CC0 のテクスチャ（ambientCG。パンチングメタルの穴の形・中のある建物の床の木目・葉の形）。出典は [assets/textures/CREDITS.md](../assets/textures/CREDITS.md) |
| `assets/town/` | 入れる | `tools/sync-town.mjs` が、設定資料の町の地図データ（このリポジトリには入れていない元のデータ）から書き出す（151 ファイル・約 25MB） |
| `assets/models/animations/` | 入れる | `tools/sync-anim.mjs` が自由に使える素材から作る（キャラクターの見た目が既定で使う待機 `idle.vrma` と切り替える待機 `idle-2.vrma`〜`idle-4.vrma`・歩き `walk.vrma` と、跳ぶ `jump-start.vrma`・`jump-loop.vrma`・`jump-land.vrma` の 8 つ）。出典は [assets/models/animations/CREDITS.md](../assets/models/animations/CREDITS.md) |

ここに置くのは、パッケージのコードが既定で使う物と、例のアプリで使う物まで（使う側のキャラクターに固有の物は、使う側の public に置く）。

`.vrma` の素材（`tools/anim/convert.mjs` の `SOURCES`）: 待機は StayStill（MIT ライセンス。Copyright (c) 2026 Eneko Atxa Landa。作った `.vrma` の
glTF の `asset.copyright` にも著作権の表示を入れる）、歩きは Quaternius の Universal Animation Library の Standard 版（CC0）。
`SOURCES` には Universal Animation Library 2 の Standard 版（CC0）と CMU Graphics Lab Motion Capture Database（cgspeed の BVH の版。複製・改変・再配布してよく、
商用の製品に入れてよい。データそのものは売らない。謝辞の文を出典に書く）もあり、使う側が自分の `.vrma`（腕組み・喜ぶ・手を振るなど）を作るときに使える。

待機の切り替え: `animations.idleVariants` の `.vrma` が読めれば、`animations.idle` と合わせて、決まった乱数とシーンの時計で枠ごとに待機を選び、
`idleMix.fade` 秒かけて入れ替える（`character/avatar/idleMix.ts`。1 つの枠は `idleMix.minSlot` 秒以上。同じ時刻なら同じ画になる）。
寄りの画で揺れを弱める `steady` は、切り替えの強さで混ぜた待機の平均の姿勢へ寄せる。切り替えをやめるなら `animations` の `idleVariants` を `[]` にする。
ファイルごとの素材と MIT の全文は `assets/models/animations/CREDITS.md`。取ってきたライセンスの文書に MIT / CC0 と書いてあるかは、道具が作るときに確かめる。
