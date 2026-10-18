/**
 * キャラクターの見た目（character/avatar/characterVisual.ts）の共通の既定値。どの VRM でも使う値で、キャラクターに固有の値（読み込む VRM・身長・飾りなど）は
 * 使う側が持つ（kanon-lab の花音は config/avatar.ts）。createCharacterVisual の引数で、欄ごとに置き換えられる。
 *
 * 注意: animations の値は `tools/anim/convert.mjs`（Node。tools/sync-anim.mjs と使う側の道具が使う）の ANIMATION_PATHS に写してある
 * （convert.mjs は .ts を読まない。8-4。食い違うと test/map-boundary.test.ts が落ちる）。他のファイルを import しない・`import.meta.env` を使わないこと。
 */

export const VISUAL_DEFAULTS = {
  /**
   * 待機・歩き・跳ぶのアニメーション（VRM Animation = .vrma、assetBase からの相対パス。`pnpm sync:anim` が書き出す）。
   * ファイルがあれば @pixiv/three-vrm-animation で再生し、無ければコードで作った動き（character/avatar/body.ts）を使う。
   * 歩きは 1.1m/s 前後で歩くループにしておく（再生速度を歩く速さに合わせる）。
   * 指は腕と同じ決まり: 歩いている間などはアニメーションの指（無ければコードの手の形）を使い、
   * 立ち寄り先での行動・反応の手の形（character/avatar/hands.ts）は、腕の姿勢と同じ強さで上に重ねる
   */
  animations: {
    idle: 'models/animations/idle.vrma',
    /**
     * 待機に足して切り替える .vrma（idle と一緒に、idleMix の決まりで切り替える。読めない物は飛ばし、1 本も読めなければ idle だけ）。
     * どれも idle と同じ立つ場所（両足の真ん中）に合わせて作ってある（tools/anim/convert.mjs の IDLE_VARIANT_OUTPUTS。align: 'standing'）
     */
    idleVariants: ['models/animations/idle-2.vrma', 'models/animations/idle-3.vrma', 'models/animations/idle-4.vrma'],
    walk: 'models/animations/walk.vrma',
    /**
     * 跳ぶ（character/avatar/jump.ts。使う側が jump を呼んだときだけ）: 踏み切り（start。しゃがんだ所から伸びて上がる）・跳んでいる間（loop）・着く（land）。
     * 待機の .vrma があって、この 3 つが読めたときに使う。無い・読めないときは、コードで作った姿勢（しゃがむ → 伸びる → 着いてしゃがむ）
     */
    jump: {
      start: 'models/animations/jump-start.vrma',
      loop: 'models/animations/jump-loop.vrma',
      land: 'models/animations/jump-land.vrma',
    },
  },

  /**
   * 実測の身長が height から allowedHeightError（割合）以上ずれていたら、height に合わせて体全体を同じ割合で拡大縮小する。
   * モデル側で身長を作り込んでいる場合は false にする。
   * 幅は 0.5%（前は 4%。花音の VRM は実測 1.59m で 4% の内だったので縮めず、設定の 165cm より 6cm 低かった。VRM を差し替えても身長に合う。
   * docs/design/town.md §7 の 218）
   */
  normalizeHeight: true,
  allowedHeightError: 0.005,
  /**
   * 目の高さ ÷ 身長 の目安（成人でおよそ 0.93）。
   * 帽子や髪の盛りを含めないよう、身長は目のボーンの高さから推定する
   */
  eyeHeightRatio: 0.93,

  /**
   * 視線・首の追従（ラジアン）。目は vrm.lookAt、首は自前で回す。maxYaw・maxPitchUp・maxPitchDown は首（neck・head）で回せる範囲
   * （上は前の 0.25 から 0.4 に。見上げる先へ顔が上がって見えるように）
   */
  lookAt: {
    maxYaw: 0.6,
    maxPitchUp: 0.4,
    maxPitchDown: 0.35,
    /** カメラ方向のうち、首で追う割合（残りは目） */
    headFollow: 0.35,
    /** 注意している間（層の look。kanon.look_at など）に首で追う割合（前は 0.75 で、首だけでは横の物まで向かなかった） */
    attendFollow: 0.92,
    /** 注意している間、首の範囲を超える分を胸・腰（spine・chest・upperChest）で回す最大（左右・上へ反る） */
    torsoYaw: 0.5,
    torsoPitchUp: 0.12,
    /** 行動の視線（カメラを見ない間）で頭を下げているとき、目を顔の正面より下（手元）へ向ける量 */
    focusDown: 0.14,
    /** 視線の細かい動き（サッカード）: 左右・上下のずれの最大と、動かす間隔（秒、最小〜最大） */
    saccade: { yaw: 0.035, pitch: 0.02, interval: [0.7, 2.4] as [number, number] },
    /** 追従のなめらかさ（大きいほど速く追う） */
    damping: 3.5,
  },

  /**
   * 寄りの画で待機の体の揺れを弱める（character/avatar/characterVisual.ts の steady）。頭（0.25m）が画の縦に占める割合が headFraction の間で
   * 0 → amount（顔のアップでいちばん強く。胸から上の画で半分ほど）。使う側の層の steady（話している間など）を足しても max まで
   */
  steady: { headFraction: [0.28, 0.55] as [number, number], amount: 0.75, max: 0.85 },

  /** 待機の姿勢とまばたき */
  idle: {
    /** 腕を下ろす角度（T ポーズから、ラジアン） */
    armDown: 1.2,
    /** ひじの曲げ（ラジアン） */
    elbowBend: 0.32,
    /** まばたきの間隔（秒、最小〜最大） */
    blinkInterval: [2.2, 5.5] as [number, number],
  },

  /** まばたきの表情の名前（VRM の preset の名前。モデルに無ければ飛ばす） */
  blink: 'blink',

  /**
   * 暗いラボになじませるための MToon の調整。
   * rim* はパラメトリックリム（視線に対する輪郭の光）で、背景に埋もれないよう輪郭をシアンで縁取る
   */
  mtoon: {
    /**
     * アバター全体の露出。ラボのライトは物理単位（スポット数十 cd）なので、
     * MToon（1.0 前後の光を想定したトゥーン）にそのまま当てると白飛びする。色に掛けて明るさをそろえる
     */
    exposure: 0.46,
    rimColor: '#6fe6ff',
    rimIntensity: 0.28,
    rimFresnelPower: 3.2,
    rimLift: 0.0,
    /** 0 = リムを照明と無関係に常に出す / 1 = 照明に比例 */
    rimLightingMix: 0.25,
    /** 環境光の均一化（MToon の giEqualization）。WebGPU の MToonNodeMaterial には無いので、今は効かない（character/avatar/loadVrm.ts の tuneMaterial） */
    giEqualization: 0.85,
    /** 影の色を少し持ち上げて、暗いラボで黒くつぶれないようにする（0〜1） */
    shadeLift: 0.12,
    /**
     * アウトラインの太さの倍率。服の折り返しなど薄いメッシュでは、アウトラインが表に突き抜けて
     * 黒いギザギザに見えることがあるので細くする（0 で消える）
     */
    outlineWidthScale: 0.35,
  },

  /**
   * 待機を切り替える決まり（character/avatar/idleMix.ts）: 枠ごとに待機を決まった乱数（seed）で選び、1 つの枠は minSlot 秒以上（短い待機は繰り返す）、
   * 入れ替えに fade 秒かける。時刻はシーンの時計なので、撮影で同じ画になる
   */
  idleMix: { fade: 1.6, minSlot: 14, seed: 2035 },

  /** 影を落とす */
  castShadow: true,
} as const

