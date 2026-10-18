import * as THREE from 'three'
import { GLOW, PALETTE } from '../../palette'
import { HologramMaterial } from '../../materials/hologram'
import { glowMaterial, type LabMaterials } from '../../materials/labMaterials'
import { cachedCanvasTexture, FONTS } from '../../textures/canvas'
import { createLabSlot, createOwned, kitChannels, type LabKitBody, type LabKitContext, type LabKitDef, type Owned } from '../kit'
import { glowSprite, matrixInstances } from '../parts/details'
import { group, mesh, type MeshOptions } from '../parts/object'
import type { Placement } from '../../../core/lab/plan'
import { HOLO_Y, holoTablePlan } from '../../../core/lab/kits/holoTable.plan'

/**
 * ホロテーブル。直径約 1.8m・高さ約 0.95m の円形テーブルの上に、投影の中身（差し込み口 projection。kanon-lab は KB-001 の分解図）が
 * ホログラムで浮かんでゆっくり回る。ローカル座標: 原点 = テーブル中心の床。
 *
 * 前の zones/HoloTable.tsx の台・投影の光・光のにじみと、分解図の根の群（出し入れの大きさ・漂い・回転）を、同じ入れ子・同じ子の順・同じ作る順
 * （部品ごとに hooks の素材 → JSX の子の順。子を作ってから群）・手で書いた数と式のまま three の形にした物（docs/design/map-split.md §6 の「段 4」・4-9）。
 * 投影の中身の高さ HOLO_Y・アンカー・障害物はデータの側（holoTable.plan.ts）。キットの object は置き場所の群（位置と向き）。
 *
 * - channels（HoloTableChannels）: projection（投影の中身を出す目標。0〜1。既定 1）。kanon-lab は「ホロテーブルにホロスクリーン
 *   （screen.show の holotable）を映している間は 0」（スクリーンと重ならないように、中身をしまう）
 * - slots: projection（入れ物はキットが動かす根の群: 高さ HOLO_Y で上下に漂い・回り・出し入れの大きさ。中身はその子）
 * - opts（HoloTableOptions）: 天板のガラスの文字（既定は前の文）
 * - 毎コマ（前の購読の順）: 光のにじみ（カメラを向く）→ 投影の中身の update（前は中身の名札が先、根が後。名札は根の前のコマの回転に向く）→
 *   投影の出し入れ・漂い・回転
 */

/** ホロテーブルの入力の値（読むたびに見る） */
export interface HoloTableChannels {
  /** 投影の中身を出す目標（0〜1。0 へは速く、1 へはゆっくり寄せる） */
  projection: number
}

export const HOLO_TABLE_CHANNELS: Readonly<HoloTableChannels> = { projection: 1 }

export interface HoloTableOptions {
  /** 天板のガラスの円形グリッドの下に書く文字 */
  label?: string
}

/** 天板のガラスの文字の既定（前の文） */
export const HOLO_TABLE_LABEL = 'KB-001 // EXPLODED VIEW  rev.7'

const TABLE_TOP = 0.95
/** 天板の半径（資料: 直径 1.2m） */
const TABLE_R = 0.6

/** 天板のガラスに映す円形グリッド（キャッシュの絵。既定の文字の名前は前と同じ） */
function tableTopTexture(label: string) {
  return cachedCanvasTexture(label === HOLO_TABLE_LABEL ? 'holotable-top' : `holotable-top:${label}`, 1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    const cx = w / 2
    const cy = h / 2
    ctx.strokeStyle = 'rgba(61,224,255,0.55)'
    ctx.lineWidth = 2
    for (let r = 60; r < 500; r += 55) {
      ctx.globalAlpha = r % 110 === 5 ? 0.9 : 0.45
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 0.35
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * 60, cy + Math.sin(a) * 60)
      ctx.lineTo(cx + Math.cos(a) * 500, cy + Math.sin(a) * 500)
      ctx.stroke()
    }
    // 外周の目盛り
    ctx.globalAlpha = 1
    ctx.lineWidth = 3
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * Math.PI * 2
      const len = i % 15 === 0 ? 26 : 10
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * 470, cy + Math.sin(a) * 470)
      ctx.lineTo(cx + Math.cos(a) * (470 - len), cy + Math.sin(a) * (470 - len))
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(160,235,255,0.9)'
    ctx.font = `28px ${FONTS.mono}`
    ctx.textAlign = 'center'
    ctx.fillText(label, cx, cy + 420)
  })
}

/** 組み立ての間に持ち回る物 */
interface Build {
  mats: LabMaterials
  /** 作った物の控え（共有の素材・キャッシュの発光の素材とテクスチャは控えない） */
  own: Owned
}

/** 形を作って控え、mesh にする（JSX の <mesh><cylinderGeometry/></mesh> など） */
const m = (b: Build, geometry: THREE.BufferGeometry, material: THREE.Material, o?: MeshOptions) => mesh(b.own.add(geometry), material, o)

