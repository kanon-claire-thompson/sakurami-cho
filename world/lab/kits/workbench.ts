import * as THREE from 'three'
import { GLOW, PALETTE } from '../../palette'
import { glowMaterial, perforatedMaterial, type LabMaterials } from '../../materials/labMaterials'
import { cachedCanvasTexture } from '../../textures/canvas'
import { drawMachineScreen, drawOscilloscope } from '../../textures/screens'
import { createOwned, kitChannels, type LabKitBody, type LabKitContext, type LabKitDef, type Owned } from '../kit'
import { cable } from '../parts/cable'
import { glowBox, sticker, stickyNote, type GlowBoxOptions, type StickerOptions, type StickyNoteOptions } from '../parts/details'
import { group, mesh, type MeshOptions } from '../parts/object'
import type { Placement, Vec3 } from '../../../core/lab/plan'
import type { LabScreen } from '../screens'
import { ASSEMBLY_SPOT_LOCAL, BENCH_ORIGIN, BENCH_TOP, PRINTER_CABINET, PRINTER_ORIGIN, workbenchPlan } from '../../../core/lab/kits/workbench.plan'
import { markDynamic } from '../../staticMerge'

/**
 * 作業台（工作ゾーンの西の壁沿いの置き場所 workshop。資料: 西側。入口から奥を向いて左）: 作業台 + 有孔ボード（ローカル x 0.4）・3D プリンタ（-1.2）・
 * 作業台の電源タップと配線。ローカル座標: z = 0 が壁の面、+z が部屋の内側、+x が北（ワールド -z）。
 *
 * 前の zones/Workshop.tsx の Workbench・AssemblyMat・Pegboard・Printer3D と置き場所の群を、同じ入れ子・同じ子の順・同じ作る順
 * （部品ごとに hooks の素材と画面 → JSX の子の順。子を作ってから群）・手で書いた数と式のまま three の形にした物（docs/design/map-split.md §6 の「段 4」・4-7）。
 * 寸法・アンカー・障害物はデータの側（workbench.plan.ts）。キットの object は置き場所の群（位置と向き）。
 *
 * - channels（WorkbenchChannels）: printer（3D プリンタの様子。印刷中・ヘッドの位置・扉の開き具合・庫内の物体）。既定は止まっている
 *   （配信が無くてもノズルがゆっくりインフィルを描き、見本の造形物が育つ）。kanon-lab はワールドの物体の印刷（world.printer）を参照で結び付ける
 * - screens: scope（オシロスコープ。320×200・毎秒 15 回）・solder（はんだごて。128×64・4 回）・printer（プリンタの操作画面。160×96・4 回）。
 *   中身は地図の側の飾りの画面（textures/screens.ts）
 * - 毎コマ（前の購読の順）: オシロスコープの画面 → はんだごての画面 → プリンタの画面 → プリンタ（ヘッド・ガントリー・扉・造形物）
 */

/** 3D プリンタの様子（入力の値。読むたびに見る） */
export interface PrinterJob {
  /** 印刷中（ノズルがワールドの物体の層の高さで動く） */
  readonly active: boolean
  /** ヘッドの左右の位置（-1〜1） */
  readonly headX: number
  /** ノズルの先の高さ（ベッドの天面から、m） */
  readonly headY: number
  /** ヘッドの前後の位置（-1〜1） */
  readonly headZ: number
  /** 前の扉の開き具合（0〜1） */
  readonly door: number
  /** 庫内に物体がある（止まっているときの見本の造形物を隠す） */
  readonly occupied: boolean
}

/** 作業台の入力の値 */
export interface WorkbenchChannels {
  /** 3D プリンタの様子（読むたびに見る。使う側の物を参照で渡せば、その値をそのまま読む） */
  printer: PrinterJob
}

/** 止まっているプリンタ（既定の入力の値） */
export const PRINTER_IDLE: Readonly<PrinterJob> = { active: false, headX: 0, headY: 0.3, headZ: 0, door: 0, occupied: false }

