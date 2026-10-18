import * as THREE from 'three'
import { LAB_OUTLINE } from '../../../core/labPlan'
import { PALETTE } from '../../palette'
import { dimmableGlowMaterial } from '../../labLight'
import { glowMaterial } from '../../materials/labMaterials'
import { bousaiFudaTexture, hirakiFudaTexture, WAKABA } from '../../textures/signs'
import { townDoorOpeners, townFocus, townOptions } from '../../townHost'
import { bolts, boxInstances, sticker, type InstanceItem } from '../parts/details'
import { group, mesh } from '../parts/object'
import { ENTRANCE, ENTRANCE_DOOR, ROOM, WALL_PANEL_DEPTH, type Vec3 } from '../../../core/lab/plan'
import { keep, type ShellBuild } from './build'
import { DOOR_CENTER, doorAngle, entranceDoor, stepEntranceDoor } from './entranceDoor'
import { markDynamic } from '../../staticMerge'

/**
 * 南西の角の見学エントランス（設定資料: 南の面の西端、入口の扉の横に若葉色の琺瑯の「ひらき札」（第二種））と、
 * その横の西の壁の南端の通用口（資料: 西向き。花音がふだん出入りする扉。vol2 4章A）。docs/design/map-split.md §6 の「段 4」・4-4。前の zones/Entrance.tsx。
 * 南の面は西の角から 角の柱（ひらき札はこの柱の外の面）→ ガラスの両開きの扉。ガラスの扉は南のガラス壁の中にある
 * （ガラス・方立て・欄間は room.ts の southWall）。ワールド座標で置く（南の壁の面は z = ROOM.south、部屋の内側は -z）。
 * 通用口は西の壁（x = -ROOM.halfWidth）の壁ローカル座標（x = 壁に沿って北へ、z = 部屋の内側）で置く。
 *
 * ひらき札は光らない琺瑯の札（つやのある PBR。庇の下のスポットで見える）。下に小さな橙色の防災札。
 */

const Z = ROOM.south
/** 壁から部屋側へのずれ（-z が部屋の内側） */
const inward = (d: number) => Z - d
/** 南の壁に貼る物は、部屋の内側（-z）を向ける */
const FACE_IN: Vec3 = [0, Math.PI, 0]
/** 取っ手・レバーの単位の形（モジュールに 1 つ。dispose で捨てない） */
const CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 10)
/**
 * 建物の外形の外の面: 東西の外の面（|x|）と、南のガラスの外の額縁の外の面（z）。町の敷地の殻（core/site.ts の SHELL.outerX・portalZ）と
 * 同じ値を、同じ式で設定資料の外形（core/labPlan.ts）から出す（地図の側のラボは core/site.ts を読まない。lighting/lightTable.ts と同じ）
 */
const OUTER_X = LAB_OUTLINE[2]
const PORTAL_Z = -LAB_OUTLINE[1]

/** 通用口の中心（西の壁の上の z）と幅。壁ローカルの x は北へ */
const STAFF = { z: (ENTRANCE.staffDoor.z[0] + ENTRANCE.staffDoor.z[1]) / 2, w: ENTRANCE.staffDoor.z[1] - ENTRANCE.staffDoor.z[0] }

/**
 * 通用口（スタッフ用の鉄の扉。西の壁）とガラスの両開きの扉（見学エントランス）の枠・板・取っ手。
 * 同じ材質の部品はまとめて 1 回で描く
 */
