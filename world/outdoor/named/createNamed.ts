import * as THREE from 'three'
import { disposeGeometries } from '../../dispose'
import { townOptions } from '../../townHost'
import { OUTDOOR_LAYER } from '../layers'
import { createSiteGlassMaterial } from '../site/siteMaterial'
import type { LightItem } from '../town/lights'
import { depthMaterial } from '../town/shadows'
import type { TownInfra } from '../town/townData'
import { ringCenter } from './frame'
import { GlassBuilder, type DoorSpec, type Kit, localMatrix } from './kit'
export { namedInteriorParts }
import { KitBuilder } from './kitBuilder'
import { buildKit, type KitContext } from './kits'
import { MassWriter } from './mass'
import { createNamedGlassMaterial, createNamedGlowMaterial, createNamedMaterial, createNamedSignMaterial, MAX_NAMED_LAMPS, namedUniforms, syncNamedUniforms } from './namedMaterial'
import type { NamedFile } from './namedData'
import { SignBuilder, signAtlas } from './signs'
import { buildStructureKits } from './structures'
import { namedDoors } from './doors'
import { clearClocks, createClockHands, tickClocks } from './clocks'
import { namedInteriorParts } from './interiorParts'

/**
 * 名前のある建物（126 棟）と構造物の外観を組み立てて、近くと遠くで描き分ける（Landscape が町を組み立てるときに 1 回作り、
 * 細かさの中心が動いたら rebuild で作り直す）。
 *
 * - 近く（細かさの中心から nearRadius m 以内）: 細かい形（質感・窓のガラス・看板・灯具・開く扉）。描画は 4〜5 回
 * - 遠く: 町の建物のシェーダーで描く安い形（mass。窓・窓明かり・質感は町の建物と同じ）。描画は 1 回
 * - 地図データの自動の形（長方形のインスタンス・形のある建物・建物の部分・小物・窓明かりの点）は、作った建物の分を描かない（skip）
 */

export interface NamedTown {
  group: THREE.Group
  /** 町の光の点に足す灯り（入口の灯り・灯台・クレーンなど。遠くのきらめき） */
  lights: LightItem[]
  /** 地図データの自動の形を描かない建物か（目録の名前のある建物の番号） */
  skip: (namedIndex: number) => boolean
  /** 細かさの中心を動かして作り直す */
  rebuild: (center: [number, number]) => void
  /** 毎コマ */
  update: () => void
  /** ?debug の数 */
  stats: () => { near: number; far: number; triangles: number }
}

interface Entry {
  kit: Kit
  name: string
  center: [number, number]
  /** 近くの形の大きさの目安（半径 m） */
  radius: number
}