/** 台（脚・天板・天板のガラス・縁の光・中央のプロジェクタ） */
function table(b: Build, label: string): THREE.Group {
  const { mats, own } = b
  // 前の Table の hooks と、JSX の値で引いていた発光の素材（中央のプロジェクタの光）
  const rim = glowMaterial(PALETTE.cyan, GLOW.strip)
  const under = glowMaterial(PALETTE.blue, 2.0)
  const topTex = tableTopTexture(label)
  const footBolts = (() => {
    const g = own.add(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 6))
    const ms: THREE.Matrix4[] = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      ms.push(new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.33, 0.065, Math.sin(a) * 0.33))
    }
    return { g, ms }
  })()
  const projectorGlow = glowMaterial('#bff3ff', GLOW.strong)
  return group([
    // 脚
    m(b, new THREE.CylinderGeometry(0.36, 0.4, 0.06, 64), mats.darkMetal, { p: [0, 0.03, 0], cast: true, receive: true }),
    own.add(matrixInstances({ matrices: footBolts.ms, geometry: footBolts.g, material: mats.steel })),
    m(b, new THREE.CylinderGeometry(0.2, 0.28, 0.84, 48), mats.blackMetal, { p: [0, 0.48, 0], cast: true, receive: true }),
    ...[0.3, 0.55, 0.8].map((y) => m(b, new THREE.TorusGeometry(0.235 - (y - 0.3) * 0.08, 0.004, 6, 64), under, { p: [0, y, 0], r: [Math.PI / 2, 0, 0] })),
    // 天板
    m(b, new THREE.CylinderGeometry(TABLE_R, TABLE_R - 0.06, 0.08, 96), mats.darkMetal, { p: [0, TABLE_TOP - 0.04, 0], cast: true, receive: true }),
    m(
      b,
      new THREE.CircleGeometry(TABLE_R - 0.06, 96),
      own.add(
        new THREE.MeshPhysicalMaterial({
          name: 'holoTableTop',
          color: '#05080c',
          emissive: '#ffffff',
          emissiveMap: topTex,
          emissiveIntensity: 0.9,
          roughness: 0.08,
          metalness: 0,
          clearcoat: 1,
          toneMapped: false,
        }),
      ),
      { p: [0, TABLE_TOP + 0.001, 0], r: [-Math.PI / 2, 0, 0] },
    ),
    m(b, new THREE.TorusGeometry(TABLE_R - 0.03, 0.008, 8, 160), rim, { p: [0, TABLE_TOP, 0], r: [Math.PI / 2, 0, 0] }),
    m(b, new THREE.TorusGeometry(TABLE_R - 0.07, 0.006, 8, 160), under, { p: [0, TABLE_TOP - 0.085, 0], r: [Math.PI / 2, 0, 0] }),
    // 中央のプロジェクタ
    m(b, new THREE.CylinderGeometry(0.07, 0.09, 0.03, 32), mats.chrome, { p: [0, TABLE_TOP + 0.015, 0] }),
    m(b, new THREE.CircleGeometry(0.045, 32), projectorGlow, { p: [0, TABLE_TOP + 0.031, 0], r: [-Math.PI / 2, 0, 0] }),
  ])
}

export function createHoloTable(at: Placement, opts: HoloTableOptions | undefined, ctx: LabKitContext): LabKitBody<HoloTableChannels> {
  const own = createOwned()
  const b: Build = { mats: ctx.materials, own }
  const ch = kitChannels(HOLO_TABLE_CHANNELS)

  // 作る順は前の JSX のまま（置き場所の群の中: 台・投影の光・光のにじみ・投影の中身の根）
  const tableGroup = table(b, opts?.label ?? HOLO_TABLE_LABEL)
  // プロジェクタから投影の中身へ広がる光
  const cone = m(
    b,
    new THREE.CylinderGeometry(0.3, 0.05, HOLO_Y - TABLE_TOP - 0.1, 48, 1, true),
    own.add(new HologramMaterial({ color: PALETTE.cyan, intensity: 0.45, base: 0.015, fresnelStrength: 0.25, fresnelPower: 1.2, scanDensity: 300, sweep: 0.3 })),
    { p: [0, (TABLE_TOP + HOLO_Y) / 2 - 0.05, 0] },
  )
  const sprite = glowSprite({ position: [0, TABLE_TOP + 0.05, 0], size: 0.7, color: PALETTE.cyan, opacity: 0.4 })
  own.mesh(sprite.inner.children[0] as THREE.Mesh)
  // 投影の中身の根（差し込み口の入れ物。前の分解図の根の群と同じ位置。中身はその子）
  const projection = createLabSlot(`${ctx.id}.projection`)
  const root = projection.object
  root.position.fromArray([0, HOLO_Y, 0])
  const object = group([tableGroup, cone, sprite.object, root], { p: at.position, ry: at.rotationY })

  /** 投影の中身の出具合（目標 channels.projection へ寄せる） */
  let shown = 1
  return {
    object,
    update(dt, f) {
      // 前の購読の順: 光のにじみ → 中身（名札 → 分解図）→ 根（出し入れ・漂い・回転）。名札は根の前のコマの回転に向く
      sprite.update(f.camera)
      projection.update(dt, f)
      const t = f.time
      const want = ch.channels.projection
      shown += (want - shown) * (1 - Math.exp(-Math.min(dt, 0.05) * (want ? 3 : 6)))
      root.rotation.y += dt * 0.25
      root.position.y = HOLO_Y + Math.sin(t * 0.8) * 0.015
      root.scale.setScalar(Math.max(0.001, shown))
      root.visible = shown > 0.01
    },
    channels: ch,
    slots: { projection },
    dispose() {
      projection.dispose()
      own.dispose()
    },
  }
}

export const holoTableKit: LabKitDef<HoloTableOptions, HoloTableChannels> = {
  kind: 'holoTable',
  plan: holoTablePlan,
  create: createHoloTable,
}
