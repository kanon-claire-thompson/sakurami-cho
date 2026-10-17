import * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { labLight, onLabLight } from '../../labLight'
import { createLabSlot, kitChannels, type LabFrame, type LabSlot, type LabSlotContent } from '../kit'
import { LAB_PLACEMENTS, type LabPlacement } from '../../../core/lab/placements'
import { createLabEnvironment } from './environment'
import { labArea, labPoint, labSpot, lightFactor } from './lights'
import { LAB_ENV_INTENSITY, LAB_LIGHTS } from './lightTable'
import { PALETTE } from '../../palette'

/**
 * ラボの照明（docs/design/map-split.md §6 の「段 4」・4-3。案の §3.1）。光の表（lightTable.ts の LAB_LIGHTS）の並びのまま光を作り、
 * 反射用の環境（environment.ts）を持つ。明るさの入力は world/labLight.ts（labLighting.set）で受ける。
 *
 * - object: 光と spot の target（表の並び。差し込み口 stage の入れ物も並びの位置に）。使う側は場面の、前の Lighting の位置に足す
 * - attach(): 場面に付ける（scene.environment に入れて初めの撮影をし、明るさが入るたびに環境の強さを書く関数を登録する）。外す関数を返す
 * - update(dt, f): 毎コマ（明るさの入力のあと、床の映り込みより前）。反射の環境の撮り直しの判定・光の強さ・コアの脈・差し込み口の中身
 * - bindChannels({ baseStation }): コアの光が読む入力の値を結び付ける（createLab は基地局のキットの channels に。4-6）
 * - dispose(): 撮る先・光る板・影の地図・差し込み口の中身を捨てる
 */

/** 基地局のコアの光が読む入力の値（基地局のキットの channels の一部） */
export interface LabCoreChannels {
  /** 通信のグリーン（0〜1） */
  link: number
  /** 接続が確立した瞬間のフラッシュ（0〜1） */
  flash: number
  /** 演出の脈（0〜1） */
  pulse: number
  /** コアの明るさ（0〜1。既定 1。0 で消灯）。光の強さに掛ける */
  core: number
  /** 琥珀の混ぜ具合（0〜1。既定 0）。光の色を通信のグリーンから琥珀へ寄せる */
  amber: number
}

const CORE_CHANNELS: Readonly<LabCoreChannels> = { link: 0, flash: 0, pulse: 0, core: 1, amber: 0 }
const _amberColor = new THREE.Color(PALETTE.amber)

export interface LabLightingOptions {
  renderer: WebGPURenderer
  scene: THREE.Scene
  /** high なら影を落とす光（作業台の手元灯など）が影を落とす */
  quality: 'high' | 'low'
  /** 置き場所の表（印の付いた光・光る板のうち、表に無い置き場所の物は作らない）。既定は LAB_PLACEMENTS */
  placements?: readonly LabPlacement[]
  /** 入力の値（照明のコアの光が基地局の link・flash・pulse・core・amber を読む。あとから bindChannels でも結び付けられる） */
  channels?: { baseStation?: Partial<LabCoreChannels> }
  /** 差し込み口 stage の中身（作る時に入れる。あとから slots.stage.set でも入れられる） */
  stage?: LabSlotContent | null
}

export interface LabLighting {
  readonly object: THREE.Group
  /** 反射用の環境（cube のテクスチャ） */
  readonly environment: THREE.Texture
  readonly slots: { readonly stage: LabSlot }
  /** 基地局の入力の値（照明のコアの光が読む。読むたびに結び付けた物（options.channels.baseStation か bindChannels の物）を見る） */
  readonly channels: { readonly baseStation: Readonly<LabCoreChannels> }
  /** 入力の値を外の物に結び付ける（読むたびに見る。写さない。null で既定の値（link・flash・pulse は 0、core は 1、amber は 0）に） */
  bindChannels(source: { baseStation?: Partial<LabCoreChannels> | null }): void
  attach(): () => void
  update(dt: number, f: LabFrame): void
  dispose(): void
}

type Dimmed = { light: THREE.Light; intensity: number; dim: number | undefined }

