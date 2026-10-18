// 人型のアニメーション（.vrma。VRM Animation）を、自由に使える素材のモーションから作る変換。
// 使い方（道具から）: convertAnimations({ cacheDir, assetRoot, outputs, generator, … })。くわしい引数は下の convertAnimations。
//   - パッケージの tools/sync-anim.mjs が、キャラクターの見た目が既定で使う待機 IDLE_OUTPUT・歩き WALK_OUTPUT を作る
//   - 使う側は自分の道具で、作る物の表（outputs。下の OUTPUT の形）を渡して、自分のアセットの根に書き出せる
//     （1 回だけ再生する身ぶりなど。身ぶりを再生する口はクリップの URL を受ける。character/avatar/characterVisual.ts の clips）
//
// 素材（どれも自由に使える。素材の表は下の SOURCES）:
// - StayStill（待機のモーションのデータセット。MIT ライセンス。Copyright (c) 2026 Eneko Atxa Landa）
//   https://zenodo.org/records/18741736 ・ https://github.com/Enekoassets/StayStill
//   待機（IDLE_OUTPUT）は、左右への体重移動（wei_lr と wei_rl）をつないで、切れ目なく繰り返す待機にする。
//   待機に足して切り替える待機（IDLE_VARIANT_OUTPUTS）は、待機のフォルダ（lafan/idle/）の区間を切り出して繰り返す。
//   動作のクリップ（見回す・伸びなど）を 1 回だけ再生する身ぶりに切り出すこともできる（OUTPUT の gesture）
// - Quaternius「Universal Animation Library」無料の Standard 版（CC0）: 歩き（WALK_OUTPUT）は Walk_Loop、跳ぶ（JUMP_OUTPUTS）は Jump_Start・Jump_Loop・Jump_Land
// - Quaternius「Universal Animation Library 2」Standard 版（CC0）: 腕組みの Idle_FoldArms_Loop など
// - CMU Graphics Lab Motion Capture Database（cgspeed の BVH の版。https://github.com/Shriinivas/cmubvh に 1 本ずつの zip。mocap.cs.cmu.edu）:
//   喜ぶ・手を振るなど。許可なく複製・改変・再配布してよく、商用の製品に入れてよい（データそのものを売るのは不可）。1 フレーム目が T ポーズ（reference: 'firstFrame'）
// - 使う側が持つ素材（人が手で置く FBX を Blender で glb にした物など）は、convertAnimations の sources で足す（公開してよくない素材の設定をここに書かない）
//
// 素材の zip は、HTTP の Range で目次と要るファイルだけを読む（StayStill の zip は 370MB あるが、読むのは数百 KB）。
// 取り出したファイルは素材の置き場（cacheDir。tools/sync-anim.mjs は根の .cache/anim/）の <素材>/ に置き、次からはネットにつながない
// （git に入れない）。Range に対応していないサーバーなら zip 全体を素材の置き場にダウンロードする。zip を手で素材の置き場に置いてもよい。
// 書き出し先はアセットの根（assetRoot）からの相対（OUTPUT の dest。待機・歩き・跳ぶは character/avatar/visualConfig.ts の animations と同じ値を下の ANIMATION_PATHS に写す）。
// 書き出した .vrma は git に入れる（作り直したら差としてコミットする）。ファイルごとの素材とライセンスは、書き出した所の CREDITS.md に書く
// （パッケージの待機・歩き・跳ぶは assets/models/animations/CREDITS.md。素材や作る物の表を変えたら、そちらも直す）。
//
// 置き換えの決まり（VRM Animation の仕様に合わせる）:
// - .vrma の骨は T ポーズを基準にする。素材の基準の姿勢から、腕・脚・指はまっすぐの向き、親指は VRM の T ポーズの決まり
//   （手の向きと前の間、45 度）にそろえたものを「T ポーズ」とみなし、骨ごとに「T ポーズからどれだけ回ったか」を出す。
//   基準の姿勢は、基本姿勢（バインドポーズ）が T ポーズの素材（Quaternius）ならそれ、BVH（StayStill）なら
//   そのアニメーションの平均の姿勢（BVH の基本姿勢は人の形になっていないため）。基準が A ポーズでも、ここで T ポーズに直る
// - 書き出す .vrma の骨は回転なし（T ポーズ）で置くので、アニメーションの回転がそのまま VRM の正規化した骨の回転になる
// - 向き: VRM は +Z が前・+X が本人の左。左右の股関節を結ぶ向きが +X になるよう、Y 軸まわりに回してそろえる
// - 腰（hips）の位置: 歩きは前に進む分を消して「その場で歩く」ループにし、両足の真ん中の平均が原点に来るようにずらす。
//   待機のループは、腰の水平の位置の平均が原点に来るようにずらす（体重移動の揺れは残す）
// - 歩きは、1 倍の速さで再生したときに足が床を滑らない進む速さ（m/s）と、そのときの脚の長さ（太もも + すね、m。
//   どちらもこの .vrma の骨格で）を、アニメーションの extras.walkSpeed・extras.legLength に書いておく。
//   sakurami-cho/character/avatar/vrmAnimation.ts がモデルの脚の長さとの比で速さを直し、sakurami-cho/character/avatar/characterVisual.ts が再生の速さを歩く速さに合わせる
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { AnimationClip, AnimationMixer, LoopOnce, Object3D, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'

/**
 * 1 回の convertAnimations の間の設定（素材の置き場・素材を取るときの User-Agent・ログの頭）。convertAnimations が初めに決める
 * （同時に 2 つは動かさない。続けて呼ぶのはよい）
 */
const run = { cacheDir: '', userAgent: 'sakurami-cho-sync-anim', tag: 'sync:anim' }

/** HTTP で取る（Zenodo は名乗らない取得を断るので、User-Agent を付ける） */
const get = (url, headers = {}) => fetch(url, { headers: { 'User-Agent': run.userAgent, ...headers } })

// --- 素材ごとの設定 ---

/**
 * 左右のある骨の表を、左右それぞれの名前に広げる。{S} が素材の左右の書き方（L / R、Left / Right など）に置き換わる
 * 例: sided({ UpperLeg: 'DEF-thigh.{S}' }, 'L', 'R') → { leftUpperLeg: 'DEF-thigh.L', rightUpperLeg: 'DEF-thigh.R' }
 */
function sided(table, left, right) {
  const out = {}
  for (const [side, s] of [
    ['left', left],
    ['right', right],
  ]) {
    for (const [bone, name] of Object.entries(table)) out[`${side}${bone}`] = name.replaceAll('{S}', s)
  }
  return out
}

/** 指の骨の表（付け根・中・先）。{F} が素材の指の名前、{N} が 1〜3 の番号の書き方に置き換わる */
function fingers(pattern, names, numbers) {
  const out = {}
  for (const [finger, name] of Object.entries(names)) {
    ;['Proximal', 'Intermediate', 'Distal'].forEach((joint, i) => (out[`${finger}${joint}`] = pattern.replaceAll('{F}', name).replaceAll('{N}', numbers[i])))
  }
  return out
}

/** Quaternius UAL1（Blender の Rigify の変形用の骨 DEF-*） */
const RIGIFY_BONES = {
  hips: 'DEF-hips',
  spine: 'DEF-spine.001',
  chest: 'DEF-spine.002',
  upperChest: 'DEF-spine.003',
  neck: 'DEF-neck',
  head: 'DEF-head',
  ...sided(
    {
      UpperLeg: 'DEF-thigh.{S}',
      LowerLeg: 'DEF-shin.{S}',
      Foot: 'DEF-foot.{S}',
      Toes: 'DEF-toe.{S}',
      Shoulder: 'DEF-shoulder.{S}',
      UpperArm: 'DEF-upper_arm.{S}',
      LowerArm: 'DEF-forearm.{S}',
      Hand: 'DEF-hand.{S}',
      ThumbMetacarpal: 'DEF-thumb.01.{S}',
      ThumbProximal: 'DEF-thumb.02.{S}',
      ThumbDistal: 'DEF-thumb.03.{S}',
      ...fingers('DEF-f_{F}.{N}.{S}', { Index: 'index', Middle: 'middle', Ring: 'ring', Little: 'pinky' }, ['01', '02', '03']),
    },
    'L',
    'R',
  ),
}

/** Quaternius UAL2（Unreal の書き方の骨。同じマネキン） */
const UNREAL_BONES = {
  hips: 'pelvis',
  spine: 'spine_01',
  chest: 'spine_02',
  upperChest: 'spine_03',
  neck: 'neck_01',
  head: 'Head',
  ...sided(
    {
      UpperLeg: 'thigh_{S}',
      LowerLeg: 'calf_{S}',
      Foot: 'foot_{S}',
      Toes: 'ball_{S}',
      Shoulder: 'clavicle_{S}',
      UpperArm: 'upperarm_{S}',
      LowerArm: 'lowerarm_{S}',
      Hand: 'hand_{S}',
      ThumbMetacarpal: 'thumb_01_{S}',
      ThumbProximal: 'thumb_02_{S}',
      ThumbDistal: 'thumb_03_{S}',
      ...fingers('{F}_{N}_{S}', { Index: 'index', Middle: 'middle', Ring: 'ring', Little: 'pinky' }, ['01', '02', '03']),
    },
    'l',
    'r',
  ),
}

/** StayStill の LaFAN1 の骨格（指は無い） */
const LAFAN_BONES = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Spine1',
  upperChest: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  ...sided(
    {
      UpperLeg: '{S}UpLeg',
      LowerLeg: '{S}Leg',
      Foot: '{S}Foot',
      Toes: '{S}Toe',
      Shoulder: '{S}Shoulder',
      UpperArm: '{S}Arm',
      LowerArm: '{S}ForeArm',
      Hand: '{S}Hand',
    },
    'Left',
    'Right',
  ),
}

