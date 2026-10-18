import * as THREE from 'three'
import { GLOW, PALETTE } from '../../palette'
import { HologramMaterial } from '../../materials/hologram'
import { glowMaterial, type LabMaterials } from '../../materials/labMaterials'
import { drawCodeScreen, drawGraphScreen, drawHoloDiagnostics, drawHoloNetwork, drawHoloPipeline, drawTerminalScreen } from '../../textures/screens'
import { createOwned, type LabAnchor, type LabKitBody, type LabKitContext, type LabKitDef, type Owned } from '../kit'
import { cable } from '../parts/cable'
import { matrixInstances, sticker, stickyNote, type StickerOptions, type StickyNoteOptions } from '../parts/details'
import { curvedPlaneGeometry } from '../parts/geometry'
import { group, mesh, type MeshOptions } from '../parts/object'
import type { Placement, Vec3 } from '../../../core/lab/plan'
import type { LabScreen, ScreenDraw } from '../screens'
import { DESK_H, devDeskPlan, MONITOR_X } from '../../../core/lab/kits/devDesk.plan'
import { markDynamic } from '../../staticMerge'

/**
 * 開発デスク（資料: 東寄りの窓際の L 字のデスク。x 3.6〜7.2・z 3.0〜4.7）。曲面マルチモニタ 3 面と短辺のモニタ 1 面・空中の透明 UI パネル・キーボード・椅子。
 * ローカル座標: z = 0 がデスクの南の縁（窓の側）、+z が部屋の内側（ワールド -z）、+x がワールド -x（西）。
 * 長辺（幅 3.6m・奥行き 0.8m）がローカル z 0〜0.8、短辺（0.7 × 0.9m）がローカル x -1.8〜-1.1・z 0.8〜1.7（東の端から北へ）。
 * モニタの並びは花音の立つ位置（STOPS.desk）の正面に合わせて、長辺の中心から MONITOR_X ずらす
 *
 * 前の zones/DevDesk.tsx を、同じ入れ子・同じ子の順・同じ作る順（部品ごとに hooks の素材と画面 → JSX の子の順。子を作ってから群）・
 * 手で書いた数と式のまま three の形にした物（docs/design/map-split.md §6 の「段 4」・4-8）。天板の高さ DESK_H とモニタの群のずれ MONITOR_X・
 * アンカー・障害物はデータの側（devDesk.plan.ts）。キットの object は置き場所の群（位置と向き）。
 * 作業の見出し（kanon-lab の DevTaskSign）は外した（アンカー devDesk.taskSign に、使う側が置く）。
 *
 * - screens（Canvas の幅・毎秒の回数。高さは画面の縦横から）: wing（短辺のモニタ。1024・10）・center（中央のモニタ。2048・12）・
 *   left（左のモニタ。1536・10）・right（右のモニタ。1536・12）・holoDiagnostics・holoPipeline・holoNetwork（空中のパネル。512・12）。
 *   中身は地図の側の飾りの画面（textures/screens.ts）。kanon-lab は center・left・right に作業の中継（dev/monitorDraw.ts）を入れる
 * - anchors: monitor（中央のモニタの画面の中心の位置と向き・大きさ。作った時に群の行列から 1 回出す。前の devAnchors.monitor と同じ式）。
 *   plan のアンカー（desk.a・desk.b・taskSign）は createLab が足す
 * - 毎コマ（前の購読の順）: 短辺のモニタの画面 → 中央 → 左 → 右のモニタの画面 → 空中のパネル ×3（画面 → 上下に漂う）
 */

const DESK_W = 3.6
const DESK_D = 0.8
/** 短辺（ローカル x の範囲と奥行き） */
const WING = { x0: -1.8, x1: -1.1, d: 0.9 }
/** 中央のモニタの画面の大きさ（m。アンカー monitor の大きさ） */
const CENTER = { w: 1.04, h: 0.45 }

/** 組み立ての間に持ち回る物 */
interface Build {
  mats: LabMaterials
  /** 作った物の控え（共有の素材・キャッシュの発光の素材とテクスチャは控えない） */
  own: Owned
  ctx: LabKitContext
}

