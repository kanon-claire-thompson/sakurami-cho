/**
 * ラボの什器のキットの口（world/lab/kit.ts・kits/index.ts・kits/plans.ts・createLab.ts。docs/design/map-split.md §6 の 4-5）の見張り:
 *   - 登録: 新しい種類を足すと plan と作る側が引ける。plan を一度読んだ種類は、違う plan に差し替えられない（読み込みの時の定数に使ったため）。
 *     同じ plan の関数での登録（作る側だけの差し替え）はよい
 *   - createLab: キットは置き場所の表の順に作る（10 種とも作る側を持つ。4-11 から create は必須）。表から外した什器は作らない。
 *     キットの入力の値・差し込み口の中身・画面の中身はラボの口から入る。アンカー・障害物は plan のまま
 *   - 基地局（4-6）: 前の BaseStation.tsx と同じ入れ子（単位の行列の群 → 置き場所の群・床のケーブル・危険線）。入力の値（リングの加速・
 *     通信のグリーン・フラッシュ・脈）は読むたびに見て、リング・管・コア・画面と照明のコアの光が読む。画面 2 つは作る時に中身が入り、
 *     最初の更新で描く。4-0b の 2 つの直し（銀の縁を出す・ガラス → 光る球の順）がそのまま
 *   - 作業台 ×3（4-7）: 前の Workshop.tsx と同じ入れ子（置き場所の群 → 作業台・有孔ボード・3D プリンタ・配線／CNC・パーツケース・下のキャビネット／
 *     作業範囲の印・アーム・治具の台）。プリンタの入力の値 printer は読むたびに見て、ヘッド・ガントリー・扉・見本の造形物が読む。画面 4 つ
 *     （scope・solder・printer・cnc）は前の大きさと回数で、毎コマは前の購読の順（画面 → プリンタ）。4-0b の作業台の縁の直しがそのまま
 *   - 開発デスク（4-8）: 前の DevDesk.tsx と同じ入れ子（置き場所の群 → 天板・脚・短辺・短辺のモニタ・モニタの群（x MONITOR_X）・ヘッドホン・PC・椅子・配線）。
 *     作業の見出しは外した（アンカー taskSign に置くと、行列が前の入れ子と最後の桁まで同じ）。中央のモニタのアンカー monitor は作った時に行列から。
 *     画面 7 つは前の大きさと回数で、毎コマは前の購読の順。インスタンスの側のアンカー lab.anchors は作ったキットの物
 *   - ホロテーブル（4-9）: 前の HoloTable.tsx と同じ入れ子（置き場所の群 → 台・投影の光・光のにじみ・投影の中身の根）。投影の中身の高さ HOLO_Y は plan の値。
 *     入力の値 projection は読むたびに見て、根の出し入れの大きさが前の式で寄る。差し込み口 projection の中身はラボの口から入り、毎コマ根を動かす前に
 *     update を呼ぶ（中身の名札は根の前のコマの回転を見る）。中身の分解図（kanon-lab の kb001/holoExploded.ts）は Bun では読めない（config/runtime が
 *     window を読む）ので、ブラウザの確かめで見る
 *   - ギャラリー（4-10）: 前の Gallery.tsx と同じ入れ子（置き場所の群 → タイトルパネル・展示棚・壁のライン・ケース ×3）。展示棚の段の x・ケースの位置は plan の値。
 *     KB-α・KB-β は地図の飾りの模型、KB-γ は差し込み口 case.3（入れ物は前の回る台の群。毎コマ中身の update → 台を回す）。opts は段の数・展示・パネルの文字。
 *     kanon-lab は KB-001 の模型（R3F）を portal で入れる（sakurami-cho/react/LabView.tsx の LabSlot）ので、ブラウザの確かめで見る
 *   - KB-001 のドック（4-11）: 前の KB001.tsx の Dock・GlowSprite・電源のケーブルと同じ入れ子（置き場所の群 → ドック・光のにじみ・ケーブル）。
 *     台座の高さは plan の KB001_DOCK_TOP。毎コマ光のにじみがカメラを向く。opts は支柱の名札の文字。アンカー hover・pad と障害物は plan のまま
 *   - サーバラック: 前の ServerRack.tsx と同じ群の位置・子の並び・LED の数。LED は毎秒 20 回だけ色を変える。4-0b のレールの直しがそのまま
 *   - 窓際の植物: 群は単位の行列（置き場所は原点）。部品の数が前と同じ（乱数の種も同じ）
 *   - dispose はキットの物を捨て、共有の素材・キャッシュの素材は捨てない。ラボの dispose は照明・殻・キット・空気を捨てる
 * Canvas は Bun に無いので、描く物は何もしない Canvas の代わりで作る（lab-shell.test.ts と同じ）。地図のコードは実行の時に読む（型は使う所だけ）
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as THREE from 'three'

const LAB = '../world/lab'
const LAB_CORE = '../core/lab'
const load = async <T>(path: string): Promise<T> => (await import(path)) as T

type V3 = [number, number, number]
interface Placement {
  id: string
  kit: string
  at: { position: V3; rotationY: number }
  opts?: object
}
interface Obstacle {
  name: string
}
interface KitPlan {
  anchors: Record<string, { p: V3; yaw?: number }>
  obstacles: Obstacle[]
}
type PlanFn = (at: Placement['at'], opts?: object) => KitPlan
interface Frame {
  time: number
  camera: THREE.Camera
  renderer: unknown
  scene: THREE.Scene
}
interface Slot {
  object: THREE.Group
  content: unknown
}
interface Kit {
  id: string
  kind: string
  object: THREE.Object3D
  update(dt: number, f: Frame): void
  anchors: Record<string, { name: string; position: THREE.Vector3; yaw: number }>
  screens: Record<string, Screen>
  channels: Record<string, number>
  obstacles: readonly Obstacle[]
  slots: Record<string, Slot>
  dispose(): void
}
interface Body {
  object: THREE.Object3D
  update?(dt: number, f: Frame): void
  channels?: unknown
  slots?: Record<string, Slot>
  dispose?(): void
}
interface Ctx {
  id: string
  materials: Mats
  quality: 'high' | 'low'
  maxAnisotropy: number
  screens: (name: string, w: number, h: number, draw: Draw, fps: number) => Screen
}
type Draw = (ctx: unknown, t: number, w: number, h: number) => void
interface Screen {
  key: string
  width: number
  height: number
  fps: number
  texture: THREE.Texture
  update(dt: number, camera: THREE.Camera): void
}
interface Def {
  kind: string
  plan: PlanFn
  create?: (at: Placement['at'], opts: object | undefined, ctx: Ctx) => Body
}
interface KitMod {
  registerLabKit(def: Def): void
  kitChannels<C extends object>(defaults: C): { channels: Readonly<C>; bind(s: Partial<C> | null): void }
  createLabSlot(name: string): Slot
  assembleLabKit(id: string, kind: string, at: Placement['at'], plan: KitPlan, body: Body): Kit
}
interface KitsMod {
  LAB_KITS: Record<string, Def>
  labKitDef(kind: string): Def | undefined
}
interface PlansMod {
  LAB_KIT_PLANS: Record<string, PlanFn>
  labKitPlanFn(kind: string): PlanFn | undefined
}
interface PlacementsMod {
  LAB_PLACEMENTS: readonly Placement[]
  labKitPlanOf(id: string, placements?: readonly Placement[]): KitPlan | undefined
  labObstacles(id: string, placements?: readonly Placement[]): readonly Obstacle[]
}
interface AnchorsMod {
  labAnchor(name: string, placements?: readonly Placement[]): { p: V3; yaw: number }
}
interface Mats {
  blackMetal: THREE.Material
  darkMetal: THREE.Material
  rubber: THREE.Material
}
interface MaterialsMod {
  createLabMaterials(tex: Record<string, THREE.Texture>): Mats
}
interface Lab {
  placements: readonly Placement[]
  kits: { object: THREE.Group; list: readonly Kit[]; get(id: string): Kit | undefined; update(dt: number, f: Frame): void }
  lighting: { object: THREE.Group; channels: { baseStation: Record<string, number> }; update(dt: number, f: { time: number }): void }
  shell: { object: THREE.Group }
  atmosphere: { object: THREE.Group }
  dispose(): void
}
interface CreateLabMod {
  createLab(o: {
    renderer: unknown
    scene: THREE.Scene
    textures: { shared: Record<string, THREE.Texture>; floor: Record<string, THREE.Texture> }
    quality: 'high' | 'low'
    pixelRatio: number
    placements?: readonly Placement[]
    host?: Host
  }): Lab
}
interface Host {
  channels: Record<string, object | undefined>
  slots: Record<string, (() => { object: THREE.Object3D }) | undefined>
  screens?: Record<string, Draw | undefined>
}
interface PlanMod {
  BASE_STATION_RING_Y: number
  BASE_STATION_RING_Z: number
  PLACE: Record<string, Placement['at']>
  WINDOW_PLANTS: { xs: readonly number[]; z: number }
}

/** 何もしない Canvas の 2D（lab-shell.test.ts と同じ） */
function fakeContext(canvas: object) {
  return new Proxy({ canvas } as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key]
      if (key === 'measureText') return () => ({ width: 10 })
      return () => ({ addColorStop() {} })
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  })
}
const realDocument = (globalThis as { document?: unknown }).document
beforeAll(() => {
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas: Record<string, unknown> = { width: 0, height: 0 }
      canvas.getContext = () => fakeContext(canvas)
      return canvas
    },
  }
})
afterAll(() => {
  ;(globalThis as { document?: unknown }).document = realDocument
})

const sharedTextures = () =>
  Object.fromEntries(['brushedNormal', 'brushedRough', 'panelNormal', 'panelRough', 'perfOpacity', 'perfNormal', 'smudge'].map((k) => [k, new THREE.Texture()]))
const floorTextures = () => Object.fromEntries(['map', 'normalMap', 'roughnessMap'].map((k) => [k, new THREE.Texture()]))
// WebGPURenderer の形（異方性の最大は renderer.getMaxAnisotropy()。前の WebGLRenderer は capabilities.getMaxAnisotropy()）
const fakeRenderer = () => ({ getMaxAnisotropy: () => 8 })
const frame = (time: number): Frame => ({ time, camera: new THREE.PerspectiveCamera(), renderer: null, scene: new THREE.Scene() })
const emptyHost = (): Host => ({ channels: {}, slots: {} })