const BENCH_H = BENCH_TOP
/**
 * 作業台の天板の前の縁（アルミ）を、天板の前の面・横の面より出す量（1mm）。
 * 4-0b で決めた（持ち主が画を見て決めた）: もとは縁の前の面が天板の前の面と同じ z、横の面も同じ x にあり、
 * 作る順（material.id）でどちらが見えるかが決まっていた。縁を見せる向きにそろえた
 */
const BENCH_EDGE_PROUD = 0.001

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
/** GlowBox（形は作った物、素材はキャッシュの発光の素材） */
const glowBoxOwned = (b: Build, o: GlowBoxOptions) => {
  const x = glowBox(o)
  b.own.add(x.geometry)
  return x
}
const stickerOwned = (b: Build, o: StickerOptions) => b.own.mesh(sticker(o))
const stickyNoteOwned = (b: Build, o: StickyNoteOptions) => b.own.mesh(stickyNote(o))
/** 画面の板の素材（発光の絵に画面。前の JSX の <meshStandardMaterial color="#000" emissive="#fff" …>） */
const screenMaterial = (b: Build, screen: LabScreen, emissiveIntensity: number, roughness?: number) =>
  mat(
    b,
    new THREE.MeshStandardMaterial({
      name: 'benchScreen',
      color: '#000',
      emissive: '#fff',
      emissiveMap: screen.texture,
      emissiveIntensity,
      ...(roughness !== undefined ? { roughness } : {}),
      toneMapped: false,
    }),
  )

/* -------------------------------------------------------------------------- */
/* 作業台                                                                       */
/* -------------------------------------------------------------------------- */