/** 形を作って控え、mesh にする（JSX の <mesh><boxGeometry/></mesh> など） */
const m = (b: Build, geometry: THREE.BufferGeometry, material: THREE.Material, o?: MeshOptions) => mesh(b.own.add(geometry), material, o)
/** 素材を作って控える（JSX の <meshStandardMaterial> など） */
const mat = <T extends THREE.Material>(b: Build, material: T): T => b.own.add(material)
const stickerOwned = (b: Build, o: StickerOptions) => b.own.mesh(sticker(o))
const stickyNoteOwned = (b: Build, o: StickyNoteOptions) => b.own.mesh(stickyNote(o))

/* -------------------------------------------------------------------------- */
/* 湾曲モニタ・空中のパネル                                                     */
/* -------------------------------------------------------------------------- */

interface MonitorOptions {
  position: Vec3
  rotationY?: number
  width: number
  height: number
  /** 既定の中身（ラボの口に「置き場所の id.画面の名前」の中身があれば、そちらを描く） */
  draw: ScreenDraw
  fps?: number
  /** 画面の Canvas の幅（px） */
  resolution?: number
}

/** 湾曲モニタ 1 台（ベゼル・背面・スタンド込み） */
function curvedMonitor(b: Build, name: string, { position, rotationY = 0, width, height, draw, fps = 10, resolution = 1024 }: MonitorOptions) {
  const { mats, own } = b
  const radius = 1.4
  const screenGeom = own.add(curvedPlaneGeometry(width, height, radius))
  const backGeom = own.add(curvedPlaneGeometry(width + 0.025, height + 0.025, radius + 0.004))
  // 異方性フィルタは GPU の最大（createLabScreen。曲面・斜めから見ても文字がつぶれない）
  const screen = own.add(b.ctx.screens(name, resolution, Math.round((resolution * height) / width), draw, fps))
  // 前の JSX の値で、部品を作る前に引いていた発光の素材（下ベゼルのインジケータ）
  const indicator = glowMaterial(PALETTE.cyan, 2)
  const object = group(
    [
      // 背面シェル（少し後ろにずらした曲面）
      mesh(backGeom, mats.plasticDark, { p: [0, 0, -0.012], cast: true }),
      mesh(backGeom, mats.darkMetal, { p: [0, 0, -0.03] }),
      // 画面の光り方（emissiveIntensity）はほかの画面と同じ。文字の色は bloom のしきい値を超えない明るさ（kanon-lab の src/dev/monitorDraw.ts）。
      // ツヤを少し落とし、天井の照明の映り込みが文字の上で白く光ってにじまないようにしている
      mesh(
        screenGeom,
        mat(
          b,
          new THREE.MeshStandardMaterial({
            name: 'monitorScreen',
            color: '#000000',
            emissive: '#ffffff',
            emissiveMap: screen.texture,
            emissiveIntensity: GLOW.screen,
            roughness: 0.45,
            envMapIntensity: 0.35,
            metalness: 0,
            toneMapped: false,
          }),
        ),
      ),
      // 下ベゼルのインジケータ
      m(b, new THREE.BoxGeometry(0.01, 0.003, 0.003), indicator, { p: [width * 0.42, -height / 2 - 0.006, 0.02] }),
    ],
    { p: position, ry: rotationY },
  )
  return { object, screen }
}

interface HoloPanelOptions {
  position: Vec3
  rotation?: Vec3
  width: number
  height: number
  draw: ScreenDraw
  /** 上下に漂う動きの位相（パネルごとにずらす） */
  phase?: number
}

/** 空中に浮かぶ透明な UI パネル（ホログラムシェーダー + Canvas） */
function holoPanel(b: Build, name: string, { position, rotation, width, height, draw, phase = 0 }: HoloPanelOptions) {
  const screen = b.own.add(b.ctx.screens(name, 512, Math.round((512 * height) / width), draw, 12))
  const object = group(
    [
      m(
        b,
        new THREE.PlaneGeometry(width, height),
        mat(b, new HologramMaterial({ color: '#ffffff', intensity: 1.5, base: 0.015, mapTexture: screen.texture, flicker: 0.08, sweep: 0.15, scanDensity: 380 })),
      ),
      // 投影元の細い線
      m(b, new THREE.BoxGeometry(width, 0.002, 0.002), mat(b, new HologramMaterial({ color: PALETTE.cyan, intensity: 2.4, base: 0.9 })), {
        p: [0, -height / 2 - 0.001, 0],
      }),
    ],
    { p: position, r: rotation },
  )
  // 漂うパネル（動く物）
  markDynamic(object)
  return {
    object,
    screen,
    update(t: number) {
      object.position.y = position[1] + Math.sin(t * 0.6 + phase) * 0.008
    },
  }
}