async function materials() {
  const M = await load<MaterialsMod>('../world/materials/labMaterials.ts')
  return M.createLabMaterials(sharedTextures())
}
async function makeLab(placements?: readonly Placement[], host = emptyHost()) {
  const { createLab } = await load<CreateLabMod>(`${LAB}/createLab.ts`)
  return createLab({
    renderer: fakeRenderer(),
    scene: new THREE.Scene(),
    textures: { shared: sharedTextures(), floor: floorTextures() },
    quality: 'high',
    pixelRatio: 1,
    placements,
    host,
  })
}
const instanced = (o: THREE.Object3D) => o.children.filter((c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh)

describe('ラボの什器のキットの口（4-5）', () => {
  test('既定の種類: plan は 10 種で、どれも作る側を持つ（4-11 でドックを足してそろった）', async () => {
    const { LAB_KITS, labKitDef } = await load<KitsMod>(`${LAB}/kits/index.ts`)
    const { LAB_KIT_PLANS } = await load<PlansMod>(`${LAB_CORE}/kits/plans.ts`)
    expect(Object.keys(LAB_KITS).sort()).toEqual(Object.keys(LAB_KIT_PLANS).sort())
    for (const [kind, def] of Object.entries(LAB_KITS)) expect(def.plan).toBe(LAB_KIT_PLANS[kind]!)
    expect(
      Object.values(LAB_KITS)
        .filter((d) => d.create)
        .map((d) => d.kind)
        .sort(),
    ).toEqual(['baseStation', 'cncCorner', 'devDesk', 'dock', 'gallery', 'holoTable', 'robotArm', 'serverRack', 'windowPlants', 'workbench'])
    expect(labKitDef('無い種類')).toBeUndefined()
  })

  test('登録: 新しい種類は plan と作る側が引ける。plan を読んだ種類は違う plan にできない。同じ plan なら作る側だけ差し替えられる', async () => {
    const { registerLabKit } = await load<KitMod>(`${LAB}/kit.ts`)
    const { labKitDef } = await load<KitsMod>(`${LAB}/kits/index.ts`)
    const { labKitPlanFn } = await load<PlansMod>(`${LAB_CORE}/kits/plans.ts`)
    const { labObstacles } = await load<PlacementsMod>(`${LAB_CORE}/placements.ts`)
    const planA: PlanFn = () => ({ anchors: {}, obstacles: [{ name: 'A' }] })
    const planB: PlanFn = () => ({ anchors: {}, obstacles: [{ name: 'B' }] })
    const create1 = () => ({ object: new THREE.Group() })
    const create2 = () => ({ object: new THREE.Group() })
    // 読む前なら plan も差し替えられる
    registerLabKit({ kind: 'test.kiosk', plan: planA, create: create1 })
    registerLabKit({ kind: 'test.kiosk', plan: planB, create: create1 })
    expect(labKitDef('test.kiosk')!.plan).toBe(planB)
    const table: Placement[] = [{ id: 'kiosk', kit: 'test.kiosk', at: { position: [0, 0, 0], rotationY: 0 } }]
    expect(labObstacles('kiosk', table).map((o) => o.name)).toEqual(['B'])
    // 読んだあとは違う plan にできない（登録は何も変えない）
    expect(() => registerLabKit({ kind: 'test.kiosk', plan: planA, create: create2 })).toThrow('もう読まれている')
    expect(labKitPlanFn('test.kiosk')).toBe(planB)
    expect(labKitDef('test.kiosk')!.create).toBe(create1)
    // 同じ plan なら作る側だけ差し替えられる
    registerLabKit({ kind: 'test.kiosk', plan: planB, create: create2 })
    expect(labKitDef('test.kiosk')!.create).toBe(create2)
    // 既定の種類も同じ（障害物を並べると表の種類の plan が読まれる。使う側は読み込みの時に並べる（kanon-lab の config/layout.ts の OBSTACLES）。
    // ここでは地図の既定の表で並べる。8-4 で kanon-lab の server/test から移したときに、kanon-lab の config/layout.ts を読む形から替えた）
    ;(await load<{ labNavObstacles(): unknown[] }>(`${LAB_CORE}/navData.ts`)).labNavObstacles()
    expect(() => registerLabKit({ kind: 'serverRack', plan: planA })).toThrow('もう読まれている')
    expect(labKitDef('serverRack')!.create).toBeDefined()
  })

  test('createLab: キットは置き場所の表の順。表から外すと作らない。知らない種類は例外', async () => {
    const { LAB_PLACEMENTS } = await load<PlacementsMod>(`${LAB_CORE}/placements.ts`)
    const lab = await makeLab()
    expect(lab.placements).toBe(LAB_PLACEMENTS)
    expect(lab.kits.object.name).toBe('lab:kits')
    expect(lab.kits.list.map((k) => [k.id, k.kind])).toEqual([
      ['baseStation', 'baseStation'],
      ['holoTable', 'holoTable'],
      ['workshop', 'workbench'],
      ['workshopNorth', 'cncCorner'],
      ['robotArm', 'robotArm'],
      ['devDesk', 'devDesk'],
      ['serverRack', 'serverRack'],
      ['gallery', 'gallery'],
      ['windowPlants', 'windowPlants'],
      ['kb001Dock', 'dock'],
    ])
    expect(lab.kits.object.children).toEqual(lab.kits.list.map((k) => k.object))
    expect(lab.kits.get('serverRack')).toBe(lab.kits.list[6]!)
    expect(lab.lighting.object.name).toBe('lab:lighting')
    expect(lab.shell.object.name).toBe('lab:shell')
    expect(lab.atmosphere.object.name).toBe('lab:atmosphere')
    lab.dispose()

    const without = await makeLab(LAB_PLACEMENTS.filter((p) => p.id !== 'serverRack'))
    expect(without.kits.list.map((k) => k.id)).toEqual(['baseStation', 'holoTable', 'workshop', 'workshopNorth', 'robotArm', 'devDesk', 'gallery', 'windowPlants', 'kb001Dock'])
    without.dispose()

    await expect(makeLab([{ id: 'x', kit: '無い種類', at: { position: [0, 0, 0], rotationY: 0 } }])).rejects.toThrow('キットの種類が無い')
  })

  test('createLab: キットの入力の値と差し込み口の中身はラボの口から。アンカーと障害物は plan のまま', async () => {
    const { registerLabKit, kitChannels, createLabSlot } = await load<KitMod>(`${LAB}/kit.ts`)
    const plan: PlanFn = (at) => ({ anchors: { front: { p: [at.position[0], 1, 2] } }, obstacles: [{ name: '台' }] })
    registerLabKit({
      kind: 'test.lamp',
      plan,
      create: () => {
        const ch = kitChannels({ power: 0.25 })
        return { object: new THREE.Group(), channels: ch, slots: { top: createLabSlot('top') } }
      },
    })
    const content = { object: new THREE.Group() }
    const source = { power: 0.5 }
    const lab = await makeLab([{ id: 'lamp', kit: 'test.lamp', at: { position: [3, 0, 0], rotationY: 0.5 } }], {
      channels: { lamp: source },
      slots: { 'lamp.top': () => content },
    })
    const kit = lab.kits.get('lamp')!
    expect(kit.channels.power).toBe(0.5)
    source.power = 0.75
    expect(kit.channels.power).toBe(0.75) // 読むたびに見る
    expect(kit.slots.top!.content).toBe(content)
    expect(kit.anchors.front!.name).toBe('lamp.front')
    expect(kit.anchors.front!.position.toArray()).toEqual([3, 1, 2])
    expect(kit.anchors.front!.yaw).toBe(0.5)
    expect(kit.obstacles.map((o) => o.name)).toEqual(['台'])
    lab.dispose()
  })

  test('サーバラック: 前の ServerRack.tsx と同じ群の位置・子の並び・LED の数。4-0b のレールの直しがそのまま', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const lab = await makeLab()
    const rack = lab.kits.get('serverRack')!.object
    expect(rack.position.toArray()).toEqual(PLACE.serverRack!.position)
    expect(rack.rotation.y).toBe(PLACE.serverRack!.rotationY)
    // 筐体・レール・発光バー・サーバ・通気口・LED（InstancedMesh）・ステッカー 2 枚・配線 3 本
    const inst = instanced(rack)
    expect(inst.map((m) => m.count)).toEqual([16, 6, 3, 75, 66, 296])
    expect(rack.children.length).toBe(11)
    expect(inst.map((m) => [m.castShadow, m.receiveShadow])).toEqual([
      [true, true],
      [false, true],
      [false, false],
      [false, true],
      [false, false],
      [false, false],
    ])
    // レール: 下端は台の上の面（0.08）、前の面は側板の前の面より 1mm 奥
    const rails = inst[1]!
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    rails.getMatrixAt(0, m)
    m.decompose(p, q, s)
    expect(p.y - s.y / 2).toBeCloseTo(0.08, 6) // instanceMatrix は float32
    expect(p.z + s.z / 2).toBeCloseTo(0.9 - 0.001, 6)
    lab.dispose()
  })

  test('サーバラックの LED は毎秒 20 回だけ色を変える（溜めた時間が 1/20 秒に届いたコマ）', async () => {
    const lab = await makeLab()
    const kit = lab.kits.get('serverRack')!
    const led = instanced(kit.object)[5]!
    const colors = () => Array.from(led.instanceColor!.array)
    const first = colors()
    kit.update(0.03, frame(1.0))
    expect(colors()).toEqual(first)
    kit.update(0.03, frame(1.03))
    const lit = colors()
    expect(lit).not.toEqual(first)
    kit.update(0.03, frame(1.06))
    expect(colors()).toEqual(lit)
    lab.dispose()
  })

  test('窓際の植物: 群は単位の行列（置き場所は原点）。部品の数とアンカーは plan のまま', async () => {
    const { WINDOW_PLANTS } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { labAnchor } = await load<AnchorsMod>(`${LAB_CORE}/anchors.ts`)
    const lab = await makeLab()
    const kit = lab.kits.get('windowPlants')!
    kit.object.updateMatrix()
    expect(kit.object.matrix.equals(new THREE.Matrix4())).toBe(true)
    const inst = instanced(kit.object)
    expect(inst.length).toBe(4)
    expect(inst[0]!.count).toBe(WINDOW_PLANTS.xs.length)
    expect(inst[1]!.count).toBe(WINDOW_PLANTS.xs.length)
    // 葉は茎ごとに 2 枚ずつ（乱数の種は前と同じ 4804。数は前の WindowPlants.tsx と同じ）
    expect(inst[3]!.count % 2).toBe(0)
    expect([inst[2]!.count, inst[3]!.count]).toEqual([23, 124])
    for (let i = 1; i <= WINDOW_PLANTS.xs.length; i++) {
      const a = labAnchor(`windowPlants.${i}`)
      expect(kit.anchors[`${i}`]!.position.toArray()).toEqual(a.p)
    }
    expect(kit.obstacles.length).toBe(WINDOW_PLANTS.xs.length)
    lab.dispose()
  })

  test('dispose: キットの物は捨て、共有の素材・キャッシュの発光の素材は捨てない', async () => {
    const lab = await makeLab()
    const rack = lab.kits.get('serverRack')!
    const inst = instanced(rack.object)
    const disposed = new Set<unknown>()
    const watch = (x: object) => (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
    const black = inst[0]!.material as THREE.Material
    const glow = inst[2]!.material as THREE.Material
    const led = inst[5]!
    for (const x of [black, glow, led.material as THREE.Material, led.geometry, led, inst[0]!.geometry]) watch(x)
    lab.dispose()
    expect(disposed.has(led.material)).toBe(true)
    expect(disposed.has(led.geometry)).toBe(true)
    expect(disposed.has(led)).toBe(true)
    expect(disposed.has(black)).toBe(false)
    expect(disposed.has(glow)).toBe(false)
    expect(disposed.has(inst[0]!.geometry)).toBe(false) // UNIT_BOX（使い回し）
  })
})

interface BaseStationMod {
  BASE_STATION_CHANNELS: Record<string, number>
  createBaseStation(at: Placement['at'], opts: object | undefined, ctx: Ctx): Body & { screens?: Record<string, Screen> }
}
interface ScreensMod {
  createLabScreen(key: string, w: number, h: number, draw: Draw, fps: number, o: { maxAnisotropy: number }): Screen
}

/** 基地局の群（単位の行列の群 → 置き場所の群・床のケーブル・危険線）の中の物 */
function stationParts(kit: Kit) {
  const [station, cables, danger] = kit.object.children as [THREE.Group, THREE.Group, THREE.InstancedMesh]
  // 置き場所の群の中: 背面板・基壇・カストル・ポルックス・リング・コア・上の吊り金具
  const [, , castor, pollux, ring, core] = station.children as THREE.Group[]
  return { station, cables, danger, castor: castor!, pollux: pollux!, ring: ring!, core: core! }
}
/** 自作の材質（TSL）の値の一覧（material.uniforms.<名前>.value。前の ShaderMaterial と同じ書き方） */
type UniformsMaterial = THREE.Material & { uniforms: Record<string, { value: unknown } | undefined> }

/** 光の芯（FlowMaterial）の mesh（作った順） */
function flowCores(o: THREE.Object3D) {
  const out: THREE.Mesh[] = []
  o.traverse((x) => {
    const m = (x as THREE.Mesh).material as THREE.Material | undefined
    if (m && !Array.isArray(m) && (m as UniformsMaterial).uniforms?.uDensity) out.push(x as THREE.Mesh)
  })
  return out
}

describe('基地局のキット（4-6）', () => {
  test('前の BaseStation.tsx と同じ入れ子（単位の行列の群 → 置き場所の群・床のケーブル・危険線）。アンカーと障害物は plan のまま', async () => {
    const { PLACE, BASE_STATION_RING_Y, BASE_STATION_RING_Z } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { labAnchor } = await load<AnchorsMod>(`${LAB_CORE}/anchors.ts`)
    const lab = await makeLab()
    const kit = lab.kits.get('baseStation')!
    kit.object.updateMatrix()
    expect(kit.object.matrix.equals(new THREE.Matrix4())).toBe(true)
    expect(kit.object.children.length).toBe(3)
    const { station, cables, danger, ring, core } = stationParts(kit)
    expect(station.position.toArray()).toEqual(PLACE.baseStation!.position)
    expect(station.rotation.y).toBe(PLACE.baseStation!.rotationY)
    expect(station.children.length).toBe(7)
    expect(cables.children.length).toBe(6)
    expect(danger.isInstancedMesh).toBe(true)
    // リングとコアの群はリングの中心（置き場所の中）。コアのワールドの位置はアンカー baseStation.core と同じ
    expect(ring.position.toArray()).toEqual([0, BASE_STATION_RING_Y, BASE_STATION_RING_Z])
    expect(core.position.toArray()).toEqual([0, BASE_STATION_RING_Y, BASE_STATION_RING_Z])
    kit.object.updateMatrixWorld(true)
    expect(core.getWorldPosition(new THREE.Vector3()).toArray()).toEqual(labAnchor('baseStation.core').p)
    expect(kit.anchors.core!.position.toArray()).toEqual(labAnchor('baseStation.core').p)
    expect(kit.anchors['pollux.top']!.position.toArray()).toEqual(labAnchor('baseStation.pollux.top').p)
    expect(kit.obstacles.map((o) => o.name)).toEqual(['基地局', '危険線の内側'])
    // 流す管は 7 本（タワー 2・上 5）
    expect(flowCores(kit.object).length).toBe(7)
    lab.dispose()
  })

  test('入力の値は読むたびに見て、リング・管・コアと照明のコアの光が読む（既定は 0。コアの明るさ core は 1）', async () => {
    const lab0 = await makeLab()
    expect({ ...lab0.kits.get('baseStation')!.channels }).toEqual({ ring: 0, ringBoost: 0, link: 0, flash: 0, pulse: 0, core: 1, amber: 0 })
    lab0.dispose()

    const fx = { ring: 0, ringBoost: 0, link: 0, flash: 0, pulse: 0 }
    const source = Object.fromEntries(Object.keys(fx).map((k) => [k, undefined]))
    for (const k of Object.keys(fx) as (keyof typeof fx)[]) Object.defineProperty(source, k, { get: () => fx[k], enumerable: true })
    const lab = await makeLab(undefined, { channels: { baseStation: source }, slots: {} })
    const kit = lab.kits.get('baseStation')!
    const { ring, core } = stationParts(kit)
    fx.link = 1
    expect(kit.channels.link).toBe(1)
    // 照明のコアの光は基地局のキットの入力の値を読む
    expect(lab.lighting.channels.baseStation.link).toBe(1)
    fx.link = 0

    // リング: 回る速さ ×(1 + 5 × ring + 14 × ringBoost)
    const middle = ring.children[5]!
    let z = middle.rotation.z
    kit.update(0.1, frame(1))
    expect(middle.rotation.z).toBe(z - 0.1 * 0.12 * 1)
    fx.ring = 1
    fx.ringBoost = 0.5
    z = middle.rotation.z
    kit.update(0.1, frame(1.1))
    expect(middle.rotation.z).toBe(z - 0.1 * 0.12 * 13)

    // コア: 明るさに link・flash・pulse
    const coreMesh = core.getObjectByName('baseStation:core') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
    kit.update(0, frame(2))
    const dim = coreMesh.material.color.r
    fx.flash = 1
    kit.update(0, frame(2))
    expect(coreMesh.material.color.r).toBeCloseTo(dim * (1 + 1.6), 12)

    // 管: 光の芯の強さに flash（linkColor のある 7 本とも）
    fx.flash = 0
    kit.update(0, frame(3))
    const before = flowCores(kit.object).map((m) => (m.material as UniformsMaterial).uniforms.uIntensity!.value as number)
    fx.flash = 1
    kit.update(0, frame(3))
    const after = flowCores(kit.object).map((m) => (m.material as UniformsMaterial).uniforms.uIntensity!.value as number)
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]! * (1 + 1.5), 12))
    lab.dispose()
  })

  test('コアの明るさ（core）と琥珀の混ぜ具合（amber）: コアの球・光る殻・まわりの緑・にじみ・外周の表示灯・照明のコアの光。既定の 1・0 は今の見た目のまま', async () => {
    const { PALETTE, GLOW } = await load<{ PALETTE: Record<string, string>; GLOW: Record<string, number> }>('../world/palette.ts')
    const fx = { core: 1, amber: 0 }
    const source = {
      get core() {
        return fx.core
      },
      get amber() {
        return fx.amber
      },
    }
    const plain = await makeLab()
    const lab = await makeLab(undefined, { channels: { baseStation: source }, slots: {} })
    const kit = lab.kits.get('baseStation')!
    const { ring, core } = stationParts(kit)
    const coreMesh = core.getObjectByName('baseStation:core') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
    const shell = core.children.find((c) => Array.isArray((c as THREE.Mesh).material)) as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>
    const holo = shell.material[1] as THREE.Material & { intensity: number; color: THREE.Color }
    const energy = (core.children[core.children.length - 2]!.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material
    const glow = core.children[core.children.length - 1]!
    const spriteMat = (() => {
      let m: THREE.MeshBasicMaterial | null = null
      glow.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) m = (o as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material
      })
      return m! as THREE.MeshBasicMaterial
    })()
    const seg = (ring.children[3] as THREE.InstancedMesh).material as THREE.MeshBasicMaterial
    const coreLight = lab.lighting.object.children[1] as THREE.PointLight

    // 既定（1・0）: 結び付けていないラボと同じ色と明るさ
    const { ring: ring0, core: core0 } = stationParts(plain.kits.get('baseStation')!)
    plain.kits.update(0, frame(2))
    plain.lighting.update(0, { time: 2 })
    kit.update(0, frame(2))
    lab.lighting.update(0, { time: 2 })
    const core0Mesh = core0.getObjectByName('baseStation:core') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
    expect(coreMesh.material.color.toArray()).toEqual(core0Mesh.material.color.toArray())
    expect(((ring0.children[3] as THREE.InstancedMesh).material as THREE.MeshBasicMaterial).color.toArray()).toEqual(seg.color.toArray())
    expect(seg.color.toArray()).toEqual(new THREE.Color(PALETTE.cyan).multiplyScalar(2.2).toArray())
    expect(energy.color.toArray()).toEqual(new THREE.Color(PALETTE.comm).multiplyScalar(GLOW.strong!).toArray())
    expect(holo.intensity).toBe(1.2)
    expect(spriteMat.opacity).toBe(0.38)
    expect(coreLight.intensity).toBe((plain.lighting.object.children[1] as THREE.PointLight).intensity)
    expect(coreLight.color.getHexString()).toBe(new THREE.Color(PALETTE.comm).getHexString())
    const bright = coreMesh.material.color.g
    const light = coreLight.intensity

    // 明るさ 0.5: コアの球・光る殻・まわりの緑・にじみ・照明のコアの光が半分。外周の表示灯はそのまま
    fx.core = 0.5
    kit.update(0, frame(2))
    lab.lighting.update(0, { time: 2 })
    expect(coreMesh.material.color.g).toBeCloseTo(bright * 0.5, 12)
    expect(holo.intensity).toBeCloseTo(0.6, 12)
    expect(energy.color.g).toBeCloseTo(new THREE.Color(PALETTE.comm).g * GLOW.strong! * 0.5, 12)
    expect(spriteMat.opacity).toBeCloseTo(0.19, 12)
    expect(coreLight.intensity).toBeCloseTo(light * 0.5, 12)
    expect(seg.color.toArray()).toEqual(new THREE.Color(PALETTE.cyan).multiplyScalar(2.2).toArray())

    // LOST（消灯・琥珀）: コアは消え、外周の表示灯と照明の色は琥珀
    fx.core = 0
    fx.amber = 1
    kit.update(0, frame(2))
    lab.lighting.update(0, { time: 2 })
    expect(coreMesh.material.color.toArray()).toEqual([0, 0, 0])
    expect(holo.intensity).toBe(0)
    expect(spriteMat.opacity).toBe(0)
    expect(coreLight.intensity).toBe(0)
    const amber = new THREE.Color(PALETTE.amber)
    for (let i = 0; i < 3; i++) expect(seg.color.toArray()[i]!).toBeCloseTo(amber.toArray()[i]! * 2.2, 12)
    expect(coreLight.color.getHexString()).toBe(amber.getHexString())
    // 範囲の外・数でない値は収める（明るさは既定の 1 に）
    fx.core = Number.NaN
    fx.amber = 3
    kit.update(0, frame(2))
    expect(coreMesh.material.color.r).toBeCloseTo(amber.r * GLOW.core! * (1 + Math.sin(2 * 1.3) * 0.12 + Math.max(0, Math.sin(2 * 0.45)) ** 16 * 0.6), 9)
    plain.dispose()
    lab.dispose()
  })

  test('画面 2 つ（castor・pollux。320×240・毎秒 12 回）は作る時にラボの口の中身が入り、最初の更新で描く。無い画面は既定の待機表示', async () => {
    const calls: number[] = []
    const live: Draw = (_c, t) => {
      calls.push(t)
    }
    const lab = await makeLab(undefined, { channels: {}, slots: {}, screens: { 'baseStation.pollux': live } })
    const kit = lab.kits.get('baseStation')!
    const { castor, pollux } = stationParts(kit)
    expect(Object.keys(kit.screens)).toEqual(['castor', 'pollux'])
    for (const [name, s] of Object.entries(kit.screens)) {
      expect([s.key, s.width, s.height, s.fps]).toEqual([`baseStation.${name}`, 320, 240, 12])
    }
    // 画面の板の発光の絵がその画面
    expect((castor.children[4] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.emissiveMap).toBe(kit.screens.castor!.texture)
    expect((pollux.children[4] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.emissiveMap).toBe(kit.screens.pollux!.texture)
    const v0 = kit.screens.castor!.texture.version
    kit.update(0.02, frame(0))
    expect(calls).toEqual([0.02])
    expect(kit.screens.castor!.texture.version).toBe(v0 + 1) // 既定の待機表示も最初の更新で描く
    kit.update(0.02, frame(0.02))
    expect(calls).toEqual([0.02]) // 次に描くのは 1/12 秒たってから
    for (let i = 0; i < 4; i++) kit.update(0.02, frame(0.04 + i * 0.02))
    expect(calls.length).toBe(2)
    lab.dispose()
  })

  test('4-0b の 2 つの直し（内側リングの銀の縁を前と後ろと穴の側へ出す・コアはガラス → 光る球の 1 つの物）がそのまま', async () => {
    const lab = await makeLab()
    const { ring, core } = stationParts(lab.kits.get('baseStation')!)
    const [innerRing, innerTrim] = ring.children[6]!.children as THREE.Mesh[]
    const a = innerRing!.geometry.boundingBox ?? (innerRing!.geometry.computeBoundingBox(), innerRing!.geometry.boundingBox!)
    const b = innerTrim!.geometry.boundingBox ?? (innerTrim!.geometry.computeBoundingBox(), innerTrim!.geometry.boundingBox!)
    expect(b.max.z).toBeCloseTo(a.max.z + 0.002, 9)
    expect(b.min.z).toBeCloseTo(a.min.z - 0.002, 9)
    const shell = core.children.find((c) => Array.isArray((c as THREE.Mesh).material)) as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>
    const mats = shell.material as THREE.Material[] & { transparent?: boolean; depthWrite?: boolean }
    expect(mats.map((m) => m.type)).toEqual(['MeshPhysicalMaterial', 'HologramMaterial'])
    expect([mats.transparent, mats.depthWrite]).toEqual([true, false])
    expect(shell.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1])
    expect(shell.geometry.groups[0]!.start).toBe(0)
    lab.dispose()
  })

  test('作る時に画面を 2 つ作り（ctx.screens）、dispose はキットの物を捨てて共有の素材・キャッシュの発光の素材は捨てない', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { createBaseStation } = await load<BaseStationMod>(`${LAB}/kits/baseStation.ts`)
    const { createLabScreen } = await load<ScreensMod>(`${LAB}/screens.ts`)
    const mats = await materials()
    const made: string[] = []
    const ctx: Ctx = {
      id: 'bs',
      materials: mats,
      quality: 'low',
      maxAnisotropy: 8,
      screens: (name, w, h, draw, fps) => {
        made.push(`${name} ${w}x${h} ${fps}`)
        return createLabScreen(`bs.${name}`, w, h, draw, fps, { maxAnisotropy: 8 })
      },
    }
    const body = createBaseStation(PLACE.baseStation!, undefined, ctx)
    expect(made).toEqual(['castor 320x240 12', 'pollux 320x240 12'])
    const disposed = new Set<unknown>()
    const watch = (x: object) => (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
    const shared = new Set<unknown>(Object.values(mats as unknown as Record<string, unknown>).filter((m) => (m as THREE.Material)?.isMaterial))
    const geometries = new Set<THREE.BufferGeometry>()
    const usedMaterials = new Set<THREE.Material>()
    body.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      geometries.add(m.geometry)
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) usedMaterials.add(mat)
    })
    const screen = body.screens!.castor!.texture
    for (const x of [...geometries, ...usedMaterials, screen]) watch(x)
    body.dispose!()
    expect(disposed.has(screen)).toBe(true)
    // 形は全部キットが作った物（UNIT_BOX などの使い回しは無い）
    expect([...geometries].filter((g) => !disposed.has(g))).toEqual([])
    // 共有の素材は捨てない
    expect([...usedMaterials].filter((m) => shared.has(m) && disposed.has(m))).toEqual([])
    // キャッシュの発光の素材（glowMaterial・overlayGlowMaterial）は捨てない。捨てる MeshBasicMaterial はコアの光る芯（clone）・にじみの板と、
    // コアの明るさ・琥珀の混ぜ具合で変える写し（外周の区切りの表示灯・まわりの緑の線 2 つ）の 5 つだけ
    const basics = [...usedMaterials].filter((m) => (m as THREE.MeshBasicMaterial).isMeshBasicMaterial)
    expect(basics.filter((m) => disposed.has(m)).length).toBe(5)
    // そのほかの素材（画面・危険線・ガラスの球・光る球・流れる光の芯・ステッカー・グレーチング）は捨てる
    expect([...usedMaterials].filter((m) => !shared.has(m) && !(m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !disposed.has(m))).toEqual([])
  })
})

