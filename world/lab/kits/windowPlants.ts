import * as THREE from 'three'
import { mulberry32 } from '../../../core/random'
import { createOwned, type LabKitBody, type LabKitContext, type LabKitDef } from '../kit'
import { boxInstances, type InstanceItem } from '../parts/details'
import { group } from '../parts/object'
import { WINDOW_PLANTS, type Placement } from '../../../core/lab/plan'
import { windowPlantsPlan, type WindowPlantsOpts } from '../../../core/lab/kits/windowPlants.plan'

/**
 * 窓際の観葉植物 4 鉢（設定資料: 窓際に観葉植物 4 鉢。見学ルートの最後に夜景を見る所）。
 * 南のガラス壁の前に、黒い陶器の鉢と、広い葉の観葉植物（茎と、平たい楕円の葉）。窓から町を見る線より低く（高さ 1.3m まで）。
 * 同じ材質の部品は 4 鉢まとめて 1 回で描く。置き場所は原点で、鉢の位置は opts（既定は plan.ts の WINDOW_PLANTS。ワールド座標）。
 *
 * 前の zones/WindowPlants.tsx を、同じ入れ子・同じ子の順・同じ作る順で three の形にした物（docs/design/map-split.md §6 の「段 4」・4-5）。
 * 障害物とアンカーはデータの側（windowPlants.plan.ts）
 */

const SPHERE = new THREE.SphereGeometry(1, 12, 8)
const POT = new THREE.CylinderGeometry(1, 0.78, 1, 24)
const STEM = new THREE.CylinderGeometry(1, 1, 1, 6)
const _qy = new THREE.Quaternion()
const _qx = new THREE.Quaternion()
const _e = new THREE.Euler()
/** 葉の向き: 外へ向けて（y 軸まわり yaw）、先を下へ垂らす（葉の横の軸まわり droop） */
function leafEuler(yaw: number, droop: number): [number, number, number] {
  _qy.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  _qx.setFromAxisAngle(new THREE.Vector3(1, 0, 0), droop)
  _e.setFromQuaternion(_qy.multiply(_qx))
  return [_e.x, _e.y, _e.z]
}

export function createWindowPlants(at: Placement, opts: WindowPlantsOpts | undefined, ctx: LabKitContext): LabKitBody {
  const plants = opts ?? WINDOW_PLANTS
  const mats = ctx.materials
  const own = createOwned()
  const leafMat = own.add(new THREE.MeshStandardMaterial({ name: 'leaf', color: '#ffffff', roughness: 0.62, metalness: 0, side: THREE.DoubleSide }))
  const soilMat = own.add(new THREE.MeshStandardMaterial({ name: 'pottingSoil', color: '#1c1712', roughness: 1, metalness: 0 }))

  const rnd = mulberry32(4804)
  const pots: InstanceItem[] = []
  const soil: InstanceItem[] = []
  const stems: InstanceItem[] = []
  const leaves: InstanceItem[] = []
  const greens = ['#2f5a34', '#3b6b3c', '#284d2e', '#4a7a45']
  plants.xs.forEach((x, k) => {
    const z = plants.z
    // 鉢（2 鉢ごとに大きさを変える）
    const r = k % 2 === 0 ? 0.24 : 0.2
    const h = k % 2 === 0 ? 0.42 : 0.36
    pots.push({ p: [x, h / 2, z], s: [r, h, r] })
    soil.push({ p: [x, h - 0.02, z], s: [r * 0.92, 0.02, r * 0.92] })
    // 茎と葉（鉢から斜めに立つ茎に、2〜3 枚ずつ広い葉。葉は外へ傾けて少し垂れる）
    const n = 5 + Math.floor(rnd() * 3)
    const top = k % 2 === 0 ? 1.25 : 1.0
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.6
      const lean = 0.12 + rnd() * 0.32
      const len = (top - h) * (0.6 + rnd() * 0.4)
      const bx = x + Math.cos(a) * 0.03
      const bz = z + Math.sin(a) * 0.03
      const dir = new THREE.Vector3(Math.cos(a) * Math.sin(lean), Math.cos(lean), Math.sin(a) * Math.sin(lean))
      const mid = new THREE.Vector3(bx, h, bz).addScaledVector(dir, len / 2)
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      const e = new THREE.Euler().setFromQuaternion(q)
      stems.push({ p: [mid.x, mid.y, mid.z], s: [0.007, len, 0.007], e: [e.x, e.y, e.z], c: '#3d5a2e' })
      for (const t of [0.5, 0.75, 1.0]) {
        if (t < 0.6 && rnd() < 0.4) continue
        const at = new THREE.Vector3(bx, h, bz).addScaledVector(dir, len * t)
        const la = a + (rnd() - 0.5) * 1.2
        const leafLen = 0.2 + rnd() * 0.12
        // 葉の中心は茎の点から外へ半分の長さ。外へ下がる向き（x 軸まわりの傾き）と、外へ向く向き（y 軸まわり）
        leaves.push({
          p: [at.x + Math.cos(la) * leafLen * 0.45, at.y - leafLen * 0.12, at.z + Math.sin(la) * leafLen * 0.45],
          s: [leafLen * 0.32, 0.01, leafLen * 0.5],
          e: leafEuler(-la + Math.PI / 2, 0.25 + rnd() * 0.3),
          c: greens[Math.floor(rnd() * greens.length)],
        })
        // 2 枚目の向きの違う葉（重ねて広く見せる）
        leaves.push({
          p: [at.x + Math.cos(la + 0.9) * leafLen * 0.4, at.y - leafLen * 0.18, at.z + Math.sin(la + 0.9) * leafLen * 0.4],
          s: [leafLen * 0.28, 0.01, leafLen * 0.45],
          e: leafEuler(-(la + 0.9) + Math.PI / 2, 0.4 + rnd() * 0.3),
          c: greens[Math.floor(rnd() * greens.length)],
        })
      }
    }
  })

  // 形はモジュールの物（4 つの部品で使い回す。捨てない）
  const object = group(
    [
      own.add(boxInstances({ items: pots, material: mats.blackMetal, geometry: POT, castShadow: true })),
      own.add(boxInstances({ items: soil, material: soilMat, geometry: STEM })),
      own.add(boxInstances({ items: stems, material: leafMat, geometry: STEM })),
      own.add(boxInstances({ items: leaves, material: leafMat, geometry: SPHERE, castShadow: true })),
    ],
    // 前は位置の無い群（置き場所は原点）。置き場所を動かしたときのために位置と向きを入れる（原点なら行列は前と同じ単位の行列）
    { p: at.position, ry: at.rotationY },
  )
  return { object, dispose: () => own.dispose() }
}

export const windowPlantsKit: LabKitDef<WindowPlantsOpts> = {
  kind: 'windowPlants',
  plan: windowPlantsPlan,
  create: createWindowPlants,
}