function workbench(b: Build, position: Vec3) {
  const { mats, own } = b
  const scope = own.add(b.ctx.screens('scope', 320, 200, drawOscilloscope, 15))
  const solder = own.add(b.ctx.screens('solder', 128, 64, drawMachineScreen('350°C', 'IRON  READY'), 4))
  const lampRing = glowMaterial('#eef6ff', GLOW.strong)
  const W = 2.0
  const D = 0.8
  const matMat = mat(b, new THREE.MeshStandardMaterial({ name: 'cuttingMat', color: '#10243d', roughness: 0.85 }))

  const object = group(
    [
      // 天板と脚
      m(b, new THREE.BoxGeometry(W, 0.05, D), mats.benchTop, { p: [0, BENCH_H - 0.025, D / 2], cast: true, receive: true }),
      m(b, new THREE.BoxGeometry(W + BENCH_EDGE_PROUD * 2, 0.05, 0.02), mats.aluminium, { p: [0, BENCH_H - 0.06, D - 0.01 + BENCH_EDGE_PROUD] }),
      ...[-1, 1].flatMap((s) =>
        [0.08, D - 0.08].map((z) => m(b, new THREE.BoxGeometry(0.05, BENCH_H - 0.05, 0.05), mats.aluminium, { p: [s * (W / 2 - 0.06), (BENCH_H - 0.05) / 2, z], cast: true })),
      ),
      m(b, new THREE.BoxGeometry(W - 0.1, 0.02, D - 0.1), mats.darkMetal, { p: [0, 0.2, D / 2], receive: true }),
      // 下段の工具ワゴン
      m(b, new THREE.BoxGeometry(0.6, 0.3, 0.5), mats.darkMetal, { p: [-0.7, 0.36, D / 2 + 0.05], cast: true, receive: true }),
      ...[0.26, 0.36, 0.46].map((y) => m(b, new THREE.BoxGeometry(0.3, 0.012, 0.012), mats.steel, { p: [-0.7, y, D / 2 + 0.305] })),

      // 帯電防止マット
      m(b, new THREE.PlaneGeometry(0.9, 0.5), matMat, { p: [0.15, BENCH_H + 0.002, 0.45], r: [-Math.PI / 2, 0, 0], receive: true }),
      // 作りかけの KB-001（上半分を外した状態）
      group(
        [
          m(b, new THREE.SphereGeometry(0.15, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), mats.whitePaint, { r: [Math.PI, 0, 0], cast: true, receive: true }),
          m(b, new THREE.CylinderGeometry(0.13, 0.13, 0.006, 32), mats.pcb),
          m(b, new THREE.BoxGeometry(0.07, 0.05, 0.05), mats.darkMetal, { p: [0, 0.03, 0] }),
          glowBoxOwned(b, { position: [0.04, 0.012, 0.04], size: [0.012, 0.004, 0.012], color: PALETTE.cyan, intensity: 3 }),
          m(b, new THREE.SphereGeometry(0.15, 40, 12, 0, Math.PI * 2, 0, 1.0), mats.whitePaint, { p: [0.3, -0.07, 0.05], r: [0.2, 0.6, 0.4], cast: true }),
        ],
        { p: [0.15, BENCH_H + 0.12, 0.45] },
      ),
      // 組み立ての場所（ワールドの物体の world.spawn how=assemble。アンカー workshop.bench.assembly）
      assemblyMat(b),
      // 基板と小物（組み立ての場所をあけて、端に寄せてある）
      m(b, new THREE.BoxGeometry(0.14, 0.006, 0.1), mats.pcb, { p: [-0.82, BENCH_H + 0.006, 0.3], r: [0, 0.3, 0], cast: true }),
      ...(
        [
          [0.95, 0.64, 0.2],
          [1.07, 0.44, -0.4],
          [0.55, 0.66, 0.1],
        ] as const
      ).map(([x, z, r], i) =>
        m(b, new THREE.BoxGeometry(0.12, 0.04, 0.08), i === 1 ? mats.plasticGrey : mats.plasticDark, { p: [x, BENCH_H + 0.02, z], r: [0, r, 0], cast: true }),
      ),
      // はんだごてステーション
      group(
        [
          m(b, new THREE.BoxGeometry(0.18, 0.12, 0.16), mats.plasticDark, { p: [0, 0.06, 0], cast: true }),
          m(b, new THREE.PlaneGeometry(0.1, 0.05), screenMaterial(b, solder, 1), { p: [0, 0.07, 0.081] }),
          m(b, new THREE.CylinderGeometry(0.025, 0.018, 0.14, 12, 1, true), mats.steel, { p: [0.16, 0.08, 0], r: [0, 0, 0.5] }),
          m(b, new THREE.CylinderGeometry(0.012, 0.01, 0.16, 10), mats.plasticDark, { p: [0.2, 0.09, 0.02], r: [0, 0, 1.0] }),
        ],
        { p: [-0.75, BENCH_H, 0.35] },
      ),
      // オシロスコープ（棚の上）
      m(b, new THREE.BoxGeometry(1.6, 0.02, 0.26), mats.aluminium, { p: [0.2, BENCH_H + 0.2, 0.14], receive: true }),
      ...[-0.7, 0.9].map((x) => m(b, new THREE.BoxGeometry(0.03, 0.2, 0.24), mats.aluminium, { p: [x, BENCH_H + 0.1, 0.14] })),
      group(
        [
          m(b, new THREE.BoxGeometry(0.38, 0.2, 0.18), mats.plasticGrey, { cast: true }),
          m(b, new THREE.PlaneGeometry(0.22, 0.14), screenMaterial(b, scope, 1.2, 0.25), { p: [-0.05, 0, 0.091] }),
          ...[0, 1, 2, 3].map((i) =>
            m(b, new THREE.CylinderGeometry(0.012, 0.012, 0.012, 16), mats.plasticDark, {
              p: [0.12 + (i % 2) * 0.04, 0.04 - Math.floor(i / 2) * 0.05, 0.095],
              r: [Math.PI / 2, 0, 0],
            }),
          ),
        ],
        { p: [0.55, BENCH_H + 0.3, 0.15] },
      ),
      // 部品ケース（棚の上）
      ...[-0.45, -0.25, -0.05].map((x, i) =>
        m(b, new THREE.BoxGeometry(0.17, 0.08, 0.2), i === 1 ? mats.plasticGrey : mats.plasticDark, { p: [x, BENCH_H + 0.25, 0.14], cast: true }),
      ),
      // 拡大鏡ライト
      group(
        [
          m(b, new THREE.CylinderGeometry(0.03, 0.03, 0.1, 12), mats.darkMetal, { p: [0, 0.05, 0] }),
          m(b, new THREE.CylinderGeometry(0.01, 0.01, 0.5, 8), mats.steel, { p: [-0.08, 0.3, 0.1], r: [0.4, 0, 0.35] }),
          m(b, new THREE.TorusGeometry(0.08, 0.018, 10, 36), mats.plasticDark, { p: [-0.2, 0.52, 0.28], r: [0.9, 0, 0.2] }),
          m(b, new THREE.RingGeometry(0.065, 0.078, 36), lampRing, { p: [-0.2, 0.505, 0.285], r: [0.9 + Math.PI / 2, 0, 0.2] }),
        ],
        { p: [0.82, BENCH_H, 0.15] },
      ),
      // 万力
      group(
        [
          m(b, new THREE.BoxGeometry(0.12, 0.08, 0.22), mats.darkMetal, { p: [0, 0.04, 0], cast: true }),
          m(b, new THREE.BoxGeometry(0.14, 0.06, 0.03), mats.steel, { p: [0, 0.1, 0.06], cast: true }),
          m(b, new THREE.BoxGeometry(0.14, 0.06, 0.03), mats.steel, { p: [0, 0.1, -0.03], cast: true }),
          m(b, new THREE.CylinderGeometry(0.008, 0.008, 0.16, 8), mats.chrome, { p: [0, 0.06, 0.16], r: [Math.PI / 2, 0, 0] }),
        ],
        { p: [-0.84, BENCH_H, 0.65] },
      ),
      stickyNoteOwned(b, { position: [0.78, BENCH_H + 0.221, 0.2], rotation: [-Math.PI / 2, 0, 0.2], lines: ['耳サーボ', 'ガタ確認!'], color: '#f3e79b' }),
      stickyNoteOwned(b, { position: [-0.52, BENCH_H + 0.321, 0.241], rotation: [0, 0, -0.05], lines: ['M2 ネジ', '残り少'], color: '#bfe6ff', size: 0.06 }),
    ],
    { p: position },
  )
  return { object, scope, solder }
}

