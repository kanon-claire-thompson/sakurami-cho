import * as THREE from 'three'
import { GLOW, PALETTE } from '../../palette'
import { glowMaterial, type LabMaterials } from '../../materials/labMaterials'
import { cachedCanvasTexture, FONTS } from '../../textures/canvas'
import { createLabSlot, createOwned, type LabKitBody, type LabKitContext, type LabKitDef, type LabSlot, type Owned } from '../kit'
import { bolts, glowBox, sticker } from '../parts/details'
import { chamferBoxGeometry } from '../parts/geometry'
import { group, mesh, type MeshOptions } from '../parts/object'
import { WALL_PANEL_DEPTH, type Placement, type Vec3 } from '../../../core/lab/plan'
import {
  GALLERY_CASE_XS,
  GALLERY_CASE_Z,
  GALLERY_SHELF_Y,
  GALLERY_SHELF_Z,
  GALLERY_SHELVES,
  galleryPlan,
  galleryShelfXOf,
  type GalleryPlanOpts,
} from '../../../core/lab/kits/gallery.plan'

/**
 * KB-001 試作機ギャラリー（資料: 東の壁沿い。黒い台座の上のガラスケース 3 基、台座の下端に青いライン照明）。
 * ケースの上の壁には、使う側の作品を飾る展示棚（ARCHIVE SHELF。段の数は opts の shelves。kanon-lab はワールドの置き場所 gallery-1〜6）。
 * 作品そのものは使う側（kanon-lab はワールドの物体 src/world/）が置き、名札も付ける。
 * ローカル座標: z = 0 が壁の面、+z が部屋の内側（ワールド -x）、+x がワールド +z。
 *
 * 前の zones/Gallery.tsx を、同じ入れ子・同じ子の順・同じ作る順（部品ごとに hooks の素材と形 → JSX の値で引いた発光の素材 → JSX の子の順。
 * 子を作ってから群）・手で書いた数と式のまま three の形にした物（docs/design/map-split.md §6 の「段 4」・4-10）。展示棚の高さと奥行き・段の x・
 * ケースの位置・アンカー・障害物はデータの側（gallery.plan.ts）。キットの object は置き場所の群（位置と向き）。
 *
 * - opts（GalleryOptions）: 展示棚の段の数（shelves。plan と同じ値）・ケース 3 基の展示（exhibits。既定は KB-α・KB-β の模型と KB-γ の差し込み口）・
 *   背面のタイトルパネルの文字（panel）
 * - slots: 差し込み口のある展示の case.N（入れ物は回る台の群。中身はその子。既定は case.3 = KB-γ。kanon-lab は R3F の portal で KB-001 の模型を入れる）
 * - 毎コマ: 差し込み口の中身の update → 回る台（時刻 × 回る速さ。前の ProtoMk3 の式）
 */

/** 地図の飾りの模型（試作 1 号機・2 号機） */
export type GalleryModel = 'protoMk1' | 'protoMk2'

/** ガラスケース 1 基の展示 */
export interface GalleryExhibit {
  /** 台座のプレートの文字（題と下の行） */
  title: string
  sub: string
  /** 地図の飾りの模型（slot と一緒には使わない） */
  model?: GalleryModel
  /**
   * 差し込み口（キットの中の名前 case.N）。入れ物は展示面の上の回る台の群（展示面からの高さ y・大きさ scale・回る速さ spin rad/s）。
   * 中身は外から（ラボの口の slots・R3F の portal）。無ければ空のまま回る
   */
  slot?: { y: number; scale: number; spin: number }
}

/** 背面のタイトルパネルの文字 */
export interface GalleryPanel {
  title: string
  sub: string
}

export interface GalleryOptions extends GalleryPlanOpts {
  /** ガラスケース 3 基の展示（西から。既定 GALLERY_EXHIBITS） */
  exhibits?: readonly [GalleryExhibit, GalleryExhibit, GalleryExhibit]
  /** 背面のタイトルパネルの文字（既定 GALLERY_PANEL） */
  panel?: GalleryPanel
}

/** ケース 3 基の展示の既定（前の文と模型。KB-γ は差し込み口: 前の ProtoMk3 の群の位置・大きさ・回る速さ） */
export const GALLERY_EXHIBITS: readonly [GalleryExhibit, GalleryExhibit, GalleryExhibit] = [
  { title: 'KB-α', sub: '2024 // FIRST BUILD', model: 'protoMk1' },
  { title: 'KB-β', sub: '2025 // FRAME TEST', model: 'protoMk2' },
  { title: 'KB-γ', sub: '2025 // PRE-PROD', slot: { y: 0.2, scale: 0.95, spin: 0.3 } },
]

