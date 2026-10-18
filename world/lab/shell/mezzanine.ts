import * as THREE from 'three'
import { PALETTE } from '../../palette'
import { mulberry32 } from '../../../core/random'
import { dimmableGlowMaterial } from '../../labLight'
import { glowMaterial } from '../../materials/labMaterials'
import { hirakiBoardFrameTexture } from '../../textures/signs'
import { bolts, boxInstances, sticker, type InstanceItem } from '../parts/details'
import { group, mesh } from '../parts/object'
import { MEZZANINE, ROOM, WALL_PANEL_DEPTH, type Vec3 } from '../../../core/lab/plan'
import { keep, perforated, wallWash, type ShellBuild } from './build'

/**
 * 中二階（設定資料: 北側の上部。内法 16.8m × 2.86m・床は 1 階から 3.0m。仮眠用のソファベッド、資料庫、ひらきボードの額。
 * docs/design/map-split.md §6 の「段 4」・4-4。前の zones/Mezzanine.tsx）。
 * 北の壁の線（z = ROOM.north）より奥、北側の部屋の上にあり、中央は基地局の背の暗い背板に隠れ、左右がホールに向かって開いている。
 * 縁は床板の見付（黒い金属）にシアンの光のライン、その上にガラスの手すり（手すりの下にブルーの細い光）。
 * 西の端は 1 階からの急な鉄骨の階段（mezzanineStair。資料の「中二階への階段」）の口で、手すりを開けてある。
 * 西に仮眠用のソファベッドとひらきボードの額、東に資料庫の棚。
 * 基地局より目立たないよう、中の明かりは天井際のライン照明と、壁を照らす光のにじみ（加算合成の板）・小さな明かりだけにしている
 * （実ライトは足さない）。同じ材質の部品は左右まとめて 1 回で描く。ワールド座標で置く。
 */

const H = ROOM.height
/**
 * 中二階の天井の板を張る高さ。部屋の高さ H より 2mm 上。4-0b で決めた。仮: 町の敷地の殻（site/labShell）の屋根のスラブの下の面が
 * 同じ高さ（SHELL.ceiling = 6.5m）にあり、作る順（material.id）でどちらが見えるかが決まっていた。今の見え方（殻の面が見える）にそろえる。
 * 殻は町の敷地とまとめて描いていて段 4 では動かさないので、ラボの側を上げる（町が無いときは、この板がそのまま天井に見える）
 */
const CEILING_Y = H + 0.002
const Z0 = ROOM.north
const ZN = Z0 - MEZZANINE.depth
const FY = MEZZANINE.floorY
const UNDER = FY - MEZZANINE.slab
/** 角の柱の内側の面（|x|。北の角の柱は中二階の縁の角にある） */
const PILLAR_IN = ROOM.halfWidth - 0.4
/** 階段（1 階の x・z の範囲） */
const STAIR = MEZZANINE.stair
/** 手すりのガラスの高さ */
const RAIL_H = 1.05
const SIDES = [-1, 1] as const

/** 上から下へ消えていく、天井際の照明が壁を照らす光のにじみの色 */
const TOP_WASH = new THREE.Color('#9cc8ff').multiplyScalar(0.3)

/** 単位の形（モジュールに 1 つ。dispose で捨てない） */
const PLANE = new THREE.PlaneGeometry(1, 1)
const CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 16)
const LAMP_SHADE = new THREE.CylinderGeometry(0.7, 1, 1, 20, 1, true)

/** 片側の中二階の x の範囲（基地局の背板の側 → 外の壁） */
function sideSpan(s: -1 | 1) {
  const x0 = Math.min(s * MEZZANINE.backdropX, s * ROOM.halfWidth)
  const x1 = Math.max(s * MEZZANINE.backdropX, s * ROOM.halfWidth)
  return { x0, x1, W: x1 - x0, cx: (x0 + x1) / 2 }
}

/**
 * 壁ローカル座標（x = 壁に沿って、z = 内側）の金属パネルの並びを、ワールド座標の直方体にする（room.ts の panelField と同じ割り付け）。
 * origin・rotY は壁の置き方、[a, b] × [y0, y1] がパネルを敷く範囲
 */
