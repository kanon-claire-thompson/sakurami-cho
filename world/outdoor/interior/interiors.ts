import * as THREE from 'three'
import { disposeGeometries } from '../../dispose'
import { townOptions, type TownDoorOpener, type TownFocus } from '../../townHost'
import { INTERIOR_ZONES, INTERIOR_ZONE_IDS, zoneAt, type InteriorZoneId } from '../../../core/interiors'
import { townPlaces } from '../../../core/places'
import { outdoor } from '../../environment/daylight'
import { OUTDOOR_LAYER } from '../layers'
import { namedDoors } from '../named/doors'
import { namedInteriorParts } from '../named/interiorParts'
import { localMatrix, type Kit } from '../named/kit'
import type { NamedFile } from '../named/namedData'
import { depthMaterial, localShadowCasters } from '../town/shadows'
import { gardenDomeShell } from '../town/infraMeshes'
import { groundHole } from '../town/townMaterials'
import { InteriorBuilder } from './builder'
import { createInteriorGlassMaterial, createInteriorGlowMaterial, createInteriorPictureMaterial, createInteriorSurfaceMaterial, createInteriorUniforms, MAX_IGROUP, MAX_ILAMP, MAX_IWIN, type InteriorUniforms } from './interiorMaterial'
import { InteriorModel, polyMargin, type DoorM } from './model'
import { PictureAtlas } from './pictures'
import { ShellBuilder, type DoorLeaf } from './shell'
import { INTERIOR_BRIEFS } from './briefs'
import type { InteriorDecor, LampDef } from './types'

/**
 * 中のある建物の「中」をまとめて扱う（町の段階 4 の後半。docs/design/town.md の §13）。
 *
 * - 形の決まり（model）: 町のデータを読んだら、ゾーンごとに作る（花音の通り道・高さ・カメラの確かめ。形を作る前から使う）
 * - 形: カメラか花音が建物の近く（loadRadius）に来たら作り、離れたら（unloadRadius）壊す。作ったら外観の不透明な窓・仮の物を隠す
 * - 毎コマ: 扉（注目点の花音と、扉を開ける物（townHost の townDoorOpeners。付いて浮かぶロボットなど）が近づくと開く）・灯り（時刻と花音のいる部屋）・窓の光（空と太陽）・まわりの明るさ・ガラスの映り込み
 * - 花音の光（OutdoorLighting が使う）: 中にいるとき、いちばん明るい窓か灯りの向き・色・強さと、まわりの明るさ
 */

const LAB = 116

/**
 * 扉を開ける物（注目点のほか。townDoorOpeners）のどれかが扉の前にいるか: 扉の中心（x, z）から水平に 0.9m・扉の床から 1m の高さの上下 1.8m の中
 * （付いて浮かぶ物は花音の肩より上を飛ぶので、高さは床から 1m を中心に広く取る）
 */
function openerNear(openers: readonly TownDoorOpener[], x: number, z: number, floorY: number) {
  for (let i = 0; i < openers.length; i++) {
    const p = openers[i].position
    if (Math.hypot(p.x - x, p.z - z) < 0.9 && Math.abs(p.y - floorY - 1) < 1.8) return true
  }
  return false
}

interface LeafState {
  leaf: DoorLeaf
  pivot: THREE.Object3D
  open: number
  hold: number
  q0: THREE.Quaternion
  /** 開く向きの回転の符号（局所の z が開く側なら -1） */
  sign: number
}

interface NamedDoorState {
  door: DoorM
  open: number
  hold: number
}

interface WindowLight {
  /** 角の点・横の辺・縦の辺（シーン。U × V が部屋の内向き） */
  p0: THREE.Vector3
  U: THREE.Vector3
  V: THREE.Vector3
  /** 外向き */
  out: THREE.Vector3
  area: number
  group: number
  center: THREE.Vector3
}

interface LampState {
  def: LampDef
  index: number
  group: number
  pos: THREE.Vector3
  on: number
}

interface Loaded {
  id: InteriorZoneId
  model: InteriorModel
  group: THREE.Group
  uniforms: InteriorUniforms
  materials: THREE.Material[]
  leaves: LeafState[]
  named: NamedDoorState[]
  windows: WindowLight[]
  lamps: LampState[]
  /** 組ごとの床の広さ（まわりの明るさの計算） */
  groupArea: number[]
  triangles: number
  /** 決まりが足した形（ドームの植物・水・霧・ガラス） */
  decor: InteriorDecor | null
  /** ガラスの温室（ガーデンドーム） */
  glass: boolean
  /** この建物の絵のアトラス（片付けるときに一緒に捨てる。#15） */
  atlas: PictureAtlas
}

