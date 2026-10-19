import * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { createLabMaterials, type LabMaterials, type LabTextures } from '../materials/labMaterials'
import { createLabAtmosphere, type LabAtmosphere } from './atmosphere'
import { assembleLabKit, type LabAnchor, type LabFrame, type LabKit, type LabScreenFactory, type LabSlot } from './kit'
import { labKitDef } from './kits'
import { labOptions, type LabHostOptions } from './labHost'
import { createLabLighting, type LabLighting } from './lighting/createLabLighting'
import { LAB_PLACEMENTS, labKitPlanOf, type LabPlacement } from '../../core/lab/placements'
import { createLabScreen, type LabScreen } from './screens'
import { createLabShell, type LabShell } from './shell/createShell'
import { prepareLabSharedTextures } from './textures'
import { mergeStatic, type StaticMerge } from '../staticMerge'
import { createLabCull, type LabCull } from './labCull'

/**
 * ラボを作る（docs/design/map-split.md §6 の「段 4」・4-5。案の §4.2・§4.3）: 素材 → 照明 → 殻 → 什器のキット（置き場所の表の順）→ 空気。
 * 作るのは物だけで、場面に付けること（照明・殻・空気の attach）と毎コマの更新は使う側が決まった位置で呼ぶ
 * （段 4 のあいだは「照明・殻・什器」の 3 本の購読。照明は明るさの入力のあと、殻（床の映り込み・見学エントランスの扉）は照明と町の遠景のあと、
 * 什器はそのあと。1 本にまとめるのは段 5）。
 *
 * - 置き場所の表（placements）から外した什器は、キット・印の付いた光・光る板・光の筋も作らない。表の順がキットの作る順と毎コマの順
 * - キットの入力の値・差し込み口の中身・画面の中身は、ラボの口（labHost.ts の configureLab）から読む
 * - 照明のコアの光は、基地局のキット（置き場所 baseStation）の入力の値を読む（キットは照明のあとに作るので、作ったあとで結び付ける。4-6）
 * - anchors: インスタンスの側のアンカー（作ったキットの物。作った物の行列から出したアンカー（devDesk.monitor）も。4-8）
 * - slots: 差し込み口を名前で引く（作ったキットの「置き場所の id.差し込み口の名前」と照明の lighting.stage。R3F の子を入れる口が使う。4-10）
 * - mergeStatic(): 殻と什器の動かない物を合わせる（WebGPU への移行の第 3 段。world/staticMerge.ts。描く回数を減らす）。場面に付けたあと
 *   （殻の太陽の影の印のあと。町の口の attach）、最初に描く前に 1 回。差し込み口（slot:）の中は触らない。2 回目からは何もしない
 * - cull: 什器と空気を、見えないコマだけ描かない（labCull.ts。WebGPU への移行の第 3 段）。使う側は cull.proxy を場面に置き、毎コマ
 *   cull.update(camera)（町の口の view が、殻と什器の更新の前に呼ぶ）。箱は mergeStatic のあとの殻と什器を囲む箱
 * - dispose(): 照明・殻・キット・空気が作った物を捨てる（共有の素材は捨てない。前も捨てていなかった）
 */

export interface LabOptions {
  renderer: WebGPURenderer
  scene: THREE.Scene
  /** 読んだままのテクスチャ（下ごしらえはここでする。textures.ts の labTextureUrls の置き場所から読んだ物） */
  textures: { shared: LabTextures }
  /** high なら影を落とす光・ほこりの数 */
  quality: 'high' | 'low'
  /** 画面の画素の比（ほこりの粒の大きさ。あとから lab.atmosphere.setPixelRatio で変えられる） */
  pixelRatio: number
  /** 置き場所の表（既定は LAB_PLACEMENTS） */
  placements?: readonly LabPlacement[]
  /** ラボの口（既定は configureLab で入れた物） */
  host?: Readonly<LabHostOptions>
}

/** 什器のキット（置き場所の表の順） */
export interface LabKits {
  /** キットの群（中は表の順）。使う側は場面の、什器の位置に足す */
  readonly object: THREE.Group
  readonly list: readonly LabKit[]
  get(id: string): LabKit | undefined
  /** 毎コマ（表の順に kit.update） */
  update(dt: number, f: LabFrame): void
  dispose(): void
}

/**
 * インスタンスの側のアンカー（docs/design/map-split.md §6 の「段 4」・4-8。案の §3.4 の lab.anchors）。作ったキットの物だけで、表に無い置き場所は無い。
 * モジュールの読み込みの時に使うのはデータの側（anchors.ts の labAnchor）
 */
