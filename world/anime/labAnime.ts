import * as THREE from 'three/webgpu'
import { ROOM } from '../../core/lab/plan'
import type { Outdoor } from '../environment/daylight'
import type { Lab } from '../lab/createLab'
import { isDynamic } from '../staticMerge'
import { CASTER_LAYER, DYNAMIC_CASTER_LAYER, createKeyShadow, type KeyShadow } from './keyShadow'
import { AnimeShading, castsAnimeShadow, createAnimeMaterial, createAnimeUniforms, isAnimeTarget, syncAnime, type AnimeUniforms } from './material'
import { createNeonLights, type NeonLights } from './neon'
import { OUTLINE_LAYER } from './outline'
import { createTimeMix, mixTime, timeWeights, type AnimeRole, type AnimeTimeMix, type AnimeTimeName } from './palette'
import { updateTownPaint } from './townPaint'

/**
 * ラボのアニメ塗り（地図の既定の見た目。react の TownView が毎コマ動かす）: ラボの殻と什器の素材（名前の付いた MeshStandardMaterial。素材の名前で役割を引く
 * palette.ts）を、アニメ塗りの素材（material.ts）に差し替える。
 *
 * - 差し替えた物に輪郭線の層（OUTLINE_LAYER。後処理の輪郭線 outline.ts）と、部屋の殻・ガラス・半透明でなければ影を落とす物の層（keyShadow.ts。
 *   動かない物は CASTER_LAYER、動く物（markDynamic の物）は DYNAMIC_CASTER_LAYER）を足す
 * - 毎コマ: 時刻の配色（palette.ts。町の外の状態 outdoor の太陽の高さ・夜中の度合いから）→ ネオンの照り返しの光源（neon.ts）→ 町の塗りの時刻の配色
 *   （townPaint.ts）。描く直前にキーライトの影の地図を描く
 * - 差し込み口（slot:）の中は触らない。使う側の物（ラボの中に置く物・連れ歩く物）は convertMesh で同じく差し替えられる（shading を渡せば配色を自分の値に）
 * 元の素材は捨てない（ほかの物と共有している）。restore で元に戻す。
 *
 * ページに 1 つ（labAnime()。町と同じく 1 ページに 1 つ）
 */

/** 差し替えた組（元の素材・差し替えた素材・役割・最初に見つけた物・前に写した元の透明度） */
export interface AnimePair {
  source: THREE.MeshStandardMaterial
  anime: THREE.MeshBasicNodeMaterial
  role: AnimeRole
  mesh: THREE.Mesh
  last: { opacity: number }
}

export interface LabAnime {
  readonly uniforms: AnimeUniforms
  readonly shadow: KeyShadow
  /** ラボの色の式（使う側の物も、これを渡せばラボの配色で塗る） */
  readonly shading: AnimeShading
  readonly neon: NeonLights
  /** 混ぜた時刻の配色と、今の時刻の配色の重み */
  readonly mix: AnimeTimeMix
  readonly weights: Record<AnimeTimeName, number>
  /** 差し替えた組（元の素材 → 組）と、差し替えた物の元の素材と層 */
  readonly pairs: Map<THREE.Material, AnimePair>
  readonly meshes: Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; layers: number }>
  /** 時刻の配色を毎コマ書くか（false にすると uniforms を手で書ける。確かめる用） */
  auto: boolean
  /**
   * 1 つの物の素材を差し替え（差し替えない物はそのまま）、輪郭線の層と影を落とす物の層を足す。dynamic = 動く物（影は毎コマ描く地図へ）、
   * shading = 色の式（省けばラボの物）。戻り値は動かない物の影を落とす物か
   */
  convertMesh(mesh: THREE.Mesh, dynamic: boolean, shading?: AnimeShading): boolean
  /** ラボの殻と什器を見直す（あとから差し替えた素材・足した物も拾う）。動かない物の影を落とす物の数が変わったら、影の地図を描き直す。ネオンの光源も拾い直す */
  scanLab(lab: Lab): void
  /** 元の素材の変わる値（見え方・透明度）を写す（毎コマ） */
  sync(): void
  /** 時刻の配色を書く（毎コマ。auto のときだけ）・ネオンの照り返しの光源 */
  update(o: Outdoor): void
  /** 影の地図（描く直前。場面の行列を計算してから） */
  renderShadow(renderer: THREE.WebGPURenderer, scene: THREE.Scene, lab: Lab): void
  /** 元の素材と層に戻し、差し替えた素材を捨てる */
  restore(): void
}

/** ラボの影の地図の範囲: メインホールと、北側の部屋・中二階、南のガラス壁の外の少し */
const SHADOW_BOUNDS = new THREE.Box3(new THREE.Vector3(-ROOM.halfWidth - 0.5, -0.2, ROOM.north - 6), new THREE.Vector3(ROOM.halfWidth + 0.5, ROOM.height + 0.3, ROOM.south + 1.5))

