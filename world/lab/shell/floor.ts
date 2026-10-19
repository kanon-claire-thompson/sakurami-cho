import * as THREE from 'three/webgpu'
import { ROOM } from '../../../core/lab/plan'

/**
 * ラボの床（docs/design/map-split.md §6 の「段 4」・4-4。前の Room.tsx の Floor）。素材は名前 labFloor の 1 色（描くときはアニメ塗りの素材に
 * 差し替える。world/anime/labAnime.ts）。前のリアル寄りの見た目の床の映り込み（reflector）とコンクリートの質感は 2026-10-20 に無くした
 */

export interface LabFloor {
  readonly mesh: THREE.Mesh
  /** 素材・形を捨てる */
  dispose(): void
}

/** 床を作る */
export function createLabFloor(): LabFloor {
  const geometry = new THREE.PlaneGeometry(ROOM.width, ROOM.depth)
  const material = new THREE.MeshStandardMaterial({ name: 'labFloor', color: '#8d949c', roughness: 0.55, metalness: 0 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(0, 0, ROOM.centerZ)
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  return {
    mesh,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