function panelItems(origin: Vec3, rotY: number, a: number, b: number, y0: number, y1: number, cols: number, rows: number): InstanceItem[] {
  const out: InstanceItem[] = []
  const pw = (b - a) / cols
  const ph = (y1 - y0) / rows
  const c = Math.cos(rotY)
  const sn = Math.sin(rotY)
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const jitter = ((cx * 7 + cy * 13) % 5) / 5
      const d = WALL_PANEL_DEPTH * (0.9 + jitter * 0.2)
      const lx = a + pw * (cx + 0.5)
      const lz = d / 2
      out.push({
        p: [origin[0] + lx * c + lz * sn, y0 + ph * (cy + 0.5), origin[2] - lx * sn + lz * c],
        s: [pw - 0.014, ph - 0.014, d],
        e: [0, rotY, 0],
        c: new THREE.Color().setScalar(0.82 + jitter * 0.3),
      })
    }
  }
  return out
}

/** 左右の中二階の箱（床板・縁・手すり・壁・天井・照明） */
function mezzanineShell(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const edgeLine = dimmableGlowMaterial(PALETTE.cyan, 2.4, 0.3)
  const railLine = dimmableGlowMaterial(PALETTE.blue, 1.8, 0.3)
  const cove = dimmableGlowMaterial('#d8ecff', 2.2, 0.35)
  const floorMat = new THREE.MeshStandardMaterial({ name: 'mezzanineFloor', color: '#0b0e12', roughness: 0.38, metalness: 0.25 })
  const ceilingMat = new THREE.MeshStandardMaterial({ name: 'ceiling', color: '#07090c', roughness: 0.85, metalness: 0.3 })
  const floorWash = wallWash(b)
  const topWash = wallWash(b, TOP_WASH)

  const dark: InstanceItem[] = []
  const black: InstanceItem[] = []
  const glass: InstanceItem[] = []
  const rails: InstanceItem[] = []
  const edges: InstanceItem[] = []
  const railLines: InstanceItem[] = []
  const coves: InstanceItem[] = []
  const floors: InstanceItem[] = []
  const ceilings: InstanceItem[] = []
  const topWashes: InstanceItem[] = []
  const floorWashes: InstanceItem[] = []
  const panels: InstanceItem[] = []
  const D = MEZZANINE.depth
  const zc = (Z0 + ZN) / 2
  for (const s of SIDES) {
    const { x0, x1, W, cx } = sideSpan(s)
    // 縁の見付は基地局の背板の端から角の柱まで。手すりも同じだが、西は階段の口（STAIR の x の範囲）を開ける
    const e0 = s < 0 ? -PILLAR_IN : MEZZANINE.backdropX + 0.05
    const e1 = s < 0 ? -MEZZANINE.backdropX - 0.05 : PILLAR_IN
    const ew = e1 - e0
    const ec = (e0 + e1) / 2
    const r0 = s < 0 ? STAIR.max[0] + 0.03 : e0
    const r1 = e1
    const rw = r1 - r0
    const rc = (r0 + r1) / 2
    // 床板（下の部屋の天井）・開口の上の梁
    dark.push({ p: [cx, (UNDER + FY) / 2, zc], s: [W, MEZZANINE.slab, D] })
    dark.push({ p: [cx, H - 0.2, Z0], s: [W, 0.4, 0.26] })
    // 縁の見付（ホール側へ少し出す）・手すりの受け金物・天井際の照明の器具
    black.push({ p: [ec, (UNDER + FY + 0.06) / 2, Z0 + 0.03], s: [ew, FY + 0.06 - UNDER, 0.06] })
    black.push({ p: [rc, FY + 0.05, Z0 - 0.05], s: [rw, 0.1, 0.08] })
    black.push({ p: [cx, H - 0.06, ZN + 0.35], s: [W - 0.6, 0.06, 0.12] })
    // 光のライン（縁・奥の壁の床際）・手すりの下の細い光・天井際の照明
    edges.push({ p: [ec, FY - 0.03, Z0 + 0.064], s: [ew, 0.012, 0.008] })
    edges.push({ p: [cx, FY + 0.012, ZN + 0.05], s: [W, 0.012, 0.012] })
    railLines.push({ p: [rc, FY + 0.05 + RAIL_H, Z0 - 0.05], s: [rw, 0.006, 0.006] })
    coves.push({ p: [cx, H - 0.092, ZN + 0.35], s: [W - 0.7, 0.006, 0.06] })
    // ガラスの手すりと、上の手すり
    glass.push({ p: [rc, FY + 0.06 + RAIL_H / 2, Z0 - 0.05], s: [rw, RAIL_H, 0.015] })
    rails.push({ p: [rc, FY + 0.08 + RAIL_H, Z0 - 0.05], s: [0.024, rw, 0.024], e: [0, 0, Math.PI / 2] })
    // 床・天井
    floors.push({ p: [cx, FY + 0.002, zc], s: [W, D, 1], e: [-Math.PI / 2, 0, 0] })
    ceilings.push({ p: [cx, CEILING_Y, zc], s: [W, D, 1], e: [Math.PI / 2, 0, 0] })
    // 奥の壁の光のにじみ（上は天井際の照明、下は床際の LED）
    topWashes.push({ p: [cx, H - 1.25, ZN + WALL_PANEL_DEPTH + 0.015], s: [W, 2.5, 1], e: [0, 0, Math.PI] })
    floorWashes.push({ p: [cx, FY + 0.45, ZN + WALL_PANEL_DEPTH + 0.015], s: [W, 0.9, 1] })
    // 金属パネルの壁: 奥・外・基地局側の仕切り（ローカル +z が中二階の内側）
    panels.push(...panelItems([0, 0, ZN], 0, x0, x1, FY, H, 4, 3))
    const outerRot = s < 0 ? Math.PI / 2 : -Math.PI / 2
    const range = (rot: number): [number, number] => (rot > 0 ? [-Z0, -ZN] : [ZN, Z0])
    panels.push(...panelItems([s * ROOM.halfWidth, 0, 0], outerRot, ...range(outerRot), FY, H, 3, 3))
    panels.push(...panelItems([s * MEZZANINE.backdropX, 0, 0], -outerRot, ...range(-outerRot), FY, H, 3, 3))
  }

  return group([
    boxInstances({ items: panels, material: mats.wallPanel }),
    boxInstances({ items: dark, material: mats.darkMetal }),
    boxInstances({ items: black, material: mats.blackMetal }),
    boxInstances({ items: glass, material: mats.tintedGlass, renderOrder: 1 }),
    boxInstances({ items: rails, material: mats.steel, geometry: CYLINDER }),
    boxInstances({ items: edges, material: edgeLine, receiveShadow: false }),
    boxInstances({ items: railLines, material: railLine, receiveShadow: false }),
    boxInstances({ items: coves, material: cove, receiveShadow: false }),
    boxInstances({ items: floors, material: floorMat, geometry: PLANE }),
    boxInstances({ items: ceilings, material: ceilingMat, geometry: PLANE }),
    boxInstances({ items: topWashes, material: topWash, geometry: PLANE, receiveShadow: false, renderOrder: 4 }),
    boxInstances({ items: floorWashes, material: floorWash, geometry: PLANE, receiveShadow: false, renderOrder: 4 }),
  ])
}

