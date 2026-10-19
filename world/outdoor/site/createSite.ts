import * as THREE from 'three'
import { SITE } from '../../../core/town'
import { outdoor } from '../../environment/daylight'
import { enableSunShadow } from '../../environment/sunShadow'
import { labLight } from '../../labLight'
import { OUTDOOR_LAYER } from '../layers'
import { LIGHT_KIND, type LightItem } from '../town/lights'
import { depthMaterial, localShadowCasters } from '../town/shadows'
import { shrubMesh, type TreeMaterials } from '../town/trees'
import { GeoBuilder } from './builder'
import { buildShell } from './labShell'
import { buildSite, lampHeads } from './siteMeshes'
import { createSiteGlassMaterial, createSiteGlowMaterial, createSiteMaterial, MAX_LAMPS, siteUniforms } from './siteMaterial'
import { site } from './siteModel'

/**
 * ラボの外観とまわりのセットを組み立てる（Landscape が町を組み立てるとき、または町のデータが無いと分かったときに 1 回）。
 *
 * - 殻（labShell.ts）: 打ち放しの壁・屋根・屋上の物。太陽の影（部屋の SUN_SHADOW_LAYER。外にいる花音に建物の影が落ちる）・町の影の地図・
 *   花音のまわりの細かい影の地図に入れる
 * - セット（siteMeshes.ts）: テラス・石段・スロープ・見晴らし台は細かい影の地図にも入れる。小道と縁石と街灯は町の影の地図だけ
 * - 外から見たガラス・ガラスの手すり・ネオン・電球色の灯り
 * どれも遠景のレイヤー（OUTDOOR_LAYER。床の映り込みには入れない）
 */

const LAB = SITE.labFloorElevation
const NEON = new THREE.Color('#5fe6ff')
const WARM = new THREE.Color('#ffc27a')
const LENS_DAY = new THREE.Color('#d8d2c4')
const SPILL_LIVE = new THREE.Color('#57cfff')
const SPILL_ROOM = new THREE.Color('#b9d6ff')

export interface LabSite {
  group: THREE.Group
  /** 夜の灯りの点（町の灯りの点に足す。街灯の灯具） */
  lightItems: LightItem[]
  /** 毎コマ（時刻の光・部屋の照明に合わせる） */
  update(): void
  dispose(): void
}

export function createLabSite(treeMat: TreeMaterials | null): LabSite {
  const group = new THREE.Group()
  group.name = 'labSite'
  const mat = createSiteMaterial()
  const depth = depthMaterial()
  const shell = buildShell()
  const grounds = buildSite()

  const shellMesh = new THREE.Mesh(shell.solid.build(), mat)
  shellMesh.name = 'site:shell'
  shellMesh.userData.shadowMaterial = depth
  const groundMesh = new THREE.Mesh(grounds.solid.build(), mat)
  groundMesh.name = 'site:grounds'
  groundMesh.userData.shadowMaterial = depth

  const glassMat = createSiteGlassMaterial()
  const glassGeo = new GeoBuilder()
  glassGeo.merge(grounds.glass)
  const shellGlass = new THREE.Mesh(shell.glass, glassMat)
  shellGlass.name = 'site:glass'
  shellGlass.renderOrder = 20
  shellGlass.userData.noLocalShadow = true
  const railGlass = new THREE.Mesh(glassGeo.build(), glassMat)
  railGlass.name = 'site:railGlass'
  railGlass.renderOrder = 20
  railGlass.userData.noLocalShadow = true

  const neonMat = createSiteGlowMaterial(NEON)
  const neon = new THREE.Mesh(shell.neon.build(), neonMat)
  neon.name = 'site:neon'
  neon.userData.noLocalShadow = true
  const warmMat = createSiteGlowMaterial(WARM)
  const warmGeo = new GeoBuilder()
  warmGeo.merge(shell.warm)
  warmGeo.merge(grounds.warm)
  const warm = new THREE.Mesh(warmGeo.build(), warmMat)
  warm.name = 'site:warm'
  warm.userData.noLocalShadow = true

  const objects: THREE.Object3D[] = [shellMesh, groundMesh, shellGlass, railGlass, neon, warm]
  let shrubs: THREE.Object3D | null = null
  if (treeMat && grounds.shrubs.length) {
    shrubs = shrubMesh(grounds.shrubs, treeMat)
    shrubs.name = 'site:shrubs'
    objects.push(shrubs)
  }
  for (const o of objects) {
    o.layers.set(OUTDOOR_LAYER)
    o.frustumCulled = o !== shrubs
    group.add(o)
  }
  // 外にいる花音に、ラボの建物の太陽の影が落ちる（部屋の太陽の影の地図に入れる）
  enableSunShadow(shellMesh)

  // 街灯の灯具の位置（夜の光の uniform。ラボに近い順に）
  const heads = lampHeads().sort((a, b) => a.lengthSq() - b.lengthSq())
  const u = siteUniforms
  u.uLampCount.value = Math.min(MAX_LAMPS, heads.length)
  heads.slice(0, MAX_LAMPS).forEach((h, i) => (u.uLamps.array[i] as THREE.Vector4).set(h.x, h.y, h.z, 1))
  const lightItems: LightItem[] = heads.map((h, i) => ({ x: h.x, y: -h.z, z: h.y + LAB - 0.02, kind: LIGHT_KIND.path, color: '#ffb866', size: 0.32, power: 1.5, seed: (i * 0.618) % 1 * 0.3 }))

  // 細かい影の地図に入れる物（殻とセット。花音と KB-001 は character/avatar/characterVisual・KB001 が入れる）
  localShadowCasters.add(group)

  const _c = new THREE.Color()
  return {
    group,
    lightItems,
    update() {
      const o = outdoor
      const on = o.lights.path
      u.uLampOn.value = on * (0.6 + 0.4 * o.night)
      // ガラス壁からこぼれる光: 部屋の照明（配信中は暗くシアン寄り）と、外の暗さ
      const room = labLight.value
      _c.copy(SPILL_LIVE).lerp(SPILL_ROOM, Math.min(1, room))
      u.uSpill.value.copy(_c).multiplyScalar((0.12 + 0.5 * Math.min(1, room)) * (0.15 + 0.85 * o.night))
      u.uNeon.value = 0.08 + 0.32 * o.night
      neonMat.color.copy(NEON).multiplyScalar(1.4 + 2.2 * o.night)
      warmMat.color.copy(LENS_DAY).multiplyScalar(0.35).lerp(_c.copy(WARM).multiplyScalar(3.2), on)
    },
    dispose() {
      localShadowCasters.delete(group)
      for (const o of objects) (o as THREE.Mesh).geometry?.dispose()
    },
  }
}

/** 町の灯りの点のうち、作り直した小道の上の街灯（ラボから 150m まで）を外す（形のある街灯に置き換えたため） */
export function replacedTownLight(x: number, y: number, kind: number) {
  if (kind !== LIGHT_KIND.path && kind !== LIGHT_KIND.street) return false
  const z = -y
  if (Math.hypot(x, z) > 155) return false
  return site.pathAt(x, z, 1.6) !== null
}