function doors(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const visionGlass = new THREE.MeshStandardMaterial({ name: 'visionGlass', color: '#06090d', metalness: 0.3, roughness: 0.08 })
  const jambLine = dimmableGlowMaterial(PALETTE.blue, 1.8, 0.3)
  const black: InstanceItem[] = []
  const staffBlack: InstanceItem[] = []
  const staffDark: InstanceItem[] = []
  const staffSteel: InstanceItem[] = []
  const staffChrome: InstanceItem[] = []
  const staffVision: InstanceItem[] = []
  const staffJambs: InstanceItem[] = []
  // 通用口（西の壁の壁ローカル座標: x = 北へ、z = 部屋の内側。扉の中心が原点）: 枠・扉の板・縦の細い窓・蹴込みの板・レバーハンドル（北の側）
  {
    const w = STAFF.w
    const [a, bb] = [-w / 2, w / 2]
    const DH = ENTRANCE.staffDoorHeight
    const leafZ = 0.06
    for (const x of [a + 0.03, bb - 0.03]) {
      staffBlack.push({ p: [x, (DH + 0.06) / 2, 0.05], s: [0.06, DH + 0.06, 0.1] })
      // 縦枠の正面の細い光（北の部屋の扉と同じ）
      staffJambs.push({ p: [x, DH / 2, 0.102], s: [0.008, DH - 0.1, 0.004] })
    }
    staffBlack.push({ p: [0, DH + 0.03, 0.05], s: [w, 0.06, 0.1] })
    staffDark.push({ p: [0, (DH + 0.02) / 2, leafZ], s: [w - 0.13, DH - 0.02, 0.045] })
    staffVision.push({ p: [-0.12, 1.45, leafZ + 0.025], s: [0.12, 0.6, 0.004] })
    staffSteel.push({ p: [0, 0.16, leafZ + 0.025], s: [w - 0.2, 0.24, 0.004] })
    staffSteel.push({ p: [bb - 0.16, 1.02, leafZ + 0.035], s: [0.05, 0.11, 0.024] })
    staffChrome.push({ p: [bb - 0.22, 1.04, leafZ + 0.063], s: [0.011, 0.13, 0.011], e: [0, 0, Math.PI / 2] })
  }
  // ガラスの両開きの扉の上の自動扉の開閉装置（欄間の下の黒い箱）
  {
    const [a, bb] = ENTRANCE.glassDoor
    black.push({ p: [(a + bb) / 2, ENTRANCE.doorHeight + 0.05, inward(0.11)], s: [bb - a - 0.1, 0.1, 0.12] })
  }
  return group([
    boxInstances({ items: black, material: mats.blackMetal, castShadow: true }),
    // 通用口（西の壁）
    group(
      [
        boxInstances({ items: staffBlack, material: mats.blackMetal, castShadow: true }),
        boxInstances({ items: staffDark, material: mats.darkMetal, castShadow: true }),
        boxInstances({ items: staffSteel, material: mats.steel }),
        boxInstances({ items: staffChrome, material: mats.chrome, geometry: CYLINDER }),
        boxInstances({ items: staffVision, material: visionGlass }),
        boxInstances({ items: staffJambs, material: jambLine, receiveShadow: false }),
        sticker({
          text: '通用口',
          sub: 'STAFF ONLY',
          position: [0, ENTRANCE.staffDoorHeight + 0.24, WALL_PANEL_DEPTH + 0.02],
          width: 0.42,
          aspect: 3.2,
          background: '#0a0f15',
          color: '#cfe6f5',
          font: 'jp',
          radius: 0.12,
          glow: 0.85,
        }),
        cardReader(b),
      ],
      { p: [-ROOM.halfWidth, 0, STAFF.z], ry: Math.PI / 2 },
    ),
    // 表示板: 欄間のガラスの見学エントランスの表示
    sticker({
      text: '見学エントランス',
      sub: 'VISITOR ENTRANCE // ひらき 第二種',
      position: [(ENTRANCE.glassDoor[0] + ENTRANCE.glassDoor[1]) / 2, ENTRANCE.transoms[0] + 0.24, inward(0.02)],
      rotation: FACE_IN,
      width: 0.95,
      aspect: 4.2,
      background: 'transparent',
      color: '#d6e4f0',
      font: 'jp',
    }),
    // 扉の内側の玄関マット
    mesh(new THREE.BoxGeometry(1.6, 0.012, 0.95), new THREE.MeshStandardMaterial({ name: 'doorMat', color: '#0b0e12', roughness: 0.95, metalness: 0 }), {
      p: [(ENTRANCE.glassDoor[0] + ENTRANCE.glassDoor[1]) / 2, 0.006, inward(0.75)],
    }),
  ])
}