/** 西の中二階: 仮眠用のソファベッドと、ひらきボードの額 */
function napCorner(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const fabric = new THREE.MeshStandardMaterial({ name: 'sofaFabric', color: '#ffffff', roughness: 0.92, metalness: 0 })
  const frameTex = hirakiBoardFrameTexture()
  const lamp = keep(b, glowMaterial('#dcecff', 1.15))
  const pictureLight = dimmableGlowMaterial('#e6f1ff', 1.5, 0.5)
  const sx = -5.95
  const sz = ZN + 0.52
  // 額の中心
  const fy = FY + 1.6
  const fz = ZN + WALL_PANEL_DEPTH + 0.02
  // サイドテーブルの位置
  const tx = -4.45
  const tz = ZN + 0.42
  const fabricItems: InstanceItem[] = [
    // ソファベッドの台・座面のクッション 2 つ・背もたれ・ひじ掛け
    { p: [sx, FY + 0.15, sz], s: [2.0, 0.3, 0.92], c: '#151a22' },
    { p: [sx - 0.49, FY + 0.37, sz + 0.06], s: [0.96, 0.14, 0.78], c: '#232b37' },
    { p: [sx + 0.49, FY + 0.37, sz + 0.06], s: [0.96, 0.14, 0.78], c: '#212935' },
    { p: [sx, FY + 0.58, ZN + 0.16], s: [2.0, 0.56, 0.2], c: '#1b222c' },
    { p: [sx - 1.07, FY + 0.33, sz], s: [0.14, 0.4, 0.92], c: '#161b23' },
    { p: [sx + 1.07, FY + 0.33, sz], s: [0.14, 0.4, 0.92], c: '#161b23' },
    // たたんだ毛布と枕
    { p: [sx + 0.62, FY + 0.48, sz + 0.08], s: [0.62, 0.08, 0.66], c: '#3e4d63', e: [0, 0.08, 0] },
    { p: [sx - 0.72, FY + 0.53, sz - 0.12], s: [0.46, 0.16, 0.3], c: '#bfc8d3', e: [0, -0.18, 0] },
    // 足もとの小さなラグ
    { p: [sx, FY + 0.006, sz + 1.05], s: [1.7, 0.012, 0.9], c: '#121820' },
  ]
  // 額縁・額を照らす小さな明かりの器具と腕
  const blackBoxes: InstanceItem[] = [
    { p: [sx, fy, fz], s: [0.72, 0.56, 0.04] },
    { p: [sx, fy + 0.36, fz + 0.07], s: [0.4, 0.035, 0.05] },
    { p: [sx, fy + 0.33, fz + 0.02], s: [0.02, 0.06, 0.1] },
  ]
  // サイドテーブル（天板・脚）と、マグカップ
  const blackCylinders: InstanceItem[] = [
    { p: [tx, FY + 0.26, tz], s: [0.22, 0.03, 0.22] },
    { p: [tx, FY + 0.13, tz], s: [0.045, 0.26, 0.045] },
    { p: [tx + 0.1, FY + 0.3, tz + 0.06], s: [0.04, 0.09, 0.04] },
  ]
  return group([
    boxInstances({ items: fabricItems, material: fabric }),
    boxInstances({ items: blackBoxes, material: mats.blackMetal }),
    boxInstances({ items: blackCylinders, material: mats.blackMetal, geometry: CYLINDER }),
    // 小さな明かり（支柱とかさ）
    mesh(new THREE.CylinderGeometry(0.012, 0.03, 0.24, 8), mats.steel, { p: [tx, FY + 0.4, tz] }),
    mesh(LAMP_SHADE, lamp, { p: [tx, FY + 0.56, tz], s: [0.1, 0.12, 0.1] }),
    // ひらきボードの額の中身とガラス、額を照らす明かり
    mesh(new THREE.PlaneGeometry(0.64, 0.48), new THREE.MeshStandardMaterial({ name: 'framedPicture', map: frameTex, roughness: 0.7, metalness: 0 }), { p: [sx, fy, fz + 0.021] }),
    mesh(new THREE.PlaneGeometry(0.64, 0.48), mats.glass, { p: [sx, fy, fz + 0.026] }),
    mesh(new THREE.BoxGeometry(0.34, 0.004, 0.02), pictureLight, { p: [sx, fy + 0.342, fz + 0.08] }),
  ])
}