/* -------------------------------------------------------------------------- */
/* 机の上と足もとの小物                                                         */
/* -------------------------------------------------------------------------- */

function keyboard(b: Build, position: Vec3, rotationY = 0): THREE.Group {
  const { mats, own } = b
  const keys: THREE.Matrix4[] = []
  const rows = 5
  const cols = 15
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * 0.0275
      const z = (r - (rows - 1) / 2) * 0.0255
      keys.push(new THREE.Matrix4().makeTranslation(x + (r % 2) * 0.006, 0.018, z))
    }
  }
  // スペースキー
  keys.push(new THREE.Matrix4().compose(new THREE.Vector3(0, 0.018, 0.078), new THREE.Quaternion(), new THREE.Vector3(6, 1, 1)))
  const keyGeom = own.add(new THREE.BoxGeometry(0.024, 0.012, 0.023))
  const keyMat = mat(b, new THREE.MeshStandardMaterial({ name: 'keycap', color: '#1a1e24', roughness: 0.6 }))
  const backlight = glowMaterial(PALETTE.cyan, 1.1)
  return group(
    [
      m(b, new THREE.BoxGeometry(0.44, 0.016, 0.16), mats.aluminium, { p: [0, 0.008, 0.005], cast: true, receive: true }),
      // キーの隙間から漏れるバックライト
      m(b, new THREE.PlaneGeometry(0.42, 0.14), backlight, { p: [0, 0.0165, 0.005], r: [-Math.PI / 2, 0, 0] }),
      own.add(matrixInstances({ matrices: keys, geometry: keyGeom, material: keyMat })),
    ],
    { p: position, ry: rotationY },
  )
}

function chair(b: Build, position: Vec3, rotationY = 0): THREE.Group {
  const { mats } = b
  const fabric = mat(b, new THREE.MeshStandardMaterial({ name: 'chairFabric', color: '#15191f', roughness: 0.9 }))
  const stripe = glowMaterial(PALETTE.blue, 1.4)
  return group(
    [
      ...[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2
        return group(
          [
            m(b, new THREE.BoxGeometry(0.04, 0.03, 0.32), mats.darkMetal, { p: [0, 0.06, 0.16], cast: true }),
            m(b, new THREE.SphereGeometry(0.028, 12, 8), mats.rubber, { p: [0, 0.03, 0.31] }),
          ],
          { ry: a },
        )
      }),
      m(b, new THREE.CylinderGeometry(0.025, 0.03, 0.4, 16), mats.chrome, { p: [0, 0.27, 0] }),
      m(b, new THREE.BoxGeometry(0.5, 0.08, 0.48), fabric, { p: [0, 0.48, 0], cast: true, receive: true }),
      m(b, new THREE.BoxGeometry(0.46, 0.66, 0.07), fabric, { p: [0, 0.85, 0.25], r: [0.12, 0, 0], cast: true, receive: true }),
      m(b, new THREE.BoxGeometry(0.012, 0.5, 0.004), stripe, { p: [0, 0.85, 0.29], r: [0.12, 0, 0] }),
      ...[-1, 1].map((s) =>
        group([
          m(b, new THREE.BoxGeometry(0.03, 0.2, 0.03), mats.darkMetal, { p: [s * 0.27, 0.6, 0.02] }),
          m(b, new THREE.BoxGeometry(0.06, 0.03, 0.26), mats.plasticDark, { p: [s * 0.27, 0.71, -0.02] }),
        ]),
      ),
    ],
    { p: position, ry: rotationY },
  )
}