interface WorkbenchPlanMod {
  BENCH_ORIGIN: V3
  BENCH_TOP: number
  PRINTER_ORIGIN: V3
  PRINTER_CABINET: number
}
interface PrinterJob {
  active: boolean
  headX: number
  headY: number
  headZ: number
  door: number
  occupied: boolean
}
interface WorkbenchMod {
  PRINTER_IDLE: PrinterJob
}

/** 作業台のキットの中の物（置き場所の群 → 作業台・有孔ボード・3D プリンタ・配線） */
function benchParts(kit: Kit) {
  const [bench, board, printer, power] = kit.object.children as [THREE.Group, THREE.Group, THREE.Group, THREE.Mesh]
  // プリンタの群: キャビネット・取っ手 2・スプール・庫内の群（フレーム 12・扉・左右の窓 2・背板・天板・照明・ベッド・造形物・ガントリー・画面・ステッカー）
  const inner = printer.children[4] as THREE.Group
  const door = inner.children[12] as THREE.Group
  const part = inner.children[19] as THREE.Mesh
  const gantry = inner.children[20] as THREE.Group
  const head = gantry.children[1]!
  return { bench, board, printer, power, inner, door, part, gantry, head }
}

describe('作業台 ×3 のキット（4-7）', () => {
  test('作業台: 前の Workshop.tsx と同じ入れ子と位置。アンカーと障害物は plan のまま。4-0b の縁の直し（前と横へ 1mm）がそのまま', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { BENCH_ORIGIN, BENCH_TOP, PRINTER_ORIGIN, PRINTER_CABINET } = await load<WorkbenchPlanMod>(`${LAB_CORE}/kits/workbench.plan.ts`)
    const { labAnchor } = await load<AnchorsMod>(`${LAB_CORE}/anchors.ts`)
    const lab = await makeLab()
    const kit = lab.kits.get('workshop')!
    expect(kit.kind).toBe('workbench')
    expect(kit.object.position.toArray()).toEqual(PLACE.workshop!.position)
    expect(kit.object.rotation.y).toBe(PLACE.workshop!.rotationY)
    expect(kit.object.children.length).toBe(4)
    const { bench, board, printer, power, inner, door, part, gantry } = benchParts(kit)
    expect(bench.position.toArray()).toEqual([BENCH_ORIGIN[0], 0, BENCH_ORIGIN[2]])
    expect(board.position.toArray()).toEqual([BENCH_ORIGIN[0] - 0.9, BENCH_TOP + 0.3, BENCH_ORIGIN[2]])
    expect(printer.position.toArray()).toEqual([PRINTER_ORIGIN[0], 0, PRINTER_ORIGIN[2]])
    expect((power.geometry as THREE.TubeGeometry).type).toBe('TubeGeometry')
    expect([bench.children.length, board.children.length, printer.children.length, inner.children.length]).toEqual([30, 32, 6, 23])
    expect(inner.position.toArray()).toEqual([0, PRINTER_CABINET, 0])
    expect((door.children[0] as THREE.Mesh).renderOrder).toBe(2)
    expect((part.geometry as THREE.CylinderGeometry).parameters.radialSegments).toBe(40)
    expect(gantry.position.toArray()).toEqual([0, 0.4, 0])
    // 天板（幅 2.0・奥行き 0.8）の前の縁: 前の面は天板の前の面より 1mm 前、横の面も 1mm 外
    const top = bench.children[0] as THREE.Mesh<THREE.BoxGeometry>
    const edge = bench.children[1] as THREE.Mesh<THREE.BoxGeometry>
    const front = (x: THREE.Mesh<THREE.BoxGeometry>) => x.position.z + x.geometry.parameters.depth / 2
    expect(front(edge)).toBeCloseTo(front(top) + 0.001, 12)
    expect(edge.geometry.parameters.width / 2).toBeCloseTo(top.geometry.parameters.width / 2 + 0.001, 12)
    for (const name of ['bench.assembly', 'bench.b', 'bench.c', 'bench.tray', 'printer.bed']) {
      expect(kit.anchors[name]!.position.toArray()).toEqual(labAnchor(`workshop.${name}`).p)
    }
    // 組み立ての場所のマットの中心のワールドの位置は、アンカー workshop.bench.assembly（天面から 3mm）と x・z が同じ
    kit.object.updateMatrixWorld(true)
    const mat = bench.children[13] as THREE.Group
    const p = mat.getWorldPosition(new THREE.Vector3())
    const a = labAnchor('workshop.bench.assembly').p
    expect(p.x).toBeCloseTo(a[0], 12)
    expect(p.z).toBeCloseTo(a[2], 12)
    expect(kit.obstacles.map((o) => o.name)).toEqual(['作業台', '3D プリンタ'])
    lab.dispose()
  })

  test('3D プリンタの入力の値 printer は読むたびに見る（既定は止まっている）。ヘッド・ガントリー・扉・見本の造形物が読む', async () => {
    const { PRINTER_IDLE } = await load<WorkbenchMod>(`${LAB}/kits/workbench.ts`)
    const lab0 = await makeLab()
    const kit0 = lab0.kits.get('workshop')!
    expect((kit0.channels as unknown as { printer: PrinterJob }).printer).toEqual(PRINTER_IDLE)
    const idle = benchParts(kit0)
    kit0.update(0.02, frame(1))
    // 止まっているとき: ノズルはゆっくりインフィルを描き、見本の造形物が育つ
    expect(idle.head.position.x).toBe(Math.sin(1 * 2.3) * 0.12)
    expect(idle.gantry.position.z).toBe(Math.sin(1 * 0.7) * 0.1)
    expect(idle.part.visible).toBe(true)
    expect(idle.part.scale.y).toBe(0.25 + ((1 * 0.02) % 1) * 0.75)
    lab0.dispose()

    // 使う側の物（world.printer）を参照で渡す
    const job: PrinterJob = { active: false, headX: 0, headY: 0.3, headZ: 0, door: 0, occupied: false }
    const lab = await makeLab(undefined, { channels: { workshop: { printer: job } }, slots: {} })
    const kit = lab.kits.get('workshop')!
    const { head, gantry, door, part } = benchParts(kit)
    job.active = true
    job.headX = 0.5
    job.headZ = -0.4
    job.headY = 0.05
    job.door = 0.5
    const y0 = gantry.position.y
    kit.update(0.02, frame(2))
    expect(head.position.x).toBe(0.5 * 0.14)
    expect(gantry.position.z).toBe(-0.4 * 0.12)
    const wantY = Math.min(0.66 - 0.08, 0.126 + 0.05 + 0.066)
    expect(gantry.position.y).toBe(y0 + (wantY - y0) * (1 - Math.exp(-0.02 * 14)))
    expect(door.rotation.y).toBe(-0.5 * 1.75)
    expect(part.visible).toBe(false)
    // 印刷が終わっても、庫内に物体があれば見本の造形物は出さない
    job.active = false
    job.occupied = true
    kit.update(0.1, frame(2.1))
    expect(part.visible).toBe(false)
    job.occupied = false
    kit.update(0.02, frame(2.12))
    expect(part.visible).toBe(true)
    lab.dispose()
  })

  test('画面 4 つ（scope 320×200・15 回、solder 128×64・4 回、printer 160×96・4 回、cnc 192×128・4 回）。毎コマは前の購読の順（画面 → プリンタ）', async () => {
    const calls: string[] = []
    const rec =
      (name: string): Draw =>
      () => {
        calls.push(name)
      }
    const lab = await makeLab(undefined, {
      channels: {},
      slots: {},
      screens: { 'workshop.scope': rec('scope'), 'workshop.solder': rec('solder'), 'workshop.printer': rec('printer'), 'workshopNorth.cnc': rec('cnc') },
    })
    const bench = lab.kits.get('workshop')!
    const cnc = lab.kits.get('workshopNorth')!
    expect(Object.entries(bench.screens).map(([n, s]) => [n, s.key, s.width, s.height, s.fps])).toEqual([
      ['scope', 'workshop.scope', 320, 200, 15],
      ['solder', 'workshop.solder', 128, 64, 4],
      ['printer', 'workshop.printer', 160, 96, 4],
    ])
    expect(Object.entries(cnc.screens).map(([n, s]) => [n, s.key, s.width, s.height, s.fps])).toEqual([['cnc', 'workshopNorth.cnc', 192, 128, 4]])
    expect(lab.kits.get('robotArm')!.screens).toEqual({})
    // 画面の板の発光の絵がその画面
    const emissiveMaps = new Set<unknown>()
    for (const kit of [bench, cnc])
      kit.object.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
        if (m && !Array.isArray(m) && m.emissiveMap) emissiveMaps.add(m.emissiveMap)
      })
    expect(emissiveMaps).toEqual(new Set([bench.screens.scope!.texture, bench.screens.solder!.texture, bench.screens.printer!.texture, cnc.screens.cnc!.texture]))
    // 最初の更新で全部描き、そのあとは回数ごと
    lab.kits.update(0.02, frame(0))
    expect(calls).toEqual(['scope', 'solder', 'printer', 'cnc'])
    for (let i = 0; i < 4; i++) lab.kits.update(0.02, frame(0.02 * (i + 1)))
    expect(calls).toEqual(['scope', 'solder', 'printer', 'cnc', 'scope']) // 1/15 秒たった scope だけ（1/4 秒の画面はまだ）
    lab.dispose()
  })

  test('CNC の隅とロボットアーム: 前の Workshop.tsx と同じ入れ子。毎コマ時刻で動く。アンカーと障害物は plan のまま', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { labAnchor } = await load<AnchorsMod>(`${LAB_CORE}/anchors.ts`)
    const lab = await makeLab()
    const cnc = lab.kits.get('workshopNorth')!
    expect(cnc.kind).toBe('cncCorner')
    expect(cnc.object.position.toArray()).toEqual(PLACE.workshopNorth!.position)
    expect(cnc.object.rotation.y).toBe(PLACE.workshopNorth!.rotationY)
    const [machine, cabinet, lower] = cnc.object.children as [THREE.Group, THREE.Group, THREE.Mesh]
    // CNC: 台・ボルト・筐体の群・操作パネル・表示灯・ステッカー
    expect([machine.children.length, cabinet.children.length]).toEqual([6, 3])
    expect(instanced(cabinet).map((m) => m.count)).toEqual([30, 30])
    expect(lower.castShadow && lower.receiveShadow).toBe(true)
    const spindle = (machine.children[2] as THREE.Group).children[9] as THREE.Group
    cnc.update(0.02, frame(3))
    expect(spindle.position.x).toBe(Math.sin(3 * 0.5) * 0.22)
    expect(spindle.children[2]!.rotation.y).toBe(3 * 40)
    for (const name of ['partsCabinet.front', 'partsCabinet.out']) {
      expect(cnc.anchors[name]!.position.toArray()).toEqual(labAnchor(`workshopNorth.${name}`).p)
    }
    expect(cnc.obstacles.map((o) => o.name)).toEqual(['CNC・パーツケース'])

    const arm = lab.kits.get('robotArm')!
    expect(arm.object.position.toArray()).toEqual(PLACE.robotArm!.position)
    const [marking, armGroup, table] = arm.object.children as [THREE.Mesh, THREE.Group, THREE.Group]
    expect((marking.material as THREE.MeshStandardMaterial).transparent).toBe(true)
    expect([armGroup.position.z, table.position.z]).toEqual([-0.35, 0.53])
    const j1 = armGroup.children[3] as THREE.Group
    const j2 = j1.children[2] as THREE.Group
    const j6 = (((j2.children[5] as THREE.Group).children[5] as THREE.Group).children[2] as THREE.Group)!
    arm.update(0.02, frame(4))
    expect(j1.rotation.y).toBe(Math.sin(4 * 0.23) * 0.45 + Math.sin(4 * 0.07) * 0.2)
    expect(j2.rotation.x).toBe(0.5 + Math.sin(4 * 0.37) * 0.16)
    expect(j6.rotation.y).toBe(4 * 0.4)
    const open = 0.012 + Math.max(0, Math.sin(4 * 0.6)) * 0.018
    expect([j6.children[3]!.position.x, j6.children[4]!.position.x]).toEqual([-open, open])
    expect(arm.obstacles.map((o) => o.name)).toEqual(['ロボットアームの作業範囲'])
    lab.dispose()
  })

  test('dispose はキットの物（形・素材・画面・パンチングの写し）を捨て、共有の素材・キャッシュの発光の素材と絵は捨てない', async () => {
    const lab = await makeLab()
    const mats = (lab as unknown as { materials: object }).materials
    const shared = new Set<unknown>(Object.values(mats as Record<string, unknown>).filter((m) => (m as THREE.Material)?.isMaterial))
    for (const id of ['workshop', 'workshopNorth', 'robotArm']) {
      const kit = lab.kits.get(id)!
      const disposed = new Set<unknown>()
      const watch = (x: object) => (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
      const geometries = new Set<THREE.BufferGeometry>()
      const used = new Set<THREE.Material>()
      const maps = new Set<THREE.Texture>()
      kit.object.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        geometries.add(m.geometry)
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          used.add(mat)
          const s = mat as THREE.MeshStandardMaterial
          if (s.map) maps.add(s.map)
        }
      })
      const screens = Object.values(kit.screens).map((s) => s.texture)
      for (const x of [...geometries, ...used, ...maps, ...screens]) watch(x)
      kit.dispose()
      expect(screens.every((t) => disposed.has(t))).toBe(true)
      // 形は全部キットが作った物
      expect([...geometries].filter((g) => !disposed.has(g))).toEqual([])
      // 共有の素材・キャッシュの発光の素材（MeshBasicMaterial の glowMaterial）は捨てない
      expect([...used].filter((m) => shared.has(m) && disposed.has(m))).toEqual([])
      const basics = [...used].filter((m) => (m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(m as THREE.MeshBasicMaterial).map)
      expect(basics.filter((m) => disposed.has(m))).toEqual([])
      // そのほかの素材（画面・マット・ステッカー・付箋・パンチング・シャドーボード・引き出し・作業範囲の印）は捨てる
      expect([...used].filter((m) => !shared.has(m) && !basics.includes(m) && !disposed.has(m))).toEqual([])
      // ステッカー・付箋・シャドーボード・作業範囲の印の絵はキャッシュなので捨てない
      expect([...maps].filter((t) => disposed.has(t))).toEqual([])
    }
  })
})