/** 東の中二階: 資料庫の棚（ファイル・箱・本）と脚立 */
function archiveCorner(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const paper = new THREE.MeshStandardMaterial({ name: 'archivePaper', color: '#ffffff', roughness: 0.8, metalness: 0 })
  const unitXs = [4.35, 5.45, 6.55]
  const UW = 1.0
  const UH = 2.3
  const UD = 0.42
  const zb = ZN + WALL_PANEL_DEPTH + 0.03
  const shelfYs = [0.08, 0.52, 0.96, 1.4, 1.84, UH - 0.03]
  const rnd = mulberry32(1125)
  const frame: InstanceItem[] = []
  const things: InstanceItem[] = []
  const boltPositions: Vec3[] = []
  const palette = ['#1a2433', '#243042', '#2f3b4d', '#5a6575', '#c8d0da', '#1e3a5f', '#2c5d8a', '#0f1620']
  const pick = () => palette[Math.floor(rnd() * palette.length)]
  for (const ux of unitXs) {
    // 側板・背板・棚板
    for (const sgn of [-1, 1]) frame.push({ p: [ux + sgn * (UW / 2 - 0.015), FY + UH / 2, zb + UD / 2], s: [0.03, UH, UD] })
    frame.push({ p: [ux, FY + UH / 2, zb + 0.01], s: [UW, UH, 0.02] })
    for (const y of shelfYs) frame.push({ p: [ux, FY + y, zb + UD / 2], s: [UW - 0.03, 0.025, UD] })
    // 棚の中身: ファイル（背の高い板）・資料の箱・寝かせて積んだ本
    for (let k = 0; k < shelfYs.length - 1; k++) {
      const y0 = FY + shelfYs[k] + 0.0125
      const room = shelfYs[k + 1] - shelfYs[k] - 0.04
      let x = ux - UW / 2 + 0.05
      const end = ux + UW / 2 - 0.05
      while (x < end - 0.05) {
        const kind = rnd()
        if (kind < 0.62) {
          const w = 0.05 + rnd() * 0.035
          const h = Math.min(room, 0.26 + rnd() * 0.08)
          if (x + w > end) break
          things.push({ p: [x + w / 2, y0 + h / 2, zb + 0.21], s: [w - 0.004, h, 0.3], c: pick() })
          x += w
        } else if (kind < 0.85) {
          const w = 0.24 + rnd() * 0.1
          const h = Math.min(room, 0.18 + rnd() * 0.1)
          if (x + w > end) break
          things.push({ p: [x + w / 2 + 0.01, y0 + h / 2, zb + 0.22], s: [w, h, 0.32], c: rnd() < 0.5 ? '#2a3240' : '#3a4352' })
          x += w + 0.03
        } else {
          const w = 0.22
          const n = 2 + Math.floor(rnd() * 3)
          if (x + w > end) break
          for (let j = 0; j < n; j++) things.push({ p: [x + w / 2, y0 + 0.02 + j * 0.04, zb + 0.2], s: [w - j * 0.01, 0.036, 0.26], c: pick(), e: [0, (rnd() - 0.5) * 0.12, 0] })
          x += w + 0.03
        }
        if (rnd() < 0.08) x += 0.08 + rnd() * 0.1
      }
    }
    boltPositions.push([ux - UW / 2 + 0.015, FY + UH - 0.05, zb + UD + 0.002], [ux + UW / 2 - 0.015, FY + UH - 0.05, zb + UD + 0.002])
  }
  // 床に置いた資料の箱
  things.push({ p: [7.35, FY + 0.15, ZN + 0.7], s: [0.42, 0.3, 0.34], c: '#2a3240', e: [0, 0.1, 0] })
  things.push({ p: [7.38, FY + 0.45, ZN + 0.72], s: [0.4, 0.28, 0.32], c: '#3a4352', e: [0, -0.05, 0] })
  things.push({ p: [7.3, FY + 0.15, ZN + 1.18], s: [0.4, 0.3, 0.34], c: '#2a3240', e: [0, -0.2, 0] })
  // 棚に立てかけた脚立（上の段を取る）。少し後ろへ傾ける
  const lean = -0.22
  const lx = 7.15
  const lz = zb + UD + 0.32
  const at = (y: number): [number, number] => [FY + y * Math.cos(lean), lz + y * Math.sin(lean)]
  const ladder: InstanceItem[] = [
    ...[-0.2, 0.2].map((x): InstanceItem => {
      const [y, z] = at(0.95)
      return { p: [lx + x, y, z], s: [0.035, 1.9, 0.05], e: [lean, 0, 0] }
    }),
    ...[0.3, 0.7, 1.1, 1.5].map((h): InstanceItem => {
      const [y, z] = at(h)
      return { p: [lx, y, z], s: [0.4, 0.025, 0.08], e: [lean, 0, 0] }
    }),
  ]
  return group([
    boxInstances({ items: frame, material: mats.blackMetal }),
    boxInstances({ items: things, material: paper }),
    boxInstances({ items: ladder, material: mats.steel }),
    bolts({ positions: boltPositions, axis: 'z', radius: 0.01 }, mats),
    // 棚の札
    sticker({ text: 'ARCHIVE', sub: '資料庫 // 2011–', position: [unitXs[0], FY + UH + 0.14, zb + 0.02], width: 0.5, aspect: 3.4, background: '#0a0f15', color: '#9fb4c8' }),
  ])
}

