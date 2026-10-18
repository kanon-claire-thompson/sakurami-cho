import * as THREE from 'three'
import { GLOW, PALETTE } from '../../palette'
import { dimmableGlowMaterial } from '../../labLight'
import { getExteriorGlass } from '../../outdoor/exteriorGlass'
import { floorStencilTexture } from '../../textures/city'
import { bolts, boxInstances, glowBox, matrixInstances, type InstanceItem } from '../parts/details'
import { group, mesh } from '../parts/object'
import { CEILING_LIGHTS, ENTRANCE, MEZZANINE, ROOM, WALL_PANEL_DEPTH, type Vec3 } from '../../../core/lab/plan'
import { keep, perforated, sunCasters, wallWash, type ShellBuild } from './build'
import type { LabFloor } from './floor'
import { instancedMesh } from '../../instancing'

/**
 * 部屋そのもの（床・壁・天井・南のガラス壁。docs/design/map-split.md §6 の「段 4」・4-4。前の Room.tsx）。外の景色（空・町の遠景）は outdoor/landscape.ts。
 * 壁はそれぞれ「壁ローカル座標」で作る: x = 壁に沿って右、y = 上、z = 部屋の内側。
 * 北の壁の扉（northDoors.ts）・中二階（mezzanine.ts）・南西の見学エントランス（entrance.ts）は別のファイル。床と映り込みは floor.ts。
 *
 * 前の R3F の部品と同じ入れ子・同じ子の順・同じ作る順（部品の hooks の素材 → JSX の子。子を作ってから群）で作る（素材の id の並びと、
 * 行列の掛け方を変えないため）。窓のある壁・柱・天井の板は、太陽の影を落とす物の群に入れる（印は attach で付ける）
 */

const H = ROOM.height
const HW = ROOM.halfWidth
/** 北の壁・南のガラス壁の面（z）と、奥行きの中心 */
const N = ROOM.north
const S = ROOM.south
const CZ = ROOM.centerZ
/** 中二階の床板の下の面（北の壁の、扉の並ぶ下の段の上端） */
const MEZZ_UNDER = MEZZANINE.floorY - MEZZANINE.slab
/** 角の柱の内側の面（|x|）。南西の角の柱だけは見学エントランスの扉まで太い（ENTRANCE.pier） */
const PILLAR_IN = HW - 0.4

/* -------------------------------------------------------------------------- */
/* 床                                                                           */
/* -------------------------------------------------------------------------- */