interface DevDeskPlanMod {
  DESK_H: number
  MONITOR_X: number
}
interface LabAnchorFull {
  name: string
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  yaw: number
  size?: { w: number; h: number }
}
interface AnchorDataMod {
  labAnchor(name: string): { p: V3; yaw: number; at: Placement['at']; local?: { p: V3; yaw: number } }
}

/** 開発デスクのキットの中の物（置き場所の群 → 天板・縁の光・脚 2・幕板・短辺の天板・縁の光・脚・短辺のモニタ・モニタの群・ヘッドホン・PC・椅子・配線 3） */
function deskParts(kit: Kit) {
  const c = kit.object.children
  const wing = c[8] as THREE.Group
  const row = c[9] as THREE.Group
  // モニタの群: アーム 2・中央・左・右のモニタ・付箋 2・空中のパネル 3・マット・キーボード・マウス・マグカップ
  const [center, left, right] = [row.children[2], row.children[3], row.children[4]] as THREE.Group[]
  const panels = row.children.slice(7, 10) as THREE.Group[]
  return { wing, row, center: center!, left: left!, right: right!, panels }
}

describe('開発デスクのキット（4-8）', () => {
  test('前の DevDesk.tsx と同じ入れ子と位置（DESK_H・MONITOR_X は plan の値）。アンカー（plan の desk.a・desk.b・taskSign と、行列から出す monitor）と障害物', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { DESK_H, MONITOR_X } = await load<DevDeskPlanMod>(`${LAB_CORE}/kits/devDesk.plan.ts`)
    const { labAnchor } = await load<AnchorDataMod>(`${LAB_CORE}/anchors.ts`)
    const lab = await makeLab()
    const kit = lab.kits.get('devDesk')!
    expect(kit.kind).toBe('devDesk')
    expect(kit.object.position.toArray()).toEqual(PLACE.devDesk!.position)
    expect(kit.object.rotation.y).toBe(PLACE.devDesk!.rotationY)
    expect(kit.object.children.length).toBe(16)
    const { wing, row, center, left, right, panels } = deskParts(kit)
    expect(row.position.toArray()).toEqual([MONITOR_X, 0, 0])
    expect(row.children.length).toBe(14)
    expect(wing.position.toArray()).toEqual([-1.8 + 0.2, DESK_H + 0.42, 0.8 + 0.45])
    expect(wing.rotation.y).toBe(Math.PI / 2)
    expect(center.position.toArray()).toEqual([0, DESK_H + 0.47, 0.2])
    expect([left.rotation.y, right.rotation.y]).toEqual([0.5, -0.5])
    expect(panels.map((p) => p.position.toArray())).toEqual([
      [-0.55, DESK_H + 0.98, 0.5],
      [0.1, DESK_H + 1.05, 0.42],
      [0.72, DESK_H + 0.95, 0.52],
    ])
    // 天板の高さ（天板の上の面が DESK_H）
    const top = kit.object.children[0] as THREE.Mesh<THREE.BoxGeometry>
    expect(top.position.y + top.geometry.parameters.height / 2).toBeCloseTo(DESK_H, 12)
    // 作業の見出しはキットの中に無い（renderOrder 11 の板が無い）
    let sign = 0
    kit.object.traverse((o) => {
      if ((o as THREE.Mesh).renderOrder === 11) sign++
    })
    expect(sign).toBe(0)

    // plan のアンカー
    for (const name of ['desk.a', 'desk.b', 'taskSign']) expect(kit.anchors[name]!.position.toArray()).toEqual(labAnchor(`devDesk.${name}`).p)
    // monitor: 中央のモニタの群のワールドの行列から（前の devAnchors.monitor と同じ式）。大きさは中央のモニタの画面
    const monitor = kit.anchors.monitor as unknown as LabAnchorFull
    expect(monitor.name).toBe('devDesk.monitor')
    kit.object.updateMatrixWorld(true)
    expect(monitor.position.toArray()).toEqual(center.getWorldPosition(new THREE.Vector3()).toArray())
    expect(monitor.quaternion.toArray()).toEqual(center.getWorldQuaternion(new THREE.Quaternion()).toArray())
    expect(monitor.yaw).toBe(PLACE.devDesk!.rotationY)
    expect(monitor.size).toEqual({ w: 1.04, h: 0.45 })
    // インスタンスの側のアンカー（lab.anchors）: 作ったキットの物だけ
    const anchors = (lab as unknown as { anchors: { get(n: string): LabAnchorFull | undefined } }).anchors
    expect(anchors.get('devDesk.monitor')).toBe(monitor as never)
    expect(anchors.get('devDesk.taskSign')).toBe(kit.anchors.taskSign as never)
    expect(anchors.get('devDesk')!.position.toArray()).toEqual(PLACE.devDesk!.position)
    expect(anchors.get('devDesk')!.yaw).toBe(PLACE.devDesk!.rotationY)
    expect(anchors.get('kb001Dock.hover')).toBe(lab.kits.get('kb001Dock')!.anchors.hover as never) // 4-11 からドックもキット
    expect(anchors.get('stage')).toBeUndefined() // 表に無い置き場所
    expect(anchors.get('devDesk.無い')).toBeUndefined()
    expect(kit.obstacles.map((o) => o.name)).toEqual(['開発デスク（長辺）', '開発デスク（短辺）', '椅子'])
    lab.dispose()
  })

  test('作業の見出しのアンカー taskSign: 置き場所の群の中にローカルで置くと、前の入れ子（デスクの群 → モニタの群 → 見出し）と行列が最後の桁まで同じ', async () => {
    const { MONITOR_X, DESK_H } = await load<DevDeskPlanMod>(`${LAB_CORE}/kits/devDesk.plan.ts`)
    const { labAnchor } = await load<AnchorDataMod>(`${LAB_CORE}/anchors.ts`)
    const a = labAnchor('devDesk.taskSign')
    const local = a.local!
    for (const [y, s] of [
      [0, 1],
      [0.0099, 0.42],
      [-0.0071, 0.8731],
      [0.0042, 1.2],
    ] as const) {
      // 前: デスクの群 → 群（x MONITOR_X）→ 見出し（[0, DESK_H + 1.5 + 揺れ, 0.95]・向き 0.3・大きさ）
      const before = new THREE.Group()
      before.position.fromArray(a.at.position)
      before.rotation.y = a.at.rotationY
      const offset = new THREE.Group()
      offset.position.fromArray([MONITOR_X, 0, 0])
      const m0 = new THREE.Object3D()
      m0.position.fromArray([0, DESK_H + 1.5, 0.95])
      m0.rotation.y = 0.3
      m0.position.y = DESK_H + 1.5 + y
      m0.scale.setScalar(s)
      offset.add(m0)
      before.add(offset)
      before.updateMatrixWorld(true)
      // 後: 置き場所の群 → 見出し（ローカル）
      const after = new THREE.Group()
      after.position.fromArray(a.at.position)
      after.rotation.y = a.at.rotationY
      const m1 = new THREE.Object3D()
      m1.position.fromArray(local.p)
      m1.rotation.y = local.yaw
      m1.position.y = local.p[1] + y
      m1.scale.setScalar(s)
      after.add(m1)
      after.updateMatrixWorld(true)
      expect(m1.matrixWorld.elements).toEqual(m0.matrixWorld.elements)
    }
  })

  test('画面 7 つ（wing 1024・10 回、center 2048・12 回、left 1536・10 回、right 1536・12 回、空中のパネル 3 つ 512・12 回）。毎コマは前の購読の順', async () => {
    const calls: string[] = []
    const rec =
      (name: string): Draw =>
      () => {
        calls.push(name)
      }
    const names = ['wing', 'center', 'left', 'right', 'holoDiagnostics', 'holoPipeline', 'holoNetwork']
    const lab = await makeLab(undefined, { channels: {}, slots: {}, screens: Object.fromEntries(names.map((n) => [`devDesk.${n}`, rec(n)])) })
    const kit = lab.kits.get('devDesk')!
    expect(Object.entries(kit.screens).map(([n, s]) => [n, s.key, s.width, s.height, s.fps])).toEqual([
      ['wing', 'devDesk.wing', 1024, 633, 10],
      ['center', 'devDesk.center', 2048, 886, 12],
      ['left', 'devDesk.left', 1536, 941, 10],
      ['right', 'devDesk.right', 1536, 941, 12],
      ['holoDiagnostics', 'devDesk.holoDiagnostics', 512, 307, 12],
      ['holoPipeline', 'devDesk.holoPipeline', 512, 372, 12],
      ['holoNetwork', 'devDesk.holoNetwork', 512, 366, 12],
    ])
    // モニタの画面の板の発光の絵・空中のパネルのホログラムの絵がその画面
    const { wing, center, left, right, panels } = deskParts(kit)
    const screenOf = (g: THREE.Group) => ((g.children[2] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissiveMap
    expect([wing, center, left, right].map(screenOf)).toEqual([kit.screens.wing, kit.screens.center, kit.screens.left, kit.screens.right].map((s) => s!.texture))
    const holoMap = (g: THREE.Group) => ((g.children[0] as THREE.Mesh).material as UniformsMaterial).uniforms.uMap!.value
    expect(panels.map(holoMap)).toEqual([kit.screens.holoDiagnostics, kit.screens.holoPipeline, kit.screens.holoNetwork].map((s) => s!.texture))
    // 最初の更新で全部描き、そのあとは回数ごと（1/12 秒たった画面だけ）
    kit.update(0.02, frame(1))
    expect(calls).toEqual(names)
    // 空中のパネルは上下に漂う（位相はパネルごと）
    expect(panels.map((p) => p.position.y)).toEqual([0.98, 1.05, 0.95].map((y, i) => 0.74 + y + Math.sin(1 * 0.6 + [0, 2.1, 4.3][i]!) * 0.008))
    calls.length = 0
    for (let i = 0; i < 3; i++) kit.update(0.03, frame(1 + 0.03 * (i + 1)))
    expect(calls).toEqual(['center', 'right', 'holoDiagnostics', 'holoPipeline', 'holoNetwork']) // 0.09 秒: 毎秒 12 回の画面だけ（10 回の wing・left はまだ）
    lab.dispose()
  })

  test('dispose はキットの物（形・素材・画面）を捨て、共有の素材・キャッシュの発光の素材と絵は捨てない', async () => {
    const lab = await makeLab()
    const mats = (lab as unknown as { materials: object }).materials
    const shared = new Set<unknown>(Object.values(mats as Record<string, unknown>).filter((m) => (m as THREE.Material)?.isMaterial))
    const kit = lab.kits.get('devDesk')!
    const disposed = new Set<unknown>()
    const watch = (x: object) => (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
    const geometries = new Set<THREE.BufferGeometry>()
    const used = new Set<THREE.Material>()
    const maps = new Set<THREE.Texture>()
    kit.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      geometries.add(m.geometry)
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        used.add(mat)
        const s = mat as THREE.MeshStandardMaterial
        if (s.map) maps.add(s.map)
      }
    })
    const screens = Object.values(kit.screens).map((s) => s.texture)
    for (const x of [...geometries, ...used, ...maps, ...screens]) watch(x)
    kit.dispose()
    expect(screens.every((t) => disposed.has(t))).toBe(true)
    expect([...geometries].filter((g) => !disposed.has(g))).toEqual([])
    expect([...used].filter((m) => shared.has(m) && disposed.has(m))).toEqual([])
    const basics = [...used].filter((m) => (m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(m as THREE.MeshBasicMaterial).map)
    expect(basics.length).toBeGreaterThan(0)
    expect(basics.filter((m) => disposed.has(m))).toEqual([])
    // そのほかの素材（画面・ホログラム・マット・キー・マグ・ヘッドホン・椅子・付箋・ステッカー）は捨てる
    expect([...used].filter((m) => !shared.has(m) && !basics.includes(m) && !disposed.has(m))).toEqual([])
    // 付箋・ステッカーの絵はキャッシュなので捨てない
    expect(maps.size).toBeGreaterThan(0)
    expect([...maps].filter((t) => disposed.has(t))).toEqual([])
  })
})