export interface LabAnchors {
  /**
   * 名前で引く（無ければ undefined）: 「置き場所の id.キットの中の名前」（plan のアンカーと、作った物の行列から出したアンカー）か、
   * 「置き場所の id」（置き場所の原点。キットの object の位置と向き）
   */
  get(name: string): LabAnchor | undefined
}

/**
 * 差し込み口を名前で引く（docs/design/map-split.md §6 の「段 4」・4-10）。中身はラボの口（labHost.ts の slots）で作る時に入れるか、
 * 使う側があとから入れる（R3F の子は react/LabView.tsx の LabSlot が portal で入れ物の子にする）
 */
export interface LabSlots {
  /** 「置き場所の id.差し込み口の名前」（作ったキットの物）か 'lighting.stage'（無ければ undefined） */
  get(name: string): LabSlot | undefined
}

export interface Lab {
  readonly placements: readonly LabPlacement[]
  readonly materials: LabMaterials
  readonly lighting: LabLighting
  readonly shell: LabShell
  readonly kits: LabKits
  readonly anchors: LabAnchors
  readonly slots: LabSlots
  readonly atmosphere: LabAtmosphere
  /** 什器と空気を、見えないコマだけ描かない（cull.proxy を場面に置き、毎コマ cull.update(camera)） */
  readonly cull: LabCull
  /** 殻と什器の動かない物を合わせる（場面に付けたあと、最初に描く前に 1 回。合わせた元の mesh の数と、できた mesh の数を返す） */
  mergeStatic(): { sources: number; merged: number }
  dispose(): void
}

export function createLab(o: LabOptions): Lab {
  const placements = o.placements ?? LAB_PLACEMENTS
  const host = o.host ?? labOptions()
  const quality = o.quality
  // 前の LabRoot の順: 共有のテクスチャの下ごしらえと素材 → 照明
  const materials = createLabMaterials(prepareLabSharedTextures(o.textures.shared))
  const lighting = createLabLighting({
    renderer: o.renderer,
    scene: o.scene,
    quality,
    placements,
    stage: host.slots['lighting.stage']?.() ?? null,
  })
  const shell = createLabShell({ materials })
  const screens: LabScreen[] = []
  const kits = createKits(placements, host, { materials, quality, maxAnisotropy: o.renderer.getMaxAnisotropy(), renderer: o.renderer, screens })
  // 画面を貼った物を描いたら、その画面に知らせる（描き直した画面を早めにテクスチャへ送るのは、見えている画面だけ）
  bindScreenMeshes(kits.object, screens)
  // 照明のコアの光（印 baseStation）は基地局のキットの入力の値を読む（読むたびに見る。キットの入力の値はラボの口の channels.baseStation を読む）
  lighting.bindChannels({ baseStation: kits.get('baseStation')?.channels ?? null })
  const atmosphere = createLabAtmosphere({ quality, pixelRatio: o.pixelRatio, placements })
  let merges: StaticMerge[] | null = null
  const cull = createLabCull()
  cull.setTargets([kits.object, atmosphere.object])
  return {
    placements,
    materials,
    lighting,
    shell,
    kits,
    anchors: kitAnchors(kits.list, placements),
    slots: labSlots(lighting, kits.list),
    atmosphere,
    cull,
    mergeStatic() {
      if (!merges) {
        merges = [shell.mergeStatic(), ...kits.list.map((k) => mergeStatic(k.object, { skip: isSlot }))]
        // 殻と什器の群も動かない（固める。場面の根を固めた使う側では、動く物の下だけが毎コマ行列を計算する）
        for (const g of [shell.object, kits.object]) {
          g.updateMatrix()
          g.matrixAutoUpdate = false
        }
        // 見えないコマを調べる箱（殻と什器を囲む。動く物はこの中で動く）
        shell.object.updateMatrixWorld(true)
        kits.object.updateMatrixWorld(true)
        cull.setBounds(new THREE.Box3().setFromObject(shell.object).union(new THREE.Box3().setFromObject(kits.object)))
      }
      return { sources: merges.reduce((n, m) => n + m.sources, 0), merged: merges.reduce((n, m) => n + m.merged, 0) }
    },
    dispose() {
      lighting.dispose()
      shell.dispose()
      kits.dispose()
      atmosphere.dispose()
      for (const m of merges ?? []) m.dispose()
      cull.dispose()
    },
  }
}

