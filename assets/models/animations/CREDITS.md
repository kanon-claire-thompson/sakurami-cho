# モーションの出典（assets/models/animations/）

`assets/models/animations/` の `.vrma`（キャラクターの見た目が既定で使う待機・切り替える待機・歩き・跳ぶ）は、下の自由に使える素材のモーションから `tools/sync-anim.mjs` が作った物です
（素材から `.vrma` を作る変換は `tools/anim/convert.mjs`。素材ごとの設定は `SOURCES`、どの素材のどのアニメーションを使うかは `IDLE_OUTPUT`・`IDLE_VARIANT_OUTPUTS`・`WALK_OUTPUT`・`JUMP_OUTPUTS`）。
骨の向きを VRM の T ポーズの基準にそろえ、ループにつなぐ・震えをならす などの手を加えています（手の加え方は `tools/anim/convert.mjs` の頭のコメント）。

## 素材

| 素材 | 作者 | ライセンス | 入手先 |
|---|---|---|---|
| StayStill（待機のモーションのデータセット。LaFAN1 の骨格に合わせた BVH） | Eneko Atxa Landa | MIT License（Copyright (c) 2026 Eneko Atxa Landa。全文は下） | https://zenodo.org/records/18741736 ・ https://github.com/Enekoassets/StayStill |
| Universal Animation Library（Standard 版） | Quaternius | CC0 1.0 Universal（パブリックドメイン） | https://quaternius.com/ ・ https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip |

StayStill の論文: Eneko Atxa Landa, Igor Rodriguez, Elena Lazkano, Taras Kucherenko, "StayStill: A Large-Scale 3D Idle Animation Dataset", arXiv:2605.13693, 2026.

ライセンスの文書は、道具が作るときに取ってきて確かめる（StayStill は Zenodo の `LICENSE.txt` に「MIT License」、Quaternius は zip の中の `License.txt` に「CC0」）。
CC0 の素材は表記が要らないが、感謝をこめて書いておく。

## ファイルと素材

| ファイル | 中身 | 素材 | 素材の中のアニメーション |
|---|---|---|---|
| `idle.vrma` | 待機のループ | StayStill（MIT） | `wei_lr_16` と `wei_rl_16`（16 番の人の左右への体重移動）をつないだ物 |
| `idle-2.vrma` | 切り替える待機のループ（体重を移しながら、ときどき横を見る） | StayStill（MIT） | 待機のフォルダの `idle_25` の 0〜14 秒 |
| `idle-3.vrma` | 切り替える待機のループ（片方の脚に体重を預けた、くつろいだ立ち方） | StayStill（MIT） | 待機のフォルダの `idle_34` の 1〜15 秒 |
| `idle-4.vrma` | 切り替える待機のループ（ゆっくり大きく体重を移す） | StayStill（MIT） | 待機のフォルダの `idle_06` の 12〜26 秒 |
| `walk.vrma` | 歩き（その場で歩くループ） | Universal Animation Library（CC0） | `Walk_Loop` |
| `jump-start.vrma` | 跳ぶ: 踏み切り（しゃがんだ所から伸びて上がる。1 回） | Universal Animation Library（CC0） | `Jump_Start` |
| `jump-loop.vrma` | 跳ぶ: 跳んでいる間（ループ） | Universal Animation Library（CC0） | `Jump_Loop` |
| `jump-land.vrma` | 跳ぶ: 着く（脚を伸ばして着き、しゃがんで立つ。1 回） | Universal Animation Library（CC0） | `Jump_Land` |

StayStill から作った `.vrma`（`idle.vrma`・`idle-2.vrma`〜`idle-4.vrma`）には、glTF の `asset.copyright` にも著作権の表示（`Motion data from the StayStill dataset. Copyright (c) 2026 Eneko Atxa Landa. MIT License.`）を入れている。

## StayStill のライセンス（全文。Zenodo の LICENSE.txt のまま）

```
MIT License

Copyright (c) [2026] [Eneko Atxa landa]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
