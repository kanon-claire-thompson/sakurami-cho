import * as THREE from 'three'
import { GLOW, PALETTE } from '../../palette'
import { glowMaterial } from '../../materials/labMaterials'
import { cachedCanvasTexture } from '../../textures/canvas'
import { createOwned, type LabKitBody, type LabKitContext, type LabKitDef } from '../kit'
import { bolts, glowBox, sticker } from '../parts/details'
import { group, mesh, type MeshOptions } from '../parts/object'
import type { Placement, Vec3 } from '../../../core/lab/plan'
import { robotArmPlan } from '../../../core/lab/kits/robotArm.plan'
import { markDynamic } from '../../staticMerge'

/**
 * ロボットアーム（工作ゾーンの床の中ほどの置き場所 robotArm）: 床の作業範囲の印（半径 1.1m。中心が置き場所の原点）・ロボットアーム・治具の台。
 *
 * 前の zones/Workshop.tsx の SafetyMarking・RobotArm・FixtureTable と置き場所の群を、同じ入れ子・同じ子の順・同じ作る順
 * （部品ごとに hooks の素材 → JSX の子の順。子を作ってから群）・手で書いた数と式のまま three の形にした物（docs/design/map-split.md §6 の「段 4」・4-7）。
 * 障害物はデータの側（robotArm.plan.ts）。キットの object は置き場所の群（位置と向き）。
 *
 * - 毎コマ: アームの関節とグリッパ（ゆっくり作業している動き。時刻だけで決まる）
 */