/** 組み立ての場所の小さなマット（作業台のローカル。縁が光る） */
function assemblyMat(b: Build): THREE.Group {
  const [x, z] = ASSEMBLY_SPOT_LOCAL
  const matMat = mat(b, new THREE.MeshStandardMaterial({ name: 'assemblyMat', color: '#0b1a2c', roughness: 0.9 }))
  const edge = glowMaterial(PALETTE.cyan, 1.4)
  return group(
    [
      m(b, new THREE.PlaneGeometry(0.32, 0.27), matMat, { r: [-Math.PI / 2, 0, 0], receive: true }),
      ...(
        [
          [0, 0.135, 0.32, 0.004],
          [0, -0.135, 0.32, 0.004],
          [0.16, 0, 0.004, 0.27],
          [-0.16, 0, 0.004, 0.27],
        ] as const
      ).map(([ex, ez, w, d]) => m(b, new THREE.PlaneGeometry(w, d), edge, { p: [ex, 0.0006, ez], r: [-Math.PI / 2, 0, 0] })),
    ],
    { p: [x, BENCH_H + 0.0035, z] },
  )
}

/* -------------------------------------------------------------------------- */
/* 有孔ボード                                                                   */
/* -------------------------------------------------------------------------- */

function pegboard(b: Build, position: Vec3): THREE.Group {
  const { mats, own } = b
  const W = 2.2
  const H = 1.15
  // 穴のピッチ約 25mm（テクスチャ 1 枚 ≒ 0.28m）
  const boardMat = own.add(perforatedMaterial(mats, W / 0.28, H / 0.28))
  for (const t of [boardMat.alphaMap, boardMat.normalMap]) if (t) own.add(t)
  // 工具のシルエット（シャドーボード）
  const shadowTex = cachedCanvasTexture('pegboard-shadow', 1024, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(160,190,215,0.22)'
    const sx = w / W
    const sy = h / H
    const shapes: [number, number, number, number][] = [
      [0.25, 0.3, 0.05, 0.45],
      [0.38, 0.3, 0.05, 0.42],
      [0.5, 0.3, 0.05, 0.38],
      [1.25, 0.25, 0.08, 0.5],
      [1.45, 0.25, 0.08, 0.5],
    ]
    for (const [x, y, ww, hh] of shapes) ctx.fillRect(x * sx, y * sy, ww * sx, hh * sy)
  })
  // 工具：[x, y(上端), 長さ, 太さ, 種類]
  const tools: { x: number; y: number; len: number; r: number; kind: 'wrench' | 'driver' | 'plier' | 'hammer' }[] = []
  ;[0.26, 0.36, 0.46, 0.56, 0.66].forEach((x, i) => tools.push({ x, y: 0.95, len: 0.2 + i * 0.035, r: 0.012 + i * 0.002, kind: 'wrench' }))
  ;[0.9, 0.98, 1.06, 1.14, 1.22].forEach((x, i) => tools.push({ x, y: 0.95, len: 0.22 + (i % 3) * 0.03, r: 0.014, kind: 'driver' }))
  tools.push({ x: 1.5, y: 0.95, len: 0.22, r: 0.02, kind: 'plier' }, { x: 1.66, y: 0.95, len: 0.2, r: 0.02, kind: 'plier' })
  tools.push({ x: 1.9, y: 0.95, len: 0.32, r: 0.016, kind: 'hammer' })
  const driverColors = [mats.plasticDark, mats.plasticGrey]
  const driverAccent = glowMaterial(PALETTE.cyan, 0.9)

  const tool = (t: (typeof tools)[number], i: number): THREE.Group => {
    const x = t.x
    const top = t.y
    if (t.kind === 'wrench') {
      return group(
        [
          m(b, new THREE.BoxGeometry(t.r * 1.4, t.len, 0.006), mats.chrome, { cast: true }),
          m(b, new THREE.TorusGeometry(t.r * 1.2, t.r * 0.45, 6, 16, Math.PI * 1.6), mats.chrome, { p: [0, t.len / 2 + t.r * 0.8, 0], r: [0, 0, -Math.PI * 0.3] }),
          m(b, new THREE.TorusGeometry(t.r, t.r * 0.4, 6, 16), mats.chrome, { p: [0, -t.len / 2 - t.r * 0.6, 0] }),
        ],
        { p: [x, top - t.len / 2, 0.05] },
      )
    }
    if (t.kind === 'driver') {
      return group(
        [
          m(b, new THREE.CylinderGeometry(t.r, t.r * 1.1, 0.1, 12), driverColors[i % 2]!, { p: [0, -0.05, 0], cast: true }),
          m(b, new THREE.CylinderGeometry(t.r * 1.05, t.r * 1.05, 0.006, 12), driverAccent, { p: [0, -0.02, 0] }),
          m(b, new THREE.CylinderGeometry(0.0035, 0.0035, t.len, 8), mats.chrome, { p: [0, -0.1 - t.len / 2, 0] }),
        ],
        { p: [x, top, 0.05] },
      )
    }
    if (t.kind === 'plier') {
      return group(
        [
          ...[-1, 1].map((s) => m(b, new THREE.BoxGeometry(0.014, 0.14, 0.012), mats.plasticDark, { p: [s * 0.015, -0.03, 0], r: [0, 0, s * 0.12], cast: true })),
          m(b, new THREE.BoxGeometry(0.022, 0.07, 0.01), mats.steel, { p: [0, 0.07, 0] }),
        ],
        { p: [x, top - 0.1, 0.05] },
      )
    }
    return group(
      [
        m(b, new THREE.CylinderGeometry(0.013, 0.015, 0.3, 10), mats.plasticDark, { cast: true }),
        m(b, new THREE.CylinderGeometry(0.02, 0.02, 0.11, 12), mats.steel, { p: [0, 0.16, 0], r: [0, 0, Math.PI / 2], cast: true }),
      ],
      { p: [x, top - 0.18, 0.05] },
    )
  }

  return group(
    [
      // 枠
      m(b, new THREE.BoxGeometry(W + 0.06, H + 0.06, 0.02), mats.darkMetal, { p: [W / 2, H / 2, 0.012], receive: true }),
      m(b, new THREE.PlaneGeometry(W, H), boardMat, { p: [W / 2, H / 2, 0.026], receive: true }),
      m(b, new THREE.PlaneGeometry(W, H), mat(b, new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false })), {
        p: [W / 2, H / 2, 0.027],
      }),
      // 工具
      ...tools.map(tool),
      // フック
      ...tools.map((t) => m(b, new THREE.CylinderGeometry(0.003, 0.003, 0.04, 6), mats.steel, { p: [t.x, t.y + 0.015, 0.04], r: [Math.PI / 2, 0, 0] })),
      stickyNoteOwned(b, { position: [0.1, 0.9, 0.04], rotation: [0, 0, 0.06], lines: ['トルク', '0.6 N·m'], color: '#f3e79b' }),
      stickyNoteOwned(b, { position: [2.05, 0.35, 0.04], rotation: [0, 0, -0.08], lines: ['CNC 刃', '交換 10/2'], color: '#ffc9d6' }),
      stickerOwned(b, { text: '0235', position: [1.1, 0.13, 0.04], width: 0.16, aspect: 2.2, background: '#0b1522', color: '#3de0ff' }),
    ],
    { p: position },
  )
}

