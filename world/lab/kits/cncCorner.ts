import * as THREE from 'three'
import { GLOW, PALETTE } from '../../palette'
import { glowMaterial } from '../../materials/labMaterials'
import { drawMachineScreen } from '../../textures/screens'
import { createOwned, type LabKitBody, type LabKitContext, type LabKitDef } from '../kit'
import { bolts, matrixInstances, sticker } from '../parts/details'
import { boltGrid } from '../parts/geometry'
import { group, mesh, type MeshOptions } from '../parts/object'
import { WALL_PANEL_DEPTH, type Placement, type Vec3 } from '../../../core/lab/plan'
import { cncCornerPlan, PARTS_CABINET_X } from '../../../core/lab/kits/cncCorner.plan'
import { markDynamic } from '../../staticMerge'

/**
 * CNC の隅（工作ゾーンの北の壁沿いの置き場所 workshopNorth。階段と電源室の扉の間）: CNC（ローカル x -0.5）・パーツケースと下の低いキャビネット（0.5）。
 * ローカル座標: z = 0 が壁の面、+z が部屋の内側。
 *
 * 前の zones/Workshop.tsx の CNC・PartsCabinet と置き場所の群を、同じ入れ子・同じ子の順・同じ作る順（部品ごとに hooks の素材と画面 →
 * JSX の子の順。子を作ってから群）・手で書いた数と式のまま three の形にした物（docs/design/map-split.md §6 の「段 4」・4-7）。
 * 寸法・アンカー・障害物はデータの側（cncCorner.plan.ts）。キットの object は置き場所の群（位置と向き）。
 *
 * - screens: cnc（CNC の操作パネル。192×128・毎秒 4 回）。中身は地図の側の飾りの画面（textures/screens.ts）
 * - 毎コマ（前の購読の順）: CNC の画面 → スピンドル
 */

