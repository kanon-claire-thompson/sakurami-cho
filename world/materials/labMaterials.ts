import * as THREE from 'three'

/**
 * ラボ全体で共有する素材（MeshStandardMaterial・MeshPhysicalMaterial。色・金属の度合い・透け・名前を持つ「素材の表」で、描くときは
 * アニメ塗りの素材に差し替える（world/anime/labAnime.ts。名前で役割を引く world/anime/palette.ts の BY_NAME）。法線・ラフネスの質感の写真は持たない）。
 * ゾーンごとに new しないことで、テクスチャとシェーダーを使い回す。
 * `TownRoot`（react/TownView.tsx）がテクスチャを読み込んで作り（town.buildLab）、`useLabMaterials()` で取り出す。
 *
 * three だけで作る（docs/design/map-split.md §6 の「段 4」・4-2）。React の hooks（useLabMaterials・usePerforated・useGlow）と context は
 * react/labHooks.ts（R3F の使い手はそちらを読む。元のパスから再び出すのは 4-13 でやめた）
 */
export interface LabMaterials {
  /** 黒い金属の壁パネル */
  wallPanel: THREE.MeshStandardMaterial
  /** 装置の外装（濃いガンメタル） */
  darkMetal: THREE.MeshStandardMaterial
  /** フレーム・脚などほぼ黒の金属 */
  blackMetal: THREE.MeshStandardMaterial
  /** ヘアラインのステンレス */
  steel: THREE.MeshStandardMaterial
  /** アルミフレーム */
  aluminium: THREE.MeshStandardMaterial
  /** 鏡面に近い金属（ボルト・ノズル・レンズ枠） */
  chrome: THREE.MeshStandardMaterial
  /** 白い塗装（ロボットアーム・3D プリンタ） */
  whitePaint: THREE.MeshStandardMaterial
  /** ケーブル・ゴム */
  rubber: THREE.MeshStandardMaterial
  /** 黒い樹脂 */
  plasticDark: THREE.MeshStandardMaterial
  /** グレーの樹脂 */
  plasticGrey: THREE.MeshStandardMaterial
  /** 透明ガラス（ケース・壁） */
  glass: THREE.MeshPhysicalMaterial
  /** 少し色の付いたガラス（3D プリンタや CNC の窓） */
  tintedGlass: THREE.MeshPhysicalMaterial
  /** 消えている画面・黒い光沢パネル */
  screenOff: THREE.MeshStandardMaterial
  /** パンチングメタル・有孔ボード */
  perforated: THREE.MeshStandardMaterial
  /** 基板（濃紺） */
  pcb: THREE.MeshStandardMaterial
  /** 作業台の天板（黒いフェノール樹脂） */
  benchTop: THREE.MeshStandardMaterial
}

/** ラボのテクスチャ（パンチングメタルの穴の形だけ。アニメ塗りの素材が alphaMap として読む） */
export interface LabTextures {
  perfOpacity: THREE.Texture
}

export function createLabMaterials(tex: LabTextures): LabMaterials {
  return {
    wallPanel: new THREE.MeshStandardMaterial({
      name: 'wallPanel',
      color: '#1b1f26',
      metalness: 0.7,
      roughness: 0.62,
    }),
    darkMetal: new THREE.MeshStandardMaterial({
      name: 'darkMetal',
      color: '#262b33',
      metalness: 0.85,
      roughness: 0.5,
    }),
    blackMetal: new THREE.MeshStandardMaterial({
      name: 'blackMetal',
      color: '#0e1115',
      metalness: 0.8,
      roughness: 0.55,
    }),
    steel: new THREE.MeshStandardMaterial({
      name: 'steel',
      color: '#9aa3ad',
      metalness: 1,
      roughness: 0.62,
    }),
    aluminium: new THREE.MeshStandardMaterial({
      name: 'aluminium',
      color: '#b7bec7',
      metalness: 1,
      roughness: 0.75,
    }),
    chrome: new THREE.MeshStandardMaterial({
      name: 'chrome',
      color: '#d7dde4',
      metalness: 1,
      roughness: 0.14,
    }),
    whitePaint: new THREE.MeshStandardMaterial({
      name: 'whitePaint',
      color: '#d9dee4',
      metalness: 0.15,
      roughness: 0.48,
    }),
    rubber: new THREE.MeshStandardMaterial({
      name: 'rubber',
      color: '#0b0c0e',
      metalness: 0,
      roughness: 0.62,
    }),
    plasticDark: new THREE.MeshStandardMaterial({
      name: 'plasticDark',
      color: '#1c2026',
      metalness: 0.05,
      roughness: 0.5,
    }),
    plasticGrey: new THREE.MeshStandardMaterial({
      name: 'plasticGrey',
      color: '#4a5059',
      metalness: 0.05,
      roughness: 0.55,
    }),
    // ガラスは拡散反射をほぼ持たない（色を暗くして、映り込み＝鏡面反射だけが見えるようにする）
    glass: new THREE.MeshPhysicalMaterial({
      name: 'glass',
      color: '#0b1218',
      metalness: 0,
      roughness: 0.2,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      specularIntensity: 1,
      ior: 1.5,
      side: THREE.DoubleSide,
    }),
    tintedGlass: new THREE.MeshPhysicalMaterial({
      name: 'tintedGlass',
      color: '#5d7f99',
      metalness: 0,
      roughness: 0.25,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      specularIntensity: 1,
    }),
    screenOff: new THREE.MeshStandardMaterial({
      name: 'screenOff',
      color: '#040507',
      metalness: 0.2,
      roughness: 0.12,
    }),
    perforated: new THREE.MeshStandardMaterial({
      name: 'perforated',
      color: '#2a2f37',
      metalness: 0.75,
      roughness: 0.45,
      alphaMap: tex.perfOpacity,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    }),
    pcb: new THREE.MeshStandardMaterial({
      name: 'pcb',
      color: '#0d2138',
      metalness: 0.2,
      roughness: 0.4,
    }),
    benchTop: new THREE.MeshStandardMaterial({
      name: 'benchTop',
      color: '#15181c',
      metalness: 0.1,
      roughness: 0.42,
    }),
  }
}