/* -------------------------------------------------------------------------- */
/* 3D プリンタ                                                                  */
/* -------------------------------------------------------------------------- */

function printer3D(b: Build, position: Vec3, ch: Readonly<WorkbenchChannels>) {
  const { mats, own } = b
  const screen = own.add(b.ctx.screens('printer', 160, 96, drawMachineScreen('PRINT', 'shell-A  PLA'), 4))
  const light = glowMaterial('#eaf4ff', GLOW.strip)
  const nozzleGlow = glowMaterial(PALETTE.amber, 2.5)
  const W = 0.6
  const HH = 0.66
  const D = 0.6
  const CAB = PRINTER_CABINET

  const frameEdges: { p: Vec3; s: Vec3 }[] = []
  const e = 0.03
  for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) frameEdges.push({ p: [x, HH / 2, z], s: [e, HH, e] })
  for (const y of [0, HH]) for (const z of [-D / 2, D / 2]) frameEdges.push({ p: [0, y, z], s: [W, e, e] })
  for (const y of [0, HH]) for (const x of [-W / 2, W / 2]) frameEdges.push({ p: [x, y, 0], s: [e, e, D] })
  // 前の JSX の値で、部品を作る前に引いていた発光の素材（ヘッドの表示灯）
  const headLamp = glowMaterial(PALETTE.cyan, 2.5)

  const children: THREE.Object3D[] = []
  // キャビネット
  children.push(m(b, new THREE.BoxGeometry(0.72, CAB, 0.66), mats.darkMetal, { p: [0, CAB / 2, 0], cast: true, receive: true }))
  for (const y of [0.22, 0.5]) children.push(m(b, new THREE.BoxGeometry(0.24, 0.015, 0.015), mats.steel, { p: [0, y, 0.332] }))
  // フィラメントのスプール
  children.push(
    group(
      [
        m(b, new THREE.CylinderGeometry(0.1, 0.1, 0.06, 32), mats.plasticDark, { r: [0, 0, Math.PI / 2] }),
        m(b, new THREE.CylinderGeometry(0.085, 0.085, 0.062, 32), mats.whitePaint, { r: [0, 0, Math.PI / 2] }),
        m(b, new THREE.BoxGeometry(0.02, 0.16, 0.06), mats.darkMetal, { p: [-0.04, -0.07, 0] }),
      ],
      { p: [0.42, CAB + 0.14, 0] },
    ),
  )
  // 庫内（フレーム・窓・照明・ベッドと造形物・ガントリーとヘッド・操作画面）
  const inner: THREE.Object3D[] = []
  // フレーム
  for (const f of frameEdges) inner.push(m(b, new THREE.BoxGeometry(), mats.aluminium, { p: f.p, s: f.s, cast: true }))
  // 窓（左右・前・上）。前は扉（KB-001 がワールドの物体を出し入れするときに開く）
  const door = group([m(b, new THREE.PlaneGeometry(W - 0.03, HH - 0.03), mats.tintedGlass, { p: [W / 2, HH / 2, 0], order: 2 })], { p: [-W / 2, 0, D / 2 + 0.012] })
  inner.push(door)
  for (const s of [-1, 1]) {
    inner.push(m(b, new THREE.PlaneGeometry(D - 0.03, HH - 0.03), mats.tintedGlass, { p: [s * (W / 2 + 0.012), HH / 2, 0], r: [0, Math.PI / 2, 0], order: 2 }))
  }
  inner.push(m(b, new THREE.PlaneGeometry(W, HH), mats.darkMetal, { p: [0, HH / 2, -D / 2 + 0.01] }))
  inner.push(m(b, new THREE.PlaneGeometry(W, D), mats.tintedGlass, { p: [0, HH + 0.015, 0], r: [-Math.PI / 2, 0, 0] }))
  // 庫内照明
  inner.push(m(b, new THREE.BoxGeometry(W - 0.08, 0.008, 0.01), light, { p: [0, HH - 0.03, D / 2 - 0.04] }))
  // ベッドと造形物
  inner.push(m(b, new THREE.BoxGeometry(0.42, 0.012, 0.42), mats.steel, { p: [0, 0.12, 0], receive: true }))
  const part = m(b, new THREE.CylinderGeometry(0.1, 0.13, 0.12, 40, 1, false), mats.whitePaint, { p: [0, 0.126, 0], cast: true })
  inner.push(part)
  // ガントリーとヘッド
  const gantry = group(
    [
      m(b, new THREE.CylinderGeometry(0.008, 0.008, W - 0.04, 8), mats.chrome, { r: [0, 0, Math.PI / 2] }),
      group([
        m(b, new THREE.BoxGeometry(0.07, 0.07, 0.06), mats.plasticDark, { cast: true }),
        m(b, new THREE.ConeGeometry(0.012, 0.03, 12), mats.chrome, { p: [0, -0.05, 0] }),
        m(b, new THREE.SphereGeometry(0.004, 8, 8), nozzleGlow, { p: [0, -0.066, 0] }),
        m(b, new THREE.BoxGeometry(0.03, 0.006, 0.002), headLamp, { p: [0, 0.035, 0.031] }),
      ]),
    ],
    { p: [0, 0.4, 0] },
  )
  const head = gantry.children[1]!
  // 動くガントリーとヘッド・扉・育つ造形物（動く物）
  markDynamic(gantry, head, door, part)
  inner.push(gantry)
  // 操作画面
  inner.push(m(b, new THREE.PlaneGeometry(0.14, 0.085), screenMaterial(b, screen, 1.1), { p: [0.18, 0.05, D / 2 + 0.02], r: [-0.3, 0, 0] }))
  inner.push(stickerOwned(b, { text: '0235', sub: 'FAB-02', position: [-0.18, 0.05, D / 2 + 0.018], width: 0.12, aspect: 2, background: '#e9edf1', color: '#0b1522' }))
  children.push(group(inner, { p: [0, CAB, 0] }))
  // フィラメントのチューブ
  const tube = cable({
    points: [
      [0.42, CAB + 0.2, 0],
      [0.38, CAB + HH + 0.12, 0.05],
      [0.1, CAB + HH + 0.05, 0.05],
      [0.02, CAB + 0.45, 0],
    ],
    radius: 0.004,
    material: mats.plasticGrey,
  })
  own.add(tube.geometry)
  children.push(tube)

  return {
    object: group(children, { p: position }),
    screen,
    update(dt: number, t: number) {
      const job = ch.printer
      // ノズルはジグザグにインフィルを描く。ワールドの物体を印刷しているときは、その層の高さで動く（入力の値 printer）
      head.position.x = job.active ? job.headX * 0.14 : Math.sin(t * 2.3) * 0.12
      gantry.position.z = job.active ? job.headZ * 0.12 : Math.sin(t * 0.7) * 0.1
      // ノズルの先（ヘッドの中心から 0.066 下）が、ベッドの天面（0.126）から headY の高さ
      const wantY = job.active ? Math.min(HH - 0.08, 0.126 + job.headY + 0.066) : 0.4
      gantry.position.y += (wantY - gantry.position.y) * (1 - Math.exp(-Math.min(dt, 0.05) * (job.active ? 14 : 2)))
      door.rotation.y = -job.door * 1.75
      // 造形物がゆっくり育つ（30 秒周期）。ワールドの物体が入っている・印刷しているときは出さない
      part.visible = !job.active && !job.occupied
      const g = 0.25 + ((t * 0.02) % 1) * 0.75
      part.scale.y = g
    },
  }
}