/** 床の目地（カッター目地）と吹き付けのマーキング */
function floorDetails(): THREE.Group {
  const seamMat = new THREE.MeshStandardMaterial({ name: 'floorSeam', color: '#030405', roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1 })
  const stencil = floorStencilTexture(['SAKURAGI-OKA'], 'south-floor')
  // 奥行きを 3 つに割る横の目地と、x = ±4 の縦の目地
  const seams: { pos: Vec3; size: [number, number] }[] = [
    { pos: [0, 0.0012, N + ROOM.depth / 3], size: [ROOM.width, 0.01] },
    { pos: [0, 0.0012, N + (ROOM.depth * 2) / 3], size: [ROOM.width, 0.01] },
    { pos: [-4, 0.0012, CZ], size: [0.01, ROOM.depth] },
    { pos: [4, 0.0012, CZ], size: [0.01, ROOM.depth] },
  ]
  return group([
    ...seams.map((s) => mesh(new THREE.PlaneGeometry(...s.size), seamMat, { p: s.pos, r: [-Math.PI / 2, 0, 0] })),
    // 南のガラス壁の手前の床に吹き付けた文字
    mesh(
      new THREE.PlaneGeometry(3.2, 1.6),
      new THREE.MeshStandardMaterial({
        name: 'floorStencil',
        map: stencil,
        color: '#9aa3ad',
        transparent: true,
        opacity: 0.35,
        roughness: 0.7,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
      { p: [0, 0.0015, S - 1.5], r: [-Math.PI / 2, 0, 0] },
    ),
  ])
}

/* -------------------------------------------------------------------------- */
/* 壁パネル                                                                     */
/* -------------------------------------------------------------------------- */

export interface PanelFieldOptions {
  x0: number
  x1: number
  y0: number
  y1: number
  cols: number
  rows: number
  gap?: number
  depth?: number
  bolts?: boolean
}

/** 壁ローカル座標で、矩形の範囲を黒い金属パネルで敷き詰める（InstancedMesh。パネルごとに形を 1 つ） */
export function panelField(b: ShellBuild, { x0, x1, y0, y1, cols, rows, gap = 0.014, depth = WALL_PANEL_DEPTH, bolts: withBolts = true }: PanelFieldOptions): THREE.Group {
  const count = cols * rows
  const pw = (x1 - x0) / cols
  const ph = (y1 - y0) / rows

  const boltPositions: Vec3[] = []
  if (withBolts) {
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const x = x0 + pw * (cx + 0.5)
        const y = y0 + ph * (cy + 0.5)
        const dx = pw / 2 - 0.05
        const dy = ph / 2 - 0.05
        boltPositions.push([x - dx, y - dy, depth + 0.002], [x + dx, y - dy, depth + 0.002], [x - dx, y + dy, depth + 0.002], [x + dx, y + dy, depth + 0.002])
      }
    }
  }

  const boxGeom = new THREE.BoxGeometry(1, 1, 1)
  const panels = instancedMesh(boxGeom, b.mats.wallPanel, count)
  panels.receiveShadow = true
  const m = new THREE.Matrix4()
  const c = new THREE.Color()
  let i = 0
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const x = x0 + pw * (cx + 0.5)
      const y = y0 + ph * (cy + 0.5)
      // パネルごとにわずかに出っ張り・色をばらつかせて「一枚ずつ取り付けた」感じを出す
      const jitter = ((cx * 7 + cy * 13) % 5) / 5
      m.makeScale(pw - gap, ph - gap, depth * (0.9 + jitter * 0.2))
      m.setPosition(x, y, (depth * (0.9 + jitter * 0.2)) / 2)
      panels.setMatrixAt(i, m)
      c.setScalar(0.82 + jitter * 0.3)
      panels.setColorAt(i, c)
      i++
    }
  }
  panels.instanceMatrix.needsUpdate = true
  if (panels.instanceColor) panels.instanceColor.needsUpdate = true
  panels.computeBoundingSphere()

  const children: THREE.Object3D[] = [panels]
  if (boltPositions.length > 0) children.push(bolts({ positions: boltPositions, axis: 'z', radius: 0.008, material: b.mats.darkMetal }, b.mats))
  return group(children)
}

interface GlassBandOptions {
  x0: number
  x1: number
  y0: number
  y1: number
  /** 縦の方立ての間隔（m） */
  mullionSpacing?: number
}

/** 壁ローカル座標のガラス帯（ガラス + 黒い方立て + 上下の枠。方立てと枠はまとめて 1 回で描く） */
function glassBand(b: ShellBuild, { x0, x1, y0, y1, mullionSpacing = 1.2 }: GlassBandOptions): THREE.Group {
  const glass = keep(b, getExteriorGlass(b.mats.glass))
  const width = x1 - x0
  const height = y1 - y0
  const count = Math.max(1, Math.round(width / mullionSpacing))
  const frame: InstanceItem[] = [
    ...Array.from({ length: count + 1 }, (_, i): InstanceItem => ({ p: [x0 + (width * i) / count, (y0 + y1) / 2, 0.04], s: [0.06, height, 0.08] })),
    { p: [(x0 + x1) / 2, y0, 0.05], s: [width, 0.08, 0.1] },
    { p: [(x0 + x1) / 2, y1, 0.05], s: [width, 0.08, 0.1] },
  ]
  return group([
    mesh(new THREE.PlaneGeometry(width, height), glass, { p: [(x0 + x1) / 2, (y0 + y1) / 2, 0.01], order: 1 }),
    boxInstances({ items: frame, material: b.mats.blackMetal }),
  ])
}

/** 壁の後ろの暗い下地（パネルの目地から見える部分。壁ごとに素材を 1 つ） */
export function wallBacking(x0: number, x1: number, y0: number = 0, y1: number = H): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ name: 'wallBacking', color: '#030406', roughness: 0.9, metalness: 0.2 })
  return mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), mat, { p: [(x0 + x1) / 2, (y0 + y1) / 2, -0.005] })
}

function wall(position: Vec3, rotationY: number, children: readonly THREE.Object3D[]): THREE.Group {
  return group(children, { p: position, ry: rotationY })
}

/**
 * 北の壁（z = ROOM.north）。中央は基地局の背の暗い背板（床から天井まで。|x| < MEZZANINE.backdropX）。
 * 左右は、下の段が北側の部屋（電源室・冷却機械室・給湯室と WC の前室・資料庫）の扉の並ぶ壁（扉は northDoors.ts）、
 * 上の段は中二階（mezzanine.ts）へ開いている。北の角の柱は壁の線の奥（中二階の角）にあるので、下の段は西と東の壁まで
 */