/**
 * ガラスの両開きの扉（自動の開き戸。外開き）。扉ごとに吊り元（外側の縦枠）を軸にした組で、entranceDoor.open で外（テラスの側）へ開く。
 * 形は前のまま: ガラス・框（縦・上・下）・縦の取っ手（部屋の側）。外の側にも取っ手を付けた
 */
function glassDoors(b: ShellBuild): { object: THREE.Group; update(dt: number): void } {
  const mats = b.mats
  const [a, bb] = ENTRANCE.glassDoor
  const DH = ENTRANCE.doorHeight
  const leafW = (bb - a) / 2 - 0.04
  const parts = [-1, 1].map((s) => {
    // s = -1 が西の扉（吊り元は西の縦枠）、1 が東の扉（吊り元は東の縦枠）。扉の組の原点は吊り元、ローカル x は合わせ目の向き
    const hinge = s < 0 ? a + 0.03 : bb - 0.03
    const dir = -s
    const cx = (leafW / 2 + 0.01) * dir
    const meet = (leafW + 0.005) * dir
    const black: InstanceItem[] = []
    const glass: InstanceItem[] = [{ p: [cx, DH / 2, 0], s: [leafW - 0.06, DH - 0.14, 0.012] }]
    const chrome: InstanceItem[] = []
    for (const x of [cx - leafW / 2 + 0.025, cx + leafW / 2 - 0.025]) black.push({ p: [x, DH / 2, 0], s: [0.05, DH, 0.05] })
    black.push({ p: [cx, DH - 0.035, 0], s: [leafW, 0.07, 0.05] })
    black.push({ p: [cx, 0.06, 0], s: [leafW, 0.12, 0.05] })
    for (const side of [-1, 1]) {
      // 縦の取っ手（side = -1 が部屋の側、1 が外の側）
      const hx = meet - dir * 0.095
      chrome.push({ p: [hx, 1.1, side * 0.07], s: [0.014, 1.0, 0.014] })
      for (const y of [0.65, 1.55]) chrome.push({ p: [hx, y, side * 0.045], s: [0.008, 0.05, 0.008], e: [Math.PI / 2, 0, 0] })
    }
    return { hinge, dir, black, glass, chrome }
  })
  const z = inward(0.06)
  const leaves = parts.map((p) =>
    group(
      [
        boxInstances({ items: p.black, material: mats.blackMetal, castShadow: true }),
        boxInstances({ items: p.chrome, material: mats.chrome, geometry: CYLINDER }),
        boxInstances({ items: p.glass, material: mats.tintedGlass, renderOrder: 1 }),
      ],
      { p: [p.hinge, 0, z] },
    ),
  )
  // 開け閉めする扉の板（動く物）
  markDynamic(...leaves)
  return {
    object: group(leaves),
    update(delta) {
      // 注目点（花音）はセンサーの距離、扉を開ける物（townDoorOpeners。付いて浮かぶロボットなど）はその 3/4 の距離まで来たら開く
      const k = townFocus().position
      let near = Math.hypot(k.x - DOOR_CENTER.x, k.z - DOOR_CENTER.z) < ENTRANCE_DOOR.sensor
      const openers = townDoorOpeners()
      for (let i = 0; i < openers.length && !near; i++) {
        const p = openers[i].position
        near = Math.hypot(p.x - DOOR_CENTER.x, p.z - DOOR_CENTER.z) < ENTRANCE_DOOR.sensor * 0.75
      }
      stepEntranceDoor(near, townOptions().clock.sceneTime(), Math.min(delta, 0.1))
      const ang = doorAngle(entranceDoor.open)
      leaves.forEach((g, i) => {
        // 外（+z）へ開く: 西の扉は y 軸まわりに -、東の扉は +
        g.rotation.y = parts[i].dir > 0 ? -ang : ang
      })
    },
  }
}