/* -------------------------------------------------------------------------- */

export function createWorkbench(at: Placement, _opts: object | undefined, ctx: LabKitContext): LabKitBody<WorkbenchChannels> {
  const own = createOwned()
  const channels = kitChannels<WorkbenchChannels>({ printer: PRINTER_IDLE })
  const b: Build = { mats: ctx.materials, own, ctx }
  const z0 = BENCH_ORIGIN[2]
  const [bx] = BENCH_ORIGIN

  // 作る順は前の JSX のまま（置き場所の群の中: 作業台・有孔ボード・3D プリンタ・作業台の電源タップと配線）
  const bench = workbench(b, [bx, 0, z0])
  const board = pegboard(b, [bx - 0.9, BENCH_H + 0.3, z0])
  const printer = printer3D(b, [PRINTER_ORIGIN[0], 0, PRINTER_ORIGIN[2]], channels.channels)
  // 作業台の電源タップと配線（作業台の下から壁沿いに北へ。素材は共有の物なので、控えるのは形だけ）
  const power = cable({
    points: [
      [bx + 0.9, 0.15, z0 + 0.03],
      [bx + 1.25, 0.03, z0 + 0.1],
      [bx + 1.7, 0.03, z0 + 0.12],
    ],
    radius: 0.014,
    material: b.mats.rubber,
  })
  own.add(power.geometry)
  const object = group([bench.object, board, printer.object, power], { p: at.position, ry: at.rotationY })

  return {
    object,
    update(dt, f) {
      // 前の購読の順: オシロスコープの画面 → はんだごての画面 → プリンタの画面 → プリンタ
      bench.scope.update(dt, f.camera)
      bench.solder.update(dt, f.camera)
      printer.screen.update(dt, f.camera)
      printer.update(dt, f.time)
    },
    screens: { scope: bench.scope, solder: bench.solder, printer: printer.screen },
    channels,
    dispose: () => own.dispose(),
  }
}

export const workbenchKit: LabKitDef<object, WorkbenchChannels> = {
  kind: 'workbench',
  plan: workbenchPlan,
  create: createWorkbench,
}
