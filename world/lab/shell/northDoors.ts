import * as THREE from 'three'
import { PALETTE } from '../../palette'
import { dimmableGlowMaterial } from '../../labLight'
import { boxInstances, sticker, type InstanceItem } from '../parts/details'
import { group } from '../parts/object'
import { NORTH_DOOR_HEIGHT, NORTH_DOORS, ROOM, WALL_PANEL_DEPTH } from '../../../core/lab/plan'
import { keep, wallWash, type ShellBuild } from './build'

/**
 * 北の壁の下の段の、北側の部屋への扉（西から 電源室・冷却機械室・給湯室と WC の前室・資料庫。設定資料の間取りの順。
 * docs/design/map-split.md §6 の「段 4」・4-4。前の zones/NorthDoors.tsx）。
 * 扉の上に小さな表示板（Canvas のラベル）、その上にシアンの細い LED、縦枠の正面にブルーの細い光。
 * 扉の下の方には、床際の LED の光のにじみを壁と同じように貼る。部屋の中は作らない（扉は閉じている）。
 * 同じ材質の部品は扉 4 枚ぶんをまとめて 1 回で描く。ワールド座標で置く（北の壁の面は z = ROOM.north）。
 */

const Z = ROOM.north
const DH = NORTH_DOOR_HEIGHT
/** 扉の枠の見付（幅）と、壁からの出っ張り */
const FRAME = 0.06
const FRAME_D = 0.1
/** 扉の板の厚みと、板の中心の壁からの距離（壁のパネルより手前） */
const LEAF_T = 0.045
const LEAF_Z = Z + 0.06
const LEAF_FRONT = LEAF_Z + LEAF_T / 2

/** 扉ごとの小さな違い（窓の有無・注意書き） */
const DOOR_KIND: Record<(typeof NORTH_DOORS)[number]['name'], { window: boolean; caution?: string }> = {
  電源室: { window: false, caution: 'HIGH VOLTAGE' },
  冷却機械室: { window: false, caution: 'NOISE // COOLANT' },
  '給湯室・WC': { window: true },
  資料庫: { window: true },
}

/** レバーハンドルとにじみの単位の形（モジュールに 1 つ。dispose で捨てない） */
const CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 10)
const PLANE = new THREE.PlaneGeometry(1, 1)

export function buildNorthDoors(b: ShellBuild): THREE.Group {
  const mats = b.mats
  keep(b, CYLINDER)
  keep(b, PLANE)
  const wash = wallWash(b)
  // 扉の上の LED と縦枠の細い光は、部屋の LED と一緒に配信中は落とす
  const led = dimmableGlowMaterial(PALETTE.cyan, 2.2, 0.2)
  const jambLine = dimmableGlowMaterial(PALETTE.blue, 1.8, 0.3)
  const visionGlass = new THREE.MeshStandardMaterial({ name: 'visionGlass', color: '#06090d', metalness: 0.3, roughness: 0.08 })

  const frames: InstanceItem[] = []
  const leaves: InstanceItem[] = []
  const steel: InstanceItem[] = []
  const levers: InstanceItem[] = []
  const windows: InstanceItem[] = []
  const jambs: InstanceItem[] = []
  const leds: InstanceItem[] = []
  const washes: InstanceItem[] = []
  for (const d of NORTH_DOORS) {
    const w = d.width
    const x = d.x
    // 枠（左右の縦枠と上枠）と、縦枠の正面の細い光
    for (const s of [-1, 1]) {
      frames.push({ p: [x + s * (w / 2 + FRAME / 2), (DH + FRAME) / 2, Z + FRAME_D / 2], s: [FRAME, DH + FRAME, FRAME_D] })
      jambs.push({ p: [x + s * (w / 2 + FRAME / 2), DH / 2, Z + FRAME_D + 0.002], s: [0.008, DH - 0.1, 0.004] })
    }
    frames.push({ p: [x, DH + FRAME / 2, Z + FRAME_D / 2], s: [w + FRAME * 2, FRAME, FRAME_D] })
    // 扉の板（床から少し浮かせる。床際の LED の光が下からもれる）
    leaves.push({ p: [x, (DH + 0.02) / 2, LEAF_Z], s: [w - 0.01, DH - 0.02, LEAF_T] })
    // 蹴込みの板とレバーハンドルの座
    steel.push({ p: [x, 0.16, LEAF_FRONT + 0.002], s: [w - 0.08, 0.24, 0.004] })
    steel.push({ p: [x + w / 2 - 0.09, 1.02, LEAF_FRONT + 0.012], s: [0.05, 0.11, 0.024] })
    levers.push({ p: [x + w / 2 - 0.15, 1.04, LEAF_FRONT + 0.04], s: [0.011, 0.13, 0.011], e: [0, 0, Math.PI / 2] })
    // 細い縦の窓（給湯室・WC の前室・資料庫）
    if (DOOR_KIND[d.name].window) windows.push({ p: [x - w / 2 + 0.18, 1.45, LEAF_FRONT + 0.002], s: [0.12, 0.62, 0.004] })
    // 床際の LED の光のにじみ（壁と同じ）と、表示板の上の LED
    washes.push({ p: [x, 0.65, LEAF_FRONT + 0.004], s: [w, 1.3, 1] })
    leds.push({ p: [x, DH + 0.3, Z + WALL_PANEL_DEPTH + 0.02], s: [0.42, 0.01, 0.01] })
  }

  return group([
    boxInstances({ items: frames, material: mats.blackMetal, castShadow: true }),
    boxInstances({ items: leaves, material: mats.darkMetal, castShadow: true }),
    boxInstances({ items: steel, material: mats.steel }),
    boxInstances({ items: levers, material: mats.chrome, geometry: CYLINDER }),
    boxInstances({ items: windows, material: visionGlass }),
    boxInstances({ items: jambs, material: jambLine, receiveShadow: false }),
    boxInstances({ items: leds, material: led, receiveShadow: false }),
    boxInstances({ items: washes, material: wash, geometry: PLANE, receiveShadow: false, renderOrder: 4 }),
    ...NORTH_DOORS.map((d) => {
      const caution = DOOR_KIND[d.name].caution
      return group([
        // 表示板（部屋の名前と英語の小さな字）
        sticker({
          text: d.name,
          sub: d.en,
          position: [d.x, DH + 0.19, Z + WALL_PANEL_DEPTH + 0.02],
          width: 0.42,
          aspect: 3.2,
          background: '#0a0f15',
          color: '#cfe6f5',
          font: 'jp',
          radius: 0.12,
          glow: 0.85,
        }),
        // 注意書き（電源室・冷却機械室。小さなアンバーの札）
        ...(caution
          ? [sticker({ text: 'CAUTION', sub: caution, position: [d.x, 1.5, LEAF_FRONT + 0.003], width: 0.26, aspect: 2.4, background: '#c98a2e', color: '#14100a' })]
          : []),
      ])
    }),
  ])
}