export function createRobotArm(at: Placement, _opts: object | undefined, ctx: LabKitContext): LabKitBody {
  const mats = ctx.materials
  const own = createOwned()
  const m = (geometry: THREE.BufferGeometry, material: THREE.Material, o?: MeshOptions) => mesh(own.add(geometry), material, o)

  /* ---- 床の安全区画（ロボットアームの可動範囲） ---- */
  const safetyMarking = (position: Vec3) => {
    const tex = cachedCanvasTexture('arm-safety', 512, 512, (ctx2, w, h) => {
      ctx2.clearRect(0, 0, w, h)
      ctx2.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx2.lineWidth = 10
      ctx2.setLineDash([36, 24])
      ctx2.beginPath()
      ctx2.arc(w / 2, h / 2, w / 2 - 12, 0, Math.PI * 2)
      ctx2.stroke()
      ctx2.setLineDash([])
      ctx2.font = 'bold 30px "Share Tech Mono", monospace'
      ctx2.fillStyle = 'rgba(255,255,255,0.9)'
      ctx2.textAlign = 'center'
      ctx2.fillText('ROBOT WORK AREA', w / 2, h - 60)
    })
    const geometry = own.add(new THREE.PlaneGeometry(2.2, 2.2))
    const material = own.add(
      new THREE.MeshStandardMaterial({
        name: 'floorMarking',
        map: tex,
        color: '#8fa0b2',
        transparent: true,
        opacity: 0.45,
        roughness: 0.8,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    )
    return mesh(geometry, material, { p: position, r: [-Math.PI / 2, 0, 0] })
  }

  /* ---- ロボットアーム ---- */
  const robotArm = (position: Vec3) => {
    const ring = glowMaterial(PALETTE.cyan, GLOW.strip)
    const boltsOwned = () => {
      const x = bolts(
        {
          positions: Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2) * 0.235, 0.123, Math.sin((i / 8) * Math.PI * 2) * 0.235] as Vec3),
          axis: 'y',
          radius: 0.013,
        },
        mats,
      )
      own.add(x.geometry)
      return own.add(x)
    }
    const base = [
      // 台座
      m(new THREE.CylinderGeometry(0.24, 0.27, 0.12, 48), mats.darkMetal, { p: [0, 0.06, 0], cast: true, receive: true }),
      boltsOwned(),
      m(new THREE.RingGeometry(0.18, 0.19, 64), ring, { p: [0, 0.121, 0], r: [-Math.PI / 2, 0, 0] }),
    ]
    // 関節の入れ子（j1 → j2 → j3 → j5 → j6）。作る順は前の JSX のまま（群の中の子を順に作り、子を作ってから群）
    const j1 = group(
      [
        // 旋回部
        m(new THREE.CylinderGeometry(0.15, 0.18, 0.28, 40), mats.whitePaint, { p: [0, 0.14, 0], cast: true, receive: true }),
        m(new THREE.TorusGeometry(0.15, 0.006, 6, 48), ring, { p: [0, 0.285, 0], r: [Math.PI / 2, 0, 0] }),
        group(
          [
            // 肩
            m(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 36), mats.darkMetal, { r: [0, 0, Math.PI / 2], cast: true }),
            ...[-1, 1].map((s) => m(new THREE.TorusGeometry(0.09, 0.006, 6, 40), ring, { p: [s * 0.152, 0, 0], r: [0, 0, Math.PI / 2] })),
            // 上腕
            m(new THREE.BoxGeometry(0.16, 0.56, 0.15), mats.whitePaint, { p: [0, 0.33, 0], cast: true, receive: true }),
            own.mesh(
              sticker({ text: 'KC-ARM 06', position: [0.081, 0.36, 0], rotation: [0, Math.PI / 2, Math.PI / 2], width: 0.3, aspect: 6, background: 'transparent', color: '#3a4048' }),
            ),
            group(
              [
                m(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 32), mats.darkMetal, { r: [0, 0, Math.PI / 2], cast: true }),
                ...[-1, 1].map((s) => m(new THREE.TorusGeometry(0.07, 0.005, 6, 36), ring, { p: [s * 0.112, 0, 0], r: [0, 0, Math.PI / 2] })),
                // 前腕
                m(new THREE.BoxGeometry(0.12, 0.46, 0.12), mats.whitePaint, { p: [0, 0.28, 0], cast: true, receive: true }),
                // 前腕に沿うケーブル
                m(new THREE.CylinderGeometry(0.012, 0.012, 0.44, 8), mats.rubber, { p: [0.075, 0.28, 0.03] }),
                group(
                  [
                    m(new THREE.CylinderGeometry(0.065, 0.065, 0.15, 28), mats.darkMetal, { r: [0, 0, Math.PI / 2], cast: true }),
                    m(new THREE.CylinderGeometry(0.055, 0.06, 0.1, 28), mats.whitePaint, { p: [0, 0.08, 0], cast: true }),
                    group(
                      [
                        m(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 28), mats.steel, { cast: true }),
                        m(new THREE.TorusGeometry(0.05, 0.004, 6, 32), ring, { p: [0, 0.02, 0], r: [Math.PI / 2, 0, 0] }),
                        // グリッパ
                        m(new THREE.BoxGeometry(0.11, 0.03, 0.05), mats.darkMetal, { p: [0, 0.04, 0] }),
                        m(new THREE.BoxGeometry(0.012, 0.07, 0.04), mats.steel, { p: [-0.02, 0.085, 0], cast: true }),
                        m(new THREE.BoxGeometry(0.012, 0.07, 0.04), mats.steel, { p: [0.02, 0.085, 0], cast: true }),
                      ],
                      { p: [0, 0.14, 0] },
                    ),
                  ],
                  { p: [0, 0.55, 0] },
                ),
              ],
              { p: [0, 0.65, 0] },
            ),
          ],
          { p: [0, 0.42, 0] },
        ),
      ],
      { p: [0, 0.12, 0] },
    )
    // 動かす関節（前の ref）: 各群の最後の子が次の関節
    const j2 = j1.children[2] as THREE.Group
    const j3 = j2.children[5] as THREE.Group
    const j5 = j3.children[5] as THREE.Group
    const j6 = j5.children[2] as THREE.Group
    const [fingerL, fingerR] = j6.children.slice(3) as [THREE.Object3D, THREE.Object3D]
    markDynamic(j1, j2, j3, j5, j6, fingerL, fingerR)
    return {
      object: group([...base, j1], { p: position }),
      update(t: number) {
        // ゆっくり作業している動き（複数の周期を重ねて単調にならないように）
        j1.rotation.y = Math.sin(t * 0.23) * 0.45 + Math.sin(t * 0.07) * 0.2
        j2.rotation.x = 0.5 + Math.sin(t * 0.37) * 0.16
        j3.rotation.x = 1.25 + Math.sin(t * 0.37 + 0.9) * 0.22
        j5.rotation.x = 1.15 + Math.sin(t * 0.5 + 2) * 0.2
        j6.rotation.y = t * 0.4
        const open = 0.012 + Math.max(0, Math.sin(t * 0.6)) * 0.018
        fingerL.position.x = -open
        fingerR.position.x = open
      },
    }
  }

  /* ---- ロボットアームの作業台（組み立て中の KB-001 の殻を固定している） ---- */
  const fixtureTable = (position: Vec3): THREE.Group => {
    const glowOwned = () => {
      const x = glowBox({ position: [0.03, 0.756, 0.02], size: [0.02, 0.006, 0.02], color: PALETTE.cyan, intensity: 2.5 })
      own.add(x.geometry)
      return x
    }
    return group(
      [
        m(new THREE.BoxGeometry(0.7, 0.04, 0.6), mats.benchTop, { p: [0, 0.7, 0], cast: true, receive: true }),
        ...(
          [
            [-0.3, -0.25],
            [0.3, -0.25],
            [-0.3, 0.25],
            [0.3, 0.25],
          ] as const
        ).map(([x, z]) => m(new THREE.BoxGeometry(0.04, 0.68, 0.04), mats.aluminium, { p: [x, 0.34, z], cast: true })),
        // 治具と KB-001 の半球シェル
        m(new THREE.CylinderGeometry(0.13, 0.15, 0.03, 32), mats.steel, { p: [0, 0.735, 0], cast: true }),
        m(new THREE.SphereGeometry(0.15, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), mats.whitePaint, { p: [0, 0.75, 0], r: [Math.PI, 0, 0], cast: true }),
        m(new THREE.CircleGeometry(0.14, 40), mats.pcb, { p: [0, 0.752, 0], r: [-Math.PI / 2, 0, 0] }),
        glowOwned(),
      ],
      { p: position },
    )
  }

  // 作る順は前の JSX のまま（置き場所の群の中: 作業範囲の印（中心が原点）・アーム・治具の台）
  const marking = safetyMarking([0, 0.002, 0])
  const arm = robotArm([0, 0, -0.35])
  const table = fixtureTable([0, 0, 0.53])
  const object = group([marking, arm.object, table], { p: at.position, ry: at.rotationY })

  return {
    object,
    update(_dt, f) {
      arm.update(f.time)
    },
    dispose: () => own.dispose(),
  }
}

export const robotArmKit: LabKitDef = {
  kind: 'robotArm',
  plan: robotArmPlan,
  create: createRobotArm,
}
