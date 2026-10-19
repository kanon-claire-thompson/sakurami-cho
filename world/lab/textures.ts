import * as THREE from 'three'
import type { LabTextures } from '../materials/labMaterials'

/**
 * ラボのテクスチャ（docs/design/map-split.md §6 の「段 4」・4-2）。パンチングメタルの穴の形 1 枚（アニメ塗りの素材が alphaMap として読む）。
 * 読み込みは使う側（今は R3F の useTexture。react の包み）がして、ここは置き場所と、読んだあとの下ごしらえだけ。出典は assets/textures/CREDITS.md。
 * 前のリアル寄りの見た目の素材の法線・ラフネス・汚れと床のテクスチャは 2026-10-20 に無くした
 */

export interface LabTextureSet {
  shared: LabTextures
}

export interface LabTextureUrls {
  shared: Record<keyof LabTextures, string>
}

/** テクスチャの置き場所。base は public の根（地図の引数 assetBase。react/TownView.tsx が渡す） */
export function labTextureUrls(base: string): LabTextureUrls {
  return {
    shared: {
      perfOpacity: `${base}textures/perforated_metal/opacity.jpg`,
    },
  }
}

/** 共有のテクスチャの下ごしらえ（読んだ物をそのまま直して返す） */
export function prepareLabSharedTextures(t: LabTextures): LabTextures {
  for (const tex of Object.values(t)) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.anisotropy = 8
    // データテクスチャ（マスク）なので色空間はリニアのまま
    tex.colorSpace = THREE.NoColorSpace
    tex.needsUpdate = true
  }
  return t
}

/** 下ごしらえする */
export function prepareLabTextures(t: LabTextureSet): LabTextureSet {
  prepareLabSharedTextures(t.shared)
  return t
}
