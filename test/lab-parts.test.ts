/**
 * ラボの素材・部品・画面の three の形（world/lab/parts/*・screens.ts・textures.ts、materials・labLight の three の作り手。
 * docs/design/map-split.md §6 の 4-2）の見張り:
 *   - 部品の既定の値が前の R3F の部品（scene/parts/*.tsx。4-13 で消した）と同じ（MatrixInstances・BoxInstances は影を受けて落とさない、Bolts はどちらもしない、
 *     Cable は受ける、GlowSprite は drei の Billboard と同じ入れ子と向き）
 *   - 作る物の数が同じ（GlowBox・Bolts ごとに形を 1 つ、BoxInstances の既定の形は 1 つを使い回す、発光の素材は色と強さで使い回す）
 *   - 画面は最初の更新で描き、そのあとは 1 / 回数 ごと。ホールの外は回数を減らす
 *   - 明るさの入力の暗くする関数は、外す関数で外れる
 * Canvas は Bun に無いので、描く物は何もしない Canvas の代わりで作る（絵そのものはアプリの比べる画で見る）。
 * 地図のコードは DOM の型を使うので、lab-plan.test.ts と同じく実行の時に読む（kanon-lab の server/test にあった時に、server の tsconfig の型の確かめに入れなかった形。型は使う所だけ）
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as THREE from 'three'

const LAB = '../world/lab'
const load = async <T>(path: string): Promise<T> => (await import(path)) as T

type V3 = [number, number, number]
interface Mats {
  steel: THREE.Material
  tintedGlass: THREE.Material
  perforated: THREE.MeshStandardMaterial
}
interface MaterialsMod {
  createLabMaterials(tex: Record<string, THREE.Texture>): Mats
  perforatedMaterial(mats: Mats, rx: number, ry: number): THREE.MeshStandardMaterial
  glowMaterial(color: string, intensity: number): THREE.MeshBasicMaterial
}
interface Billboard {
  object: THREE.Group
  inner: THREE.Group
  update(camera: THREE.Camera): void
}
interface DetailsMod {
  glowBox(o: { position?: V3; size: V3; color: string; intensity: number; overlay?: boolean }): THREE.Mesh
  bolts(o: { positions: V3[]; axis: 'x' | 'y' | 'z'; radius?: number }, mats: Mats): THREE.InstancedMesh
  sticker(o: { text: string; width: number; glow?: number }): THREE.Mesh
  stickyNote(o: { position: V3; lines: string[] }): THREE.Mesh
  billboard(position?: V3): Billboard
  glowSprite(o: { position?: V3; size: number; color: string }): Billboard
  matrixInstances(o: { matrices: THREE.Matrix4[]; geometry: THREE.BufferGeometry; material: THREE.Material }): THREE.InstancedMesh
  boxInstances(o: { items: { p: V3; s: V3; c?: string }[]; material: THREE.Material; renderOrder?: number }): THREE.InstancedMesh
  UNIT_BOX: THREE.BufferGeometry
}
interface FlowPipeMod {
  flowPipe(
    o: { points: V3[]; color: string; linkColor?: string; intensity?: number; collarSpacing?: number },
    mats: Mats,
    ch?: { link: number; flash: number; pulse: number; ringBoost: number },
  ): { object: THREE.Group; update(): void; dispose(): void }
}
interface CableMod {
  cable(o: { points: V3[]; material: THREE.Material }): THREE.Mesh
}
interface ScreenLike {
  texture: THREE.CanvasTexture
  setContent(d: ((ctx: unknown, t: number) => void) | null): void
  update(dt: number, camera: THREE.Camera): void
}
interface ScreensMod {
  labScreenRate(fps: number, camera: THREE.Camera): number
  createLabScreen(key: string, w: number, h: number, draw: (ctx: unknown, t: number) => void, fps: number, o: { maxAnisotropy: number }): ScreenLike
}
interface TexturesMod {
  prepareLabSharedTextures(t: Record<string, THREE.Texture>): Record<string, THREE.Texture>
}
interface LabLightMod {
  setLabLight(room: number, flash?: number): void
  addLabLightDimmer(apply: (k: number) => void, min: number): () => void
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

const sharedTextures = () => ({ perfOpacity: new THREE.Texture() })

describe('ラボの素材・部品・画面の three の形（段 4 の 4-2）', () => {
  test('MatrixInstances・BoxInstances は影を受けて落とさない。BoxInstances の既定の形は 1 つを使い回し、色はどれかに c があるときだけ', async () => {
    const D = await load<DetailsMod>(`${LAB}/parts/details.ts`)
    const mat = new THREE.MeshStandardMaterial()
    const mi = D.matrixInstances({ matrices: [new THREE.Matrix4().makeTranslation(1, 2, 3)], geometry: new THREE.BoxGeometry(), material: mat })
    expect([mi.castShadow, mi.receiveShadow, mi.count]).toEqual([false, true, 1])
    const a = D.boxInstances({ items: [{ p: [0, 1, 0], s: [1, 2, 3] }], material: mat })
    const b = D.boxInstances({ items: [{ p: [0, 0, 0], s: [1, 1, 1], c: '#ff0000' }, { p: [1, 0, 0], s: [1, 1, 1] }], material: mat, renderOrder: 4 })
    expect([a.castShadow, a.receiveShadow, a.renderOrder, b.renderOrder]).toEqual([false, true, 0, 4])
    expect(a.geometry).toBe(D.UNIT_BOX)
    expect(b.geometry).toBe(D.UNIT_BOX)
    expect(a.instanceColor).toBeNull()
    expect(b.instanceColor).not.toBeNull()
    const m = new THREE.Matrix4()
    a.getMatrixAt(0, m)
    expect(m.elements).toEqual(new THREE.Matrix4().compose(new THREE.Vector3(0, 1, 0), new THREE.Quaternion(), new THREE.Vector3(1, 2, 3)).elements)
  })

  test('GlowBox は形を 1 つずつ作り、発光の素材は色と強さで使い回す。Bolts は形を 1 つずつ作り、影はどちらもしない（既定は steel）', async () => {
    const D = await load<DetailsMod>(`${LAB}/parts/details.ts`)
    const M = await load<MaterialsMod>('../world/materials/labMaterials.ts')
    const g1 = D.glowBox({ position: [1, 2, 3], size: [0.1, 0.2, 0.3], color: '#33ccff', intensity: 4 })
    const g2 = D.glowBox({ size: [1, 1, 1], color: '#33ccff', intensity: 4 })
    const g3 = D.glowBox({ size: [1, 1, 1], color: '#33ccff', intensity: 4, overlay: true })
    expect(g1.geometry).not.toBe(g2.geometry)
    expect(g1.material).toBe(g2.material)
    expect(g1.material).toBe(M.glowMaterial('#33ccff', 4))
    expect(g3.material).not.toBe(g1.material)
    expect(g1.position.toArray()).toEqual([1, 2, 3])
    expect(g1.scale.toArray()).toEqual([0.1, 0.2, 0.3])
    expect(g2.position.toArray()).toEqual([0, 0, 0])

    const mats = M.createLabMaterials(sharedTextures())
    const b1 = D.bolts({ positions: [[0, 0, 0], [1, 0, 0]], axis: 'z' }, mats)
    const b2 = D.bolts({ positions: [[0, 0, 0]], axis: 'x', radius: 0.02 }, mats)
    expect([b1.castShadow, b1.receiveShadow, b1.count, b1.material === mats.steel]).toEqual([false, false, 2, true])
    expect(b1.geometry).not.toBe(b2.geometry)
    expect((b1.geometry as THREE.CylinderGeometry).parameters).toMatchObject({ radiusTop: 0.012, height: 0.012 * 0.7, radialSegments: 6 })
    const m = new THREE.Matrix4()
    b1.getMatrixAt(1, m)
    const q = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.7 % 1.05))
    // 行列は Float32 で持つ
    expect(Array.from(m.elements)).toEqual(Array.from(new Float32Array(new THREE.Matrix4().compose(new THREE.Vector3(1, 0, 0), q, new THREE.Vector3(1, 1, 1)).elements)))
  })

  test('Sticker・StickyNote は板と素材を 1 つずつ作り、テクスチャはキーで使い回す（光らせる物は MeshBasicMaterial）', async () => {
    const D = await load<DetailsMod>(`${LAB}/parts/details.ts`)
    const s1 = D.sticker({ text: 'KB-001', width: 0.5 })
    const s2 = D.sticker({ text: 'KB-001', width: 0.5 })
    const s3 = D.sticker({ text: 'KB-001', width: 0.5, glow: 2 })
    expect(s1.material).not.toBe(s2.material)
    expect((s1.material as THREE.MeshStandardMaterial).map).toBe((s2.material as THREE.MeshStandardMaterial).map)
    expect(s1.material).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(s3.material).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect((s1.material as THREE.MeshStandardMaterial).map?.colorSpace).toBe(THREE.SRGBColorSpace)
    expect((s1.geometry as THREE.PlaneGeometry).parameters).toMatchObject({ width: 0.5, height: 0.5 / 2.5 })
    expect((s3.material as THREE.MeshBasicMaterial).color.toArray()).toEqual([2, 2, 2])
    const n = D.stickyNote({ position: [0, 1, 0], lines: ['a'] })
    expect((n.material as THREE.MeshStandardMaterial).side).toBe(THREE.DoubleSide)
    expect((n.geometry as THREE.PlaneGeometry).parameters).toMatchObject({ width: 0.075, height: 0.075 })
  })

  test('GlowSprite は drei の Billboard と同じ入れ子（置く群 → カメラを向く群 → 板）で、更新のあとカメラと同じ向きになる', async () => {
    const D = await load<DetailsMod>(`${LAB}/parts/details.ts`)
    const s = D.glowSprite({ position: [1, 2, 3], size: 0.4, color: '#ffffff' })
    expect(s.object.children).toEqual([s.inner])
    const plane = s.inner.children[0] as THREE.Mesh
    expect(plane.scale.toArray()).toEqual([0.4, 0.4, 0.4])
    const mat = plane.material as THREE.MeshBasicMaterial
    expect([mat.transparent, mat.depthWrite, mat.toneMapped, mat.blending, mat.opacity]).toEqual([true, false, false, THREE.AdditiveBlending, 0.6])

    const parent = new THREE.Group()
    parent.rotation.set(0.3, 1.1, -0.2)
    parent.add(s.object)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(4, 3, 9)
    camera.lookAt(0, 1, 0)
    camera.updateMatrixWorld()
    s.update(camera)
    s.inner.updateMatrixWorld()
    const got = s.inner.getWorldQuaternion(new THREE.Quaternion())
    const want = camera.getWorldQuaternion(new THREE.Quaternion())
    expect(Math.abs(got.dot(want))).toBeCloseTo(1, 12)
  })

  test('Cable は影を受けて落とさない。FlowPipe は「ガラスの管（renderOrder 2）→ 光の芯 → 継ぎ手」で、channels を読むたびに見る。dispose は作った物だけ', async () => {
    const M = await load<MaterialsMod>('../world/materials/labMaterials.ts')
    const C = await load<CableMod>(`${LAB}/parts/cable.ts`)
    const F = await load<FlowPipeMod>(`${LAB}/parts/flowPipe.ts`)
    const mats = M.createLabMaterials(sharedTextures())
    const c = C.cable({ points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], material: mats.steel })
    expect([c.castShadow, c.receiveShadow]).toEqual([false, true])
    expect((c.geometry as THREE.TubeGeometry).parameters).toMatchObject({ tubularSegments: 3 * 14, radius: 0.02, radialSegments: 10 })

    const ch = { link: 0, flash: 0, pulse: 0, ringBoost: 0 }
    const p = F.flowPipe({ points: [[0, 0, 0], [0, 2, 0]], color: '#00ffff', linkColor: '#00ff66', intensity: 2 }, mats, ch)
    const [sleeve, core, collars] = p.object.children as [THREE.Mesh, THREE.Mesh, THREE.InstancedMesh]
    expect(p.object.children.length).toBe(3)
    expect([sleeve.material === mats.tintedGlass, sleeve.renderOrder, core.renderOrder]).toEqual([true, 2, 0])
    expect([collars.material === mats.steel, collars.castShadow, collars.receiveShadow, collars.count]).toEqual([true, false, true, 5])
    const flow = core.material as THREE.Material & { uniforms: Record<string, { value: unknown } | undefined> }
    expect(flow.uniforms.uIntensity!.value).toBe(2)
    ch.link = 1
    ch.flash = 1
    p.update()
    expect(flow.uniforms.uIntensity!.value).toBeCloseTo(2 * (1 + 0.3 + 1.5), 12)
    expect((flow.uniforms.uColor!.value as THREE.Color).getHexString()).toBe('00ff66')
    // linkColor が無ければ何もしない・継ぎ手 0 なら付けない
    const still = F.flowPipe({ points: [[0, 0, 0], [0, 2, 0]], color: '#00ffff' }, mats, ch)
    const stillFlow = (still.object.children[1] as THREE.Mesh).material as THREE.Material & { uniforms: Record<string, { value: unknown } | undefined> }
    const before = [stillFlow.uniforms.uIntensity!.value, stillFlow.uniforms.uSpeed!.value, (stillFlow.uniforms.uColor!.value as THREE.Color).getHex()]
    still.update()
    expect([stillFlow.uniforms.uIntensity!.value, stillFlow.uniforms.uSpeed!.value, (stillFlow.uniforms.uColor!.value as THREE.Color).getHex()]).toEqual(before)
    const bare = F.flowPipe({ points: [[0, 0, 0], [0, 2, 0]], color: '#00ffff', collarSpacing: 0 }, mats)
    expect(bare.object.children.length).toBe(2)
    // dispose: 管と芯と継ぎ手の形・芯の素材・継ぎ手を捨て、共有の素材（ガラス・金属）は捨てない（4-6）
    const disposed = new Set<unknown>()
    const own = [sleeve.geometry, core.geometry, flow, collars.geometry, collars]
    for (const x of [...own, mats.tintedGlass, mats.steel]) (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(x))
    p.dispose()
    expect(own.filter((x) => !disposed.has(x))).toEqual([])
    expect([disposed.has(mats.tintedGlass), disposed.has(mats.steel)]).toEqual([false, false])
    bare.dispose()
  })

  test('パンチングメタルは呼ぶたびに素材を 1 つ作り、穴のテクスチャを写して repeat を変える', async () => {
    const M = await load<MaterialsMod>('../world/materials/labMaterials.ts')
    const mats = M.createLabMaterials(sharedTextures())
    const a = M.perforatedMaterial(mats, 10, 2)
    const b = M.perforatedMaterial(mats, 10, 2)
    expect(a).not.toBe(b)
    expect(a.alphaMap).not.toBe(mats.perforated.alphaMap)
    expect(a.alphaMap?.repeat.toArray()).toEqual([10, 2])
    expect([a.alphaMap?.wrapS, a.normalMap]).toEqual([THREE.RepeatWrapping, null])
    expect(mats.perforated.alphaMap?.repeat.toArray()).toEqual([1, 1])
  })

  test('画面は最初の更新で描き、そのあとは 1 / 回数 ごと。ホールの外では回数を減らす。setContent(null) で既定の中身に戻る', async () => {
    const S = await load<ScreensMod>(`${LAB}/screens.ts`)
    const inside = new THREE.PerspectiveCamera()
    inside.position.set(0, 1.6, 1)
    const far = new THREE.PerspectiveCamera()
    far.position.set(0, 1.6, 80)
    expect(S.labScreenRate(12, inside)).toBe(12)
    expect(S.labScreenRate(12, far)).toBe(1)

    const calls: string[] = []
    const screen = S.createLabScreen('t', 64, 32, (_c, t) => calls.push(`base ${t.toFixed(2)}`), 10, { maxAnisotropy: 16 })
    expect([screen.texture.anisotropy, screen.texture.colorSpace]).toEqual([16, THREE.SRGBColorSpace])
    const v0 = screen.texture.version
    screen.update(0.05, inside)
    expect(calls).toEqual(['base 0.05'])
    expect(screen.texture.version).toBe(v0 + 1)
    screen.update(0.05, inside)
    expect(calls.length).toBe(1)
    screen.setContent((_c, t) => calls.push(`next ${t.toFixed(2)}`))
    screen.update(0.05, inside)
    screen.setContent(null)
    screen.update(0.1, inside)
    expect(calls).toEqual(['base 0.05', 'next 0.15', 'base 0.25'])
  })

  test('テクスチャの下ごしらえ: パンチングメタルの穴の形 1 枚を、繰り返し・異方性 8・リニアに', async () => {
    const T = await load<TexturesMod>(`${LAB}/textures.ts`)
    const shared = T.prepareLabSharedTextures(sharedTextures())
    expect(Object.keys(shared)).toEqual(['perfOpacity'])
    for (const t of Object.values(shared)) expect([t.wrapS, t.wrapT, t.anisotropy, t.colorSpace]).toEqual([THREE.RepeatWrapping, THREE.RepeatWrapping, 8, THREE.NoColorSpace])
  })

  test('明るさの入力の暗くする関数は、min〜1 の割合を受け、外す関数で外れる', async () => {
    const L = await load<LabLightMod>('../world/labLight.ts')
    const got: number[] = []
    const remove = L.addLabLightDimmer((k) => got.push(k), 0.3)
    L.setLabLight(0.5)
    remove()
    L.setLabLight(1)
    expect(got).toEqual([0.3 + 0.7 * 0.5])
  })
})