interface HoloTablePlanMod {
  HOLO_Y: number
}
interface HoloTableMod {
  HOLO_TABLE_CHANNELS: { projection: number }
  HOLO_TABLE_LABEL: string
}

describe('ホロテーブルのキット（4-9）', () => {
  test('前の HoloTable.tsx と同じ入れ子と位置（投影の中身の高さ HOLO_Y は plan の値）。差し込み口 projection の入れ物は前の分解図の根。アンカーと障害物は plan のまま', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { HOLO_Y } = await load<HoloTablePlanMod>(`${LAB_CORE}/kits/holoTable.plan.ts`)
    const { labAnchor } = await load<AnchorDataMod>(`${LAB_CORE}/anchors.ts`)
    const lab = await makeLab()
    const kit = lab.kits.get('holoTable')!
    expect(kit.kind).toBe('holoTable')
    expect(kit.object.position.toArray()).toEqual(PLACE.holoTable!.position)
    expect(kit.object.rotation.y).toBe(PLACE.holoTable!.rotationY)
    // 置き場所の群 → 台・投影の光・光のにじみ・投影の中身の根
    expect(kit.object.children.length).toBe(4)
    const [table, cone, sprite, root] = kit.object.children as [THREE.Group, THREE.Mesh<THREE.CylinderGeometry>, THREE.Group, THREE.Group]
    // 台: 脚・ボルト・柱・柱の光 ×3・天板・天板のガラス・縁の光・下の縁の光・プロジェクタ・プロジェクタの光
    expect(table.children.length).toBe(12)
    expect(instanced(table).map((m) => m.count)).toEqual([8])
    const glass = table.children[7] as THREE.Mesh<THREE.CircleGeometry, THREE.MeshPhysicalMaterial>
    expect(glass.position.toArray()).toEqual([0, 0.95 + 0.001, 0])
    expect([glass.material.clearcoat, glass.material.emissiveIntensity, glass.material.toneMapped]).toEqual([1, 0.9, false])
    // 投影の光（高さは HOLO_Y から。前と同じ式）
    expect(cone.position.toArray()).toEqual([0, (0.95 + HOLO_Y) / 2 - 0.05, 0])
    expect(cone.geometry.parameters.height).toBe(HOLO_Y - 0.95 - 0.1)
    expect(cone.geometry.parameters.openEnded).toBe(true)
    expect(sprite.position.toArray()).toEqual([0, 0.95 + 0.05, 0])
    // 投影の中身の根 = 差し込み口の入れ物（ラボの口に中身が無ければ空）
    expect(root).toBe(kit.slots.projection!.object)
    expect(root.name).toBe('slot:holoTable.projection')
    expect(root.position.toArray()).toEqual([0, HOLO_Y, 0])
    expect(root.children).toEqual([])
    // アンカー（plan）と障害物
    for (const name of ['top', 'projector', 'projection']) expect(kit.anchors[name]!.position.toArray()).toEqual(labAnchor(`holoTable.${name}`).p)
    expect(kit.anchors.projection!.position.y).toBe(HOLO_Y)
    const anchors = (lab as unknown as { anchors: { get(n: string): unknown } }).anchors
    expect(anchors.get('holoTable.top')).toBe(kit.anchors.top as never)
    expect(kit.obstacles.map((o) => o.name)).toEqual(['ホロテーブル'])
    lab.dispose()
  })

  test('入力の値 projection は読むたびに見る（既定 1）。毎コマ: 中身の update（根の前のコマの回転を見る）→ 根の出し入れ・漂い・回転（前の式）', async () => {
    const { HOLO_Y } = await load<HoloTablePlanMod>(`${LAB_CORE}/kits/holoTable.plan.ts`)
    const { HOLO_TABLE_CHANNELS } = await load<HoloTableMod>(`${LAB}/kits/holoTable.ts`)
    expect(HOLO_TABLE_CHANNELS).toEqual({ projection: 1 })
    const plain = await makeLab()
    expect(plain.kits.get('holoTable')!.channels.projection).toBe(1)
    plain.dispose()

    let root: THREE.Object3D | null = null
    const seen: number[] = []
    const content = {
      object: new THREE.Group(),
      update: (_dt: number, f: Frame) => {
        seen.push(root!.rotation.y, f.time)
      },
    }
    const source = { projection: 1 }
    const lab = await makeLab(undefined, { channels: { holoTable: source }, slots: { 'holoTable.projection': () => content } })
    const kit = lab.kits.get('holoTable')!
    root = kit.slots.projection!.object
    expect(kit.slots.projection!.content).toBe(content)
    expect(content.object.parent).toBe(root)
    // 前の ExplodedKB の毎コマの式で出した値と同じ
    let shown = 1
    let rot = 0
    let t = 1
    const step = (dt: number) => {
      t += dt
      const before = root!.rotation.y
      seen.length = 0
      kit.update(dt, frame(t))
      expect(seen).toEqual([before, t]) // 中身は根を回す前に呼ぶ
      const want = source.projection
      shown += (want - shown) * (1 - Math.exp(-Math.min(dt, 0.05) * (want ? 3 : 6)))
      rot += dt * 0.25
      expect(root!.rotation.y).toBe(rot)
      expect(root!.position.y).toBe(HOLO_Y + Math.sin(t * 0.8) * 0.015)
      expect(root!.scale.toArray()).toEqual([1, 1, 1].map(() => Math.max(0.001, shown)) as V3)
      expect(root!.visible).toBe(shown > 0.01)
    }
    for (let i = 0; i < 10; i++) step(1 / 60)
    // ホロスクリーンを映している間（0）: 速く（6）しまう。1 コマが長くても 0.05 秒ぶんまで
    source.projection = 0
    expect(kit.channels.projection).toBe(0)
    step(0.2)
    for (let i = 0; i < 60; i++) step(1 / 60)
    expect(root.visible).toBe(false)
    expect(root.scale.x).toBeLessThan(0.01)
    // 消したら（1）ゆっくり（3）出す
    source.projection = 1
    for (let i = 0; i < 90; i++) step(1 / 60)
    expect(root.visible).toBe(true)
    lab.dispose()
  })

  test('天板のガラスの文字は opts（既定は前の文。既定の絵は前と同じキャッシュの名前 holotable-top）', async () => {
    const { HOLO_TABLE_LABEL } = await load<HoloTableMod>(`${LAB}/kits/holoTable.ts`)
    const { LAB_PLACEMENTS } = await load<PlacementsMod>(`${LAB_CORE}/placements.ts`)
    expect(HOLO_TABLE_LABEL).toBe('KB-001 // EXPLODED VIEW  rev.7')
    const glassMap = (lab: Lab) =>
      ((lab.kits.get('holoTable')!.object.children[0]!.children[7] as THREE.Mesh).material as THREE.MeshPhysicalMaterial).emissiveMap!
    const a = await makeLab()
    const b = await makeLab()
    const c = await makeLab(LAB_PLACEMENTS.map((p) => (p.id === 'holoTable' ? { ...p, opts: { label: 'XW-08 // TEST' } } : p)))
    expect(glassMap(a)).toBe(glassMap(b))
    expect(glassMap(c)).not.toBe(glassMap(a))
    for (const lab of [a, b, c]) lab.dispose()
  })

  test('dispose はキットの物（形・素材・差し込み口の中身）を捨て、共有の素材・キャッシュの発光の素材と絵は捨てない', async () => {
    let disposedContent = 0
    const content = { object: new THREE.Group(), dispose: () => void disposedContent++ }
    const lab = await makeLab(undefined, { channels: {}, slots: { 'holoTable.projection': () => content } })
    const mats = (lab as unknown as { materials: object }).materials
    const shared = new Set<unknown>(Object.values(mats as Record<string, unknown>).filter((m) => (m as THREE.Material)?.isMaterial))
    const kit = lab.kits.get('holoTable')!
    const disposed = new Set<unknown>()
    const watch = (x: object) => (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
    const geometries = new Set<THREE.BufferGeometry>()
    const used = new Set<THREE.Material>()
    const maps = new Set<THREE.Texture>()
    kit.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      geometries.add(m.geometry)
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        used.add(mat)
        const s = mat as THREE.MeshStandardMaterial
        if (s.map) maps.add(s.map)
        if (s.emissiveMap) maps.add(s.emissiveMap)
      }
    })
    for (const x of [...geometries, ...used, ...maps]) watch(x)
    kit.dispose()
    expect(disposedContent).toBe(1)
    expect([...geometries].filter((g) => !disposed.has(g))).toEqual([])
    expect([...used].filter((m) => shared.has(m) && disposed.has(m))).toEqual([])
    // 発光の素材（キャッシュ）と光のにじみの素材（にじみの絵はキャッシュ、素材はキットの物）
    const glows = [...used].filter((m) => (m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(m as THREE.MeshBasicMaterial).map)
    expect(glows.length).toBeGreaterThan(0)
    expect(glows.filter((m) => disposed.has(m))).toEqual([])
    expect([...used].filter((m) => !shared.has(m) && !glows.includes(m) && !disposed.has(m))).toEqual([])
    // 天板の絵・にじみの絵はキャッシュなので捨てない
    expect(maps.size).toBe(2)
    expect([...maps].filter((t) => disposed.has(t))).toEqual([])
  })
})