function createKits(
  placements: readonly LabPlacement[],
  host: Readonly<LabHostOptions>,
  ctx: { materials: LabMaterials; quality: 'high' | 'low'; maxAnisotropy: number; renderer: WebGPURenderer; screens: LabScreen[] },
): LabKits {
  const object = new THREE.Group()
  object.name = 'lab:kits'
  const list: LabKit[] = []
  for (const p of placements) {
    const def = labKitDef(p.kit)
    if (!def) throw new Error(`lab: キットの種類が無い（${p.kit}。置き場所 ${p.id}）`)
    const plan = labKitPlanOf(p.id, placements)!
    const kit = assembleLabKit(
      p.id,
      p.kit,
      p.at,
      plan,
      def.create(p.at, p.opts, { id: p.id, materials: ctx.materials, quality: ctx.quality, maxAnisotropy: ctx.maxAnisotropy, screens: screenFactory(p.id, host, ctx) }),
    )
    const channels = host.channels[p.id]
    if (channels) kit.bindChannels(channels)
    for (const [name, slot] of Object.entries(kit.slots)) {
      const make = host.slots[`${p.id}.${name}`]
      if (make) slot.set(make())
    }
    object.add(kit.object)
    list.push(kit)
  }
  const byId = new Map(list.map((k) => [k.id, k]))
  return {
    object,
    list,
    get: (id) => byId.get(id),
    update(dt, f) {
      for (const kit of list) kit.update(dt, f)
    },
    dispose() {
      for (const kit of list) kit.dispose()
    },
  }
}

const _yAxis = new THREE.Vector3(0, 1, 0)

/** 差し込み口の入れ物（中身は外から入る。動かない物を合わせるときに中を触らない） */
const isSlot = (o: THREE.Object3D) => o.name.startsWith('slot:')

/** 作ったキットのアンカーを名前で引く表（置き場所の原点と、キットの anchors） */
function kitAnchors(list: readonly LabKit[], placements: readonly LabPlacement[]): LabAnchors {
  const byName = new Map<string, LabAnchor>()
  for (const kit of list) {
    const at = placements.find((p) => p.id === kit.id)!.at
    byName.set(kit.id, {
      name: kit.id,
      position: new THREE.Vector3(...at.position),
      quaternion: new THREE.Quaternion().setFromAxisAngle(_yAxis, at.rotationY),
      yaw: at.rotationY,
    })
    for (const [key, a] of Object.entries(kit.anchors)) byName.set(`${kit.id}.${key}`, a)
  }
  return { get: (name) => byName.get(name) }
}

/** 差し込み口を名前で引く表（照明の stage と、作ったキットの slots） */
function labSlots(lighting: LabLighting, list: readonly LabKit[]): LabSlots {
  const byName = new Map<string, LabSlot>([['lighting.stage', lighting.slots.stage]])
  for (const kit of list) for (const [key, slot] of Object.entries(kit.slots)) byName.set(`${kit.id}.${key}`, slot)
  return { get: (name) => byName.get(name) }
}

/**
 * 置き場所ごとの画面の作り手。画面の名前は「置き場所の id.キットの中の名前」で、ラボの口にその名前の中身があれば作る時に入れる
 * （最初の更新で描くのがその中身になる。作ったあとで入れると、最初のコマが既定の中身になり、次に描くのは数コマ先になる）
 */
function screenFactory(id: string, host: Readonly<LabHostOptions>, o: { maxAnisotropy: number; renderer: WebGPURenderer; screens: LabScreen[] }): LabScreenFactory {
  return (name, width, height, defaultDraw, fps) => {
    const key = `${id}.${name}`
    const screen = createLabScreen(key, width, height, defaultDraw, fps, { maxAnisotropy: o.maxAnisotropy, renderer: o.renderer })
    o.screens.push(screen)
    const content = host.screens?.[key]
    if (content) screen.setContent(content)
    return screen
  }
}

/**
 * 画面のテクスチャを貼った mesh に、描いたことを画面へ知らせる onBeforeRender を付ける（素材のどれかの値か、ホロの mapTexture がその画面のテクスチャの物）。
 * 画面を貼った物は素材がそれぞれ別なので、動かない物を合わせる対象にはもともとならない
 */
function bindScreenMeshes(root: THREE.Object3D, screens: readonly LabScreen[]) {
  if (screens.length === 0) return
  const byTexture = new Map<THREE.Texture, LabScreen>(screens.map((s) => [s.texture, s]))
  const find = (m: THREE.Material): LabScreen | undefined => {
    const holo = (m as { mapTexture?: THREE.Texture | null }).mapTexture
    if (holo && byTexture.has(holo)) return byTexture.get(holo)
    for (const v of Object.values(m)) if (v instanceof THREE.Texture && byTexture.has(v)) return byTexture.get(v)
    return undefined
  }
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const found = new Set<LabScreen>()
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const s = find(m)
      if (s) found.add(s)
    }
    if (found.size === 0) return
    const list = [...found]
    mesh.onBeforeRender = () => {
      for (const s of list) s.markShown()
    }
  })
}