function backWall(b: ShellBuild): THREE.Group {
  const GL = MEZZANINE.backdropX // 中央の背板の半幅
  return wall([0, 0, N], 0, [
    wallBacking(-GL, GL),
    // 中央：基地局の背の暗い背板
    panelField(b, { x0: -GL, x1: GL, y0: 0, y1: H, cols: 4, rows: 6 }),
    // 左右の下の段: パネルはほぼ 1m ごと
    ...[-1, 1].map((s) =>
      group([
        wallBacking(s < 0 ? -HW : GL, s < 0 ? -GL : HW, 0, MEZZ_UNDER),
        panelField(b, { x0: s < 0 ? -HW : GL, x1: s < 0 ? -GL : HW, y0: 0, y1: MEZZ_UNDER, cols: Math.round(HW - GL), rows: 2 }),
      ]),
    ),
  ])
}

/**
 * 西と東の壁（x = ∓8.4）。下は金属パネル、中ほどにハイサイドのガラス窓（外は空と丘の上の木々）、その上の天井までは金属パネル。
 * 西の壁の南端に通用口（ENTRANCE.staffDoor。扉は entrance.ts）の開口
 */
function sideWall(b: ShellBuild, side: -1 | 1): THREE.Group {
  // 壁ローカルの x の範囲（奥行きの中心に置くので ±奥行きの半分）。西の壁はローカル x = CZ - z、東の壁は z - CZ
  const HD = ROOM.depth / 2
  const G0 = 2.6
  const G1 = 4.4
  const cols = Math.round(ROOM.depth / 1.5)
  // 通用口の開口（壁ローカルの x の範囲）
  const door = side < 0 ? ([CZ - ENTRANCE.staffDoor.z[1], CZ - ENTRANCE.staffDoor.z[0]] as const) : null
  const DH = ENTRANCE.staffDoorHeight + 0.06
  return wall([side * HW, 0, CZ], side < 0 ? Math.PI / 2 : -Math.PI / 2, [
    wallBacking(-HD, HD, 0, G0),
    wallBacking(-HD, HD, G1, H),
    ...(door
      ? [
          panelField(b, { x0: -HD, x1: door[0], y0: 0, y1: G0, cols: 1, rows: 2 }),
          panelField(b, { x0: door[0], x1: door[1], y0: DH, y1: G0, cols: 1, rows: 1 }),
          panelField(b, { x0: door[1], x1: HD, y0: 0, y1: G0, cols: cols - 1, rows: 2 }),
        ]
      : [panelField(b, { x0: -HD, x1: HD, y0: 0, y1: G0, cols, rows: 2 })]),
    glassBand(b, { x0: -HD, x1: HD, y0: G0, y1: G1, mullionSpacing: 1.5 }),
    panelField(b, { x0: -HD, x1: HD, y0: G1, y1: H, cols, rows: 2, bolts: false }),
  ])
}

/**
 * 南の壁（z = +5.2）。床から天井までのガラス壁（設定資料: 南面を大きく切り取ったガラス壁。枠のネオンは wallLedLines）。
 * 西の端（南西の角）は見学エントランス: 角の柱（ひらき札は外の面）のすぐ東に、見学用のガラスの両開きの扉がガラス壁の中にある
 * （扉・ひらき札・表示は entrance.ts）。外は町の遠景（outdoor/landscape.ts）。ガラスは時刻で暗さが変わる（outdoor/exteriorGlass.ts）
 */