function createLabAnime(): LabAnime {
  const uniforms = createAnimeUniforms()
  const shadow = createKeyShadow(uniforms)
  shadow.setBounds(SHADOW_BOUNDS)
  const shading = new AnimeShading(uniforms, shadow)
  const neon = createNeonLights()
  const mix = createTimeMix()
  const weights: Record<AnimeTimeName, number> = { day: 0, dusk: 0, night: 1, deep: 0 }
  const pairs = new Map<THREE.Material, AnimePair>()
  const meshes = new Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; layers: number }>()
  let staticCasters = 0

  function convert(m: THREE.Material, mesh: THREE.Mesh, sh: AnimeShading): { material: THREE.Material; caster: boolean } {
    if (!isAnimeTarget(m)) return { material: m, caster: false }
    let p = pairs.get(m)
    if (!p) {
      const source = m as THREE.MeshStandardMaterial
      const made = createAnimeMaterial(source, mesh, sh)
      p = { source, anime: made.material, role: made.role, mesh, last: { opacity: source.opacity } }
      pairs.set(m, p)
    }
    return { material: p.anime, caster: castsAnimeShadow(p.role, p.source) }
  }

  const self: LabAnime = {
    uniforms,
    shadow,
    shading,
    neon,
    mix,
    weights,
    pairs,
    meshes,
    auto: true,
    convertMesh(mesh, dynamic, sh = shading) {
      const before = mesh.material
      let caster = false
      const after = Array.isArray(before)
        ? before.map((m) => {
            const r = convert(m, mesh, sh)
            caster ||= r.caster
            return r.material
          })
        : (() => {
            const r = convert(before, mesh, sh)
            caster = r.caster
            return r.material
          })()
      const changed = Array.isArray(before) ? (after as THREE.Material[]).some((m, i) => m !== before[i]) : after !== before
      if (changed) {
        if (!meshes.has(mesh)) meshes.set(mesh, { material: before, layers: mesh.layers.mask })
        mesh.material = after
        // 輪郭線の描画は透ける物も不透明に描くので、透ける物（ガラス・張り紙）は入れない（入れると、ガラスの向こうの物に線が出ず、ガラスの縁に線が出た）
        if (!isTransparent(after)) mesh.layers.enable(OUTLINE_LAYER)
      }
      if (caster) mesh.layers.enable(dynamic ? DYNAMIC_CASTER_LAYER : CASTER_LAYER)
      return mesh.layers.isEnabled(CASTER_LAYER)
    },
    scanLab(lab) {
      let n = 0
      const visit = (o: THREE.Object3D, moving: boolean) => {
        // 動く物（markDynamic の物とその下）の影は、毎コマ描く地図へ
        const dyn = moving || isDynamic(o)
        // 差し込み口の中は使う側の物（触らない）
        if (o.name.startsWith('slot:')) return
        const mesh = o as THREE.Mesh
        if (mesh.isMesh && mesh.material && self.convertMesh(mesh, dyn)) n++
        for (const c of o.children) visit(c, dyn)
      }
      visit(lab.shell.object, false)
      visit(lab.kits.object, false)
      // 古い物（場面から外れた物）の控えを捨てる
      for (const mesh of meshes.keys()) if (!mesh.parent) meshes.delete(mesh)
      // 動かない物の影を落とす物が増えたら（あとから足した物）、動かない物の地図を描き直す
      if (n !== staticCasters) {
        staticCasters = n
        shadow.invalidate()
      }
      neon.scan(lab.lighting.object)
    },
    sync() {
      for (const p of pairs.values()) syncAnime(p.source, p.anime, p.last)
    },
    update(o) {
      if (self.auto) {
        timeWeights(o, weights)
        mixTime(weights, o.sunDir, mix)
        uniforms.base.value.copy(mix.base)
        uniforms.shade.value.copy(mix.shade)
        uniforms.key.value.copy(mix.key)
        uniforms.keyDir.value.copy(mix.keyDir)
        uniforms.neon.value = mix.neon
        uniforms.rim.value = mix.rim
      }
      neon.update(uniforms)
      // 町のアニメ塗りの時刻の配色（townPaint.ts。町の材質が読む）
      if (self.auto) updateTownPaint(o)
    },
    renderShadow(renderer, scene, lab) {
      scene.updateMatrixWorld()
      shadow.render(renderer, scene, uniforms.keyDir.value, [lab.kits.object])
    },
    restore() {
      for (const [mesh, prev] of meshes) {
        mesh.material = prev.material
        mesh.layers.mask = prev.layers
      }
      for (const p of pairs.values()) p.anime.dispose()
      meshes.clear()
      pairs.clear()
      staticCasters = 0
    },
  }
  return self
}

let instance: LabAnime | null = null

/** ラボのアニメ塗り（ページに 1 つ。初めて呼んだときに作る） */
export function labAnime(): LabAnime {
  return (instance ??= createLabAnime())
}

/** 素材（の 1 つ）が透けるか */
export function isTransparent(m: THREE.Material | THREE.Material[]): boolean {
  return Array.isArray(m) ? m.some((x) => x.transparent) : m.transparent
}