/**
 * CMU の BVH（cgspeed の MotionBuilder 向けの版）の骨格。腰の下に左右の股（LHipJoint）・背骨の付け根（LowerBack）の長さ 0 の関節があり、
 * 首は 2 本（Neck・Neck1）。VRM の首は上の Neck1 にして、下の Neck の回りは胸の上（Spine1）と首の間に入る（向きはワールドで取るので、間の骨の回りも残る）。
 * 指は付け根と人差し指・親指が 1 本ずつの粗い物で、動きもほとんど無いので使わない（指はコードの手の形のまま）
 */
const CMU_BONES = {
  hips: 'Hips',
  spine: 'LowerBack',
  chest: 'Spine',
  upperChest: 'Spine1',
  neck: 'Neck1',
  head: 'Head',
  ...sided(
    {
      UpperLeg: '{S}UpLeg',
      LowerLeg: '{S}Leg',
      Foot: '{S}Foot',
      Toes: '{S}ToeBase',
      Shoulder: '{S}Shoulder',
      UpperArm: '{S}Arm',
      LowerArm: '{S}ForeArm',
      Hand: '{S}Hand',
    },
    'Left',
    'Right',
  ),
}

/** CMU の BVH（cgspeed の版）を 1 本ずつの zip で置いている所（GitHub の Shriinivas/cmubvh。zip の中は <番号>.bvh が 1 本） */
const CMU_BVH_BASE = 'https://github.com/Shriinivas/cmubvh/raw/main/'

/**
 * 使う素材（素材の id → 設定）。作る物の表（OUTPUT）の source が id で指す。別の素材（Mixamo の FBX を glb にしたものなど）を足すときは、同じ形の設定を足す
 * （使う側が自分の素材を足すときは convertAnimations の sources。公開してはいけない素材の設定は、このファイルに書かない）。
 * - url: zip の場所。zip: 素材の置き場（cacheDir）に置くときのファイル名。
 *   archives: アニメーションごとに 1 本ずつの zip に分かれている素材（CMU）。{ base: 置き場の URL, clips: { アニメーションの名前: base からのパス } }。
 *   zip は小さいので丸ごと素材の置き場の <素材>/ にダウンロードして置く（Range では読まない）
 * - local: true = 手で素材の置き場の <素材>/ に置いたファイル（glb など）をそのまま読む素材（ネットにつながない。zip も使わない）
 * - format: 'glb'（file = zip の中の glb。名前の末尾で探す）か 'bvh'（dir = zip の中の BVH のフォルダ。アニメーションの名前 = ファイル名。
 *   名前に / が入っていれば root からのパス。StayStill の待機のフォルダは 'idle/idle_08' のように書く）
 * - license: 確かめるライセンスの文書（zip の中の inZip か、別の url）と、そこにあるはずの言葉。文書の無い素材は note（確かめずに表示するだけ）
 * - reference: T ポーズの基準にする姿勢。'rest' = 基本姿勢（T ポーズの素材）/ 'firstFrame' = アニメーションごとの 1 フレーム目（CMU の cgspeed の BVH は
 *   1 フレーム目が T ポーズ。そのフレームは動きに入れない）/ { meanOf: [アニメーションの名前…] } = それらの平均の姿勢。
 *   BVH は基本姿勢が人の形になっていないので、ふつうに立っているアニメーションの平均を基準にする。この素材から作るものは全部同じ基準を使う
 *   （待機と身ぶりで、まっすぐ立った姿勢がそろうように。StayStill は全員が同じ骨格に合わせてあるので、別の人のアニメーションにも使える）
 * - fps: 取り出すコマ数（毎秒。素材がそれより細かいときは間引く。CMU は 120 → 30。無ければ素材のまま）
 * - neckToHead: 首の回転のうち、頭へ回す割合（0〜1）。LaFAN の骨格は頭の向きを首の関節だけで持っている（頭の関節は動かない）ので、
 *   VRM の首と頭に分けて、首の付け根だけで曲がって見えないようにする
 * - unit: 位置の単位を m にする倍率（StayStill の BVH は cm。CMU は 1/0.45 インチ = 0.05644 m。腰の高さが 1m 前後になる）。
 *   .vrma の腰の位置は VRM の腰の高さとの比で直して使われる（three-vrm-animation）ので、倍率は腰の動きの大きさにだけ効く。
 *   floorFromFeet: 足先のいちばん低いところを床（y = 0）にする
 * - bones: VRM の骨の名前 → 素材の骨の名前。VRM の必須の骨（腰・背骨・頭・腕・脚）は全部書く。
 *   胸の上（upperChest）・首・肩・つま先・指は、素材に無ければ書かなくてよい
 */
export const SOURCES = {
  ual1: {
    label: 'Quaternius「Universal Animation Library」Standard 版（CC0）',
    url: 'https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip',
    zip: 'universal_animation_librarystandard.zip',
    format: 'glb',
    file: 'AnimationLibrary_Godot_Standard.glb',
    license: { inZip: 'License.txt', mustInclude: 'CC0' },
    reference: 'rest',
    bones: RIGIFY_BONES,
  },
  ual2: {
    label: 'Quaternius「Universal Animation Library 2」Standard 版（CC0）',
    url: 'https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip',
    zip: 'universal_animation_library_2standard.zip',
    format: 'glb',
    file: 'Unreal-Godot/UAL2_Standard.glb',
    license: { inZip: 'License.txt', mustInclude: 'CC0' },
    reference: 'rest',
    bones: UNREAL_BONES,
  },
  staystill: {
    label: 'StayStill（MIT License, Copyright (c) 2026 Eneko Atxa Landa）',
    url: 'https://zenodo.org/api/records/18741736/files/staystill.zip/content',
    zip: 'staystill.zip',
    format: 'bvh',
    dir: 'lafan/actions/',
    root: 'lafan/',
    license: { url: 'https://zenodo.org/api/records/18741736/files/LICENSE.txt/content', mustInclude: 'MIT License' },
    /** .vrma（glTF の asset.copyright）に書く著作権の表示 */
    copyright: 'Motion data from the StayStill dataset. Copyright (c) 2026 Eneko Atxa Landa. MIT License.',
    reference: { meanOf: ['wei_lr_16', 'wei_rl_16'] },
    neckToHead: 0.5,
    unit: 0.01,
    floorFromFeet: true,
    bones: LAFAN_BONES,
  },
  cmu: {
    label: 'CMU Graphics Lab Motion Capture Database（cgspeed の BVH の版）',
    format: 'bvh',
    dir: '',
    // CMU の番号（被験者_試技）→ cmubvh のパス。使う物だけを書く（足すときは cmubvh の目次で同じ番号の zip を探す）
    archives: {
      base: CMU_BVH_BASE,
      clips: {
        '69_16': 'Sequence-060-075/69/Data/69_16.zip',
        '69_17': 'Sequence-060-075/69/Data/69_17.zip',
        '69_18': 'Sequence-060-075/69/Data/69_18.zip',
        '69_19': 'Sequence-060-075/69/Data/69_19.zip',
        '74_12': 'Sequence-060-075/74/Data/74_12.zip',
        '79_69': 'Sequence-076-080/79/Data/79_69.zip',
        '79_70': 'Sequence-076-080/79/Data/79_70.zip',
        '79_85': 'Sequence-076-080/79/Data/79_85.zip',
        '120_15': 'Sequence-113-128/120/Data/120_15.zip',
        '141_16': 'Sequence-141-144/141/Data/141_16.zip',
        '142_06': 'Sequence-141-144/142/Data/142_06.zip',
        '142_09': 'Sequence-141-144/142/Data/142_09.zip',
        '143_25': 'Sequence-141-144/143/Data/143_25.zip',
      },
    },
    // CMU のデータには文書が付いていない。使ってよい範囲は http://mocap.cs.cmu.edu/faqs.php と http://mocap.cs.cmu.edu/ のトップ（CREDITS.md に写した）
    license: {
      note: 'CMU: 許可なく複製・改変・再配布してよい（FAQ）。商用の製品に入れてよいが、データそのものを売ってはいけない（mocap.cs.cmu.edu）。謝辞の文を CREDITS.md に書く',
    },
    copyright: 'Motion data from the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu). The database was created with funding from NSF EIA-0196217.',
    reference: 'firstFrame',
    unit: 0.0254 / 0.45,
    fps: 30,
    floorFromFeet: true,
    bones: CMU_BONES,
  },
}