/** 見た目の共通の設定の形（欄ごとに置き換えられる） */
export interface VisualConfig {
  /** jump を省けば、跳ぶ姿勢はコードで作った物 */
  animations: { idle: string; idleVariants?: readonly string[]; walk: string; jump?: { start: string; loop: string; land: string } }
  normalizeHeight: boolean
  allowedHeightError: number
  eyeHeightRatio: number
  lookAt: {
    maxYaw: number
    maxPitchUp: number
    maxPitchDown: number
    headFollow: number
    attendFollow: number
    torsoYaw: number
    torsoPitchUp: number
    focusDown: number
    saccade: { yaw: number; pitch: number; interval: readonly [number, number] }
    damping: number
  }
  steady: { headFraction: readonly [number, number]; amount: number; max: number }
  idle: VisualIdleConfig
  idleMix: { fade: number; minSlot: number; seed: number }
  blink: string
  mtoon: VrmMtoonConfig
  castShadow: boolean
}

/** 待機の姿勢とまばたき（character/avatar/pose.ts の idleBasePose も読む） */
export interface VisualIdleConfig {
  armDown: number
  elbowBend: number
  blinkInterval: readonly [number, number]
}

/** MToon の調整（character/avatar/loadVrm.ts の loadVrm・createVrmRim） */
export interface VrmMtoonConfig {
  exposure: number
  rimColor: string
  rimIntensity: number
  rimFresnelPower: number
  rimLift: number
  rimLightingMix: number
  giEqualization: number
  shadeLift: number
  outlineWidthScale: number
}