interface GalleryPlanMod {
  GALLERY_SHELVES: number
  GALLERY_SHELF_Y: number
  GALLERY_SHELF_Z: number
  GALLERY_CASE_XS: readonly number[]
  GALLERY_CASE_Z: number
  galleryShelfXOf(i: number, shelves: number): number
}
interface GalleryExhibit {
  title: string
  sub: string
  model?: string
  slot?: { y: number; scale: number; spin: number }
}
interface GalleryMod {
  GALLERY_EXHIBITS: readonly GalleryExhibit[]
  GALLERY_PANEL: { title: string; sub: string }
}
const labSlots = (lab: Lab) => (lab as unknown as { slots: { get(n: string): Slot | undefined } }).slots

describe('ギャラリーのキット（4-10）', () => {
  test('前の Gallery.tsx と同じ入れ子と位置（展示棚・ケースの位置は plan の値）。KB-γ は差し込み口 case.3（入れ物は前の回る台の群）。アンカーと障害物は plan のまま', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const G = await load<GalleryPlanMod>(`${LAB_CORE}/kits/gallery.plan.ts`)
    const { labAnchor } = await load<AnchorDataMod>(`${LAB_CORE}/anchors.ts`)
    const { WALL_PANEL_DEPTH } = await load<{ WALL_PANEL_DEPTH: number }>(`${LAB_CORE}/plan.ts`)
    const lab = await makeLab()
    const mats = (lab as unknown as { materials: Record<string, THREE.Material> }).materials
    const kit = lab.kits.get('gallery')!
    expect(kit.kind).toBe('gallery')
    expect(kit.object.position.toArray()).toEqual(PLACE.gallery!.position)
    expect(kit.object.rotation.y).toBe(PLACE.gallery!.rotationY)
    // 置き場所の群 → タイトルパネル・展示棚・壁のライン・ケース ×3
    expect(kit.object.children.length).toBe(6)
    const [panel, shelf, line, ...cases] = kit.object.children as [THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>, THREE.Group, THREE.Mesh, ...THREE.Group[]]
    expect(panel.position.toArray()).toEqual([0, 2.4, WALL_PANEL_DEPTH + 0.02])
    expect([panel.geometry.parameters.width, panel.geometry.parameters.height]).toEqual([2.4, 0.6])
    expect([panel.material.emissiveIntensity, panel.material.roughness, panel.material.toneMapped]).toEqual([1.15, 0.3, false])
    // 展示棚: 棚板・縁の光・支え ×2・段の光の円 ×6（段の x は plan の式、棚板の幅は前の式）
    expect(shelf.children.length).toBe(4 + G.GALLERY_SHELVES)
    const board = shelf.children[0] as THREE.Mesh<THREE.BoxGeometry>
    expect(board.geometry.parameters.width).toBe((G.GALLERY_SHELVES + 0.2) * 0.5)
    expect(board.position.toArray()).toEqual([0, G.GALLERY_SHELF_Y - 0.03 / 2, WALL_PANEL_DEPTH + 0.28 / 2])
    expect(shelf.children.slice(4).map((r) => r.position.toArray())).toEqual(
      Array.from({ length: G.GALLERY_SHELVES }, (_, i) => [G.galleryShelfXOf(i + 1, G.GALLERY_SHELVES), G.GALLERY_SHELF_Y + 0.0015, G.GALLERY_SHELF_Z]),
    )
    expect(line.position.toArray()).toEqual([0, 1.6, WALL_PANEL_DEPTH + 0.02])
    expect(line.scale.toArray()).toEqual([2.9, 0.006, 0.006])
    // ケース: 位置は plan の GALLERY_CASE_XS・GALLERY_CASE_Z。台座・縁の光・下端の光・展示面・ガラス・照明ボックス・照明・中身・プレート
    expect(cases.map((c) => c.position.toArray())).toEqual(G.GALLERY_CASE_XS.map((x) => [x, 0, G.GALLERY_CASE_Z]))
    kit.object.updateMatrixWorld(true)
    cases.forEach((c, i) => {
      expect(c.children.length).toBe(9)
      const glass = c.children[4] as THREE.Mesh
      expect(glass.material).toBe(mats.glass!)
      expect(glass.renderOrder).toBe(3)
      expect(c.children[7]!.position.toArray()).toEqual([0, 0.95 + 0.01, 0])
      // アンカー case.N（ケースの床の中心）
      const p = c.getWorldPosition(new THREE.Vector3()).toArray()
      labAnchor(`gallery.case.${i + 1}`).p.forEach((x, k) => expect(p[k]!).toBeCloseTo(x, 12))
    })
    // 中身: KB-α・KB-β は地図の飾りの模型、KB-γ は差し込み口の入れ物（前の ProtoMk3 の群の位置と大きさ。ラボの口に中身が無ければ空）
    const contents = cases.map((c) => c.children[7]!.children)
    expect(contents.map((c) => c.length)).toEqual([1, 1, 1])
    const [mk1, mk2, gamma] = contents.map((c) => c[0]!) as [THREE.Group, THREE.Group, THREE.Group]
    expect([mk1.position.toArray(), mk1.rotation.y, mk1.children.length]).toEqual([[0, 0.16, 0], -0.4, 8])
    expect(instanced(mk1).map((m) => m.count)).toEqual([4])
    expect([mk2.position.toArray(), mk2.rotation.y, mk2.children.length]).toEqual([[0, 0.2, 0], 0.5, 8])
    expect(gamma).toBe(kit.slots['case.3']!.object)
    expect(gamma.name).toBe('slot:gallery.case.3')
    expect([gamma.position.toArray(), gamma.scale.toArray(), gamma.children]).toEqual([[0, 0.2, 0], [0.95, 0.95, 0.95], []])
    expect(Object.keys(kit.slots)).toEqual(['case.3'])
    // 差し込み口を名前で引く（ラボの slots。R3F の portal が使う）
    expect(labSlots(lab).get('gallery.case.3')).toBe(kit.slots['case.3']!)
    expect(labSlots(lab).get('holoTable.projection')).toBe(lab.kits.get('holoTable')!.slots.projection!)
    expect(labSlots(lab).get('lighting.stage')).toBeDefined()
    expect(labSlots(lab).get('gallery.case.1')).toBeUndefined()
    // アンカー（plan）と障害物
    for (const name of ['shelf.1', 'shelf.6', 'case.3']) expect(kit.anchors[name]!.position.toArray()).toEqual(labAnchor(`gallery.${name}`).p)
    expect(kit.obstacles.map((o) => o.name)).toEqual(['ギャラリー'])
    lab.dispose()
  })

  test('毎コマ: 差し込み口の中身の update → 回る台（時刻 × 0.3。前の ProtoMk3 の式）', async () => {
    const { GALLERY_EXHIBITS } = await load<GalleryMod>(`${LAB}/kits/gallery.ts`)
    expect(GALLERY_EXHIBITS.map((e) => [e.title, e.sub, e.model ?? null, e.slot ?? null])).toEqual([
      ['KB-α', '2024 // FIRST BUILD', 'protoMk1', null],
      ['KB-β', '2025 // FRAME TEST', 'protoMk2', null],
      ['KB-γ', '2025 // PRE-PROD', null, { y: 0.2, scale: 0.95, spin: 0.3 }],
    ])
    let holder: THREE.Object3D | null = null
    const seen: number[] = []
    const content = { object: new THREE.Group(), update: (_dt: number, f: Frame) => void seen.push(holder!.rotation.y, f.time) }
    const lab = await makeLab(undefined, { channels: {}, slots: { 'gallery.case.3': () => content } })
    const kit = lab.kits.get('gallery')!
    holder = kit.slots['case.3']!.object
    expect(kit.slots['case.3']!.content).toBe(content)
    expect(content.object.parent).toBe(holder)
    let prev = 0
    for (const t of [0.5, 1 / 3, 7.25, 1234.5678]) {
      seen.length = 0
      kit.update(1 / 60, frame(t))
      expect(seen).toEqual([prev, t]) // 中身は台を回す前に呼ぶ
      expect(holder.rotation.y).toBe(t * 0.3)
      prev = holder.rotation.y
    }
    lab.dispose()
  })

  test('opts: 展示棚の段の数（plan と同じ値）・ケースの展示・タイトルパネルの文字（既定の絵は前と同じキャッシュの名前 archive-panel）', async () => {
    const { LAB_PLACEMENTS } = await load<PlacementsMod>(`${LAB_CORE}/placements.ts`)
    const G = await load<GalleryPlanMod>(`${LAB_CORE}/kits/gallery.plan.ts`)
    const { GALLERY_PANEL } = await load<GalleryMod>(`${LAB}/kits/gallery.ts`)
    expect(GALLERY_PANEL).toEqual({ title: 'PROTOTYPE ARCHIVE', sub: 'KB-α → KB-β → KB-γ   /   KB-001 PROTOTYPES 2024–2025' })
    const withOpts = (opts: object) => LAB_PLACEMENTS.map((p) => (p.id === 'gallery' ? { ...p, opts } : p))
    const panelMap = (lab: Lab) => ((lab.kits.get('gallery')!.object.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissiveMap!
    const a = await makeLab()
    const b = await makeLab()
    const c = await makeLab(
      withOpts({
        shelves: 8,
        exhibits: [
          { title: 'A', sub: 'a', slot: { y: 0.1, scale: 1, spin: 1 } },
          { title: 'B', sub: 'b', model: 'protoMk1' },
          { title: 'C', sub: 'c' },
        ],
        panel: { title: 'XW ARCHIVE', sub: 'TEST' },
      }),
    )
    expect(panelMap(a)).toBe(panelMap(b))
    expect(panelMap(c)).not.toBe(panelMap(a))
    const kit = c.kits.get('gallery')!
    const shelf = kit.object.children[1]!
    expect(shelf.children.length).toBe(4 + 8)
    expect((shelf.children[0] as THREE.Mesh<THREE.BoxGeometry>).geometry.parameters.width).toBe((8 + 0.2) * 0.5)
    expect(shelf.children.slice(4).map((r) => r.position.x)).toEqual(Array.from({ length: 8 }, (_, i) => G.galleryShelfXOf(i + 1, 8)))
    expect(Object.keys(kit.anchors).filter((k) => k.startsWith('shelf.')).length).toBe(8)
    expect(Object.keys(kit.slots)).toEqual(['case.1'])
    const contents = kit.object.children.slice(3).map((cs) => cs.children[7]!.children)
    expect(contents[0]).toEqual([kit.slots['case.1']!.object])
    expect(contents[1]!.length).toBe(1)
    expect(contents[2]).toEqual([])
    kit.update(0, frame(2))
    expect(kit.slots['case.1']!.object.rotation.y).toBe(2)
    for (const lab of [a, b, c]) lab.dispose()
  })

  test('dispose はキットの物（形・素材・差し込み口の中身）を捨て、共有の素材・キャッシュの発光の素材と絵は捨てない', async () => {
    let disposedContent = 0
    const content = { object: new THREE.Group(), dispose: () => void disposedContent++ }
    const lab = await makeLab(undefined, { channels: {}, slots: { 'gallery.case.3': () => content } })
    const mats = (lab as unknown as { materials: object }).materials
    const shared = new Set<unknown>(Object.values(mats as Record<string, unknown>).filter((m) => (m as THREE.Material)?.isMaterial))
    const kit = lab.kits.get('gallery')!
    const disposed = new Set<unknown>()
    const watch = (x: object) => (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
    const geometries = new Set<THREE.BufferGeometry>()
    const used = new Set<THREE.Material>()
    const maps = new Set<THREE.Texture>()
    kit.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      geometries.add(m.geometry)
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        used.add(mat)
        const s = mat as THREE.MeshStandardMaterial
        if (s.map) maps.add(s.map)
        if (s.emissiveMap) maps.add(s.emissiveMap)
      }
    })
    for (const x of [...geometries, ...used, ...maps]) watch(x)
    kit.dispose()
    expect(disposedContent).toBe(1)
    expect([...geometries].filter((g) => !disposed.has(g))).toEqual([])
    expect([...used].filter((m) => shared.has(m) && disposed.has(m))).toEqual([])
    // 発光の素材（キャッシュ）は捨てない。ほかのキットの素材（パネル・プレート）は捨てる
    const glows = [...used].filter((m) => (m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(m as THREE.MeshBasicMaterial).map)
    expect(glows.length).toBeGreaterThan(0)
    expect(glows.filter((m) => disposed.has(m))).toEqual([])
    expect([...used].filter((m) => !shared.has(m) && !glows.includes(m) && !disposed.has(m))).toEqual([])
    // パネルの絵・プレートの絵はキャッシュなので捨てない（パネル 1 枚・プレート 3 枚）
    expect(maps.size).toBe(4)
    expect([...maps].filter((t) => disposed.has(t))).toEqual([])
  })
})

