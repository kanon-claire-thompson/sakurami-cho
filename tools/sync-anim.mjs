// キャラクターの見た目が既定で使う待機・歩き・跳ぶのアニメーション（.vrma）を、自由に使える素材から作る。
// 使い方: node tools/sync-anim.mjs --out <アセットの根> [--root <根>]
//   （待機 idle.vrma と切り替える待機 idle-2〜4.vrma・歩き walk.vrma・跳ぶ jump-start.vrma・jump-loop.vrma・jump-land.vrma。書き出し先はアセットの根の models/animations/。
//   パスは character/avatar/visualConfig.ts の animations）
//   使う側は自分の package.json の script で --root・--out を渡す。相対のパスは根（--root。既定は作業ディレクトリ）から。
//   素材の置き場は根の .cache/anim/（git に入れない）。
//
// 素材から .vrma を作る変換は tools/anim/convert.mjs（素材の表 SOURCES・取得・T ポーズへの置き換え・書き出し）。
// 使う側が自分の .vrma（身ぶりなど）を作るときも、その変換を名前（sakurami-cho/tools/anim）で読んで使う。
// 素材: 待機は StayStill（MIT）、歩きと跳ぶは Quaternius「Universal Animation Library」（CC0）。ファイルごとの出典は assets/models/animations/CREDITS.md
import { resolve } from 'node:path'
import { convertAnimations, IDLE_OUTPUT, IDLE_VARIANT_OUTPUTS, JUMP_OUTPUTS, WALK_OUTPUT } from './anim/convert.mjs'
import { toolArgs } from './args.mjs'

const { root, values, at } = toolArgs('sync:anim', 'node tools/sync-anim.mjs --out <アセットの根> [--root <根>]', { out: { type: 'string' } }, ['out'])

try {
  await convertAnimations({
    cacheDir: resolve(root, '.cache/anim'),
    assetRoot: at(values.out),
    outputs: [IDLE_OUTPUT, ...IDLE_VARIANT_OUTPUTS, WALK_OUTPUT, ...JUMP_OUTPUTS],
    generator: 'sakurami-cho tools/sync-anim.mjs',
  })
} catch (e) {
  console.error(`[sync:anim] ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
}
