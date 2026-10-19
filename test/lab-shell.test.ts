/**
 * ラボの殻の three の形（world/lab/shell/*。docs/design/map-split.md §6 の 4-4）の見張り:
 *   - 殻の群の並び（部屋・北の扉・中二階・見学エントランスの太陽の影の群）と、床（名前 labFloor の 1 色の素材。映り込みは無くした）
 *   - attach で太陽の影を落とす物の印が付くのは、窓のある壁と柱・天井の板・見学エントランスの群の中だけ（ガラスと小さな部品は除く）
 *   - 4-0b の直し（中二階の天井の板は部屋の高さ + 2mm・天井のケーブルラックの縁は 1mm 上げる）がそのまま
 *   - 光のにじみは、付けている間だけ部屋の照明に合わせて暗くなる
 *   - 毎コマ: 見学エントランスの扉を進める（扉は注目点が前に来ると開く。何も描かない）
 *   - 扉の値（sakurami-cho/core/site.ts の DOOR）は間取りのデータ（plan.ts の ENTRANCE_DOOR）と同じ物
 *   - dispose は殻の物を捨て、共有の素材は捨てない
 * Canvas は Bun に無いので、描く物は何もしない Canvas の代わりで作る（絵そのものはアプリの比べる画で見る）。
 * 地図のコードは DOM の型を使うので、lab-plan.test.ts と同じく実行の時に読む（kanon-lab の server/test にあった時に、server の tsconfig の型の確かめに入れなかった形。型は使う所だけ）
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as THREE from 'three'

const LAB = '../world/lab'
const LAB_CORE = '../core/lab'
const load = async <T>(path: string): Promise<T> => (await import(path)) as T

interface Mats {
  blackMetal: THREE.Material
  glass: THREE.Material
}
interface MaterialsMod {
  createLabMaterials(tex: Record<string, THREE.Texture>): Mats
}
interface Frame {
  time: number
  camera: THREE.Camera
  renderer: unknown
  scene: THREE.Scene
}
interface Shell {
  object: THREE.Group
  floor: { mesh: THREE.Mesh }
  attach(): () => void
  update(dt: number, f: Frame): void
  dispose(): void
}
interface ShellMod {
  createLabShell(o: { materials: Mats }): Shell
}
interface DoorMod {
  entranceDoor: { open: number; lastNear: number }
  DOOR_CENTER: { x: number; z: number }
}
interface PlanMod {
  ROOM: { height: number; south: number }
  ENTRANCE_DOOR: { x: number; width: number; sensor: number; openSeconds: number; closeSeconds: number; openAngle: number }
}
interface SiteMod {
  DOOR: unknown
}
interface SunMod {
  SUN_SHADOW_LAYER: number
}
interface LabLightMod {
  setLabLight(room: number, flash?: number): void
}
interface WashMod {
  WASH_COLOR: THREE.Color
}
interface TownHostMod {
  configureTown(o: { clock?: { sceneTime?: () => number } }): void
  setTownFocus(f: unknown): void
  townFocus(): unknown
}

/** 何もしない Canvas の 2D（呼ばれた物は何もせず、グラデーションと文字の幅だけそれらしく返す） */
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
beforeAll(async () => {
  // 扉は場面の時計を読む（地図の口。kanon-lab は townBinding.ts で入れる）
  ;(await load<TownHostMod>('../world/townHost.ts')).configureTown({ clock: { sceneTime: () => 10 } })
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

const sharedTextures = () => ({ perfOpacity: new THREE.Texture() })

/** WebGPURenderer の形の偽の renderer（毎コマの更新が何も描かないことを確かめる）。描き先の移り変わりを targets に記録する */
function fakeRenderer(onRender: (scene: THREE.Object3D, camera: THREE.Camera) => void) {
  return {
    autoClear: true,
    coordinateSystem: THREE.WebGPUCoordinateSystem,
    current: null as unknown,
    mrt: null as unknown,
    targets: [] as unknown[],
    getDrawingBufferSize(v: THREE.Vector2) {
      return v.set(1280, 720)
    },
    getRenderTarget() {
      return this.current
    },
    setRenderTarget(t: unknown) {
      this.current = t
      this.targets.push(t)
    },
    getMRT() {
      return this.mrt
    },
    setMRT(m: unknown) {
      this.mrt = m
    },
    clear() {},
    render(scene: THREE.Object3D, camera: THREE.Camera) {
      onRender(scene, camera)
    },
  }
}

async function makeShell() {
  const M = await load<MaterialsMod>('../world/materials/labMaterials.ts')
  const S = await load<ShellMod>(`${LAB}/shell/createShell.ts`)
  const mats = M.createLabMaterials(sharedTextures())
  return { mats, shell: S.createLabShell({ materials: mats }) }
}

const meshesOf = (o: THREE.Object3D) => {
  const out: THREE.Mesh[] = []
  o.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) out.push(x as THREE.Mesh)
  })
  return out
}