/** タイトルパネルの文字の既定（前の文） */
export const GALLERY_PANEL: GalleryPanel = {
  title: 'PROTOTYPE ARCHIVE',
  sub: 'KB-α → KB-β → KB-γ   /   KB-001 PROTOTYPES 2024–2025',
}

const PED_H = 0.95
const CASE = 0.5
const CASE_H = 0.52

/** 組み立ての間に持ち回る物 */
interface Build {
  mats: LabMaterials
  /** 作った物の控え（共有の素材・キャッシュの発光の素材とテクスチャは控えない） */
  own: Owned
}

/** 形を作って控え、mesh にする（JSX の <mesh><boxGeometry/></mesh> など） */
const m = (b: Build, geometry: THREE.BufferGeometry, material: THREE.Material, o?: MeshOptions) => mesh(b.own.add(geometry), material, o)

/** 背面の壁に貼った、控えめに光るタイトルパネル（絵はキャッシュ。既定の文字の名前は前と同じ archive-panel） */
function archivePanel(b: Build, panel: GalleryPanel): THREE.Mesh {
  const key = panel.title === GALLERY_PANEL.title && panel.sub === GALLERY_PANEL.sub ? 'archive-panel' : `archive-panel:${panel.title}:${panel.sub}`
  const tex = cachedCanvasTexture(key, 1024, 256, (ctx, w, h) => {
    ctx.fillStyle = '#03070d'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(61,224,255,0.35)'
    ctx.lineWidth = 2
    ctx.strokeRect(8, 8, w - 16, h - 16)
    ctx.fillStyle = '#bfefff'
    ctx.font = `900 64px ${FONTS.display}`
    ctx.textBaseline = 'middle'
    ctx.fillText(panel.title, 48, h * 0.42)
    ctx.font = `28px ${FONTS.mono}`
    ctx.fillStyle = 'rgba(160,220,255,0.75)'
    ctx.fillText(panel.sub, 50, h * 0.74)
    // タイムライン
    ctx.fillStyle = 'rgba(61,224,255,0.5)'
    ctx.fillRect(w - 300, h * 0.42, 250, 2)
    ;[0, 1, 2, 3].forEach((i) => {
      ctx.beginPath()
      ctx.arc(w - 300 + i * 83, h * 0.42 + 1, 7, 0, Math.PI * 2)
      ctx.fill()
    })
  })
  return m(
    b,
    new THREE.PlaneGeometry(2.4, 0.6),
    b.own.add(new THREE.MeshStandardMaterial({ name: 'galleryScreen', color: '#000', emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 1.15, roughness: 0.3, toneMapped: false })),
    { p: [0, 2.4, WALL_PANEL_DEPTH + 0.02] },
  )
}

/** 作品の展示棚（壁付けの棚板と、段ごとのほのかな光） */
function archiveShelf(b: Build, shelves: number): THREE.Group {
  const { mats } = b
  // 前の ArchiveShelf の hooks と、JSX の値で引いていた発光の素材（段ごとの光の円）
  const edge = glowMaterial(PALETTE.cyan, GLOW.strip)
  const W = (shelves + 0.2) * 0.5
  const D = 0.28
  const T = 0.03
  const z0 = WALL_PANEL_DEPTH
  const ringGlow = glowMaterial(PALETTE.blue, 1.6, 0.8)
  return group([
    // 棚板（上面が GALLERY_SHELF_Y）
    m(b, new THREE.BoxGeometry(W, T, D), mats.darkMetal, { p: [0, GALLERY_SHELF_Y - T / 2, z0 + D / 2], cast: true, receive: true }),
    m(b, new THREE.BoxGeometry(W - 0.02, 0.004, 0.002), edge, { p: [0, GALLERY_SHELF_Y - T / 2, z0 + D + 0.001] }),
    // 支え
    ...[-1, 1].map((s) => m(b, new THREE.BoxGeometry(0.03, 0.15, 0.2), mats.aluminium, { p: [s * (W / 2 - 0.1), GALLERY_SHELF_Y - 0.09, z0 + 0.12], cast: true })),
    // 段ごとの置き場所の印（床の光の円）
    ...Array.from({ length: shelves }, (_, i) =>
      m(b, new THREE.RingGeometry(0.085, 0.09, 48), ringGlow, { p: [galleryShelfXOf(i + 1, shelves), GALLERY_SHELF_Y + 0.0015, GALLERY_SHELF_Z], r: [-Math.PI / 2, 0, 0] }),
    ),
  ])
}