/** 花音のヘッドホン（スタンドに掛けてある） */
function headphoneStand(b: Build, position: Vec3): THREE.Group {
  const { mats } = b
  const blue = mat(b, new THREE.MeshStandardMaterial({ name: 'headphoneBlue', color: '#1f4fa6', roughness: 0.45, metalness: 0.2 }))
  return group(
    [
      m(b, new THREE.CylinderGeometry(0.07, 0.08, 0.02, 24), mats.darkMetal, { p: [0, 0.01, 0] }),
      m(b, new THREE.CylinderGeometry(0.01, 0.01, 0.28, 12), mats.aluminium, { p: [0, 0.15, 0] }),
      group(
        [
          m(b, new THREE.TorusGeometry(0.085, 0.012, 10, 32, Math.PI), blue, { cast: true }),
          ...[-1, 1].map((s) => m(b, new THREE.CylinderGeometry(0.045, 0.045, 0.035, 24), blue, { p: [s * 0.085, -0.02, 0], r: [0, 0, Math.PI / 2], cast: true })),
        ],
        { p: [0, 0.27, 0] },
      ),
    ],
    { p: position },
  )
}

function pcTower(b: Build, position: Vec3): THREE.Group {
  const { mats } = b
  const fanGlow = glowMaterial(PALETTE.cyan, 2.4)
  // 前の JSX の値で、部品を作る前に引いていた発光の素材（前面の青い線）
  const lineGlow = glowMaterial(PALETTE.blue, 2.2)
  return group(
    [
      m(b, new THREE.BoxGeometry(0.22, 0.48, 0.46), mats.blackMetal, { p: [0, 0.24, 0], cast: true, receive: true }),
      // 側面のガラス越しの内部
      m(b, new THREE.PlaneGeometry(0.4, 0.4), mats.tintedGlass, { p: [-0.111, 0.26, 0], r: [0, -Math.PI / 2, 0] }),
      ...[0.13, 0.33].map((y) => m(b, new THREE.TorusGeometry(0.05, 0.004, 6, 32), fanGlow, { p: [-0.09, y, 0.15], r: [0, 0, Math.PI / 2] })),
      m(b, new THREE.BoxGeometry(0.04, 0.12, 0.24), mats.darkMetal, { p: [-0.08, 0.3, -0.05] }),
      m(b, new THREE.BoxGeometry(0.002, 0.01, 0.24), lineGlow, { p: [-0.105, 0.2, -0.05] }),
    ],
    { p: position },
  )
}

/* -------------------------------------------------------------------------- */