/**
 * 中二階への階段（資料: 西の奥、x -8.4〜-7.4・z -0.26〜2.34 の町の座標 = シーンの z 0.26〜-2.34）。
 * 南の端（1 階の床）から北の壁の線（中二階の床 3.0m）へ上がる急な鉄骨の階段（ささら桁 2 本・パンチングの踏み板・東の手すりと西の壁の手すり）。
 * 花音は上らない（通り道の障害物。plan.ts の SHELL_OBSTACLES）
 */
function mezzanineStair(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const tread = perforated(b, 3, 1)
  const nosing = dimmableGlowMaterial(PALETTE.cyan, 1.6, 0.3)
  const xw = STAIR.min[0] + 0.03 // 西のささら桁（壁の面から少し離す）
  const xe = STAIR.max[0] - 0.04 // 東のささら桁
  const zBottom = STAIR.max[1]
  const zTop = Z0
  const run = zBottom - zTop
  const n = Math.round(FY / 0.2) // 蹴上げ 0.2m
  const len = Math.hypot(run, FY)
  const ang = Math.atan2(FY, run)
  const along = (t: number, up = 0): [number, number] => [up + FY * t, zBottom - run * t]
  const steel: InstanceItem[] = []
  const treads: InstanceItem[] = []
  const lines: InstanceItem[] = []
  // ささら桁（溝形鋼。踏み板の下の線に沿って）
  for (const x of [xw, xe]) {
    const [y, z] = along(0.5, -0.05)
    steel.push({ p: [x, y, z], s: [0.05, 0.22, len + 0.1], e: [ang, 0, 0] })
  }
  // 踏み板（いちばん上の段は中二階の床）と、東の端の光る段鼻
  for (let i = 1; i < n; i++) {
    const [y, z] = along(i / n)
    treads.push({ p: [(xw + xe) / 2, y - 0.015, z - run / n / 2 + 0.02], s: [xe - xw - 0.05, 0.03, run / n + 0.06] })
    lines.push({ p: [(xw + xe) / 2, y + 0.002, z + 0.04], s: [xe - xw - 0.08, 0.006, 0.012] })
  }
  // 東の手すり（下・中・上の支柱と、段鼻の線から 0.9m の手すり）と、西の壁の手すり
  for (const t of [0.04, 0.5, 0.96]) {
    const [y, z] = along(t)
    steel.push({ p: [xe, y + 0.45, z], s: [0.035, 0.9, 0.035] })
  }
  for (const [x, up] of [
    [xe, 0.92],
    [xw + 0.02, 0.86],
  ] as const) {
    const [y, z] = along(0.5, up)
    steel.push({ p: [x, y, z], s: [0.04, 0.04, len + 0.25], e: [ang, 0, 0] })
  }
  return group([
    boxInstances({ items: steel, material: mats.blackMetal, castShadow: true }),
    boxInstances({ items: treads, material: tread, castShadow: true }),
    boxInstances({ items: lines, material: nosing, receiveShadow: false }),
  ])
}

/** 中二階（前の zones/Mezzanine.tsx の Mezzanine） */
export function buildMezzanine(b: ShellBuild): THREE.Group {
  for (const g of [PLANE, CYLINDER, LAMP_SHADE]) keep(b, g)
  return group([mezzanineShell(b), mezzanineStair(b), napCorner(b), archiveCorner(b)])
}