/** 町の建物のシェーダーの遠くの形のマテリアル（Landscape の polyMat）と、その影のマテリアル */
export function createNamedTown(named: NamedFile, infra: TownInfra, heightAt: (x: number, y: number) => number, polyMat: THREE.Material, polyDepth: THREE.Material, nearRadius: number, order: number): NamedTown {
  const ctx: KitContext = { infra, heightAt }
  const t0 = performance.now()
  const entries: Entry[] = []
  const handled = new Set<number>()
  named.buildings.forEach((rec, i) => {
    if (!rec.drawn) return
    const { kit, kitName } = buildKit(rec, ctx)
    handled.add(i)
    if (kit.interior) namedInteriorParts.kits.set(rec.id, kit)
    const c = ringCenter(rec.ring)
    const radius = rec.ring.reduce((m, q) => Math.max(m, Math.hypot(q[0] - c[0], q[1] - c[1])), 0)
    entries.push({ kit, name: kitName, center: c, radius })
  })
  for (const s of buildStructureKits(named.structures, ctx)) entries.push(s)
  const lights = entries.flatMap((e) => e.kit.lights)
  console.info(`[named] 名前のある建物と構造物を作りました（${entries.length}・${Math.round(performance.now() - t0)}ms）`)

  const solidMat = createNamedMaterial()
  const glassMat = createNamedGlassMaterial()
  const signMat = createNamedSignMaterial(signAtlas.tex)
  const glowMat = createNamedGlowMaterial()
  const clearMat = createSiteGlassMaterial()
  clearMat.side = THREE.DoubleSide
  // 中のある建物の開く扉の透けるガラス（中を作ったときに出す）
  const doorClearMat = createSiteGlassMaterial()
  doorClearMat.side = THREE.DoubleSide
  const depth = depthMaterial()
  const group = new THREE.Group()
  group.name = 'named'
  let meshes: THREE.Object3D[] = []
  let nearCount = 0
  let farCount = 0
  let tris = 0

  const add = (o: THREE.Object3D, ro: number) => {
    o.layers.set(OUTDOOR_LAYER)
    o.renderOrder = ro
    o.traverse((c) => c.layers.set(OUTDOOR_LAYER))
    group.add(o)
    meshes.push(o)
  }

  function rebuild(center: [number, number]) {
    for (const m of meshes) {
      group.remove(m)
      disposeGeometries(m)
    }
    meshes = []
    namedDoors.clear()
    namedInteriorParts.clear()
    const interiorKits: Kit[] = []
    const solid = new KitBuilder()
    const glass = new GlassBuilder()
    const glow = new KitBuilder()
    const clear = new KitBuilder()
    const signs = new SignBuilder()
    const mass = new MassWriter()
    const lamps: Kit['lamps'] = []
    const doors: DoorSpec[] = []
    const clocks: Kit['clocks'] = []
    clearClocks()
    nearCount = 0
    farCount = 0
    for (const e of entries) {
      const d = Math.hypot(e.center[0] - center[0], e.center[1] - center[1]) - e.radius
      if (d < nearRadius) {
        solid.merge(e.kit.solid)
        glass.merge(e.kit.glass)
        glow.merge(e.kit.glow)
        clear.merge(e.kit.clear)
        signs.merge(e.kit.signs)
        lamps.push(...e.kit.lamps)
        doors.push(...e.kit.doors)
        clocks.push(...e.kit.clocks)
        if (e.kit.interior) interiorKits.push(e.kit)
        nearCount++
      } else {
        mass.merge(e.kit.mass)
        farCount++
      }
    }
    signAtlas.flush()
    tris = 0
    const mk = (g: THREE.BufferGeometry, mat: THREE.Material, name: string, ro: number, shadow: THREE.Material | null) => {
      const m = new THREE.Mesh(g, mat)
      m.name = name
      m.frustumCulled = false
      if (shadow) m.userData.shadowMaterial = shadow
      add(m, ro)
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3
    }
    if (solid.vertexCount) mk(solid.build(), solidMat, 'named:solid', order, depth)
    if (glass.count) mk(glass.build(), glassMat, 'named:glass', order, null)
    if (signs.count) mk(signs.build(), signMat, 'named:signs', order + 1, null)
    if (glow.vertexCount) mk(glow.build(), glowMat, 'named:glow', order + 1, null)
    if (clear.vertexCount) mk(clear.build(), clearMat, 'named:clear', 20, null)
    if (mass.count) mk(mass.build(), polyMat, 'townBuildings:named-far', order, polyDepth)
    // 開く扉（蝶番の軸で回せる Object3D）
    const doorGlass = new Map<string, { opaque: THREE.Object3D; clear: THREE.Object3D }[]>()
    for (const d of doors) {
      const pivot = doorObject(d, solidMat, glassMat, depth, interiorKits.some((k) => k.rec.id === d.buildingId) ? doorClearMat : null)
      add(pivot, order)
      namedDoors.add(d, pivot)
      const pair = pivot.userData.glassPair as { opaque: THREE.Object3D; clear: THREE.Object3D } | undefined
      if (pair) doorGlass.set(d.buildingId, [...(doorGlass.get(d.buildingId) ?? []), pair])
    }
    // 中のある建物の窓のガラスと仮の物（中を作ったら隠す。namedInteriorParts）
    for (const k of interiorKits) {
      let g: THREE.Mesh | null = null
      let ph: THREE.Mesh | null = null
      if (k.glassSep.count) {
        g = new THREE.Mesh(k.glassSep.build(), glassMat)
        g.name = `named:glass:${k.rec.id}`
        g.frustumCulled = false
        add(g, order)
      }
      if (k.placeholder.vertexCount) {
        ph = new THREE.Mesh(k.placeholder.build(), solidMat)
        ph.name = `named:placeholder:${k.rec.id}`
        ph.frustumCulled = false
        add(ph, order)
      }
      namedInteriorParts.register(k.rec.id, { glass: g, placeholder: ph, doorGlass: doorGlass.get(k.rec.id) ?? [] })
    }
    for (const c of clocks) add(createClockHands(c), order + 2)
    // 入口の灯り（細かさの中心に近い順に MAX 個）
    lamps.sort((a, b) => Math.hypot(a.p[0] - center[0], a.p[2] + center[1]) - Math.hypot(b.p[0] - center[0], b.p[2] + center[1]))
    const u = namedUniforms
    u.uNLampCount.value = Math.min(MAX_NAMED_LAMPS, lamps.length)
    lamps.slice(0, MAX_NAMED_LAMPS).forEach((l, i) => {
      u.uNLamps.value[i].set(l.p[0], l.p[1], l.p[2], l.range)
      u.uNLampC.value[i].set(l.color[0], l.color[1], l.color[2])
    })
  }

  // ?debug のとき、開く扉をコンソールから試せるように（window.__namedDoors.setOpen('building.ekimae.cafe-platform-1872', 1)）
  if (townOptions().debug) (window as unknown as { __namedDoors: typeof namedDoors }).__namedDoors = namedDoors
  return {
    group,
    lights,
    skip: (i) => handled.has(i),
    rebuild,
    update() {
      syncNamedUniforms()
      signAtlas.flush()
      tickClocks()
    },
    stats: () => ({ near: nearCount, far: farCount, triangles: Math.round(tris) }),
  }
}

/** 開く扉の Object3D（蝶番の軸の下端が原点。rotation.y で開く）。clearMat があれば、透けるガラスも作る（中のある建物。userData.glassPair） */
function doorObject(d: DoorSpec, solidMat: THREE.Material, glassMat: THREE.Material, depth: THREE.Material, clearMat: THREE.Material | null) {
  const pivot = new THREE.Group()
  pivot.name = `namedDoor:${d.buildingId}:${d.entrance}`
  const m = localMatrix(d.hinge, d.across, d.out)
  pivot.applyMatrix4(m)
  const leaf = new THREE.Mesh(d.leaf.build(), solidMat)
  leaf.userData.shadowMaterial = depth
  leaf.frustumCulled = false
  pivot.add(leaf)
  if (d.glass) {
    const geo = d.glass.build()
    const g = new THREE.Mesh(geo, glassMat)
    g.frustumCulled = false
    pivot.add(g)
    if (clearMat) {
      const c = new THREE.Mesh(geo, clearMat)
      c.frustumCulled = false
      c.visible = false
      c.renderOrder = 20
      c.userData.noLocalShadow = true
      pivot.add(c)
      pivot.userData.glassPair = { opaque: g, clear: c }
    }
  }
  return pivot
}