interface DockMod {
  DOCK_LABEL: { text: string; sub?: string }
}
interface DockPlanMod {
  KB001_DOCK_TOP: number
}

describe('KB-001 のドックのキット（4-11）', () => {
  test('前の KB001.tsx の Dock・GlowSprite・電源のケーブルと同じ入れ子と位置（台座の高さは plan の KB001_DOCK_TOP）。アンカーと障害物は plan のまま', async () => {
    const { PLACE } = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const { KB001_DOCK_TOP: top } = await load<DockPlanMod>(`${LAB_CORE}/plan.ts`)
    const { labAnchor } = await load<AnchorDataMod>(`${LAB_CORE}/anchors.ts`)
    const lab = await makeLab()
    const mats = (lab as unknown as { materials: Record<string, THREE.Material> }).materials
    const kit = lab.kits.get('kb001Dock')!
    expect(kit.kind).toBe('dock')
    expect(kit.object.position.toArray()).toEqual(PLACE.kb001Dock!.position)
    expect(kit.object.rotation.y).toBe(PLACE.kb001Dock!.rotationY)
    // 置き場所の群 → ドック・光のにじみ（置く群 → カメラを向く群 → 板）・電源のケーブル
    expect(kit.object.children.length).toBe(3)
    const [dock, sprite, power] = kit.object.children as [THREE.Group, THREE.Group, THREE.Mesh]
    // ドック: 床のパッド・リング ×2・支柱・スリット ×3・充電パッド・天面・リング ×2・爪の群 ×3・名札
    expect(dock.children.length).toBe(15)
    const ys = dock.children.map((c) => c.position.y)
    expect(ys.slice(0, 4)).toEqual([0.015, 0.031, 0.031, (top - 0.08) / 2 + 0.03])
    expect(ys.slice(4, 7)).toEqual([top * 0.47, top * 0.47, top * 0.47])
    expect(ys.slice(7, 11)).toEqual([top - 0.04, top + 0.001, top + 0.003, top + 0.003])
    const slit = dock.children[5] as THREE.Mesh
    const a = (1 / 3) * Math.PI * 2 + Math.PI / 6
    expect([slit.position.x, slit.position.z, slit.rotation.x, slit.rotation.y]).toEqual([Math.sin(a) * 0.101, Math.cos(a) * 0.101, 0.035, a])
    const claws = dock.children.slice(11, 14) as THREE.Group[]
    expect(claws.map((c) => [c.rotation.y, c.children.length])).toEqual([0, 1, 2].map((i) => [(i / 3) * Math.PI * 2, 2]))
    expect((claws[0]!.children[0] as THREE.Mesh).castShadow).toBe(true)
    const pads = [dock.children[0], dock.children[3], dock.children[7]] as THREE.Mesh[]
    expect(pads.map((p) => [p.material === mats.darkMetal || p.material === mats.blackMetal, p.castShadow, p.receiveShadow])).toEqual([
      [true, true, true],
      [true, true, true],
      [true, true, true],
    ])
    expect((dock.children[8] as THREE.Mesh).material).toBe(mats.screenOff!)
    const label = dock.children[14] as THREE.Mesh<THREE.PlaneGeometry>
    expect(label.position.toArray()).toEqual([0, 0.55, 0.112])
    expect([label.geometry.parameters.width, label.geometry.parameters.height]).toEqual([0.11, 0.11 / 2.2])
    // 光のにじみ: パッドの上のほのかな浮遊フィールド
    expect(sprite.position.toArray()).toEqual([0, top + 0.04, 0])
    const glow = sprite.children[0]!.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
    expect([glow.scale.x, glow.material.opacity, glow.material.blending, glow.material.depthWrite, glow.material.toneMapped]).toEqual([0.5, 0.3, THREE.AdditiveBlending, false, false])
    // 電源のケーブル（共有のゴム。影は受けるだけ）
    expect([power.material === mats.rubber, power.castShadow, power.receiveShadow]).toEqual([true, false, true])
    // アンカー（plan）と障害物
    for (const name of ['hover', 'pad']) expect(kit.anchors[name]!.position.toArray()).toEqual(labAnchor(`kb001Dock.${name}`).p)
    expect(kit.anchors.hover!.position.toArray()).toEqual([PLACE.kb001Dock!.position[0], top + 0.38, PLACE.kb001Dock!.position[2]])
    expect(kit.obstacles.map((o) => o.name)).toEqual(['KB-001 のドック'])
    expect(Object.keys(kit.slots)).toEqual([])
    expect(Object.keys(kit.screens)).toEqual([])
    lab.dispose()
  })

  test('毎コマ: 光のにじみがカメラを向く（drei の Billboard と同じ式）', async () => {
    const lab = await makeLab()
    const kit = lab.kits.get('kb001Dock')!
    const inner = kit.object.children[1]!.children[0]!
    const f = frame(1)
    f.camera.quaternion.setFromEuler(new THREE.Euler(-0.3, 1.1, 0.05))
    f.camera.updateMatrixWorld(true)
    expect(inner.quaternion.toArray()).toEqual([0, 0, 0, 1])
    kit.update(1 / 60, f)
    kit.object.updateMatrixWorld(true)
    const got = inner.getWorldQuaternion(new THREE.Quaternion())
    expect(got.angleTo(f.camera.quaternion)).toBeLessThan(1e-7)
    lab.dispose()
  })

  test('opts: 支柱の名札の文字（既定は前の文。既定の絵は前と同じキャッシュ）', async () => {
    const { LAB_PLACEMENTS } = await load<PlacementsMod>(`${LAB_CORE}/placements.ts`)
    const { DOCK_LABEL } = await load<DockMod>(`${LAB}/kits/dock.ts`)
    expect(DOCK_LABEL).toEqual({ text: 'KB-001 DOCK', sub: 'CHARGE / CALIB' })
    const labelMap = (lab: Lab) => ((lab.kits.get('kb001Dock')!.object.children[0]!.children[14] as THREE.Mesh).material as THREE.MeshStandardMaterial).map!
    const a = await makeLab()
    const b = await makeLab()
    const c = await makeLab(LAB_PLACEMENTS.map((p) => (p.id === 'kb001Dock' ? { ...p, opts: { label: { text: 'XW-002 DOCK' } } } : p)))
    expect(labelMap(a)).toBe(labelMap(b))
    expect(labelMap(c)).not.toBe(labelMap(a))
    for (const lab of [a, b, c]) lab.dispose()
  })

  test('dispose はキットの物（形・素材）を捨て、共有の素材・キャッシュの発光の素材と絵は捨てない', async () => {
    const lab = await makeLab()
    const mats = (lab as unknown as { materials: object }).materials
    const shared = new Set<unknown>(Object.values(mats as Record<string, unknown>).filter((m) => (m as THREE.Material)?.isMaterial))
    const kit = lab.kits.get('kb001Dock')!
    const disposed = new Set<unknown>()
    const watch = (x: object) => (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
    const geometries = new Set<THREE.BufferGeometry>()
    const used = new Set<THREE.Material>()
    const maps = new Set<THREE.Texture>()
    kit.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      geometries.add(m.geometry)
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        used.add(mat)
        const s = mat as THREE.MeshStandardMaterial
        if (s.map) maps.add(s.map)
      }
    })
    for (const x of [...geometries, ...used, ...maps]) watch(x)
    kit.dispose()
    expect([...geometries].filter((g) => !disposed.has(g))).toEqual([])
    expect([...used].filter((m) => shared.has(m))).toHaveLength(4) // 暗い金属・黒い金属・消えた画面・ゴム
    expect([...used].filter((m) => shared.has(m) && disposed.has(m))).toEqual([])
    // 発光の素材（キャッシュ。シアンと青の 2 つ）は捨てない。名札と光のにじみの素材は捨てる
    const glows = [...used].filter((m) => (m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(m as THREE.MeshBasicMaterial).map)
    expect(glows.length).toBe(2)
    expect(glows.filter((m) => disposed.has(m))).toEqual([])
    expect([...used].filter((m) => !shared.has(m) && !glows.includes(m) && !disposed.has(m))).toEqual([])
    // 名札の絵・光のにじみの絵はキャッシュなので捨てない
    expect(maps.size).toBe(2)
    expect([...maps].filter((t) => disposed.has(t))).toEqual([])
  })
})