/** 試作 1 号機：箱型のボディに単眼カメラ（丸くなる前） */
function protoMk1(b: Build): THREE.Group {
  const { mats, own } = b
  // 前の hooks（形・発光の素材）と、JSX の値で引いていた発光の素材（アンテナの先）
  const body = own.add(chamferBoxGeometry(0.2, 0.18, 0.18, 0.025))
  const eye = glowMaterial(PALETTE.cyan, 1.6)
  const tip = glowMaterial(PALETTE.blue, 2)
  const boltMesh = () => {
    const x = bolts(
      {
        positions: [
          [-0.08, 0.07, 0.091],
          [0.08, 0.07, 0.091],
          [-0.08, -0.07, 0.091],
          [0.08, -0.07, 0.091],
        ],
        axis: 'z',
        radius: 0.006,
      },
      mats,
    )
    own.add(x.geometry)
    return own.add(x)
  }
  return group(
    [
      mesh(body, mats.plasticGrey, { cast: true, receive: true }),
      m(b, new THREE.CylinderGeometry(0.04, 0.04, 0.012, 32), mats.plasticDark, { p: [0, 0.02, 0.092], r: [Math.PI / 2, 0, 0] }),
      m(b, new THREE.CircleGeometry(0.018, 24), eye, { p: [0, 0.02, 0.099] }),
      boltMesh(),
      m(b, new THREE.CylinderGeometry(0.003, 0.003, 0.08, 6), mats.steel, { p: [0.06, 0.13, 0] }),
      m(b, new THREE.SphereGeometry(0.008, 10, 8), tip, { p: [0.06, 0.175, 0] }),
      // 脚の代わりの車輪
      ...[-1, 1].map((s) => m(b, new THREE.CylinderGeometry(0.04, 0.04, 0.02, 20), mats.rubber, { p: [s * 0.105, -0.08, 0], r: [0, 0, Math.PI / 2] })),
    ],
    { p: [0, 0.16, 0], ry: -0.4 },
  )
}

/** 試作 2 号機：球形フレーム + 片側だけの殻 */
function protoMk2(b: Build): THREE.Group {
  const { mats } = b
  // 前の JSX の値で引いていた発光の素材（顔の光）
  const face = glowMaterial(PALETTE.cyan, 1.2)
  return group(
    [
      ...[0, Math.PI / 2, Math.PI / 4].map((r, i) =>
        m(b, new THREE.TorusGeometry(0.14, 0.006, 8, 64), mats.aluminium, { r: [i === 0 ? Math.PI / 2 : 0, r, 0], cast: true }),
      ),
      m(b, new THREE.SphereGeometry(0.145, 40, 24, 0, Math.PI, 0, Math.PI), mats.whitePaint, { ry: -Math.PI / 2, cast: true }),
      m(b, new THREE.BoxGeometry(0.16, 0.006, 0.12), mats.pcb),
      m(b, new THREE.CylinderGeometry(0.03, 0.03, 0.07, 16), mats.darkMetal, { p: [0, -0.05, 0] }),
      ...[-1, 1].map((s) => m(b, new THREE.BoxGeometry(0.022, 0.03, 0.004), face, { p: [s * 0.035, 0.04, 0.1] })),
    ],
    { p: [0, 0.2, 0], ry: 0.5 },
  )
}

const MODELS: Record<GalleryModel, (b: Build) => THREE.Group> = { protoMk1, protoMk2 }