/** ひらき札（若葉色の琺瑯）と、その下の防災札。南西の角の柱の外の面（建物の外、z = PORTAL_Z）の中央に掛け、外（+z）を向く */
function hirakiFuda(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const cx = (-OUTER_X + ENTRANCE.pier[1]) / 2
  const fuda = hirakiFudaTexture()
  const bousai = bousaiFudaTexture()
  // 琺瑯: つやのある焼き付けのガラス質。光らない（emissive なし）
  const enamel = new THREE.MeshPhysicalMaterial({ name: 'enamelSign', map: fuda, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, transparent: true, alphaTest: 0.5 })
  const bousaiMat = new THREE.MeshPhysicalMaterial({ name: 'enamelSign', map: bousai, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, transparent: true, alphaTest: 0.5 })
  const back = new THREE.MeshStandardMaterial({ name: 'signBacking', color: new THREE.Color(WAKABA).multiplyScalar(0.55), roughness: 0.5 })
  const W = 0.3
  const HGT = 0.4
  const y = 1.62
  // 外の面から少し外へ（外は +z）
  const z = PORTAL_Z + 0.012
  const screws: Vec3[] = [
    [cx - W / 2 + 0.03, y + HGT / 2 - 0.03, z + 0.008],
    [cx + W / 2 - 0.03, y + HGT / 2 - 0.03, z + 0.008],
    [cx - W / 2 + 0.03, y - HGT / 2 + 0.03, z + 0.008],
    [cx + W / 2 - 0.03, y - HGT / 2 + 0.03, z + 0.008],
  ]
  return group([
    mesh(new THREE.BoxGeometry(W - 0.03, HGT - 0.03, 0.008), back, { p: [cx, y, z - 0.004] }),
    mesh(new THREE.PlaneGeometry(W, HGT), enamel, { p: [cx, y, z + 0.001] }),
    bolts({ positions: screws, axis: 'z', radius: 0.008 }, mats),
    // 防災札（ひらき札の下に掛ける。小さな鎖の代わりに 2 本の細い金具）
    ...[-0.07, 0.07].map((dx) => mesh(new THREE.BoxGeometry(0.006, 0.05, 0.006), mats.steel, { p: [cx + dx, y - HGT / 2 - 0.03, z] })),
    mesh(new THREE.PlaneGeometry(0.24, 0.08), bousaiMat, { p: [cx, y - HGT / 2 - 0.1, z + 0.002] }),
  ])
}

/** カードリーダー（通用口の南の脇の壁。通用口の壁ローカル座標） */
function cardReader(b: ShellBuild): THREE.Group {
  const mats = b.mats
  const led = keep(b, glowMaterial(PALETTE.cyan, 1.6))
  return group(
    [
      mesh(new THREE.BoxGeometry(0.08, 0.13, 0.025), mats.screenOff),
      mesh(new THREE.BoxGeometry(0.04, 0.006, 0.002), led, { p: [0, 0.035, 0.0135] }),
    ],
    { p: [-STAFF.w / 2 - 0.16, 1.18, WALL_PANEL_DEPTH + 0.018] },
  )
}

/** 見学エントランスと通用口（前の zones/Entrance.tsx の Entrance）。update はガラスの扉を進める（毎コマ。KB-001 の更新より前） */
export function buildEntrance(b: ShellBuild): { object: THREE.Group; update(dt: number): void } {
  keep(b, CYLINDER)
  const doorsGroup = doors(b)
  const glass = glassDoors(b)
  const object = group([
    doorsGroup,
    glass.object,
    hirakiFuda(b),
    // 地名のサイン（見学エントランスの扉の上の欄間のガラス）
    sticker({
      text: 'SAKURAGI-OKA',
      position: [(ENTRANCE.glassDoor[0] + ENTRANCE.glassDoor[1]) / 2, 3.35, inward(0.03)],
      rotation: FACE_IN,
      width: 1.45,
      aspect: 3.2,
      background: 'transparent',
      color: '#bfefff',
      glow: 1.8,
    }),
  ])
  return { object, update: glass.update }
}