export function createLabLighting(o: LabLightingOptions): LabLighting {
  const kits = new Set((o.placements ?? LAB_PLACEMENTS).map((p) => p.id))
  const object = new THREE.Group()
  object.name = 'lab:lighting'
  const stage = createLabSlot('stage')
  const coreChannels = kitChannels<LabCoreChannels>({ ...CORE_CHANNELS })
  if (o.channels?.baseStation) coreChannels.bind(o.channels.baseStation)
  const baseStation = coreChannels.channels
  const dimmed: Dimmed[] = []
  const lights: THREE.Light[] = []
  let hemi: { light: THREE.HemisphereLight; intensity: number; dim: number | undefined } | null = null
  let core: THREE.PointLight | null = null
  let coreAmber = 0
  /** コアの光のもとの色（光の表の色） */
  const commColor = new THREE.Color()

  for (const spec of LAB_LIGHTS) {
    if (spec.kind === 'slot') {
      object.add(stage.object)
      continue
    }
    if (spec.kit && !kits.has(spec.kit)) continue
    switch (spec.kind) {
      case 'hemi': {
        const light = new THREE.HemisphereLight(spec.sky, spec.ground, spec.intensity)
        hemi = { light, intensity: spec.intensity, dim: spec.dim }
        object.add(light)
        lights.push(light)
        break
      }
      case 'core': {
        const light = new THREE.PointLight(spec.color, spec.intensity, spec.distance, 2)
        light.position.set(...spec.at)
        commColor.set(spec.color)
        core = light
        object.add(light)
        lights.push(light)
        break
      }
      case 'point': {
        const light = labPoint(spec)
        dimmed.push({ light, intensity: spec.intensity, dim: spec.dim })
        object.add(light)
        lights.push(light)
        break
      }
      case 'spot': {
        const light = labSpot(spec, o.quality)
        dimmed.push({ light, intensity: spec.intensity, dim: spec.dim })
        object.add(light, light.target)
        lights.push(light)
        break
      }
      case 'area': {
        const light = labArea(spec)
        dimmed.push({ light, intensity: spec.intensity, dim: spec.dim })
        object.add(light)
        lights.push(light)
        break
      }
    }
  }
  if (o.stage) stage.set(o.stage)

  const environment = createLabEnvironment({ kits })

  return {
    object,
    environment: environment.texture,
    slots: { stage },
    channels: { baseStation },
    bindChannels(source) {
      coreChannels.bind(source.baseStation ?? null)
    },
    attach() {
      const { scene, renderer } = o
      const oldEnv = scene.environment
      const oldIntensity = scene.environmentIntensity
      environment.active = true
      environment.capture(renderer)
      scene.environment = environment.texture
      // 反射用の環境の強さ（部屋の照明と一緒に落とす。明滅も入った実際の明るさで）。書くのは照明だけ
      const write = (room: number) => {
        scene.environmentIntensity = LAB_ENV_INTENSITY * (0.4 + 0.6 * Math.min(1.2, room))
      }
      write(labLight.value)
      const off = onLabLight(write)
      return () => {
        off()
        environment.active = false
        if (scene.environment === environment.texture) scene.environment = oldEnv
        scene.environmentIntensity = oldIntensity
      }
    },
    update(dt, f) {
      environment.update(f.time, o.renderer)
      if (hemi) hemi.light.intensity = hemi.intensity * lightFactor(hemi.dim)
      if (core) {
        // ゆっくり呼吸するように明滅し、配信の「リンク確立」などで強くなる
        const t = f.time
        const base = 8 + Math.sin(t * 1.3) * 1.2 + Math.sin(t * 7.1) * 0.25
        // コアの明るさ（core）を掛け、色は琥珀の混ぜ具合（amber）で（既定の 1・0 では今の光のまま）
        const level = Number.isFinite(baseStation.core) ? Math.min(1, Math.max(0, baseStation.core)) : 1
        core.intensity = base * (1 + baseStation.link * 0.35 + baseStation.flash * 2.5 + baseStation.pulse * 1.8) * level
        const amber = Number.isFinite(baseStation.amber) ? Math.min(1, Math.max(0, baseStation.amber)) : 0
        if (amber !== coreAmber) {
          coreAmber = amber
          core.color.copy(commColor).lerp(_amberColor, amber)
        }
      }
      for (const d of dimmed) d.light.intensity = d.intensity * lightFactor(d.dim)
      stage.update(dt, f)
    },
    dispose() {
      environment.dispose()
      for (const l of lights) l.dispose()
      stage.dispose()
    },
  }
}