function southWall(b: ShellBuild): THREE.Group {
  const glass = keep(b, getExteriorGlass(b.mats.glass))
  // 壁ローカル座標（rotationY = π）: ローカル x = ワールドの -x、ローカル z = 部屋の内側（ワールドの -z）
  const g0 = -PILLAR_IN // ガラスの東の端（ワールド x = 8.0）
  const d0 = -ENTRANCE.glassDoor[1] // 見学エントランスの扉の区画（ローカル）
  const d1 = -ENTRANCE.glassDoor[0] // ガラスの西の端（ワールド x = -7.8。角の柱の東の面）
  const T = ENTRANCE.transoms
  // 縦の方立て: 扉の区画の東は、ほぼ 1.2m ごとに割る
  const bays = Math.round((d0 - g0) / 1.2)
  const mullions = [...Array.from({ length: bays + 1 }, (_, i) => g0 + ((d0 - g0) * i) / bays), d1]
  const frame: InstanceItem[] = [
    ...mullions.map((x): InstanceItem => ({ p: [x, H / 2, 0.06], s: [0.07, H, 0.12] })),
    ...[0.03, ...T, H - 0.04].map((y): InstanceItem => ({ p: [(g0 + d1) / 2, y, 0.06], s: [d1 - g0, 0.08, 0.12] })),
  ]
  return wall([0, 0, S], Math.PI, [
    // ガラス（扉の区画は欄間から上だけ。扉そのものは entrance.ts）
    mesh(new THREE.PlaneGeometry(d0 - g0, H), glass, { p: [(g0 + d0) / 2, H / 2, 0.01], order: 1 }),
    mesh(new THREE.PlaneGeometry(d1 - d0, H - T[0]), glass, { p: [(d0 + d1) / 2, (T[0] + H) / 2, 0.01], order: 1 }),
    // 縦の方立てと、横の桟（欄間）・下の枠・上の枠（まとめて 1 回で描く）
    boxInstances({ items: frame, material: b.mats.blackMetal }),
  ])
}

/**
 * 床際の LED ラインが壁パネルを下から照らしている「光のにじみ」。
 * 実ライトを何十個も置く代わりに、壁の手前に加算合成のグラデーション板を貼って表現する（materials/wallWash.ts）。
 */
function wallWashes(b: ShellBuild): THREE.Group {
  const mat = wallWash(b)
  const hgt = 1.3
  const z = WALL_PANEL_DEPTH + 0.006
  const walls: { position: Vec3; rotationY: number; length: number }[] = [
    { position: [0, 0, N], rotationY: 0, length: ROOM.width },
    { position: [-HW, 0, CZ], rotationY: Math.PI / 2, length: ROOM.depth },
    { position: [HW, 0, CZ], rotationY: -Math.PI / 2, length: ROOM.depth },
  ]
  return group(walls.map((w) => group([mesh(new THREE.PlaneGeometry(w.length, hgt), mat, { p: [0, hgt / 2, z], order: 4 })], { p: w.position, ry: w.rotationY })))
}

/** 床と壁の継ぎ目のシアンの LED ライン、天井際のブルーのライン、南のガラス壁の枠のシアンのネオン */
function wallLedLines(): THREE.Group {
  const t = 0.014
  const inset = WALL_PANEL_DEPTH + 0.012
  const floorY = 0.012
  // 部屋の LED は配信を始めると落ちるので、共有の発光マテリアルとは別に作る
  const strip = dimmableGlowMaterial(PALETTE.cyan, GLOW.strip, 0.25, true)
  const top = dimmableGlowMaterial(PALETTE.blue, 2.2, 0.1)
  // ガラス壁の枠のネオン（設定資料: ガラス壁の枠に沿ってシアンのネオンライン）。床際の線は床の LED と同じ（演出で一緒に光る）
  const neon = dimmableGlowMaterial(PALETTE.cyan, 2.6, 0.2)
  const gE = ENTRANCE.glassFrom // ガラスの西の端
  const gW = PILLAR_IN // ガラスの東の端
  const zFrame = S - 0.13 // 枠の部屋側の面のすぐ手前
  const line = (material: THREE.Material, p: Vec3, s: Vec3) => mesh(new THREE.BoxGeometry(), material, { p, s })
  return group([
    // 床際
    line(strip, [0, floorY, N + inset], [ROOM.width - inset * 2, t, t]),
    ...[-1, 1].map((s) => line(strip, [s * (HW - inset), floorY, CZ], [t, t, ROOM.depth - inset * 2])),
    // 床際（南）: ガラス壁の下の枠に沿う線
    line(strip, [(gE + gW) / 2, floorY, zFrame], [gW - gE, t, t]),
    // ガラス壁の枠のネオン（両端の縦と、上の枠）
    ...[gE + 0.05, gW - 0.05].map((x) => line(neon, [x, H / 2, zFrame], [t, H - 0.1, t])),
    line(neon, [(gE + gW) / 2, H - 0.1, zFrame], [gW - gE, t, t]),
    // 天井際
    ...[-1, 1].map((s) => line(top, [s * (HW - inset), H - 0.72, CZ], [t, t, ROOM.depth - 0.2])),
  ])
}

/* -------------------------------------------------------------------------- */
/* 天井                                                                         */
/* -------------------------------------------------------------------------- */