/** 中にいる花音の光（OutdoorLighting） */
export const interiorLight = {
  /** 花音が中のある建物の部屋にいる度合い（0〜1） */
  active: 0,
  /** 光の来る向き（花音から光へ）・色・強さ */
  dir: new THREE.Vector3(0, 1, 0),
  color: new THREE.Color(),
  intensity: 0,
  /** まわりの明るさ（空の光の代わり） */
  ambient: new THREE.Color(),
  /** カメラが中のある建物の部屋の中にいる度合い（露出。0〜1）と、その部屋の明るさ（露出の目安） */
  camera: 0,
  cameraLevel: 0.2,
  /** カメラのいる部屋のまわりの明るさの色（撮影の色の仕上げの白の合わせ。scene/grade.ts） */
  cameraAmbient: new THREE.Color(),
  /** カメラがガラスの温室（ガーデンドーム）の大きな空間の中にいる（露出は外に近い温室の値。0 / 1） */
  glass: 0,
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _c = new THREE.Color()

class Interiors {
  models = new Map<InteriorZoneId, InteriorModel>()
  private loaded = new Map<InteriorZoneId, Loaded>()
  /** 町の中に足す入れ物（Landscape の townGroup に入れる） */
  readonly group = new THREE.Group()
  private depth = depthMaterial()
  /** 作り直すたびに増える（花音の通り道） */
  version = 0
  /** ガラスの温室の中を作った・壊したたびに増える（町の影の地図を描き直す。Landscape が見る） */
  shadowVersion = 0

  constructor() {
    this.group.name = 'interiors'
  }

  /** 町のデータを読んだら呼ぶ（外観の組み立ての後。kits は namedInteriorParts に入っている） */
  init(named: NamedFile | null, terrainY: (x: number, z: number, step?: boolean) => number) {
    if (!named) return
    for (const id of INTERIOR_ZONE_IDS) {
      const z = INTERIOR_ZONES[id]
      const rec = named.buildings.find((b) => b.id === z.buildingId)
      const kit = namedInteriorParts.kits.get(z.buildingId)
      const brief = INTERIOR_BRIEFS[id]
      if (!rec || !kit || !brief) {
        console.warn(`[interior] ${z.label} の中を作れません（データ・外観・決まりのどれかが無い）`)
        continue
      }
      try {
        const t0 = performance.now()
        const model = new InteriorModel(id, brief, rec, kit.openings, terrainY)
        // 家具の障害物（形は作らない）
        const dry = new InteriorBuilder(model, null)
        brief.furnish(dry, model)
        model.buildNav(this.stopNodes(id, model))
        this.models.set(id, model)
        console.info(`[interior] ${z.label} の決まりを作りました（部屋 ${model.rooms.length}・通り道の点 ${model.nodes.length}・${Math.round(performance.now() - t0)}ms）`)
      } catch (e) {
        console.error(`[interior] ${z.label} の決まりを作れませんでした`, e)
      }
    }
    this.version++
    // ?debug のとき、コンソールから中の決まりを調べられるように（window.__interiors.models.get('thompson')）
    if (townOptions().debug) (window as unknown as { __interiors: Interiors }).__interiors = this
  }

  /** ゾーンの立ち寄り先（通り道のグラフの点）。立ち寄り先の表は使う側が渡した物（core/places.ts の townPlaces。5-1b）で、並びは表の並び */
  private stopNodes(id: InteriorZoneId, m: InteriorModel) {
    const out: { x: number; z: number; level: number }[] = []
    for (const s of Object.values(townPlaces())) {
      if (s.zone !== id) continue
      out.push({ x: s.position[0], z: s.position[2], level: s.level ?? 0 })
    }
    void m
    return out
  }

  /** シーンの点がどのゾーンの決まりに入るか（無ければ null） */
  modelAt(x: number, z: number) {
    const id = zoneAt(x, z)
    return id === 'lab' ? null : (this.models.get(id) ?? null)
  }

  /** 木を置かない所か（中のある建物とその敷地・前の歩ける所のまわり。木の枝が玄関やポーチ・窓をふさがないように） */
  treeBlocked(x: number, z: number) {
    for (const m of this.models.values()) {
      if (Math.hypot(x - m.zone.center[0], z - m.zone.center[1]) > m.zone.radius + 20) continue
      if (m.inBuilding(x, z, 3)) return true
      for (const site of m.rec.sites) if (polyMargin(site.ring.map((p) => [p[0], -p[1]] as [number, number]), x, z) > -1.5) return true
      for (const p of m.patches) if (p.kind === 'outdoor' && polyMargin(p.poly, x, z) > -2.5) return true
    }
    return false
  }

  /** 草むらを置かない所（中のある建物の外形の中・外の歩ける所。町の段階 5 の草むら） */
  grassBlocked(x: number, z: number) {
    for (const m of this.models.values()) {
      if (Math.hypot(x - m.zone.center[0], z - m.zone.center[1]) > m.zone.radius + 20) continue
      if (m.inBuilding(x, z, 0.6)) return true
      for (const p of m.patches) if (p.kind === 'outdoor' && polyMargin(p.poly, x, z) > -0.8) return true
    }
    return false
  }

  /** 中を作ってあるか */
  isLoaded(id: InteriorZoneId) {
    return this.loaded.has(id)
  }

  /** ?debug の数 */
  stats() {
    return [...this.loaded.values()].map((l) => ({ id: l.id, triangles: l.triangles }))
  }

  /* ---------------------------------------------------------------------- */
  /* 作る・壊す                                                              */
  /* ---------------------------------------------------------------------- */

  private load(id: InteriorZoneId) {
    const model = this.models.get(id)
    const kit = model ? namedInteriorParts.kits.get(model.zone.buildingId) : undefined
    if (!model || !kit) return
    const t0 = performance.now()
    // 絵のアトラスは建物ごとに 1 枚（ほかの建物の絵と場所を分け合わない。片付けるときに捨てる。#15）
    const atlas = new PictureAtlas()
    const ib = new InteriorBuilder(model, atlas)
    // 家具の障害物は決まりを作ったときに記録してあるので、形だけ作る（障害物を二重に足さないよう、いったん外して戻す）
    const keep = model.obstacles
    model.obstacles = [...keep]
    const shell = new ShellBuilder(ib, kit)
    shell.build()
    model.brief.furnish(ib, model)
    model.obstacles = keep
    atlas.flush()
    const u = createInteriorUniforms()
    const surf = createInteriorSurfaceMaterial(u)
    const glow = createInteriorGlowMaterial(u)
    const pics = createInteriorPictureMaterial(u, atlas.tex)
    const glass = createInteriorGlassMaterial(u)
    const group = new THREE.Group()
    group.name = `interior:${id}`
    let tris = 0
    const add = (o: THREE.Object3D, ro: number) => {
      o.layers.set(OUTDOOR_LAYER)
      o.traverse((c) => c.layers.set(OUTDOOR_LAYER))
      o.renderOrder = ro
      group.add(o)
      const g = (o as THREE.Mesh).geometry
      if (g) tris += (g.index ? g.index.count : g.attributes.position.count) / 3
    }
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, ro: number, shadow: boolean) => {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = name
      mesh.frustumCulled = false
      if (shadow) mesh.userData.shadowMaterial = this.depth
      else mesh.userData.noLocalShadow = true
      add(mesh, ro)
      return mesh
    }
    ib.chunk(null)
    if (ib.solid.vertexCount) mk(ib.solid.build(), surf, `${id}:solid`, 9, true)
    if (ib.glow.vertexCount) mk(ib.glow.build(), glow, `${id}:glow`, 10, false)
    if (ib.pictures.count) mk(ib.pictures.build(), pics, `${id}:pictures`, 10, false)
    if (ib.clear.vertexCount) mk(ib.clear.build(), glass, `${id}:glass`, 21, false)
    // 所ごとの組（大きな建物）: 視野の外なら描かない（花音のまわりの細かい影の地図でも、範囲の外の組は描かない）
    for (const [key, set] of ib.chunks) {
      const cull = (mesh: THREE.Mesh) => {
        mesh.geometry.computeBoundingSphere()
        mesh.frustumCulled = true
      }
      if (set.solid.vertexCount) cull(mk(set.solid.build(), surf, `${id}:solid:${key}`, 9, true))
      if (set.glow.vertexCount) cull(mk(set.glow.build(), glow, `${id}:glow:${key}`, 10, false))
      if (set.pictures.count) cull(mk(set.pictures.build(), pics, `${id}:pictures:${key}`, 10, false))
      if (set.clear.vertexCount) cull(mk(set.clear.build(), glass, `${id}:glass:${key}`, 21, false))
    }
    // 決まりが足す形（ドームの植物・水・霧・ガラスのドーム。自分のシェーダーと描く順を持つ）
    const decor = model.brief.decorate ? model.brief.decorate({ model, uniforms: u, surface: surf, glow, glass, depth: this.depth }) : null
    if (decor)
      for (const o of decor.objects) {
        o.traverse((c) => {
          c.layers.set(OUTDOOR_LAYER)
          const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
          if (!g) return
          const per = (g.index ? g.index.count : g.attributes.position.count) / 3
          const inst = (g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry ? (g as THREE.InstancedBufferGeometry).instanceCount : 1
          if (!(c as THREE.Points).isPoints) tris += per * Math.max(1, inst)
        })
        group.add(o)
      }
    // 中の扉の板
    const leaves: LeafState[] = []
    for (const lf of shell.leaves) {
      const pivot = new THREE.Group()
      // 右手系の基底（z = x × 上）で置く。開く側（out）が -z なら、板の形を z で裏返さずに回す向きを逆にする
      const x = new THREE.Vector3(...lf.across)
      const z = new THREE.Vector3().crossVectors(x, new THREE.Vector3(0, 1, 0))
      const sign = z.dot(new THREE.Vector3(...lf.out)) >= 0 ? -1 : 1
      pivot.applyMatrix4(localMatrix(lf.hinge, lf.across, [z.x, z.y, z.z]))
      const mesh = new THREE.Mesh(lf.leaf.build(), surf)
      mesh.userData.shadowMaterial = this.depth
      mesh.frustumCulled = false
      pivot.add(mesh)
      add(pivot, 9)
      leaves.push({ leaf: lf, pivot, open: 0, hold: 0, q0: pivot.quaternion.clone(), sign })
    }
    // 外観（この建物だけ）の影を落とす形（花音のまわりの細かい影の地図で、窓から差し込む日なたを作る）。ふだんの描画には出さない
    const occ = new THREE.Mesh(kit.solid.build(), this.depth)
    occ.name = `${id}:occluder`
    occ.userData.shadowMaterial = this.depth
    occ.frustumCulled = false
    occ.layers.set(31)
    group.add(occ)
    this.group.add(group)
    localShadowCasters.add(group)
    namedInteriorParts.setActive(model.zone.buildingId, true)
    const named = model.doors.filter((d) => d.def.kind === 'named').map((door) => ({ door, open: 0, hold: 0 }))
    const isGlass = !!model.zone.glasshouse
    u.uIGlass.value = isGlass ? 1 : 0
    const lo: Loaded = { id, model, group, uniforms: u, materials: [surf, glow, pics, glass], leaves, named, windows: model.brief.noWindowLights ? [] : this.windowsOf(model, kit), lamps: [], groupArea: [], triangles: Math.round(tris), decor, glass: isGlass, atlas }
    this.setupLamps(lo)
    this.loaded.set(id, lo)
    if (isGlass) {
      // ガラスの温室: ドームの中の地形を描かず、不透明なガラスの形を隠す（中の透けるガラスのドームに替える）。町の影の地図を描き直す
      // 外形（円）の中心と、いちばん近い辺までの距離より少し内側
      const fp = model.footprint
      const cx = fp.reduce((a, q) => a + q[0], 0) / fp.length
      const cz = fp.reduce((a, q) => a + q[1], 0) / fp.length
      const r = Math.min(...fp.map((q) => Math.hypot(q[0] - cx, q[1] - cz)))
      groundHole.value.set(cx, cz, r - 0.6, 1)
      if (gardenDomeShell.mesh) gardenDomeShell.mesh.visible = false
      this.shadowVersion++
    }
    console.info(`[interior] ${model.zone.label} の中を作りました（三角形 ${Math.round(tris / 1000)} 千・窓 ${lo.windows.length}・灯り ${lo.lamps.length}・扉 ${leaves.length + named.length}・${Math.round(performance.now() - t0)}ms）`)
  }

  private unload(id: InteriorZoneId) {
    const lo = this.loaded.get(id)
    if (!lo) return
    localShadowCasters.delete(lo.group)
    this.group.remove(lo.group)
    // Sprite の形（three の全部の Sprite が共有する）は捨てない（disposeGeometries）
    disposeGeometries(lo.group)
    for (const m of lo.materials) m.dispose()
    lo.atlas.dispose()
    namedInteriorParts.setActive(lo.model.zone.buildingId, false)
    for (const n of lo.named) if (n.door.def.entrance !== undefined) namedDoors.setOpen(lo.model.zone.buildingId, 0, n.door.def.entrance)
    lo.decor?.dispose?.()
    if (lo.glass) {
      groundHole.value.w = 0
      if (gardenDomeShell.mesh) gardenDomeShell.mesh.visible = true
      this.shadowVersion++
    }
    this.loaded.delete(id)
    console.info(`[interior] ${lo.model.zone.label} の中を片付けました`)
  }

  /** 窓（外観のガラスの記録から）。U × V が内向きになるよう、右の端から左へ */
  private windowsOf(m: InteriorModel, kit: Kit): WindowLight[] {
    const out: WindowLight[] = []
    for (const pr of kit.panes) {
      const { f, o, t } = pr
      if (out.length >= MAX_IWIN) break
      const p0 = new THREE.Vector3(...f.p(o.s + o.w, t, o.h))
      const U = new THREE.Vector3(...f.dir(-o.w, 0, 0))
      const V = new THREE.Vector3(0, o.ht, 0)
      const center = p0.clone().addScaledVector(U, 0.5).addScaledVector(V, 0.5)
      // 窓の部屋（内側の点）
      const inner = center.clone().addScaledVector(new THREE.Vector3(...f.out), -0.45)
      const room = m.roomAt(inner.x, inner.y, inner.z, 0) ?? m.rooms.find((r) => polyMargin(r.poly, inner.x, inner.z) > -0.1 && inner.y > r.floorY - 0.2 && inner.y < r.ceilY + 0.3)
      if (!room) continue
      out.push({ p0, U, V, out: new THREE.Vector3(...f.out), area: o.w * o.ht, group: room.group, center })
    }
    return out
  }

  private setupLamps(lo: Loaded) {
    const m = lo.model
    const u = lo.uniforms
    lo.lamps = []
    m.brief.lamps.slice(0, MAX_ILAMP).forEach((def, index) => {
      const room = m.rooms.find((r) => r.id === def.room)
      if (!room) return
      const [lx, lz] = m.xz(def.at[0], def.at[1])
      const floorH = room.def.floor ?? m.zone.levels[room.level].floor
      const pos = new THREE.Vector3(lx, m.y(floorH + def.at[2]), lz)
      lo.lamps.push({ def, index, group: room.group, pos, on: 0 })
      const kind = { bulb: 0, pendant: 1, ceiling: 2, floor: 3, spot: 4, fire: 5, screen: 6 }[def.kind]
      _c.set(def.color).convertSRGBToLinear().multiplyScalar(def.power)
      u.uILampP.value[index].set(pos.x, pos.y, pos.z, room.group)
      u.uILampC.value[index].set(_c.r, _c.g, _c.b, kind)
      const d = new THREE.Vector3(0, -1, 0)
      if (def.dir) {
        const hl = Math.hypot(def.dir[0], def.dir[1])
        const [dx, dz] = hl > 1e-6 ? m.dirOf(def.dir[0], def.dir[1]) : [0, 0]
        d.set(dx * hl, def.dir[2], dz * hl).normalize()
      }
      u.uILampD.value[index].set(d.x, d.y, d.z, def.kind === 'ceiling' ? 0.45 : def.kind === 'fire' ? 0.3 : 0.18)
      u.uILampR.value[index] = def.range
    })
    u.uILampN.value = lo.lamps.length
    // 窓
    lo.windows.forEach((w, i) => {
      u.uIWinA.value[i].set(w.p0.x, w.p0.y, w.p0.z, w.group)
      u.uIWinU.value[i].set(w.U.x, w.U.y, w.U.z, w.area)
      u.uIWinV.value[i].set(w.V.x, w.V.y, w.V.z, 0)
    })
    u.uIWinN.value = lo.windows.length
    // 組ごとの床の広さ
    lo.groupArea = Array.from({ length: MAX_IGROUP }, () => 0)
    for (const r of m.rooms) {
      let a = 0
      for (let i = 0; i < r.poly.length; i++) {
        const p = r.poly[i]
        const q = r.poly[(i + 1) % r.poly.length]
        a += p[0] * q[1] - q[0] * p[1]
      }
      if (r.group < MAX_IGROUP) lo.groupArea[r.group] += Math.abs(a) / 2
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 毎コマ                                                                  */
  /* ---------------------------------------------------------------------- */

  /** 花音の位置と、歩いているか（毎コマ update で受け取る） */
  private focus = { position: new THREE.Vector3(), walking: false, dir: new THREE.Vector3(0, 0, 1) }

  /** openers = 注目点のほかに扉を開ける物（world/townHost.ts の townDoorOpeners()） */
  update(camera: THREE.Camera, dt: number, focus: TownFocus, openers: readonly TownDoorOpener[]) {
    if (!this.models.size) return
    this.focus.position.copy(focus.position)
    this.focus.walking = focus.walking
    this.focus.dir.copy(focus.moveDir)
    const k = this.focus.position
    // 乗っている車室（注目点の ride。駅に止まっているケーブルカーの中なら建物の部屋の光にしない・車室の中の光）
    const ride = focus.ride
    // 作る・壊す（カメラか花音が近い）
    for (const [id, m] of this.models) {
      const c = m.zone.center
      const d = Math.min(Math.hypot(camera.position.x - c[0], camera.position.z - c[1]), Math.hypot(k.x - c[0], k.z - c[1]))
      if (!this.loaded.has(id) && d < m.zone.loadRadius && namedInteriorParts.isNear(m.zone.buildingId)) this.load(id)
      else if (this.loaded.has(id) && (d > m.zone.unloadRadius || !namedInteriorParts.isNear(m.zone.buildingId))) this.unload(id)
    }
    interiorLight.camera = 0
    interiorLight.glass = 0
    let focusIn = 0
    for (const lo of this.loaded.values()) {
      this.updateDoors(lo, dt, openers)
      this.updateLights(lo, dt)
      lo.decor?.update?.(dt, camera)
      // カメラ・花音がこの建物の部屋の中か（ガラスの温室の大きな空間は外と同じ光。夜だけ中の灯りで花音を照らす）
      const cr = lo.model.roomAt(camera.position.x, camera.position.y, camera.position.z, -0.05)
      if (cr) {
        if (lo.glass && cr.def.domeCeil) interiorLight.glass = 1
        else {
          interiorLight.camera = 1
          interiorLight.cameraLevel = this.groupLevel(lo, cr.group)
          const a = lo.uniforms.uIAmb.value[cr.group]
          interiorLight.cameraAmbient.setRGB(a.x, a.y, a.z)
        }
      }
      // 乗り物の車室の中（駅に止まっているケーブルカーの中など）は、建物の部屋の光ではなく車室の光（下）
      const kr = ride.inside && ride.car ? null : lo.model.roomAt(k.x, k.y + 1.2, k.z, -0.1)
      if (kr) {
        const want = lo.glass && kr.def.domeCeil ? 1 - THREE.MathUtils.smoothstep(outdoor.daylight, 0.08, 0.4) : 1
        if (want > 0.001) {
          focusIn = Math.max(focusIn, want)
          this.focusRoomLight(lo, kr.group)
        }
      }
    }
    // 乗り物の車室の中（観覧車のゴンドラ・ケーブルカーなど。注目点の ride）: 昼は外と同じ光、暗くなったら車室の灯りで照らす。カメラが中なら露出は温室の値
    const car = ride.car
    if (car) {
      const v = car.vehicle
      if (ride.inside && v.light) {
        const head = _w.copy(this.focus.position)
        head.y += 1.15
        const dark = v.light(car, ride.seat, head, interiorLight)
        if (dark > 0.001) focusIn = Math.max(focusIn, dark)
      }
      if (v.glassBox && car.inside(car.toCabin(camera.position, _v), -0.06)) interiorLight.glass = 1
    }
    interiorLight.active += (focusIn - interiorLight.active) * (1 - Math.exp(-Math.min(dt, 0.1) * 6))
  }

  private updateDoors(lo: Loaded, dt: number, openers: readonly TownDoorOpener[]) {
    const k = this.focus.position
    const moving = this.focus.walking
    const dir = this.focus.dir
    /**
     * 歩いている花音がその扉を通るか: 扉の口の中にいるか、扉の面へ向かって歩いていて、そのまま進むと扉の幅の中で面を横切る。
     * 前は扉から reach m 以内なら開けていたので、廊下で前を通り過ぎるだけの部屋の扉まで開き、廊下を撮る画をふさいでいた（トンプソン家の 2 階。§7 の 150）
     */
    const passes = (d: DoorM, reach: number) => {
      const dx = k.x - d.center[0]
      const dz = k.z - d.center[1]
      if (Math.hypot(dx, dz) >= reach) return false
      const along = dx * d.along[0] + dz * d.along[1]
      const across = dx * d.normal[0] + dz * d.normal[1]
      const half = (d.def.width ?? 0.9) / 2
      if (Math.abs(across) < 0.6) return Math.abs(along) < half + 0.5
      const toward = -(dir.x * d.normal[0] + dir.z * d.normal[1]) * Math.sign(across)
      if (toward < 0.3) return false
      const cross = along + (dir.x * d.along[0] + dir.z * d.along[1]) * (Math.abs(across) / toward)
      return Math.abs(cross) < half + 0.6
    }
    const near = (d: DoorM, reach: number) => {
      const c = d.center
      const dk = Math.hypot(k.x - c[0], k.z - c[1])
      const yk = Math.abs(k.y - d.floorY) < 1.6
      const byFocus = yk && (moving ? passes(d, reach) : dk < 0.75)
      return byFocus || openerNear(openers, c[0], c[1], d.floorY)
    }
    const step = (s: { open: number; hold: number }, want: boolean) => {
      if (want) s.hold = 1.3
      else s.hold = Math.max(0, s.hold - dt)
      const target = want || s.hold > 0 ? 1 : 0
      const speed = target > s.open ? 1 / 0.75 : 1 / 1.2
      s.open = THREE.MathUtils.clamp(s.open + Math.sign(target - s.open) * speed * dt, 0, 1)
    }
    for (const s of lo.leaves) {
      step(s, near(s.leaf.door, 1.75))
      const e = s.open * s.open * (3 - 2 * s.open)
      // 局所の y のまわりに、開く側（局所の +z）へ回す
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.sign * e * Math.PI * 0.5)
      s.pivot.quaternion.copy(s.q0).multiply(q)
    }
    for (const s of lo.named) {
      step(s, near(s.door, 1.9))
      const e = s.open * s.open * (3 - 2 * s.open)
      if (s.door.def.entrance !== undefined) namedDoors.setOpen(lo.model.zone.buildingId, e, s.door.def.entrance)
    }
  }

  /** 灯りが点いているか（決まりと時刻と花音のいる所） */
  private lampWant(lo: Loaded, l: LampState) {
    const o = outdoor
    const h = o.time.hours
    const dark = 1 - THREE.MathUtils.smoothstep(o.daylight, 0.12, 0.55)
    const evening = THREE.MathUtils.smoothstep(h, 16.5, 17.5) + (h < 6 ? 1 : 0)
    const k = this.focus.position
    const kr = lo.model.roomAt(k.x, k.y + 1.2, k.z, -0.2)
    const here = kr ? kr.group === l.group || kr.id === l.def.room : false
    const inZone = lo.model.contains(k.x, k.z)
    switch (l.def.schedule) {
      case 'always':
        return 1
      case 'evening':
        return Math.min(1, dark * (h > 5 && h < 23.5 ? 1 : 0) + (here ? dark : 0))
      case 'late':
        return dark * (h > 17 || h < 1.5 ? 1 : 0)
      case 'presence':
        return here || (inZone && dark > 0.5 && l.def.kind === 'screen') ? Math.max(dark, l.def.kind === 'screen' || l.def.kind === 'spot' ? 1 : 0.35) : 0
      case 'shop': {
        const [o0, o1] = l.def.hours ?? [11, 22]
        const open = THREE.MathUtils.smoothstep(h, o0 - 0.2, o0 + 0.1) * (1 - THREE.MathUtils.smoothstep(h, o1, o1 + 0.3))
        return open
      }
      case 'dusk':
        return o.dome
      case 'night':
        return dark
      case 'fire':
        return dark * evening * (o.time.dayOfYear > 270 || o.time.dayOfYear < 100 ? 1 : 0)
    }
    return 0
  }

  private updateLights(lo: Loaded, dt: number) {
    const u = lo.uniforms
    const o = outdoor
    // 灯り
    const t = performance.now() / 1000
    for (const l of lo.lamps) {
      const want = this.lampWant(lo, l)
      l.on += (want - l.on) * (1 - Math.exp(-Math.min(dt, 0.1) * 3))
      let v = l.on
      if (l.def.kind === 'fire') v *= 0.82 + 0.12 * Math.sin(t * 7.3) + 0.08 * Math.sin(t * 13.1 + 1.7) + 0.05 * Math.sin(t * 23.0)
      u.uILampOn.value[l.index] = v
    }
    // 窓の明るさ（空の光。太陽の側の窓は明るく、夜は町の明かりがほのかに）
    const sun = o.sunDir
    for (let i = 0; i < lo.windows.length; i++) {
      const w = lo.windows[i]
      const facing = Math.max(0, w.out.x * sun.x + w.out.z * sun.z) / Math.max(0.2, Math.hypot(sun.x, sun.z))
      const sunUp = THREE.MathUtils.smoothstep(sun.y, -0.03, 0.15)
      // 夜の空の光（町を読めるようにした明るさ）は、部屋の中には強すぎるので弱める
      const dayK = THREE.MathUtils.lerp(0.18, 1, THREE.MathUtils.smoothstep(o.daylight, 0.02, 0.35))
      _c.copy(o.skyLight).multiplyScalar((0.85 + 0.5 * facing * sunUp) * dayK)
      // 窓から見える日の当たる町・地面の明るさ（暖かい）
      _c.r += o.sunLight.r * 0.07 * sunUp
      _c.g += o.sunLight.g * 0.065 * sunUp
      _c.b += o.sunLight.b * 0.055 * sunUp
      _c.r += o.sunLight.r * 0.05 * facing * sunUp + 0.004 * o.night
      _c.g += o.sunLight.g * 0.05 * facing * sunUp + 0.0035 * o.night
      _c.b += o.sunLight.b * 0.05 * facing * sunUp + 0.003 * o.night
      u.uIWinL.value[i].set(_c.r, _c.g, _c.b)
    }
    // まわりの明るさ（組ごと）: 窓の光・差し込む日なた・灯りの合計を、床の広さで割る
    const amb = u.uIAmb.value
    for (const a of amb) a.set(0.0015, 0.0014, 0.0013)
    for (let i = 0; i < lo.windows.length; i++) {
      const w = lo.windows[i]
      const L = u.uIWinL.value[i]
      const area = lo.groupArea[w.group] || 10
      // 窓の光の照り返し（床・壁・家具の暖かい色に一度当たった光）
      const k = (w.area * 0.62) / area
      amb[w.group].x += L.x * k * 1.0
      amb[w.group].y += L.y * k * 0.93
      amb[w.group].z += L.z * k * 0.84
      const sunIn = Math.max(0, -(w.out.x * sun.x + w.out.y * sun.y + w.out.z * sun.z)) * THREE.MathUtils.smoothstep(sun.y, -0.02, 0.1)
      // （外向きの法線と太陽が逆 = 太陽が窓の正面）
      const sunFace = Math.max(0, w.out.x * sun.x + w.out.z * sun.z) * THREE.MathUtils.smoothstep(sun.y, -0.02, 0.1)
      void sunIn
      // 差し込む日なたの照り返し（床の日なたが部屋を明るくする）
      const ks = (w.area * 0.16 * sunFace * u.uISun.value) / area
      amb[w.group].x += o.sunLight.r * ks
      amb[w.group].y += o.sunLight.g * ks * 0.92
      amb[w.group].z += o.sunLight.b * ks * 0.8
    }
    for (const l of lo.lamps) {
      const on = u.uILampOn.value[l.index]
      if (on < 0.001) continue
      const c = u.uILampC.value[l.index]
      const area = lo.groupArea[l.group] || 10
      // 灯りの照り返し（白い壁と天井の部屋では、直接の光の 3〜4 割ほど）
      const k = (on * 0.42) / area
      amb[l.group].x += c.x * k
      amb[l.group].y += c.y * k
      amb[l.group].z += c.z * k
    }
    // ガラスの映り込み（いちばん明るい組）
    let best = 0
    for (let g = 0; g < amb.length; g++) best = Math.max(best, amb[g].x + amb[g].y + amb[g].z)
    u.uIRefl.value.setScalar(Math.min(0.08, best * 0.6))
  }

  /** 組の明るさ（露出の目安） */
  private groupLevel(lo: Loaded, g: number) {
    const a = lo.uniforms.uIAmb.value[g]
    return (a.x * 0.2126 + a.y * 0.7152 + a.z * 0.0722) * 8
  }

  /** 中にいる花音の光: 窓（面光源をその中心の点とみなす）と灯りの向きの合計 */
  private focusRoomLight(lo: Loaded, group: number) {
    const p = _v.copy(this.focus.position)
    p.y += 1.3
    this.lightOf(lo, group, p, interiorLight)
  }

  /** 部屋の組 group の中の点 p の光（窓と灯りの向き・色・強さ、まわりの明るさ）を out に */
  private lightOf(lo: Loaded, group: number, p: THREE.Vector3, out: { dir: THREE.Vector3; color: THREE.Color; intensity: number; ambient: THREE.Color }) {
    const u = lo.uniforms
    const acc = _w.set(0, 0, 0)
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i < lo.windows.length; i++) {
      const w = lo.windows[i]
      if (w.group !== group) continue
      const d = _d.subVectors(w.center, p)
      const dist2 = Math.max(0.3, d.lengthSq())
      d.normalize()
      const cos = Math.max(0, -(d.x * w.out.x + d.y * w.out.y + d.z * w.out.z))
      const L = u.uIWinL.value[i]
      const e = (w.area * cos) / dist2 / Math.PI
      acc.addScaledVector(d, e * (L.x + L.y + L.z))
      r += L.x * e
      g += L.y * e
      b += L.z * e
    }
    for (const l of lo.lamps) {
      if (l.group !== group) continue
      const on = u.uILampOn.value[l.index]
      if (on < 0.001) continue
      const d = _d.subVectors(l.pos, p)
      const dist2 = d.lengthSq() + 0.05
      if (dist2 > l.def.range * l.def.range) continue
      d.normalize()
      const c = u.uILampC.value[l.index]
      const e = on / dist2
      acc.addScaledVector(d, e * (c.x + c.y + c.z))
      r += c.x * e
      g += c.y * e
      b += c.z * e
    }
    const sum = r + g + b
    if (acc.lengthSq() > 1e-8) out.dir.copy(acc).normalize()
    if (out.dir.y < 0.15) {
      out.dir.y = 0.15
      out.dir.normalize()
    }
    if (sum > 1e-6) out.color.setRGB(r / sum, g / sum, b / sum).multiplyScalar(3)
    out.intensity = sum / 3
    const a = u.uIAmb.value[group]
    out.ambient.setRGB(a.x, a.y, a.z)
  }

  /**
   * 中のある建物の部屋の中の点 p の光（駅の中の駅員ロボなど。花音と同じ考え）。部屋の中なら out に書いて true、外・中を作っていなければ false
   */
  lightAt(p: THREE.Vector3, out: { dir: THREE.Vector3; color: THREE.Color; intensity: number; ambient: THREE.Color }) {
    for (const lo of this.loaded.values()) {
      if (!lo.model.contains(p.x, p.z)) continue
      const room = lo.model.roomAt(p.x, p.y, p.z, -0.1)
      if (!room) return false
      this.lightOf(lo, room.group, p, out)
      return true
    }
    return false
  }
}

const _d = new THREE.Vector3()

export const interiors = new Interiors()

/** ラボの床の標高（シーンの y = 0）。briefs が使う */
export { LAB }