export function createCncCorner(at: Placement, _opts: object | undefined, ctx: LabKitContext): LabKitBody {
  const mats = ctx.materials
  const own = createOwned()
  const m = (geometry: THREE.BufferGeometry, material: THREE.Material, o?: MeshOptions) => mesh(own.add(geometry), material, o)
  const z0 = WALL_PANEL_DEPTH

  /* ---- CNC ---- */
  const cnc = (position: Vec3) => {
    const screen = own.add(ctx.screens('cnc', 192, 128, drawMachineScreen('CNC-01', 'ear-housing v7'), 4))
    const W = 1.0
    const D = 0.8
    const BASE = 0.82
    const ENC = 0.72
    // 前の JSX の値で、部品を作る前に引いていた発光の素材（庫内照明・スピンドルの輪・表示灯）
    const innerLight = glowMaterial('#eaf4ff', GLOW.strip)
    const spindleRing = glowMaterial(PALETTE.cyan, GLOW.strip)
    const lamp = glowMaterial(PALETTE.cyan, GLOW.strong)
    const screenMat = () =>
      own.add(new THREE.MeshStandardMaterial({ name: 'cncScreen', color: '#000', emissive: '#fff', emissiveMap: screen.texture, emissiveIntensity: 1.1, toneMapped: false }))

    const base = m(new THREE.BoxGeometry(W, BASE, D), mats.darkMetal, { p: [0, BASE / 2, D / 2], cast: true, receive: true })
    const baseBolts = bolts({ positions: boltGrid([0, BASE / 2, D + 0.002], W - 0.08, BASE - 0.08, 'xy', 3, 3), axis: 'z', radius: 0.01 }, mats)
    own.add(baseBolts.geometry)
    own.add(baseBolts)
    // 筐体・前面の窓・ベッドと材料・スピンドル
    const body: THREE.Object3D[] = [
      m(new THREE.BoxGeometry(W, 0.04, D), mats.whitePaint, { p: [0, ENC - 0.02, 0], cast: true }),
      ...[-1, 1].map((s) => m(new THREE.BoxGeometry(0.04, ENC, D), mats.whitePaint, { p: [s * (W / 2 - 0.02), ENC / 2, 0], cast: true, receive: true })),
      m(new THREE.BoxGeometry(W, ENC, 0.04), mats.whitePaint, { p: [0, ENC / 2, -D / 2 + 0.02] }),
      // 前面の窓
      m(new THREE.PlaneGeometry(W - 0.08, ENC - 0.06), mats.tintedGlass, { p: [0, ENC / 2, D / 2], order: 2 }),
      m(new THREE.BoxGeometry(W - 0.12, 0.008, 0.01), innerLight, { p: [0, ENC - 0.06, D / 2 - 0.03] }),
      // ベッド・材料
      m(new THREE.BoxGeometry(W - 0.1, 0.06, D - 0.12), mats.steel, { p: [0, 0.03, 0], receive: true }),
      m(new THREE.BoxGeometry(0.3, 0.06, 0.2), mats.aluminium, { p: [0.05, 0.09, 0], cast: true, receive: true }),
      // スピンドル
      m(new THREE.CylinderGeometry(0.012, 0.012, W - 0.08, 8), mats.chrome, { p: [0, 0.55, 0], r: [0, 0, Math.PI / 2] }),
    ]
    const spindle = group(
      [
        m(new THREE.CylinderGeometry(0.045, 0.045, 0.18, 24), mats.darkMetal, { cast: true }),
        m(new THREE.TorusGeometry(0.046, 0.004, 6, 24), spindleRing, { p: [0, 0.06, 0], r: [Math.PI / 2, 0, 0] }),
        m(new THREE.CylinderGeometry(0.004, 0.003, 0.1, 6), mats.chrome, { p: [0, -0.14, 0] }),
      ],
      { p: [0, 0.4, 0] },
    )
    const bit = spindle.children[2]!
    markDynamic(spindle, bit)
    body.push(spindle)
    const object = group(
      [
        base,
        baseBolts,
        group(body, { p: [0, BASE, D / 2] }),
        // 操作パネル
        group(
          [
            m(new THREE.BoxGeometry(0.24, 0.18, 0.04), mats.plasticDark, { cast: true }),
            m(new THREE.PlaneGeometry(0.2, 0.13), screenMat(), { p: [0, 0.01, 0.021] }),
            m(new THREE.BoxGeometry(0.02, 0.3, 0.02), mats.steel, { p: [-0.1, -0.2, -0.02] }),
          ],
          { p: [W / 2 + 0.12, BASE + 0.35, D - 0.1], ry: -0.5 },
        ),
        // 表示灯
        group(
          [
            m(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 8), mats.steel, { p: [0, 0.05, 0] }),
            m(new THREE.CylinderGeometry(0.025, 0.025, 0.04, 16), lamp, { p: [0, 0.12, 0] }),
            m(new THREE.CylinderGeometry(0.025, 0.025, 0.04, 16), mats.plasticGrey, { p: [0, 0.165, 0] }),
          ],
          { p: [-W / 2 + 0.06, BASE + ENC, D - 0.1] },
        ),
        own.mesh(sticker({ text: 'CAUTION', sub: 'ROTATING TOOL', position: [0.3, BASE - 0.15, D + 0.003], width: 0.2, aspect: 2.4, background: '#e9edf1', color: '#0b1522' })),
      ],
      { p: position },
    )
    return {
      object,
      screen,
      update(t: number) {
        spindle.position.x = Math.sin(t * 0.5) * 0.22
        spindle.position.z = Math.cos(t * 0.37) * 0.12
        bit.rotation.y = t * 40
      },
    }
  }

  /* ---- パーツケース ---- */
  const partsCabinet = (position: Vec3): THREE.Group => {
    const cols = 6
    const rows = 5
    const dw = 0.15
    const dh = 0.1
    const drawers: THREE.Matrix4[] = []
    const labels: THREE.Matrix4[] = []
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const x = (c - (cols - 1) / 2) * dw
        const y = (r - (rows - 1) / 2) * dh
        const pull = (c * 3 + r * 5) % 7 === 0 ? 0.04 : 0
        drawers.push(new THREE.Matrix4().makeTranslation(x, y, 0.1 + pull))
        labels.push(new THREE.Matrix4().makeTranslation(x, y + 0.02, 0.201 + pull))
      }
    }
    const drawerGeom = own.add(new THREE.BoxGeometry(dw - 0.012, dh - 0.012, 0.2))
    const labelGeom = own.add(new THREE.PlaneGeometry(0.08, 0.02))
    const drawerMat = own.add(new THREE.MeshPhysicalMaterial({ name: 'drawerAcrylic', color: '#8fb7d6', roughness: 0.25, transmission: 0, transparent: true, opacity: 0.55, metalness: 0 }))
    const labelMat = own.add(new THREE.MeshStandardMaterial({ name: 'drawerLabel', color: '#e7ecf1', roughness: 0.7 }))
    return group(
      [
        m(new THREE.BoxGeometry(cols * dw + 0.04, rows * dh + 0.04, 0.2), mats.darkMetal, { p: [0, 0, 0.1], cast: true, receive: true }),
        own.add(matrixInstances({ matrices: drawers, geometry: drawerGeom, material: drawerMat })),
        own.add(matrixInstances({ matrices: labels, geometry: labelGeom, material: labelMat })),
      ],
      { p: position },
    )
  }

  // 作る順は前の JSX のまま（置き場所の群の中: CNC・パーツケース・下の低いキャビネット）
  const machine = cnc([-0.5, 0, z0])
  const cabinet = partsCabinet([PARTS_CABINET_X, 1.45, z0])
  const lower = m(new THREE.BoxGeometry(0.9, 0.9, 0.6), mats.darkMetal, { p: [PARTS_CABINET_X, 0.45, z0 + 0.3], cast: true, receive: true })
  const object = group([machine.object, cabinet, lower], { p: at.position, ry: at.rotationY })

  return {
    object,
    update(dt, f) {
      // 前の購読の順: CNC の画面 → スピンドル
      machine.screen.update(dt, f.camera)
      machine.update(f.time)
    },
    screens: { cnc: machine.screen },
    dispose: () => own.dispose(),
  }
}

export const cncCornerKit: LabKitDef = {
  kind: 'cncCorner',
  plan: cncCornerPlan,
  create: createCncCorner,
}