/**
 * 穴の大きさを面ごとに合わせたパンチングメタル（共有の perforated を写し、穴のテクスチャを写して repeat を変える）。
 * repeatX / repeatY はテクスチャ（穴 約 11 個分）を何回繰り返すか。呼ぶたびに素材を 1 つ作る
 */
export function perforatedMaterial(mats: LabMaterials, repeatX: number, repeatY: number): THREE.MeshStandardMaterial {
  const m = mats.perforated.clone()
  const alpha = mats.perforated.alphaMap?.clone() ?? null
  if (alpha) {
    alpha.wrapS = alpha.wrapT = THREE.RepeatWrapping
    alpha.repeat.set(repeatX, repeatY)
    alpha.needsUpdate = true
  }
  m.alphaMap = alpha
  return m
}

/* -------------------------------------------------------------------------- */
/* 発光マテリアル                                                               */
/* -------------------------------------------------------------------------- */

const glowCache = new Map<string, THREE.MeshBasicMaterial>()

/**
 * 発光体用のマテリアル（toneMapped=false、輝度 = color × intensity）。
 * 同じ色・強さのものはキャッシュして使い回す。
 * 不透明の物は、面に重ねたり半分埋めたりして面とまったく同じ深さになる所は面を残す（depthFunc を Less に。半透明の物はいつも不透明の面の後に描くので今のまま）。決めないと、マテリアルを作った順
 * （three の不透明の並べ替えは material.id を見る）や React の描き直しの進み方で先に描いた方が変わり、その所の見え方が変わる
 * （町とラボを分ける 段 3-4。直す前の作る順では、発光体がラボの面より先に作られて面が残っていたので、それにそろえた）。
 * 面より手前に見せる物は overlayGlowMaterial
 */
export function glowMaterial(color: THREE.ColorRepresentation, intensity: number, opacity = 1): THREE.MeshBasicMaterial {
  const key = `${new THREE.Color(color).getHexString()}:${intensity}:${opacity}`
  let m = glowCache.get(key)
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      name: `glow-${key}`,
      color: new THREE.Color(color).multiplyScalar(intensity),
      toneMapped: false,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      depthFunc: opacity >= 1 ? THREE.LessDepth : THREE.LessEqualDepth,
    })
    glowCache.set(key, m)
  }
  return m
}

/**
 * 面にぴったり重ねて置き、面より手前に見せる発光体（基地局の内側リングの目盛り・柱のスリット）のマテリアル。glowMaterial と同じ光り方で、
 * 深さを少し手前へずらし（polygonOffset）、マテリアルを作った順によらず面より必ず手前に描く（町とラボを分ける 段 3-4）
 */
export function overlayGlowMaterial(color: THREE.ColorRepresentation, intensity: number): THREE.MeshBasicMaterial {
  const key = `${new THREE.Color(color).getHexString()}:${intensity}:1:overlay`
  let m = glowCache.get(key)
  if (!m) {
    m = glowMaterial(color, intensity).clone()
    m.name = `glow-${key}`
    m.depthFunc = THREE.LessEqualDepth
    m.polygonOffset = true
    m.polygonOffsetFactor = -1
    m.polygonOffsetUnits = -4
    glowCache.set(key, m)
  }
  return m
}