/** ガラスケース（台座・展示面・ガラス・上の照明・中身・プレート）。中身（模型か差し込み口の入れ物）は作り手で受け取る（前の children と同じ位置で作る） */
function displayCase(b: Build, position: Vec3, exhibit: GalleryExhibit, content: () => THREE.Object3D | null): THREE.Group {
  const { mats, own } = b
  // 前の DisplayCase の hooks と、JSX の値で引いていた発光の素材（台座の下端のライン）
  const topLight = glowMaterial('#eef6ff', 2.6)
  const edge = glowMaterial(PALETTE.cyan, GLOW.strip)
  const base = glowMaterial(PALETTE.blue, 2)
  const children: THREE.Object3D[] = [
    // 台座
    m(b, new THREE.BoxGeometry(CASE, PED_H, CASE), mats.darkMetal, { p: [0, PED_H / 2, 0], cast: true, receive: true }),
    m(b, new THREE.BoxGeometry(CASE - 0.02, 0.006, 0.004), edge, { p: [0, PED_H - 0.005, CASE / 2 + 0.001] }),
    m(b, new THREE.BoxGeometry(CASE - 0.02, 0.004, 0.004), base, { p: [0, 0.03, CASE / 2 + 0.001] }),
    // 展示面
    m(b, new THREE.BoxGeometry(CASE - 0.02, 0.01, CASE - 0.02), mats.screenOff, { p: [0, PED_H + 0.005, 0], receive: true }),
    // ガラスケース
    m(b, new THREE.BoxGeometry(CASE - 0.01, CASE_H, CASE - 0.01), mats.glass, { p: [0, PED_H + CASE_H / 2 + 0.01, 0], order: 3 }),
    // 上部の照明ボックス
    m(b, new THREE.BoxGeometry(CASE, 0.05, CASE), mats.blackMetal, { p: [0, PED_H + CASE_H + 0.035, 0], cast: true }),
    m(b, new THREE.PlaneGeometry(CASE - 0.08, CASE - 0.08), topLight, { p: [0, PED_H + CASE_H + 0.009, 0], r: [Math.PI / 2, 0, 0] }),
  ]
  // 中身
  const inner = content()
  children.push(group(inner ? [inner] : [], { p: [0, PED_H + 0.01, 0] }))
  // プレート
  children.push(
    own.mesh(
      sticker({
        text: exhibit.title,
        sub: exhibit.sub,
        position: [0, PED_H - 0.12, CASE / 2 + 0.002],
        width: 0.34,
        aspect: 3.4,
        background: '#0c1118',
        color: '#bfe9ff',
        font: 'display',
      }),
    ),
  )
  return group(children, { p: position })
}

export function createGallery(at: Placement, opts: GalleryOptions | undefined, ctx: LabKitContext): LabKitBody {
  const own = createOwned()
  const b: Build = { mats: ctx.materials, own }
  const shelves = opts?.shelves ?? GALLERY_SHELVES
  const exhibits = opts?.exhibits ?? GALLERY_EXHIBITS

  // 作る順は前の JSX のまま（置き場所の群の中: タイトルパネル・展示棚・壁のライン・ガラスケース ×3）
  const panel = archivePanel(b, opts?.panel ?? GALLERY_PANEL)
  const shelf = archiveShelf(b, shelves)
  const line = glowBox({ position: [0, 1.6, WALL_PANEL_DEPTH + 0.02], size: [2.9, 0.006, 0.006], color: PALETTE.cyan, intensity: GLOW.strip })
  own.add(line.geometry)
  const slots: Record<string, LabSlot> = {}
  /** 回る台（差し込み口の入れ物）と回る速さ */
  const turntables: { slot: LabSlot; spin: number }[] = []
  const cases = GALLERY_CASE_XS.map((x, i) => {
    const exhibit = exhibits[i]!
    return displayCase(b, [x, 0, GALLERY_CASE_Z], exhibit, () => {
      if (exhibit.slot) {
        const name = `case.${i + 1}`
        const slot = createLabSlot(`${ctx.id}.${name}`)
        slot.object.position.fromArray([0, exhibit.slot.y, 0])
        slot.object.scale.setScalar(exhibit.slot.scale)
        slots[name] = slot
        turntables.push({ slot, spin: exhibit.slot.spin })
        return slot.object
      }
      return exhibit.model ? MODELS[exhibit.model](b) : null
    })
  })
  const object = group([panel, shelf, line, ...cases], { p: at.position, ry: at.rotationY })

  return {
    object,
    update(dt, f) {
      // 前の購読の順: 中身（KB-γ の模型の目）→ 回る台
      for (const { slot, spin } of turntables) {
        slot.update(dt, f)
        slot.object.rotation.y = f.time * spin
      }
    },
    slots,
    dispose() {
      for (const { slot } of turntables) slot.dispose()
      own.dispose()
    },
  }
}

export const galleryKit: LabKitDef<GalleryOptions> = {
  kind: 'gallery',
  plan: galleryPlan,
  create: createGallery,
}