export function createDevDesk(at: Placement, _opts: object | undefined, ctx: LabKitContext): LabKitBody {
  const own = createOwned()
  const b: Build = { mats: ctx.materials, own, ctx }
  const { mats } = b
  const z0 = 0
  const deskFront = z0 + DESK_D
  const wingX = (WING.x0 + WING.x1) / 2
  const wingW = WING.x1 - WING.x0
  // 前の DevDesk の hooks の素材と、JSX の値で引いていた発光の素材（天板の縁の光）
  const mug = mat(b, new THREE.MeshStandardMaterial({ name: 'mugCeramic', color: '#e9edf1', roughness: 0.35 }))
  const strip = glowMaterial(PALETTE.blue, GLOW.strip)

  // 作る順は前の JSX のまま（置き場所の群の中: 天板・脚・短辺・短辺のモニタ・モニタの群・ヘッドホン・PC・椅子・配線）
  const children: THREE.Object3D[] = []
  // 天板
  children.push(m(b, new THREE.BoxGeometry(DESK_W, 0.04, DESK_D), mats.benchTop, { p: [0, DESK_H - 0.02, z0 + DESK_D / 2], cast: true, receive: true }))
  children.push(m(b, new THREE.BoxGeometry(DESK_W - 0.1, 0.006, 0.006), strip, { p: [0, DESK_H - 0.045, deskFront - 0.02] }))
  // 脚（板状）
  for (const s of [-1, 1]) {
    children.push(
      m(b, new THREE.BoxGeometry(0.05, DESK_H - 0.04, DESK_D - 0.06), mats.darkMetal, { p: [s * (DESK_W / 2 - 0.05), (DESK_H - 0.04) / 2, z0 + DESK_D / 2], cast: true, receive: true }),
    )
  }
  children.push(m(b, new THREE.BoxGeometry(DESK_W - 0.1, 0.25, 0.02), mats.darkMetal, { p: [0, 0.4, z0 + 0.12] }))
  // 短辺（L 字の東の端から北へ）: 天板・縁の光・脚・モニタ 1 面
  children.push(m(b, new THREE.BoxGeometry(wingW, 0.04, WING.d), mats.benchTop, { p: [wingX, DESK_H - 0.02, deskFront + WING.d / 2], cast: true, receive: true }))
  children.push(m(b, new THREE.BoxGeometry(0.006, 0.006, WING.d - 0.1), strip, { p: [WING.x1 - 0.02, DESK_H - 0.045, deskFront + WING.d / 2] }))
  children.push(m(b, new THREE.BoxGeometry(wingW - 0.06, DESK_H - 0.04, 0.05), mats.darkMetal, { p: [wingX, (DESK_H - 0.04) / 2, deskFront + WING.d - 0.05], cast: true, receive: true }))
  const wing = curvedMonitor(b, 'wing', { position: [WING.x0 + 0.2, DESK_H + 0.42, deskFront + 0.45], rotationY: Math.PI / 2, width: 0.55, height: 0.34, draw: drawTerminalScreen, resolution: 1024 })
  children.push(wing.object)

  // モニタ・キーボード・空中パネルの群（長辺の中心から MONITOR_X ずらす）
  const row: THREE.Object3D[] = []
  // モニタアーム
  row.push(m(b, new THREE.CylinderGeometry(0.02, 0.02, 0.4, 12), mats.aluminium, { p: [0, DESK_H + 0.2, z0 + 0.1] }))
  row.push(m(b, new THREE.BoxGeometry(1.76, 0.03, 0.03), mats.aluminium, { p: [0, DESK_H + 0.42, z0 + 0.12] }))
  // 曲面マルチモニタ（左: ターミナル / 中央: コード / 右: グラフ）。
  // 作品の作業が来ている間は、kanon-lab が作業の中継を入れる（中央: 打ち込むコードの差分 / 右: コマンドと結果 / 左: テスト・ビルドの結果の一覧）。
  // 寄りでも文字が読めるよう、中央は 2048 px・横は 1536 px の Canvas。中央のモニタからは、コードを大きく見せる飛び出しパネル（kanon-lab の dev.focus）が出てくる。
  // 配信の引きのカメラ（camera: cut desk）でも打ち込みが読めるよう、中央のモニタは大きめ（1.04 × 0.45 m）
  const center = curvedMonitor(b, 'center', { position: [0, DESK_H + 0.47, z0 + 0.2], width: CENTER.w, height: CENTER.h, draw: drawCodeScreen, fps: 12, resolution: 2048 })
  const left = curvedMonitor(b, 'left', { position: [-0.92, DESK_H + 0.45, z0 + 0.36], rotationY: 0.5, width: 0.62, height: 0.38, draw: drawTerminalScreen, resolution: 1536 })
  const right = curvedMonitor(b, 'right', { position: [0.92, DESK_H + 0.45, z0 + 0.36], rotationY: -0.5, width: 0.62, height: 0.38, draw: drawGraphScreen, fps: 12, resolution: 1536 })
  row.push(center.object, left.object, right.object)
  row.push(stickyNoteOwned(b, { position: [-0.43, DESK_H + 0.2, z0 + 0.238], rotation: [0, 0, 0.08], lines: ['配信', '21:00〜'], color: '#f3e79b', size: 0.06 }))
  row.push(stickyNoteOwned(b, { position: [0.3, DESK_H + 0.2, z0 + 0.238], rotation: [0, 0, -0.1], lines: ['XW-01', 'fw更新'], color: '#bfe6ff', size: 0.06 }))
  // 空中の UI パネル（この上の空間に、kanon-lab の作業の見出しを置く。アンカー devDesk.taskSign）
  const panels = [
    holoPanel(b, 'holoDiagnostics', { position: [-0.55, DESK_H + 0.98, z0 + 0.5], rotation: [0.05, 0.35, 0], width: 0.5, height: 0.3, draw: drawHoloDiagnostics }),
    holoPanel(b, 'holoPipeline', { position: [0.1, DESK_H + 1.05, z0 + 0.42], rotation: [0.05, 0, 0], width: 0.44, height: 0.32, draw: drawHoloPipeline, phase: 2.1 }),
    holoPanel(b, 'holoNetwork', { position: [0.72, DESK_H + 0.95, z0 + 0.52], rotation: [0.05, -0.4, 0], width: 0.42, height: 0.3, draw: drawHoloNetwork, phase: 4.3 }),
  ]
  row.push(...panels.map((p) => p.object))
  // 机の上
  row.push(
    m(b, new THREE.PlaneGeometry(0.9, 0.36), mat(b, new THREE.MeshStandardMaterial({ name: 'deskMat', color: '#0b0f15', roughness: 0.9 })), {
      p: [0.05, DESK_H + 0.002, deskFront - 0.24],
      r: [-Math.PI / 2, 0, 0],
      receive: true,
    }),
  )
  row.push(keyboard(b, [0, DESK_H + 0.003, deskFront - 0.24]))
  row.push(m(b, new THREE.CapsuleGeometry(0.028, 0.05, 4, 12), mats.plasticDark, { p: [0.36, DESK_H + 0.015, deskFront - 0.22], cast: true }))
  row.push(
    group(
      [
        m(b, new THREE.CylinderGeometry(0.042, 0.04, 0.1, 24), mug, { p: [0, 0.05, 0], cast: true }),
        m(b, new THREE.TorusGeometry(0.025, 0.007, 8, 16), mug, { p: [0.045, 0.05, 0] }),
        stickerOwned(b, { text: '0235', position: [0, 0.05, 0.043], width: 0.05, aspect: 2, background: 'transparent', color: '#1e6fff' }),
      ],
      { p: [-0.72, DESK_H, deskFront - 0.22] },
    ),
  )
  const monitorRow = group(row, { p: [MONITOR_X, 0, 0] })
  children.push(monitorRow)

  children.push(headphoneStand(b, [1.45, DESK_H, z0 + 0.45]))
  children.push(pcTower(b, [1.4, 0, z0 + 0.4]))
  // 椅子は脇に寄せてある（花音は立ったままキーボードを打つ。データの側の障害物「椅子」と同じ位置）
  children.push(chair(b, [-0.6, 0, deskFront + 0.55], Math.PI - 0.75))
  // モニタからの配線（素材は共有の物なので、控えるのは形だけ）
  for (const x of [-0.6, 0, 0.6]) {
    const wire = cable({
      points: [
        [x, DESK_H + 0.3, z0 + 0.1],
        [x * 0.8, DESK_H + 0.05, z0 + 0.05],
        [x * 0.5, DESK_H - 0.3, z0 + 0.04],
        [0.7, 0.05, z0 + 0.05],
      ],
      radius: 0.006,
      material: mats.rubber,
    })
    own.add(wire.geometry)
    children.push(wire)
  }
  const object = group(children, { p: at.position, ry: at.rotationY })

  // 中央のモニタの画面の中心の位置と向き（前の devAnchors.monitor と同じ式: モニタの群のワールドの行列から。キットの群は単位の行列の lab:kits の子に
  // 置くので、ここで出した値と場面の中の行列は同じ）
  const monitor: LabAnchor = {
    name: `${ctx.id}.monitor`,
    position: center.object.getWorldPosition(new THREE.Vector3()),
    quaternion: center.object.getWorldQuaternion(new THREE.Quaternion()),
    yaw: at.rotationY,
    size: { w: CENTER.w, h: CENTER.h },
  }

  return {
    object,
    update(dt, f) {
      // 前の購読の順: 短辺のモニタの画面 → 中央 → 左 → 右のモニタの画面 → 空中のパネル ×3（画面 → 漂い）
      wing.screen.update(dt, f.camera)
      center.screen.update(dt, f.camera)
      left.screen.update(dt, f.camera)
      right.screen.update(dt, f.camera)
      for (const p of panels) {
        p.screen.update(dt, f.camera)
        p.update(f.time)
      }
    },
    anchors: { monitor },
    screens: {
      wing: wing.screen,
      center: center.screen,
      left: left.screen,
      right: right.screen,
      holoDiagnostics: panels[0]!.screen,
      holoPipeline: panels[1]!.screen,
      holoNetwork: panels[2]!.screen,
    } satisfies Record<string, LabScreen>,
    dispose: () => own.dispose(),
  }
}

export const devDeskKit: LabKitDef = {
  kind: 'devDesk',
  plan: devDeskPlan,
  create: createDevDesk,
}
