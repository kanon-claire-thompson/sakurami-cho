import * as THREE from 'three'
import { texture } from 'three/tsl'
import { townOptions } from '../../townHost'

/**
 * 町の質感（CC0。アセットの根の textures/town/（assets/textures/town/）、出典は assets/textures/CREDITS.md）。町のアニメ塗りが読むのは次の 2 つだけ
 * （前のリアル寄りの見た目の地面の質感 ground-albedo / ground-normal は 2026-10-20 に無くした）:
 *
 * - building-albedo / building-normal（512px × 9 層を縦に並べた 1 枚）: 0 板張り・1 漆喰・2 石・3 煉瓦・4 コンクリート・5 波板・6 タイル・7 瓦・8 スレート。
 *   中のある建物の中の板の床（interior/interiorMaterial.ts の木目）が読む
 * - foliage（1024px の 2×2）: 葉のかたまりの板（広葉樹の密・広葉樹の疎・楓・針葉樹）。A = 葉の形（木の塊の形を切り抜く）
 *
 * 色の層は明るさの平均を 0.5 にそろえてある（シェーダーはデータの色 × 2 × 質感で塗る。ミップマップの遠くでは 1 倍になる）。
 * 縦長の 1 枚を読んで DataArrayTexture（層の配列）にする。読めないときは 1 色の層で代わりにする（町は描ける）
 */

export const BUILDING_LAYER = { wood: 0, plaster: 1, stone: 2, brick: 3, concrete: 4, metal: 5, tile: 6, kawara: 7, slate: 8 } as const

const BUILDING_LAYERS = 9

export interface TownTextureImages {
  buildingAlbedo: ImageBitmap | null
  buildingNormal: ImageBitmap | null
  foliage: ImageBitmap | null
}

/** 質感の画像を読む（読めない画像は null。町の読み込みは止めない）。置き場は地図の引数 assetBase の下の textures/town/（呼んだときに読む） */
export async function loadTownTextures(): Promise<TownTextureImages> {
  const dir = `${townOptions().assetBase}textures/town/`
  const image = async (name: string) => {
    try {
      const res = await fetch(dir + name)
      if (!res.ok) throw new Error(String(res.status))
      return await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' })
    } catch (e) {
      console.warn(`[sakurami-cho] 町の質感 ${name} を読めませんでした（1 色で代わりにします）`, e)
      return null
    }
  }
  const [buildingAlbedo, buildingNormal, foliage] = await Promise.all([image('building-albedo.webp'), image('building-normal.webp'), image('foliage.webp')])
  return { buildingAlbedo, buildingNormal, foliage }
}

function pixels(image: ImageBitmap) {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!
  ctx.drawImage(image, 0, 0)
  return new Uint8Array(ctx.getImageData(0, 0, image.width, image.height).data.buffer)
}

/** 縦に層を並べた画像 → 層の配列のテクスチャ。image が無ければ fill の 1 色（4×4）の層 */
function arrayTexture(image: ImageBitmap | null, layers: number, color: boolean, anisotropy: number, fill: [number, number, number, number]) {
  let data: Uint8Array
  let size: number
  if (image) {
    size = image.width
    data = pixels(image)
  } else {
    size = 4
    data = new Uint8Array(size * size * 4 * layers)
    for (let i = 0; i < data.length; i += 4) data.set(fill, i)
  }
  const t = new THREE.DataArrayTexture(data, size, size, layers)
  t.format = THREE.RGBAFormat
  t.type = THREE.UnsignedByteType
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = true
  t.anisotropy = anisotropy
  t.needsUpdate = true
  return t
}

function plainTexture(image: ImageBitmap | null, anisotropy: number) {
  const t = image ? new THREE.Texture(image) : new THREE.DataTexture(new Uint8Array([60, 90, 40, 255]), 1, 1)
  t.flipY = false
  t.colorSpace = THREE.SRGBColorSpace
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = true
  t.anisotropy = anisotropy
  t.needsUpdate = true
  return t
}

/** 仮の層の配列のテクスチャ（町を組み立てる前に、読む側の材質を組み立てる時の物。中身は灰色 1 画素 1 層） */
function placeholderArray() {
  const t = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1)
  t.needsUpdate = true
  return t
}

/**
 * 町の質感の uniform（中のある建物の床・木のシェーダーが読む。createTownTextures が中身を入れる）。
 * WebGPU への移行（第 1 段）から TSL の TextureNode（TSL の材質は townTextureUniforms.uBldAlb.sample(uv).depth(層) のように読む。value を替えると
 * 読む側の材質も替わる）。名前は前の GLSL の uniform と同じ
 */
export const townTextureUniforms = {
  uBldAlb: texture(placeholderArray()),
  uBldNrm: texture(placeholderArray()),
  uFoliage: texture(new THREE.DataTexture(new Uint8Array([60, 90, 40, 255]), 1, 1)),
}

/** 読んだ画像からテクスチャを作って uniform に入れる（町を組み立てるとき 1 回） */
export function createTownTextures(images: TownTextureImages | null, anisotropy: number) {
  const u = townTextureUniforms
  // 色の層も sRGB の値のまま読む（シェーダーが 2 倍してから 2.2 乗する。ミップマップの遠くがちょうど 1 倍になるように）
  u.uBldAlb.value = arrayTexture(images?.buildingAlbedo ?? null, BUILDING_LAYERS, false, anisotropy, [128, 128, 128, 255])
  u.uBldNrm.value = arrayTexture(images?.buildingNormal ?? null, BUILDING_LAYERS, false, anisotropy, [128, 128, 255, 255])
  u.uFoliage.value = plainTexture(images?.foliage ?? null, anisotropy)
}