/** 使う側が渡した素材（convertAnimations の sources）も含めた、今の素材の表 */
let sources = SOURCES

/**
 * 作るアニメーション 1 つ（OUTPUT）の形。dest = 書き出し先（アセットの根からの相対）、source = 素材（SOURCES の id）と、次のどれか 1 つ:
 * - clip: 素材のアニメーションを 1 本そのまま使う（walk: true なら「その場で歩く」ループにして、足が滑らない速さを書く。
 *   once: true なら 1 回だけ再生する物（跳ぶ踏み切り・着くなど。ループにしないので、始めと終わりのつなぎ目を見ない）
 * - loop: 素材のアニメーションを何本かつないで、切れ目なく繰り返すループにする
 *   segments = つなぐ順のアニメーション（from・to 秒で切り出せる）、blend = つなぎ目で前後を重ねて混ぜる長さ（秒）、
 *   smooth = 震えをならす強さ（ガウスのぼかしの幅、秒）
 * - gesture: 待機から入って待機へ抜ける身ぶり（下の buildGestureOutput）。clip = 素材のアニメーション、from・to = 切り出す秒、
 *   smooth = 震えをならす強さ（秒）、lowerBody: 'neutral' = 腰から下をまっすぐ立った姿勢にする、
 *   loop: true = 繰り返すアニメーション（使う側が身ぶりの長さだけ繰り返して再生する。表示だけが変わる）、
 *   facing = 前にそろえる向きを測る所（BVH の既定 'ends' = 前後の立っているところ / 'start' = 始めの 0.5 秒 / 'mean' = 全体の平均）、
 *   mirror: true = 左右を入れ替える（素材が右手で振る手を左手に）、inPlace: true = 腰の水平の動き（歩いて進む分）を消してその場にする
 * - 切り出す所は秒（from・to）のほかに、素材のフレームの番号（fromFrame・toFrame。素材のコマ数で数え、0 から）でも書ける（clip・loop の segments・gesture のどれでも）。
 *   loop の segments の 1 本だけを切り出してつなぐと、その区間を繰り返すループになる（終わりと始まりを blend 秒重ねる）
 * - loop の align: 'standing' = 両足の真ん中を、身ぶりの立つ場所（standing の待機の両足の真ん中）にそろえる（待機を何本か切り替えて使うとき、
 *   どの待機でも足が同じ所に来るように。既定は腰の水平の位置の平均を原点にする）
 * - clip の smooth: 震えをならす強さ（秒。1 本をそのまま使うときも）
 */

/**
 * 待機・歩き・跳ぶの書き出し先（アセットの根からの相対）。キャラクターの見た目が既定で読む character/avatar/visualConfig.ts の VISUAL_DEFAULTS.animations と同じ値の写し
 * （この変換は .ts を読まない。使う側が git の依存などで入れて Node で動かすとき、Node は node_modules の下の .ts を読まないため。8-4。
 * 2 つの値が食い違うとテスト test/map-boundary.test.ts が落ちる）
 */
const ANIMATION_PATHS = {
  idle: 'models/animations/idle.vrma',
  idleVariants: ['models/animations/idle-2.vrma', 'models/animations/idle-3.vrma', 'models/animations/idle-4.vrma'],
  walk: 'models/animations/walk.vrma',
  jump: { start: 'models/animations/jump-start.vrma', loop: 'models/animations/jump-loop.vrma', land: 'models/animations/jump-land.vrma' },
}

/** 待機（キャラクターの見た目が既定で使う。character/avatar/visualConfig.ts の animations.idle）。身ぶりの立つ場所もこれで決まる */
export const IDLE_OUTPUT = {
  dest: ANIMATION_PATHS.idle,
  source: 'staystill',
  // 16 番の人の体重移動（左 → 右、右 → 左）。まっすぐ立っていて、手が体の横に自然に下りていて、震えと足の動きが少なく、
  // 2 本のつなぎ目で足の位置がほぼ同じ（1cm）ものを選んだ（体重移動の 48 人のうち、数値で絞ってから画面で見比べた）
  loop: { segments: [{ clip: 'wei_lr_16' }, { clip: 'wei_rl_16' }], blend: 0.8, smooth: 0.07 },
}

/**
 * 待機に足して切り替える待機（character/avatar/visualConfig.ts の animations.idleVariants。切り替えは character/avatar/idleMix.ts）。
 * StayStill の待機のフォルダ（lafan/idle/。1 人 1 本の 2 分ほどの待機）から、震え（手と頭の 2 階差分）・足の動きが小さく、手が腰より下にあり、
 * 始めと終わりの姿勢が近い（ループにつなげる）14 秒の区間を数値で絞ってから、画面で見比べて選んだ（2026-10-18。50 人全員の頭の 30〜50 秒を調べた）。
 * 両足の真ん中は IDLE_OUTPUT の待機にそろえる（align: 'standing'。切り替えても、身ぶりへ入っても足が滑らない）
 */
export const IDLE_VARIANT_OUTPUTS = [
  // 25 番: 体重を左右に移しながら、ときどき横を見る
  ['idle/idle_25', 0, 14],
  // 34 番: 片方の脚に体重を預けて腰を傾けた、くつろいだ立ち方
  ['idle/idle_34', 1, 15],
  // 6 番: ゆっくり大きく体重を移す
  ['idle/idle_06', 12, 26],
].map(([clip, from, to], i) => ({
  dest: ANIMATION_PATHS.idleVariants[i],
  source: 'staystill',
  loop: { segments: [{ clip, from, to }], blend: 1.0, smooth: 0.07, align: 'standing' },
}))

/** 歩き（キャラクターの見た目が既定で使う。character/avatar/visualConfig.ts の animations.walk） */
export const WALK_OUTPUT = { dest: ANIMATION_PATHS.walk, source: 'ual1', clip: 'Walk_Loop', walk: true }

/**
 * 跳ぶ（キャラクターの見た目が既定で使う。character/avatar/visualConfig.ts の animations.jump。跳ぶのは character/avatar/jump.ts）:
 * 踏み切り（しゃがんだ所から伸びて上がる。1 回）・跳んでいる間（ループ）・着く（脚を伸ばして着き、しゃがんで立つ。1 回）。
 * 見た目が段階に合わせて再生する所を決め、しゃがむ深さは混ぜる強さで浅くする（character/avatar/characterVisual.ts）
 */
export const JUMP_OUTPUTS = [
  { dest: ANIMATION_PATHS.jump.start, source: 'ual1', clip: 'Jump_Start', once: true },
  { dest: ANIMATION_PATHS.jump.loop, source: 'ual1', clip: 'Jump_Loop' },
  { dest: ANIMATION_PATHS.jump.land, source: 'ual1', clip: 'Jump_Land', once: true },
]

// --- 1. 素材の zip から、要るファイルだけを取り出す ---

/**
 * 素材の zip（{ url, zip, whole }）。アニメーションごとに zip が分かれている素材（archives）は、そのアニメーションの zip
 */
function archiveOf(id, clip) {
  const src = sources[id]
  if (!src.archives) return { key: '', url: src.url, zip: src.zip, whole: false }
  const path = clip && src.archives.clips[clip]
  if (!path) throw new Error(`素材 ${id} の zip の表（archives.clips）に ${clip} がありません（表: ${Object.keys(src.archives.clips).join(', ')}）`)
  return { key: clip, url: `${src.archives.base}${path}`, zip: `${id}/${path.split('/').pop()}`, whole: true }
}

/** zip を読む口（read(位置, 長さ)）。手元の zip があればそれ、無ければ HTTP の Range、それも駄目なら（か whole なら）全体をダウンロード */
async function openZip(src) {
  const local = resolve(run.cacheDir, src.zip)
  if (existsSync(local)) {
    const fd = openSync(local, 'r')
    const read = async (offset, length) => {
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, offset)
      return buf
    }
    return { size: statSync(local).size, read, close: () => closeSync(fd), where: local }
  }
  let range = null
  if (!src.whole) {
    const probe = await get(src.url, { Range: 'bytes=0-0' })
    range = probe.status === 206 ? probe.headers.get('content-range') : null
    await probe.body?.cancel()
  }
  if (range) {
    const read = async (offset, length) => {
      const res = await get(src.url, { Range: `bytes=${offset}-${offset + length - 1}` })
      if (res.status !== 206) throw new Error(`zip の一部を読めませんでした（HTTP ${res.status}）: ${src.url}`)
      return Buffer.from(await res.arrayBuffer())
    }
    return { size: Number(range.split('/')[1]), read, close: () => {}, where: src.url }
  }
  console.log(`[${run.tag}] 素材の zip をダウンロードします: ${src.url}`)
  const res = await get(src.url)
  if (!res.ok) throw new Error(`ダウンロードに失敗しました（HTTP ${res.status}）: ${src.url}`)
  mkdirSync(dirname(local), { recursive: true })
  writeFileSync(local, Buffer.from(await res.arrayBuffer()))
  return openZip(src)
}