/** 天井（6.5m）の高さからの吊り下げの位置 */
const DUCT_Y = H - 0.65
const TRAY_Y = H - 0.45
/**
 * ケーブルラックの縁（暗い金属の板）を、パンチングメタルの底の板より上げる量（1mm）。4-0b で決めた。仮: もとは縁の下の面が底の板と
 * 同じ高さにあり（重なる幅 5mm）、作る順（material.id）でどちらが見えるかが決まっていた。今の見え方（下から底の板が見える）にそろえる
 */
const TRAY_RAIL_LIFT = 0.001
const LINE_LIGHT_Y = CEILING_LIGHTS.lineY

/**
 * 天井の梁・ダクト・ケーブルラック・ライン照明。
 * 設定資料の「天井の右手を太い銀色の空調ダクトが横切る」の銀色の丸ダクトは、左右の 2 本（右手 = 東）
 */
function ceiling(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const trayMat = perforated(b, 1.4, 40)
  const ceilingMat = new THREE.MeshStandardMaterial({ name: 'ceiling', color: '#07090c', roughness: 0.85, metalness: 0.3 })
  // 梁はほぼ 3m ごと（奥行きを等分して、奥行きの中心に対して対称に）
  const beamCount = Math.round(ROOM.depth / 3)
  const beamZ = Array.from({ length: beamCount }, (_, i) => CZ + (i - (beamCount - 1) / 2) * (ROOM.depth / beamCount))
  // 天井のライン照明（配信中はほぼ消える）
  const lightMat = dimmableGlowMaterial('#d8ecff', 2.4, 0.05)
  const ductXs = [-5.3, 5.3]
  const ringZs = Array.from({ length: Math.floor(ROOM.depth / 1.5) + 1 }, (_, i) => N + 1.5 * i).filter((z) => z > N + 0.1 && z < S - 0.1)

  // ライン照明は器具・光る面・吊りボルトをそれぞれ 1 回の描画にまとめる
  const bodies: THREE.Matrix4[] = []
  const strips: THREE.Matrix4[] = []
  const rods: THREE.Matrix4[] = []
  const rodLen = H - LINE_LIGHT_Y
  for (const x of CEILING_LIGHTS.lineXs) {
    for (const z of CEILING_LIGHTS.lineZs) {
      bodies.push(new THREE.Matrix4().makeTranslation(x, LINE_LIGHT_Y, z))
      strips.push(new THREE.Matrix4().makeTranslation(x, LINE_LIGHT_Y - 0.032, z))
      for (const s of [-1, 1]) rods.push(new THREE.Matrix4().compose(new THREE.Vector3(x, LINE_LIGHT_Y + rodLen / 2, z + s * 1.0), new THREE.Quaternion(), new THREE.Vector3(1, rodLen, 1)))
    }
  }
  const bodyGeom = new THREE.BoxGeometry(0.12, 0.06, 2.4)
  const stripGeom = new THREE.BoxGeometry(0.06, 0.006, 2.3)
  const rodGeom = new THREE.BoxGeometry(0.008, 1, 0.008)

  return group([
    // 天井の板は、窓から差し込む太陽の光をさえぎる（太陽の影を落とす）
    sunCasters(b, [mesh(new THREE.PlaneGeometry(ROOM.width, ROOM.depth), ceilingMat, { p: [0, H, CZ], r: [Math.PI / 2, 0, 0] })]),
    // H 形鋼の梁
    ...beamZ.map((z) =>
      group(
        [
          mesh(new THREE.BoxGeometry(ROOM.width, 0.03, 0.26), mats.darkMetal, { p: [0, -0.02, 0] }),
          mesh(new THREE.BoxGeometry(ROOM.width, 0.36, 0.018), mats.darkMetal, { p: [0, -0.2, 0] }),
          mesh(new THREE.BoxGeometry(ROOM.width, 0.03, 0.26), mats.darkMetal, { p: [0, -0.39, 0] }),
        ],
        { p: [0, H, z] },
      ),
    ),
    // 銀色の丸ダクト
    ...ductXs.map((x) =>
      group([
        mesh(new THREE.CylinderGeometry(0.26, 0.26, ROOM.depth, 28, 1, true), mats.aluminium, { p: [x, DUCT_Y, CZ], r: [Math.PI / 2, 0, 0] }),
        // 吊りバンド
        ...ringZs.map((z) => mesh(new THREE.BoxGeometry(0.02, H - DUCT_Y - 0.26, 0.02), mats.blackMetal, { p: [x, (DUCT_Y + 0.26 + H) / 2, z + 0.3] })),
      ]),
    ),
    ductRings(mats.steel, ductXs, ringZs),
    // ケーブルラック（パンチングメタル）
    ...[-2.6, 2.6].map((x) =>
      group(
        [
          mesh(new THREE.PlaneGeometry(0.4, ROOM.depth), trayMat, { r: [-Math.PI / 2, 0, 0] }),
          ...[-1, 1].map((s) => mesh(new THREE.BoxGeometry(0.01, 0.1, ROOM.depth), mats.darkMetal, { p: [s * 0.2, 0.05 + TRAY_RAIL_LIFT, 0] })),
          ...[-0.1, -0.04, 0.03, 0.09].map((cx, i) =>
            mesh(new THREE.CylinderGeometry(0.022, 0.022, ROOM.depth, 8), mats.rubber, { p: [cx, 0.035 + (i % 2) * 0.02, 0], r: [Math.PI / 2, 0, 0] }),
          ),
        ],
        { p: [x, TRAY_Y, CZ] },
      ),
    ),
    // ライン照明（天井から吊る。控えめ）
    matrixInstances({ matrices: bodies, geometry: bodyGeom, material: mats.blackMetal }),
    matrixInstances({ matrices: strips, geometry: stripGeom, material: lightMat }),
    matrixInstances({ matrices: rods, geometry: rodGeom, material: mats.blackMetal }),
  ])
}

