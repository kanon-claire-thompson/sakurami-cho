# テクスチャの出典

`assets/textures/` 以下の画像はすべて **CC0 1.0（パブリックドメイン）** のテクスチャです。
クレジット表記は不要ですが、管理のため出典を記録しています。
ファイル名は使いやすいように変更し、必要なマップだけを残しています。

地図の見た目はアニメ塗りだけなので、前のリアル寄りの見た目だけが使っていた質感の写真（床のコンクリート `concrete_floor/`・ヘアライン金属 `brushed_metal/`・
壁パネル `panel_metal/`・ガラスのくもり `smudges/`・ラボの外壁の打ち放し `lab_exterior/`・パンチングメタルの法線 `perforated_metal/normal.jpg`・
町の地面 `town/ground-albedo.webp`・`ground-normal.webp`）は 2026-10-20 に外した（git の履歴に残る）。

| フォルダ | 元アセット | 配布元 | 解像度 | ライセンス | 用途 |
|---|---|---|---|---|---|
| `perforated_metal/` | Sheet Metal 002 | [ambientCG](https://ambientcg.com/view?id=SheetMetal002) | 1K | CC0 | 有孔ボード・パンチングメタルの穴の形（opacity。アニメ塗りの素材の alphaMap） |

## 町の質感（`town/`。`world/outdoor/town/townTextures.ts`）

ambientCG の 1K-JPG を取り込み、層ごとに 1 枚の縦長の画像にまとめて WebP にした（色は明るさの平均を 0.5 にそろえ、AO を少し掛けた。法線は NormalGL）。
建物は 512px。並びは townTextures.ts の `BUILDING_LAYER`。取得日: 2026-10-04

| ファイル | 層 | 元アセット（すべて [ambientCG](https://ambientcg.com/)・CC0） | 用途 |
|---|---|---|---|
| `town/building-albedo.webp`・`building-normal.webp` | 0 板張り・1 漆喰・2 石・3 煉瓦・4 コンクリート・5 波板・6 タイル・7 瓦・8 スレート | [WoodSiding008](https://ambientcg.com/view?id=WoodSiding008)・[Plaster003](https://ambientcg.com/view?id=Plaster003)・[Bricks066](https://ambientcg.com/view?id=Bricks066)・[Bricks085](https://ambientcg.com/view?id=Bricks085)・[Concrete034](https://ambientcg.com/view?id=Concrete034)・[CorrugatedSteel005](https://ambientcg.com/view?id=CorrugatedSteel005)・[Bricks060](https://ambientcg.com/view?id=Bricks060)・[RoofingTiles006](https://ambientcg.com/view?id=RoofingTiles006)・[RoofingTiles003](https://ambientcg.com/view?id=RoofingTiles003) | 中のある建物の板の床の木目（0 板張り） |
| `town/foliage.webp` | 葉のかたまりの板（2×2: 広葉樹の密・広葉樹の疎・楓・針葉樹） | 広葉樹の葉は [Leaf001](https://ambientcg.com/view?id=Leaf001) の葉を切り抜いて並べた。楓の葉・針葉樹の葉と小枝は形を描いた（自作。CC0 として扱う） | 木の塊の形（A） |

- ambientCG のライセンス: https://docs.ambientcg.com/license/ （CC0）
- 取得日: 2026-09-27