/** zip の目次（名前 → 圧縮方式・大きさ・中身の位置）。ZIP64 と暗号化には対応しない */
async function readZipDirectory(zip) {
  const tailLength = Math.min(zip.size, 65557)
  const tail = await zip.read(zip.size - tailLength, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`zip の目次が見つかりません: ${zip.where}`)
  const count = tail.readUInt16LE(eocd + 10)
  const dir = await zip.read(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12))
  const entries = new Map()
  let p = 0
  for (let n = 0; n < count; n++) {
    if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip の目次が壊れています: ${zip.where}`)
    const nameLength = dir.readUInt16LE(p + 28)
    const name = dir.toString('utf8', p + 46, p + 46 + nameLength)
    entries.set(name, { method: dir.readUInt16LE(p + 10), size: dir.readUInt32LE(p + 20), local: dir.readUInt32LE(p + 42) })
    p += 46 + nameLength + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32)
  }
  return entries
}

async function readZipEntry(zip, entry, name) {
  const head = await zip.read(entry.local, 30)
  const data = await zip.read(entry.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), entry.size)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`zip の圧縮方式 ${entry.method} には対応していません（${name}）`)
}

/** 開いた zip と目次（素材ごとに 1 回だけ開く） */
const openedZips = new Map()

/**
 * 素材の zip の中のファイルを、素材の置き場の <素材>/ に取り出してそのパスを返す（もう取り出してあればそのまま）。
 * name は zip の中のパスの末尾（フォルダの名前が素材の版で変わっても探せるように）。clip は zip が分かれている素材（archives）のアニメーションの名前。
 * 手で置く素材（local）は、置いてあるファイルのパスを返す（無ければ置き方を書いて止める）
 */
async function sourceFile(id, name, clip) {
  const dest = resolve(run.cacheDir, id, name)
  if (existsSync(dest)) return dest
  const src = sources[id]
  if (src.local) throw new Error(`素材 ${src.label} の ${name} が素材の置き場にありません: ${dest}${src.howTo ? `（${src.howTo}）` : ''}`)
  const arc = archiveOf(id, clip)
  const key = `${id}:${arc.key}`
  if (!openedZips.has(key)) {
    const zip = await openZip(arc)
    openedZips.set(key, { zip, entries: await readZipDirectory(zip) })
  }
  const { zip, entries } = openedZips.get(key)
  const found = [...entries.keys()].find((n) => n === name || n.endsWith(`/${name}`))
  if (!found) throw new Error(`素材の zip の中に ${name} が見つかりません: ${zip.where}`)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, await readZipEntry(zip, entries.get(found), found))
  return dest
}

/** ライセンスの文書を取ってきて、あるはずの言葉があるか確かめる（無ければ注意を出す） */
async function checkLicense(id) {
  const { license } = sources[id]
  if (license.note) {
    console.log(`        ライセンス: ${license.note}`)
    return
  }
  let text
  if (license.inZip) text = readFileSync(await sourceFile(id, license.inZip), 'utf8')
  else {
    const dest = resolve(run.cacheDir, id, 'LICENSE.txt')
    if (!existsSync(dest)) {
      const res = await get(license.url)
      if (!res.ok) throw new Error(`ライセンスの文書を取れませんでした（HTTP ${res.status}）: ${license.url}`)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, await res.text())
    }
    text = readFileSync(dest, 'utf8')
  }
  if (!text.includes(license.mustInclude)) {
    console.warn(`[${run.tag}] 注意: ${sources[id].label} のライセンスの文書に「${license.mustInclude}」が見つかりません。ライセンスを確認してください`)
  }
}

// --- 2. 素材のアニメーションを読む ---

function parseGlb(buf) {
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('glTF バイナリではありません')
  const jsonLength = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength))
  const binStart = 20 + jsonLength
  const bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart))
  const accessor = (index) => {
    const a = json.accessors[index]
    if (a.componentType !== 5126) throw new Error('float 以外のアクセサーには対応していません')
    const view = json.bufferViews[a.bufferView]
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]
    const offset = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
    return new Float32Array(bin.buffer.slice(offset, offset + a.count * size * 4))
  }
  return { json, accessor }
}

/** glTF のノードを three.js の Object3D にする（名前は n0, n1, …。素材の骨の名前には . が入っていて、そのままだと再生の対象に使えない） */
function buildGlbScene(json) {
  const nodes = json.nodes.map((n, i) => {
    const o = new Object3D()
    o.name = `n${i}`
    if (n.translation) o.position.fromArray(n.translation)
    if (n.rotation) o.quaternion.fromArray(n.rotation)
    if (n.scale) o.scale.fromArray(n.scale)
    return o
  })
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => nodes[i].add(nodes[c])))
  const scene = new Object3D()
  for (const i of json.scenes[json.scene ?? 0].nodes) scene.add(nodes[i])
  return { scene, byName: new Map(json.nodes.map((n, i) => [n.name, nodes[i]])) }
}

function buildGlbClip(json, accessor, name) {
  // 1 本だけの glb（FBX を 1 本ずつ glb にした物）は、名前が違っても（Blender の動作の名前など）その 1 本を使う
  const def = json.animations.find((a) => a.name === name) ?? (json.animations.length === 1 ? json.animations[0] : null)
  if (!def) throw new Error(`素材にアニメーション ${name} がありません（${json.animations.map((a) => a.name).join(', ')}）`)
  const tracks = def.channels.map((c) => {
    const s = def.samplers[c.sampler]
    const [Track, prop] = { translation: [VectorKeyframeTrack, 'position'], rotation: [QuaternionKeyframeTrack, 'quaternion'], scale: [VectorKeyframeTrack, 'scale'] }[c.target.path]
    return new Track(`n${c.target.node}.${prop}`, accessor(s.input), accessor(s.output))
  })
  return new AnimationClip(name, -1, tracks)
}

const parsedGlbs = new Map()

/**
 * 素材のアニメーションを 1 本読む。scene = 骨組み（基本姿勢のまま）、byName = 骨の名前 → ノード。
 * glb の file が関数なら、アニメーションごとの glb（file(アニメーションの名前) = 素材の置き場の <素材>/ からのパス）
 */
async function loadClip(id, name) {
  const src = sources[id]
  if (src.format === 'glb') {
    const file = typeof src.file === 'function' ? src.file(name) : src.file
    const key = `${id}:${file}`
    if (!parsedGlbs.has(key)) parsedGlbs.set(key, parseGlb(readFileSync(await sourceFile(id, file, name))))
    const { json, accessor } = parsedGlbs.get(key)
    const { scene, byName } = buildGlbScene(json)
    return { scene, byName, clip: buildGlbClip(json, accessor, name) }
  }
  // 名前に / があれば、素材の BVH の根（root）からのパス（StayStill の待機 idle/idle_08 など）。無ければ dir の中のファイル
  const path = name.includes('/') ? `${src.root ?? ''}${name}.bvh` : `${src.dir}${name}.bvh`
  const { skeleton, clip } = new BVHLoader().parse(readFileSync(await sourceFile(id, path, name), 'utf8'))
  const scene = new Object3D()
  scene.scale.setScalar(src.unit ?? 1)
  scene.add(skeleton.bones[0])
  return { scene, byName: new Map(skeleton.bones.map((b) => [b.name, b])), clip }
}

// --- 3. VRM の骨（素材によらない決まり） ---

/**
 * VRM の骨の親（VRM 1.0 の humanoid の親子。書き出す .vrma の骨組みにも使う）。親が先に来る順に並べてある。
 * 素材に無い骨を飛ばすときは、そのさらに親につなぐ
 */
const VRM_PARENT = { hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck' }
/** 左右のある骨の親（'!' 付きは左右の無い骨）。左右それぞれに広げて VRM_PARENT に足す */
const LIMB_PARENT = {
  UpperLeg: '!hips',
  LowerLeg: 'UpperLeg',
  Foot: 'LowerLeg',
  Toes: 'Foot',
  Shoulder: '!upperChest',
  UpperArm: 'Shoulder',
  LowerArm: 'UpperArm',
  Hand: 'LowerArm',
  ThumbMetacarpal: 'Hand',
  ThumbProximal: 'ThumbMetacarpal',
  ThumbDistal: 'ThumbProximal',
  ...Object.fromEntries(
    ['Index', 'Middle', 'Ring', 'Little'].flatMap((f) => [
      [`${f}Proximal`, 'Hand'],
      [`${f}Intermediate`, `${f}Proximal`],
      [`${f}Distal`, `${f}Intermediate`],
    ]),
  ),
}
for (const side of ['left', 'right']) {
  for (const [bone, parent] of Object.entries(LIMB_PARENT)) VRM_PARENT[`${side}${bone}`] = parent.startsWith('!') ? parent.slice(1) : `${side}${parent}`
}

/** 必ず要る骨（VRM 1.0 の必須の骨） */
const REQUIRED = ['hips', 'spine', 'head', ...['left', 'right'].flatMap((s) => ['UpperLeg', 'LowerLeg', 'Foot', 'UpperArm', 'LowerArm', 'Hand'].map((b) => `${s}${b}`))]

/**
 * T ポーズで骨が向く方向（+X が本人の左、+Y が上、+Z が前）と、向きを測る相手の骨（骨の付け根 → 相手の付け根）。
 * 相手が無い骨（指先）は、親から自分への向きで測る。ここに無い骨（背骨・頭・足首など）は、基準の姿勢の向きのまま
 */
const TPOSE = {}
for (const [side, sign] of [
  ['left', 1],
  ['right', -1],
]) {
  const out = new Vector3(sign, 0, 0)
  const down = new Vector3(0, -1, 0)
  const thumb = new Vector3(sign, 0, 1).normalize()
  const set = (bone, dir, tip) => (TPOSE[`${side}${bone}`] = { dir, tip: tip && `${side}${tip}` })
  set('UpperLeg', down, 'LowerLeg')
  set('LowerLeg', down, 'Foot')
  set('UpperArm', out, 'LowerArm')
  set('LowerArm', out, 'Hand')
  set('Hand', out, 'MiddleProximal')
  set('ThumbMetacarpal', thumb, 'ThumbProximal')
  set('ThumbProximal', thumb, 'ThumbDistal')
  set('ThumbDistal', thumb)
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    set(`${f}Proximal`, out, `${f}Intermediate`)
    set(`${f}Intermediate`, out, `${f}Distal`)
    set(`${f}Distal`, out)
  }
}

/** 素材にある VRM の骨（親が先の順）と、素材に無い骨を飛ばした親 */
function resolveBones(id, byName) {
  const table = sources[id].bones
  const missing = REQUIRED.filter((b) => !byName.get(table[b]))
  if (missing.length) throw new Error(`素材に必須の骨がありません: ${missing.map((b) => `${b}（${table[b] ?? '表に無し'}）`).join('、')}`)
  const bones = Object.keys(VRM_PARENT).filter((b) => table[b] && byName.get(table[b]))
  const have = new Set(bones)
  const parent = {}
  for (const b of bones) {
    let p = VRM_PARENT[b]
    while (p && !have.has(p)) p = VRM_PARENT[p]
    parent[b] = p
  }
  return { bones, parent }
}

// --- 4. 骨のワールドの向きと位置を、フレームごとに取る ---

/** 今の姿勢の、骨ごとのワールドの回転（q）と位置（p） */
function snapshot(scene, byName, id, bones) {
  scene.updateMatrixWorld(true)
  const table = sources[id].bones
  const frame = { q: {}, p: {} }
  for (const b of bones) {
    const node = byName.get(table[b])
    frame.q[b] = node.getWorldQuaternion(new Quaternion())
    frame.p[b] = node.getWorldPosition(new Vector3())
  }
  return frame
}

/**
 * 素材のアニメーションを 1 本読んで、フレームごとのワールドの姿勢にする（基本姿勢も rest に、1 フレーム目も first に入れて返す）。
 * range = 切り出す所（from・to 秒か、fromFrame・toFrame = 素材のフレームの番号。0 から）。1 フレーム目を T ポーズの基準にする素材（reference: 'firstFrame'）は、
 * 1 フレーム目を動きに入れない。素材のコマ数が fps より細かければ間引く
 */
async function sampleClip(id, name, range = {}) {
  const src = sources[id]
  const { scene, byName, clip } = await loadClip(id, name)
  const rig = resolveBones(id, byName)
  const rest = snapshot(scene, byName, id, rig.bones)
  // 1 回だけ再生する設定で、時刻を直接入れて取る（繰り返しの設定だと、最後の時刻が最初に戻ってしまう）
  const mixer = new AnimationMixer(scene)
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1)
  action.clampWhenFinished = true
  action.play()
  const at = (t) => {
    action.time = t
    mixer.update(0)
    return snapshot(scene, byName, id, rig.bones)
  }
  const allTimes = [...new Set(clip.tracks.flatMap((t) => [...t.times]))].sort((a, b) => a - b)
  const frameTime = allTimes.length > 1 ? allTimes[1] - allTimes[0] : 1 / 30
  let from = range.fromFrame !== undefined ? range.fromFrame * frameTime : (range.from ?? 0)
  const to = range.toFrame !== undefined ? range.toFrame * frameTime : (range.to ?? Infinity)
  const first = at(allTimes[0] ?? 0)
  if (src.reference === 'firstFrame') from = Math.max(from, (allTimes[1] ?? 0) - 1e-6)
  let keyTimes = allTimes.filter((t) => t >= from - 1e-6 && t <= to + 1e-6)
  if (src.fps && 1 / src.fps > frameTime * 1.5) {
    const step = 1 / src.fps
    let next = -Infinity
    keyTimes = keyTimes.filter((t) => (t >= next - frameTime / 2 ? ((next = t + step), true) : false))
  }
  if (keyTimes.length < 2) throw new Error(`${name}: 切り出す所（${JSON.stringify(range)}）にフレームがありません（素材は ${allTimes.length} フレーム・${(allTimes.at(-1) ?? 0).toFixed(2)} 秒）`)
  const frames = keyTimes.map(at)
  return { rig, rest, first, frames, times: keyTimes.map((t) => t - keyTimes[0]) }
}

/** 骨ごとの平均の姿勢（回転は符号をそろえて平均し、長さを 1 に戻す） */
function meanFrame(frames, bones) {
  const out = { q: {}, p: {} }
  for (const b of bones) {
    const first = frames[0].q[b]
    const s = [0, 0, 0, 0]
    const p = new Vector3()
    for (const f of frames) {
      const q = f.q[b]
      const sign = q.dot(first) < 0 ? -1 : 1
      s[0] += q.x * sign
      s[1] += q.y * sign
      s[2] += q.z * sign
      s[3] += q.w * sign
      p.add(f.p[b])
    }
    out.q[b] = new Quaternion(...s).normalize()
    out.p[b] = p.divideScalar(frames.length)
  }
  return out
}

/** 向きを VRM にそろえる Y 軸まわりの角度（左右の股関節を結ぶ向きを +X に。平均の姿勢か基本姿勢で測る） */
function facingYaw(frame) {
  const v = frame.p.leftUpperLeg.clone().sub(frame.p.rightUpperLeg)
  return Math.atan2(v.z, v.x)
}

/** 姿勢を Y 軸まわりに回し、床の高さを引く（その場で書きかえる） */
function turnAndLower(frames, yaw, floor) {
  if (Math.abs(yaw) < 1e-9 && floor === 0) return
  const r = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw)
  for (const f of frames) {
    for (const b of Object.keys(f.q)) {
      f.q[b].premultiply(r)
      f.p[b].applyQuaternion(r).y -= floor
    }
  }
}

/** 最初と最後の 0.5 秒（身ぶりの前後の、ふつうに立っているところ）。start なら最初だけ */
function endFrames(frames, start = false) {
  const k = Math.max(1, Math.min(15, Math.floor(frames.length / 4)))
  return start ? frames.slice(0, k) : [...frames.slice(0, k), ...frames.slice(-k)]
}

/**
 * BVH のアニメーションの向きと床をそろえる（その場で書きかえる）。撮ったときの向きが本ごとに違うので、
 * 平均の向き（facing = 'mean'）か、前後の立っているところの向き（'ends'。振り返りなどで平均がずれる身ぶり用）か、始めの向き（'start'。その場で回るなど）が
 * +Z（前）になるよう回し、床を足先（無ければ足首）のいちばん低いところにする。extra（T ポーズの基準の 1 フレーム目など）は、それ自身の向きで前にそろえ、同じだけ下げる
 */
function prepareFrames(src, frames, facing, extra = []) {
  const bones = Object.keys(frames[0].q)
  const picked = facing === 'ends' ? endFrames(frames) : facing === 'start' ? endFrames(frames, true) : frames
  turnAndLower(frames, facingYaw(meanFrame(picked, bones)), 0)
  // T ポーズの基準（1 フレーム目）は、それ自身の向きで前にそろえる（撮った人が T ポーズの後に向きを変えていても、基準の腰が前を向くように）
  for (const e of extra) turnAndLower([e], facingYaw(e), 0)
  if (src.floorFromFeet) {
    const tips = bones.includes('leftToes') && bones.includes('rightToes') ? ['leftToes', 'rightToes'] : ['leftFoot', 'rightFoot']
    turnAndLower([...frames, ...extra], 0, Math.min(...frames.flatMap((f) => tips.map((b) => f.p[b].y))))
  }
}

/**
 * 左右を入れ替える（鏡に映す。体の左右の真ん中の面 x = 0 で折り返す）。向きをそろえた後の姿勢に使う。新しい姿勢を返す
 * （右手で振る手を、花音の振る左手にするなど。回転 (x, y, z, w) は (x, -y, -z, w) になる）
 */
function mirrorFrame(f) {
  const swap = (b) => (b.startsWith('left') ? `right${b.slice(4)}` : b.startsWith('right') ? `left${b.slice(5)}` : b)
  const out = { q: {}, p: {} }
  for (const b of Object.keys(f.q)) {
    const q = f.q[b]
    out.q[swap(b)] = new Quaternion(q.x, -q.y, -q.z, q.w)
    out.p[swap(b)] = f.p[b].clone().setX(-f.p[b].x)
  }
  return out
}

/** T ポーズの基準（reference.meanOf のアニメーションの平均の姿勢）。素材ごとに 1 回だけ作る */
const references = new Map()
async function standingReference(id) {
  if (!references.has(id)) {
    const src = sources[id]
    const frames = []
    for (const name of src.reference.meanOf) {
      const s = await sampleClip(id, name)
      prepareFrames(src, s.frames, 'mean')
      frames.push(...s.frames)
    }
    references.set(id, meanFrame(frames, Object.keys(frames[0].q)))
  }
  return references.get(id)
}

/** 首の回転の一部を頭へ回す（首 × 頭 の向きは変えない） */
function splitNeck(rotations, ratio) {
  if (!ratio || !rotations.neck || !rotations.head) return
  const id = new Quaternion()
  rotations.neck.forEach((q, i) => {
    const part = id.clone().slerp(q, ratio)
    rotations.head[i].premultiply(part)
    q.copy(id.clone().slerp(q, 1 - ratio))
  })
  keepHemisphere(rotations.neck)
  keepHemisphere(rotations.head)
}

/**
 * 素材の基本姿勢から、骨ごとの「T ポーズでの向き（ワールドの回転）」と位置を作る。
 * corrections は、T ポーズにそろえるために回した角度（度。表示用）
 */
function tPoseOf(rest, rig) {
  const { bones, parent } = rig
  const align = {}
  const world = {}
  const pos = {}
  const corrections = {}
  for (const b of bones) {
    const t = TPOSE[b]
    const p = parent[b]
    align[b] = new Quaternion()
    if (t) {
      // 親を直した分をまず受け継いでから（腕全体が A ポーズなら、手や指も一緒に回る）、残りの向きのずれだけ回す。
      // 骨ごとに別々に回すと、向きの決まっている親指などで、ねじれの向きが素材の基本姿勢によって変わってしまう
      const inherited = p && TPOSE[p] ? align[p] : new Quaternion()
      const from = t.tip && rest.p[t.tip] ? rest.p[t.tip].clone().sub(rest.p[b]) : p ? rest.p[b].clone().sub(rest.p[p]) : null
      if (from && from.lengthSq() > 1e-12) {
        from.normalize().applyQuaternion(inherited)
        align[b].setFromUnitVectors(from, t.dir).multiply(inherited)
        corrections[b] = (2 * Math.acos(Math.min(1, Math.abs(align[b].w))) * 180) / Math.PI
      } else align[b].copy(inherited)
    }
    world[b] = align[b].clone().multiply(rest.q[b])
    // 位置: 親の骨をそろえた分だけ、親からの向きを回す
    pos[b] = p ? rest.p[b].clone().sub(rest.p[p]).applyQuaternion(align[p]).add(pos[p]) : rest.p[b].clone()
  }
  return { world, pos, corrections }
}

/** フレームごとの姿勢を、VRM の正規化した骨の回転（T ポーズからの回り → 親の回りを除いたもの）と腰・足の位置にする */
function toNormalized(frames, tpose, rig) {
  const { bones, parent } = rig
  const inv = Object.fromEntries(bones.map((b) => [b, tpose.world[b].clone().invert()]))
  const rotations = Object.fromEntries(bones.map((b) => [b, []]))
  const delta = {}
  for (const f of frames) {
    for (const b of bones) delta[b] = f.q[b].clone().multiply(inv[b])
    for (const b of bones) {
      const q = delta[b].clone()
      if (parent[b]) q.premultiply(delta[parent[b]].clone().invert())
      rotations[b].push(q)
    }
  }
  for (const b of bones) keepHemisphere(rotations[b])
  const hips = frames.map((f) => f.p.hips.clone())
  const feet = frames.map((f) => ({ L: f.p.leftFoot.clone(), R: f.p.rightFoot.clone() }))
  return { rotations, hips, feet }
}

/** 補間で遠回りしないよう、前のフレームと同じ側の符号にそろえる */
function keepHemisphere(list) {
  for (let i = 1; i < list.length; i++) if (list[i].dot(list[i - 1]) < 0) list[i].set(-list[i].x, -list[i].y, -list[i].z, -list[i].w)
}

// --- 5. 1 本のアニメーション（歩きなど）と、つないだループ（待機） ---

/** 1 本をそのまま .vrma にする（歩きは「その場で歩く」ループにして、足が滑らない速さを出す） */
async function buildClipOutput(o) {
  const src = sources[o.source]
  const s = await sampleClip(o.source, o.clip, o)
  if (src.reference === 'rest') turnAndLower([s.rest, ...s.frames], facingYaw(s.rest), 0)
  else if (src.reference === 'firstFrame') prepareFrames(src, s.frames, o.facing ?? 'mean', [s.first])
  else throw new Error(`${o.clip}: 1 本をそのまま使う出力は、基本姿勢か 1 フレーム目が T ポーズの素材だけ（StayStill の BVH は gesture か loop で）`)
  const tpose = tPoseOf(src.reference === 'rest' ? s.rest : s.first, s.rig)
  const { rotations, hips, feet } = toNormalized(s.frames, tpose, s.rig)
  smoothTrack(rotations, hips, s.times, o.smooth ?? 0)
  const { times } = s
  const duration = times[times.length - 1]

  // 腰の位置: 前に進む分（最初と最後の差）を消して「その場」にし、両足の真ん中の平均が原点に来るようにずらす
  const drift = hips[hips.length - 1].clone().sub(hips[0]).setY(0)
  const offsetAt = (i) => drift.clone().multiplyScalar(duration > 0 ? times[i] / duration : 0)
  const center = new Vector3()
  feet.forEach((f, i) => center.add(f.L.clone().add(f.R).multiplyScalar(0.5).sub(offsetAt(i))))
  center.divideScalar(feet.length).setY(0)
  const hipsOut = hips.map((p, i) => p.clone().sub(offsetAt(i)).sub(center))

  // 歩き: 床に着いている足が後ろへ動く速さ = 1 倍の速さで進む速さ
  let walkSpeed = null
  if (o.walk) {
    const speeds = []
    for (const side of ['L', 'R']) {
      const ys = feet.map((f) => f[side].y)
      const floor = Math.min(...ys)
      for (let i = 1; i < feet.length; i++) {
        if (ys[i] > floor + 0.015 || ys[i - 1] > floor + 0.015) continue
        const a = feet[i - 1][side].clone().sub(offsetAt(i - 1))
        const b = feet[i][side].clone().sub(offsetAt(i))
        speeds.push(-(b.z - a.z) / (times[i] - times[i - 1]))
      }
    }
    speeds.sort((a, b) => a - b)
    walkSpeed = speeds[Math.floor(speeds.length / 2)]
  }
  return { name: o.clip, rig: s.rig, tpose, anim: { times, rotations, hips: hipsOut, walkSpeed } }
}

/** ガウスのぼかしで震えをならす（回転は符号をそろえて重み付きで足し、長さを 1 に戻す） */
function smoothTrack(rotations, hips, times, sigma) {
  if (!sigma || times.length < 3) return
  const dt = times[1] - times[0]
  const radius = Math.max(1, Math.round((sigma * 3) / dt))
  const weights = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-0.5 * (((k - radius) * dt) / sigma) ** 2))
  const n = times.length
  const at = (i) => Math.min(n - 1, Math.max(0, i))
  for (const list of Object.values(rotations)) {
    const src = list.map((q) => q.clone())
    for (let i = 0; i < n; i++) {
      const s = [0, 0, 0, 0]
      weights.forEach((w, k) => {
        const q = src[at(i + k - radius)]
        const sign = q.dot(src[i]) < 0 ? -w : w
        s[0] += q.x * sign
        s[1] += q.y * sign
        s[2] += q.z * sign
        s[3] += q.w * sign
      })
      list[i].set(...s).normalize()
    }
  }
  const srcHips = hips.map((p) => p.clone())
  const total = weights.reduce((a, w) => a + w, 0)
  for (let i = 0; i < n; i++) {
    hips[i].set(0, 0, 0)
    weights.forEach((w, k) => hips[i].addScaledVector(srcHips[at(i + k - radius)], w / total))
  }
}

/**
 * 何本かのアニメーションをつないで、切れ目なく繰り返すループにする。
 * それぞれの終わりと次の始まり（最後は最初の始まり）を blend 秒ずつ重ねて混ぜる
 */
async function buildLoopOutput(o, standingFeet = null) {
  const src = sources[o.source]
  const { segments, blend, smooth } = o.loop
  const parts = []
  for (const seg of segments) {
    const s = await sampleClip(o.source, seg.clip, seg)
    // 向きと床: アニメーションごとに、平均の向きが +Z（前）になるよう回す（撮ったときの向きが本ごとに違うため）
    if (src.reference !== 'rest') prepareFrames(src, s.frames, 'mean', [s.first])
    parts.push(s)
  }
  const rig = parts[0].rig
  // T ポーズの基準（素材で 1 つ。つなぎ目で基準が変わらないように。1 フレーム目を基準にする素材は 1 本目の物）
  const tpose = tPoseOf(src.reference === 'rest' ? parts[0].rest : src.reference === 'firstFrame' ? parts[0].first : await standingReference(o.source), rig)

  const tracks = parts.map((s) => {
    const t = toNormalized(s.frames, tpose, rig)
    smoothTrack(t.rotations, t.hips, s.times, smooth)
    splitNeck(t.rotations, src.neckToHead)
    // 立つ場所: アニメーションごとに、両足の真ん中の平均を原点にそろえる（本ごとに撮った場所が少し違うため）
    const center = new Vector3()
    t.feet.forEach((f) => center.add(f.L).add(f.R))
    center.divideScalar(t.feet.length * 2).setY(0)
    t.hips.forEach((p) => p.sub(center))
    return { ...t, dt: s.times[1] - s.times[0], length: s.times.length }
  })
  const dt = tracks[0].dt
  const m = Math.max(1, Math.round(blend / dt))
  for (const [i, t] of tracks.entries()) {
    if (t.length < m * 2 + 1) throw new Error(`${segments[i].clip} が短すぎて、つなぎ目を ${blend} 秒重ねられません`)
  }

  // つなぐ: [1 本目の真ん中][1 本目の終わり × 2 本目の始まり][2 本目の真ん中]…[最後の終わり × 1 本目の始まり]
  const rotations = Object.fromEntries(rig.bones.map((b) => [b, []]))
  const hips = []
  const push = (t, i) => {
    for (const b of rig.bones) rotations[b].push(t.rotations[b][i].clone())
    hips.push(t.hips[i].clone())
  }
  tracks.forEach((t, k) => {
    const next = tracks[(k + 1) % tracks.length]
    for (let i = m; i < t.length - m; i++) push(t, i)
    for (let j = 0; j < m; j++) {
      const w = (j + 0.5) / m
      const s = w * w * (3 - 2 * w)
      const a = t.length - m + j
      for (const b of rig.bones) rotations[b].push(t.rotations[b][a].clone().slerp(next.rotations[b][j], s))
      hips.push(t.hips[a].clone().lerp(next.hips[j], s))
    }
  })
  // 腰の水平の位置: ループの中の平均を原点に。そのときの両足の真ん中（本ごとに原点にそろえてあった）を、身ぶりの立つ場所に使う（standingFeet）。
  // align: 'standing' なら、両足の真ん中を渡された身ぶりの立つ場所にそろえる（待機を切り替えても足が同じ所に来るように）
  const mean = hips.reduce((a, p) => a.add(p), new Vector3()).divideScalar(hips.length).setY(0)
  if (o.loop.align === 'standing' && !standingFeet) throw new Error(`${o.dest}: align: 'standing' の待機には、身ぶりの立つ場所（standing の待機）が要ります`)
  const shift = o.loop.align === 'standing' ? standingFeet.clone() : mean.clone().negate()
  hips.forEach((p) => p.add(shift))
  // 最後に最初のフレームをもう一度置き、繰り返すときに最後 → 最初がなめらかにつながるようにする
  for (const b of rig.bones) {
    rotations[b].push(rotations[b][0].clone())
    keepHemisphere(rotations[b])
  }
  hips.push(hips[0].clone())
  const times = hips.map((_, i) => i * dt)
  return { name: segments.map((s) => s.clip).join(' + '), rig, tpose, anim: { times, rotations, hips, walkSpeed: null }, standingFeet: shift }
}

/**
 * 歩いて進む分を消して、その場にする（身ぶりの inPlace）: 腰の水平の位置をゆっくりならした道筋（ガウスのぼかし 0.6 秒）を引く。
 * 細かい揺れ（体重移動・跳ねる）は残る。足も同じだけずらす（足は床の上を少し滑るので、腰から下を立った姿勢にする lowerBody と合わせて使うとよい）
 */
function keepInPlace(hips, feet, times, sigma = 0.6) {
  const n = hips.length
  if (n < 3) return
  const dt = times[1] - times[0]
  const radius = Math.max(1, Math.round((sigma * 3) / dt))
  const path = hips.map((_, i) => {
    const v = new Vector3()
    let total = 0
    for (let k = -radius; k <= radius; k++) {
      const w = Math.exp(-0.5 * ((k * dt) / sigma) ** 2)
      v.addScaledVector(hips[Math.min(n - 1, Math.max(0, i + k))], w)
      total += w
    }
    return v.divideScalar(total).setY(0)
  })
  const start = path[0].clone()
  hips.forEach((p, i) => {
    const d = path[i].clone().sub(start)
    p.sub(d)
    feet[i].L.sub(d)
    feet[i].R.sub(d)
  })
}

/** 腰から下の骨（身ぶりの lowerBody: 'neutral' で、まっすぐ立った姿勢にする骨） */
const LOWER_BONES = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes']

/**
 * 待機から入って待機へ抜ける身ぶり（OUTPUT の gesture）。from・to 秒で切り出す。
 * standingFeet = 待機で両足の真ん中が来る場所（待機のループは腰の平均を原点にするので、足は少しずれる。convertAnimations の standing を作るときに決まる）。
 * 始めと終わり（ふつうに立っているところ）の両足の真ん中をそこに置き（待機から入って待機へ抜けるときに、足が床を滑らないように）、向きもそこで +Z にそろえる。
 * lowerBody: 'neutral' なら腰から下を、まっすぐ立った姿勢（T ポーズの基準の脚）にする（立ち方の違う素材でも、待機から入るときに足が滑らないように）
 */
async function buildGestureOutput(o, standingFeet) {
  const src = sources[o.source]
  const g = o.gesture
  const s = await sampleClip(o.source, g.clip, g)
  let reference = s.rest
  if (src.reference === 'rest') turnAndLower([s.rest, ...s.frames], facingYaw(s.rest), 0)
  else {
    prepareFrames(src, s.frames, g.facing ?? 'ends', [s.first])
    reference = src.reference === 'firstFrame' ? s.first : await standingReference(o.source)
  }
  // 左右を入れ替える（素材が右手で振る手を、左手にするなど）
  if (g.mirror) {
    s.frames = s.frames.map(mirrorFrame)
    reference = mirrorFrame(reference)
  }
  const tpose = tPoseOf(reference, s.rig)
  const { rotations, hips, feet } = toNormalized(s.frames, tpose, s.rig)
  smoothTrack(rotations, hips, s.times, g.smooth ?? 0)
  splitNeck(rotations, src.neckToHead)
  if (g.inPlace) keepInPlace(hips, feet, s.times)
  const k = Math.max(1, Math.min(15, Math.floor(feet.length / 4)))
  const ends = [...feet.slice(0, k), ...feet.slice(-k)]
  const center = ends.reduce((a, f) => a.add(f.L).add(f.R), new Vector3()).divideScalar(ends.length * 2).setY(0)
  hips.forEach((p) => p.sub(center).add(standingFeet))
  if (g.lowerBody === 'neutral') {
    // まっすぐ立った脚は腰の真下に足が来るので、腰を待機の両足の真ん中の上に置く
    for (const b of LOWER_BONES) rotations[b]?.forEach((q) => q.identity())
    hips.forEach((p) => p.set(standingFeet.x, tpose.pos.hips.y, standingFeet.z))
  }
  return { name: g.clip, rig: s.rig, tpose, anim: { times: s.times, rotations, hips, walkSpeed: null } }
}

// --- 6. .vrma（glTF + VRMC_vrm_animation）に書き出す ---

const round = (x) => Math.round(x * 10000) / 10000
/** T ポーズでの左脚の長さ（太もも + すね） */
const legLength = (tpose) => tpose.pos.leftLowerLeg.distanceTo(tpose.pos.leftUpperLeg) + tpose.pos.leftFoot.distanceTo(tpose.pos.leftLowerLeg)

function writeVrma(path, { name, rig, tpose, anim }, copyright, generator) {
  const { bones, parent } = rig
  const chunks = []
  let byteLength = 0
  const accessors = []
  const bufferViews = []
  const addAccessor = (values, type, withMinMax = false) => {
    const data = Buffer.from(new Float32Array(values).buffer)
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length })
    chunks.push(data)
    byteLength += data.length
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]
    const a = { bufferView: bufferViews.length - 1, componentType: 5126, count: values.length / size, type }
    if (withMinMax) {
      a.min = [Math.min(...values)]
      a.max = [Math.max(...values)]
    }
    accessors.push(a)
    return accessors.length - 1
  }

  // 骨組み: VRM の骨の親子で並べ、回転なし（T ポーズ）で置く
  const index = Object.fromEntries(bones.map((b, i) => [b, i]))
  const nodes = bones.map((b) => {
    const p = parent[b] ? tpose.pos[b].clone().sub(tpose.pos[parent[b]]) : tpose.pos[b].clone().setX(0).setZ(0)
    const children = bones.filter((c) => parent[c] === b).map((c) => index[c])
    return { name: b, translation: p.toArray(), ...(children.length ? { children } : {}) }
  })

  const input = addAccessor(anim.times, 'SCALAR', true)
  const samplers = []
  const channels = []
  const hipsTrack = addAccessor(anim.hips.flatMap((p) => p.toArray()), 'VEC3')
  samplers.push({ input, output: hipsTrack, interpolation: 'LINEAR' })
  channels.push({ sampler: 0, target: { node: index.hips, path: 'translation' } })
  for (const b of bones) {
    const out = addAccessor(anim.rotations[b].flatMap((q) => q.toArray()), 'VEC4')
    samplers.push({ input, output: out, interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: index[b], path: 'rotation' } })
  }

  const json = {
    // generator は呼んだ道具が名乗る字（convertAnimations の generator）
    asset: { version: '2.0', generator, ...(copyright ? { copyright } : {}) },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones: Object.fromEntries(bones.map((b) => [b, { node: index[b] }])) },
      },
    },
    scene: 0,
    scenes: [{ nodes: [index.hips] }],
    nodes,
    animations: [
      {
        name,
        channels,
        samplers,
        // 1 倍の速さで再生したときに足が滑らない進む速さ（m/s）と、脚の長さ（太もも + すね、m）。sakurami-cho/character/avatar/vrmAnimation.ts が使う
        ...(anim.walkSpeed ? { extras: { walkSpeed: round(anim.walkSpeed), legLength: round(legLength(tpose)) } } : {}),
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  }

  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b)
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20)
  const binChunk = pad(Buffer.concat(chunks), 0)
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunkHeader = (length, type) => {
    const h = Buffer.alloc(8)
    h.writeUInt32LE(length, 0)
    h.write(type, 4, 'ascii')
    return h
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([header, chunkHeader(jsonChunk.length, 'JSON'), jsonChunk, chunkHeader(binChunk.length, 'BIN\0'), binChunk]))
}

// --- 7. 作って書き出す（使う側の道具が呼ぶ口） ---

/** T ポーズへの直し（左右の大きいほう。A ポーズの素材なら上腕が 30〜45 度くらいになる）と、ループのつなぎ目のずれを表示する */
function report(out, o) {
  const { tpose, anim, rig } = out
  const n = anim.times.length
  const step = (i, j) => Math.max(...rig.bones.map((b) => anim.rotations[b][i].angleTo(anim.rotations[b][j]))) * (180 / Math.PI)
  // 1 回だけの身ぶり: 始めと終わりが、どれだけ立った姿勢に戻っているか（待機から入って待機へ抜けるので、小さいほどよい）
  if (o.once) {
    console.log('        1 回だけ再生する物（ループにしないので、つなぎ目は見ない）')
    return
  }
  if (o.gesture && !o.gesture.loop) {
    console.log(`        始めと終わりの姿勢の差: 回転 ${step(n - 1, 0).toFixed(1)}°・腰 ${(anim.hips[n - 1].distanceTo(anim.hips[0]) * 100).toFixed(1)} cm`)
    return
  }
  const deg = (...bs) => Math.max(0, ...bs.flatMap((b) => [tpose.corrections[`left${b}`] ?? 0, tpose.corrections[`right${b}`] ?? 0])).toFixed(1)
  console.log(`        T ポーズへの直し: 上腕 ${deg('UpperArm')}°、前腕 ${deg('LowerArm')}°、手 ${deg('Hand')}°、太もも ${deg('UpperLeg')}°、すね ${deg('LowerLeg')}°、親指 ${deg('ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal')}°`)
  const skipped = Object.keys(VRM_PARENT).filter((b) => !rig.bones.includes(b))
  if (skipped.length) console.log(`        素材に無いので入れない骨: ${skipped.length > 8 ? `${skipped.slice(0, 8).join(', ')} など ${skipped.length} 本` : skipped.join(', ')}`)
  // つなぎ目: 最後のフレーム → 最初のフレームで、いちばん大きく回る骨の角度と腰の動き。ふだんの 1 フレームの動きの最大と比べる
  let usual = 0
  for (let i = 1; i < n; i++) usual = Math.max(usual, step(i - 1, i))
  const seam = `つなぎ目のずれ: 回転 ${step(n - 1, 0).toFixed(2)}°・腰 ${(anim.hips[n - 1].distanceTo(anim.hips[0]) * 100).toFixed(2)} cm（ふだんの 1 フレームの回転は最大 ${usual.toFixed(2)}°）`
  if (step(n - 1, 0) > 2 || anim.hips[n - 1].distanceTo(anim.hips[0]) > 0.01) console.warn(`        注意: ループの最初と最後が合っていません（${seam}）。つなぎ目で動きが跳ねます`)
  else console.log(`        ${seam}`)
}

/**
 * 素材から .vrma を作って書き出す。
 * - cacheDir: 素材の置き場（取り出した素材のファイルと zip を置く。git に入れない）
 * - assetRoot: 書き出し先のアセットの根（OUTPUT の dest はここからの相対）
 * - outputs: 作る物の表（上の OUTPUT の形。表の順に作る）
 * - generator: .vrma の glTF の asset.generator に書く字（作った道具の名前）
 * - standing: 身ぶり（gesture）の立つ場所を決める待機（loop の OUTPUT。既定は IDLE_OUTPUT）。outputs に入っていればそれを作ったときに、
 *   入っていない（か身ぶりより後ろにある）ときは、初めの身ぶりの前に書き出さずに作って決める
 * - userAgent: 素材を取るときの User-Agent（既定 sakurami-cho-sync-anim）。tag: ログの頭（既定 sync:anim）
 * - sources: 足す素材（素材の id → SOURCES と同じ形の設定）。使う側だけが持つ素材（人が手で置く Mixamo の FBX を glb にした物など。公開のこのパッケージに書けない物）を足す。
 *   SOURCES と同じ id は上書きする
 * 失敗したら例外（取り出した zip は閉じる）。返す物: 書き出したファイルの絶対パスの並び
 */
export async function convertAnimations({ cacheDir, assetRoot, outputs, generator, standing = IDLE_OUTPUT, userAgent = 'sakurami-cho-sync-anim', tag = 'sync:anim', sources: extra = {} }) {
  if (!cacheDir || !assetRoot || !generator) throw new Error('convertAnimations: cacheDir・assetRoot・generator を渡してください')
  Object.assign(run, { cacheDir, userAgent, tag })
  sources = { ...SOURCES, ...extra }
  openedZips.clear()
  parsedGlbs.clear()
  references.clear()
  const written = []
  try {
    // 身ぶりと、足を身ぶりの立つ場所にそろえる待機は、立つ場所（standing の待機）が要る
    const needsStanding = (o) => o !== standing && (o.gesture || o.loop?.align === 'standing')
    const ids = new Set(outputs.map((o) => o.source))
    if (outputs.some(needsStanding)) ids.add(standing.source)
    for (const id of ids) {
      if (!sources[id]) throw new Error(`素材 ${id} がありません（素材の id: ${Object.keys(sources).join(', ')}）`)
      console.log(`[${tag}] 素材: ${sources[id].label}`)
      await checkLicense(id)
    }
    let standingFeet = null
    for (const o of outputs) {
      if (needsStanding(o) && !standingFeet) {
        standingFeet = (await buildLoopOutput(standing)).standingFeet
        console.log(`        身ぶりの立つ場所: ${standing.dest} の待機（書き出さずに作った）`)
      }
      const out = o.loop ? await buildLoopOutput(o, standingFeet) : o.gesture ? await buildGestureOutput(o, standingFeet) : await buildClipOutput(o)
      if (o === standing) standingFeet = out.standingFeet
      const dest = resolve(assetRoot, o.dest)
      writeVrma(dest, out, sources[o.source].copyright, generator)
      written.push(dest)
      const { anim, tpose } = out
      const speed = anim.walkSpeed ? `、足が滑らない速さ ${anim.walkSpeed.toFixed(2)} m/s・脚の長さ ${legLength(tpose).toFixed(2)} m（素材の大きさで）` : ''
      console.log(`        ${out.name} -> ${dest}  (${anim.times.length} フレーム、${anim.times[anim.times.length - 1].toFixed(2)} 秒${speed})`)
      report(out, o)
    }
  } finally {
    for (const { zip } of openedZips.values()) zip.close()
    openedZips.clear()
    sources = SOURCES
  }
  return written
}