describe('ラボの殻（4-4）', () => {
  test('殻の群は「部屋・北の扉・中二階・見学エントランス（太陽の影の群の中）」の並び。床は名前 labFloor の 1 色の素材（質感の写真・映り込みは無い）', async () => {
    const { shell } = await makeShell()
    expect(shell.object.name).toBe('lab:shell')
    expect(shell.object.children.length).toBe(4)
    const [room, , , entrance] = shell.object.children
    expect(room.children[0]).toBe(shell.floor.mesh)
    expect(entrance.children.length).toBe(1)
    const m = shell.floor.mesh.material as THREE.MeshStandardMaterial
    expect(m.constructor).toBe(THREE.MeshStandardMaterial)
    expect([m.name, m.roughness, m.metalness, m.map, m.normalMap, m.roughnessMap]).toEqual(['labFloor', 0.55, 0, null, null, null])
    expect(m.color.getHexString()).toBe(new THREE.Color('#8d949c').getHexString())
    expect(shell.floor.mesh.children.length).toBe(0)
    expect([shell.floor.mesh.receiveShadow, shell.floor.mesh.rotation.x]).toEqual([true, -Math.PI / 2])
  })

  test('attach で太陽の影を落とす物の印が付くのは、窓のある壁と柱・天井の板・見学エントランスだけ（ガラスと小さな部品は除く）', async () => {
    const { shell } = await makeShell()
    const Sun = await load<SunMod>('../world/environment/sunShadow.ts')
    const marked = () => meshesOf(shell.object).filter((x) => x.layers.isEnabled(Sun.SUN_SHADOW_LAYER))
    expect(marked().length).toBe(0)
    shell.attach()
    const [room, north, mezz, entrance] = shell.object.children
    const casters = [room.children[3], room.children[6].children[0], entrance]
    const inCasters = (x: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = x; p; p = p.parent) if (casters.includes(p)) return true
      return false
    }
    const got = marked()
    expect(got.length).toBeGreaterThan(0)
    expect(got.every(inCasters)).toBe(true)
    expect(meshesOf(north).some((x) => x.layers.isEnabled(Sun.SUN_SHADOW_LAYER))).toBe(false)
    expect(meshesOf(mezz).some((x) => x.layers.isEnabled(Sun.SUN_SHADOW_LAYER))).toBe(false)
    // 天井の板は入り、ガラス（半透明）は入らない
    const ceilingPlane = room.children[6].children[0].children[0] as THREE.Mesh
    expect(ceilingPlane.layers.isEnabled(Sun.SUN_SHADOW_LAYER)).toBe(true)
    for (const x of meshesOf(shell.object)) {
      const mats = Array.isArray(x.material) ? x.material : [x.material]
      if (mats.some((m) => m.transparent)) expect(x.layers.isEnabled(Sun.SUN_SHADOW_LAYER)).toBe(false)
    }
    // 入れた物はどれも影を落とす物（castShadow）。WebGPU の影は影のカメラのレイヤーで物を選ぶので、太陽の影は SUN_SHADOW_LAYER の物だけ
    // （前の WebGL は、ここで castShadow でなかった物を太陽の影の間だけ落としていた。setSunOnlyCasters。WebGPU への移行の第 1 段で無くした）
    expect(got.every((x) => x.castShadow)).toBe(true)
  })

  test('4-0b の直しがそのまま: 中二階の天井の板は部屋の高さ + 2mm、天井のケーブルラックの縁は 1mm 上げる', async () => {
    const { shell } = await makeShell()
    const P = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const mezz = shell.object.children[2]
    const ceilings = meshesOf(mezz).filter((x): x is THREE.InstancedMesh => (x as THREE.InstancedMesh).isInstancedMesh && (x.material as THREE.MeshStandardMaterial).color.getHexString() === new THREE.Color('#07090c').getHexString())
    expect(ceilings.length).toBe(1)
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    for (let i = 0; i < ceilings[0].count; i++) {
      ceilings[0].getMatrixAt(i, m)
      expect(p.setFromMatrixPosition(m).y).toBe(Math.fround(P.ROOM.height + 0.002))
    }
    const rails = meshesOf(shell.object.children[0]).filter((x) => {
      const g = x.geometry as THREE.BoxGeometry
      return g.type === 'BoxGeometry' && g.parameters.width === 0.01 && g.parameters.height === 0.1
    })
    expect(rails.length).toBe(4)
    for (const r of rails) expect(r.position.y).toBe(0.05 + 0.001)
  })

  test('光のにじみは、付けている間だけ部屋の照明に合わせて暗くなる', async () => {
    const { shell } = await makeShell()
    const L = await load<LabLightMod>('../world/labLight.ts')
    const W = await load<WashMod>('../world/materials/wallWash.ts')
    const washes = meshesOf(shell.object).filter((x) => (x.material as THREE.MeshBasicMaterial).map?.image && (x.material as THREE.Material).blending === THREE.AdditiveBlending && x.renderOrder === 4)
    expect(washes.length).toBeGreaterThan(0)
    const wallWash = washes.find((x) => (x.material as THREE.MeshBasicMaterial).color.equals(W.WASH_COLOR))!
    const color = (wallWash.material as THREE.MeshBasicMaterial).color
    const detach = shell.attach()
    L.setLabLight(0)
    expect(color.r).toBeCloseTo(W.WASH_COLOR.r * 0.3, 12)
    detach()
    L.setLabLight(1)
    expect(color.r).toBeCloseTo(W.WASH_COLOR.r * 0.3, 12)
  })

  test('毎コマ: 見学エントランスの扉を進める（注目点が扉の前なら開く。何も描かない）', async () => {
    const { shell } = await makeShell()
    const D = await load<DoorMod>(`${LAB}/shell/entranceDoor.ts`)
    const P = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const H = await load<TownHostMod>('../world/townHost.ts')
    const prevFocus = H.townFocus()
    H.setTownFocus({ position: new THREE.Vector3(D.DOOR_CENTER.x, 0, D.DOOR_CENTER.z - 0.5), outside: false, walking: false, moveDir: new THREE.Vector3(0, 0, 1), ride: { car: null, inside: false, seat: { z: 0, side: 1 } } })
    expect(D.DOOR_CENTER).toEqual({ x: P.ENTRANCE_DOOR.x, z: P.ROOM.south })
    D.entranceDoor.open = 0
    D.entranceDoor.lastNear = -100

    let renders = 0
    const scene = new THREE.Scene()
    scene.add(shell.object)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, 1.6, 4)
    camera.lookAt(0, 0.5, 0)
    scene.updateMatrixWorld()
    const renderer = fakeRenderer(() => renders++)
    shell.update(0.05, { time: 1, camera, renderer, scene })
    expect(renders).toBe(0)
    expect(renderer.targets.length).toBe(0)
    expect(shell.floor.mesh.visible).toBe(true)
    expect(D.entranceDoor.open).toBeCloseTo(0.05 / P.ENTRANCE_DOOR.openSeconds, 12)
    // 扉の組（西・東）は外へ逆向きに回る
    const leaves = shell.object.children[3].children[0].children[1].children
    expect(leaves.length).toBe(2)
    expect(leaves[0].rotation.y).toBeLessThan(0)
    expect(leaves[1].rotation.y).toBeCloseTo(-leaves[0].rotation.y, 15)
    H.setTownFocus(prevFocus)
  })

  test('扉の値: sakurami-cho/core/site.ts の DOOR は plan.ts の ENTRANCE_DOOR と同じ物', async () => {
    const P = await load<PlanMod>(`${LAB_CORE}/plan.ts`)
    const S = await load<SiteMod>('../core/site.ts')
    expect(S.DOOR).toBe(P.ENTRANCE_DOOR)
    expect(P.ENTRANCE_DOOR).toMatchObject({ sensor: 2.0, openSeconds: 1.1, closeSeconds: 1.6, openAngle: 1.45 })
  })

  test('dispose は殻の物（床の素材など）を捨て、共有の素材とガラスは捨てない', async () => {
    const { shell, mats } = await makeShell()
    const disposed = new Set<unknown>()
    const watch = (x: THREE.EventDispatcher<{ dispose: object }>) => x.addEventListener('dispose', () => disposed.add(x))
    watch(mats.blackMetal as never)
    watch(shell.floor.mesh.material as never)
    const glass = meshesOf(shell.object).find((x) => (x.material as THREE.Material).name === 'exteriorGlass')!
    watch(glass.material as never)
    shell.dispose()
    expect(disposed.has(shell.floor.mesh.material)).toBe(true)
    expect(disposed.has(mats.blackMetal)).toBe(false)
    expect(disposed.has(glass.material)).toBe(false)
  })
})
