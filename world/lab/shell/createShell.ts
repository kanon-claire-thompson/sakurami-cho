import * as THREE from 'three'
import { enableSunShadow } from '../../environment/sunShadow'
import { markDynamic, mergeStatic, type StaticMerge } from '../../staticMerge'
import { addWallWashDimmer } from '../../materials/wallWash'
import type { LabMaterials } from '../../materials/labMaterials'
import type { LabFrame } from '../kit'
import { createShellBuild } from './build'
import { buildEntrance } from './entrance'
import { createLabFloor, type LabFloor } from './floor'
import { buildMezzanine } from './mezzanine'
import { buildNorthDoors } from './northDoors'
import { buildRoom } from './room'

/**
 * ラボの殻（docs/design/map-split.md §6 の「段 4」・4-4。案の §4.2）: 部屋（床・壁・ガラス壁・天井・柱・LED・にじみ。room.ts・floor.ts）・
 * 北の扉（northDoors.ts）・中二階（mezzanine.ts）・見学エントランスと通用口（entrance.ts）。前の Room.tsx・zones/NorthDoors.tsx・Mezzanine.tsx・
 * Entrance.tsx を、同じ入れ子・同じ子の順・同じ作る順で three の形にした物。
 *
 * - object: 殻の群（中は前の 4 つの部品の群の並び。見学エントランスは前の Lab.tsx の SunShadowCasters の群の中）。使う側は場面の、前の Room の位置に足す
 * - attach(): 場面に付ける。太陽の影を落とす物の印（enableSunShadow。窓のある壁と柱・天井の板・見学エントランスの群。前の SunShadowCasters の
 *   layout effect と同じ順）と、光のにじみを部屋の照明に合わせる関数の登録（前の useWallWashMaterial の effect）。外す関数を返す（にじみの登録を外す。
 *   太陽の影の印は付けたまま。前も外していなかった）
 * - update(dt, f): 毎コマ。見学エントランスの扉（扉を開ける物を前のコマの位置で見る。KB-001 の更新より前。案の E4）
 * - mergeStatic(): 動かない物を合わせる（WebGPU への移行の第 3 段。world/staticMerge.ts）。太陽の影の印を付けたあと（attach のあと）に 1 回。
 *   太陽の影を落とす物の群はその群の中で合わせる（印は群の下の物に付く）。床と見学エントランスの扉の板は動く物。2 回目からは前の結果を返す
 * - dispose(): 殻が作った形・素材・テクスチャを捨てる（共有の素材・キャッシュの素材とテクスチャは捨てない）
 */

export interface LabShellOptions {
  /** 共有の素材（world/materials/labMaterials.ts の createLabMaterials） */
  materials: LabMaterials
}

export interface LabShell {
  readonly object: THREE.Group
  readonly floor: LabFloor
  attach(): () => void
  mergeStatic(): StaticMerge
  update(dt: number, f: LabFrame): void
  dispose(): void
}

export function createLabShell(o: LabShellOptions): LabShell {
  const b = createShellBuild(o.materials)
  const floor = createLabFloor()
  const room = buildRoom(b, floor)
  // 床は動く物（前は映り込みを撮る間だけ隠していた。動かない物の合わせの並びを変えないように、そのまま）
  markDynamic(floor.mesh)
  // 北の壁の扉（北側の部屋）・中二階・南西の見学エントランス（見学エントランスは太陽の影を落とす物の群の中）
  const northDoors = buildNorthDoors(b)
  const mezzanine = buildMezzanine(b)
  const entrance = buildEntrance(b)
  const entranceCasters = new THREE.Group()
  entranceCasters.add(entrance.object)
  b.sunCasters.push(entranceCasters)

  const object = new THREE.Group()
  object.name = 'lab:shell'
  object.add(room, northDoors, mezzanine, entranceCasters)

  /** 太陽の影の印を付けたか（付けるのは 1 回。合わせたあとの大きな形に付け直さない） */
  let sunMarked = false
  let merged: StaticMerge | null = null
  return {
    object,
    floor,
    attach() {
      if (!sunMarked) {
        for (const g of b.sunCasters) enableSunShadow(g)
        sunMarked = true
      }
      const offs = b.washes.map(({ material, color }) => addWallWashDimmer(material, color))
      return () => offs.forEach((off) => off())
    },
    mergeStatic() {
      merged ??= mergeStatic(object, { bodies: b.sunCasters })
      return merged
    },
    update(dt) {
      entrance.update(dt)
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      object.traverse((obj) => {
        const m = obj as THREE.Mesh
        if (!m.isMesh || m === floor.mesh) return
        if (!b.shared.has(m.geometry)) geometries.add(m.geometry)
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (!b.shared.has(mat)) materials.add(mat)
      })
      geometries.forEach((g) => g.dispose())
      materials.forEach((m) => m.dispose())
      for (const t of b.textures) t.dispose()
      floor.dispose()
      merged?.dispose()
    },
  }
}