/** ダクトの継ぎ目の環（InstancedMesh。影はどちらもしない） */
function ductRings(material: THREE.Material, ductXs: readonly number[], ringZs: readonly number[]): THREE.InstancedMesh {
  const rings = instancedMesh(new THREE.CylinderGeometry(0.275, 0.275, 0.05, 28), material, ductXs.length * ringZs.length)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
  let i = 0
  for (const x of ductXs) {
    for (const z of ringZs) {
      m.compose(new THREE.Vector3(x, DUCT_Y, z), q, new THREE.Vector3(1, 1, 1))
      rings.setMatrixAt(i++, m)
    }
  }
  rings.instanceMatrix.needsUpdate = true
  rings.computeBoundingSphere()
  return rings
}

/**
 * 柱（部屋の四隅）。北の 2 本は北の壁の線の奥（1 階は北側の部屋の壁の中、上は中二階の角）。
 * 南西の角の柱は見学エントランスの扉の縁まで（ENTRANCE.pier。ひらき札は外の面）
 */
function pillars(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const pierW = ENTRANCE.pier[1] - ENTRANCE.pier[0]
  const corners: { p: Vec3; w: number; slitY: number }[] = [
    { p: [-HW + 0.2, H / 2, N - 0.2], w: 0.4, slitY: MEZZANINE.floorY + 1.6 },
    { p: [HW - 0.2, H / 2, N - 0.2], w: 0.4, slitY: MEZZANINE.floorY + 1.6 },
    { p: [-HW + pierW / 2, H / 2, S - 0.2], w: pierW, slitY: 2.3 },
    { p: [HW - 0.2, H / 2, S - 0.2], w: 0.4, slitY: 2.3 },
  ]
  // 柱の縦スリットの長さ
  const slitLen = 3.0
  return group(
    corners.map(({ p, w, slitY }) => {
      const body = mesh(new THREE.BoxGeometry(w, H, 0.4), mats.darkMetal, { cast: true, receive: true })
      // 柱の縦スリット（部屋の側の面。面に重ねて置くので、作る順によらず面より手前に描く）
      const slit = glowBox({
        position: [p[0] < 0 ? w / 2 + 0.001 : -(w / 2 + 0.001), slitY - H / 2, p[2] < 0 ? 0.12 : -0.12],
        size: [0.004, slitLen, 0.02],
        color: PALETTE.blue,
        intensity: 2.4,
        overlay: true,
      })
      keep(b, slit.material as THREE.Material)
      return group([body, slit], { p })
    }),
  )
}

/** 部屋（前の Room.tsx の Room）。床は floor.ts で作って渡す */
export function buildRoom(b: ShellBuild, floor: LabFloor): THREE.Group {
  return group([
    floor.mesh,
    floorDetails(),
    backWall(b),
    // 窓のある壁と柱は、差し込む太陽の光の形を決める（太陽の影を落とす）
    sunCasters(b, [sideWall(b, -1), sideWall(b, 1), southWall(b), pillars(b)]),
    wallLedLines(),
    wallWashes(b),
    ceiling(b),
  ])
}
