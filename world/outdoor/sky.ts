import * as THREE from 'three/webgpu'
import type { WebGPURenderer } from 'three/webgpu'
import { townHighQuality } from '../townHost'
import { SITE } from '../../core/town'
import { outdoor } from '../environment/daylight'
import { mulberry32 } from '../../core/random'
import { createSkyMaterial, createStarsMaterial } from './materials'
import { OUTDOOR_LAYER } from './layers'

/**
 * 空（大きな球の内側に、時刻で変わるグラデーション・太陽・雲を描く）と星。
 * 空は部屋や遠景を描いたあとに描き（renderOrder）、深度を書かないので、壁に隠れた所の空は計算しない。
 * 星は天の北極（北の空、高度 = 緯度）のまわりを、恒星時に合わせて回す。
 *
 * three の形（5-5。前の Sky.tsx）: 空の球と星は skyParts() でモジュールに 1 つだけ作り（作り直さず、捨てない）、遠景の根（landscape.ts）の子に置く。
 * 毎コマ updateStars(renderer) を呼ぶ（町の毎コマの段 town.view（world/createTown.ts）の中で、ラボの照明のあと・遠景の窓の前）
 */

/** 空の球の半径（m）。カメラの far（App.tsx）より内側 */
export const SKY_RADIUS = 30000
const STAR_RADIUS = 28000

const _qNorth = new THREE.Quaternion()
const _qTilt = new THREE.Quaternion()
const _qSpin = new THREE.Quaternion()
const Y = new THREE.Vector3(0, 1, 0)
const X = new THREE.Vector3(1, 0, 0)

/** UTC のミリ秒から、その場所の恒星時（ラジアン） */
function localSiderealAngle(utcMs: number) {
  const d = utcMs / 86400_000 + 2440587.5 - 2451545.0
  const gmstHours = 18.697374558 + 24.06570982441908 * d
  const lst = gmstHours + SITE.longitude / 15
  return (((lst % 24) + 24) % 24) * ((Math.PI * 2) / 24)
}

/** 空の球と星を作る（最初の 1 回だけ） */
function createSky() {
  const high = townHighQuality()
  const sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 64, 32), createSkyMaterial())
  sky.renderOrder = 20
  sky.frustumCulled = false

  const count = high ? 2600 : 1200
  const rnd = mulberry32(4123)
  const pos = new Float32Array(count * 3)
  const mag = new Float32Array(count)
  const seed = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    // 天の北極が +Y の座標で、球面に一様に
    const u = rnd() * 2 - 1
    const a = rnd() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    pos.set([Math.cos(a) * r * STAR_RADIUS, u * STAR_RADIUS, Math.sin(a) * r * STAR_RADIUS], i * 3)
    // 暗い星ほど多い
    mag[i] = 0.15 + 0.85 * Math.pow(rnd(), 3.2)
    seed[i] = rnd()
  }
  // 星は Sprite を count 個（インスタンス）並べる（WebGPU の点は 1px だけなので、大きさのある点は板にする。materials.ts の createStarsMaterial）
  const starMaterial = createStarsMaterial({
    position: new THREE.InstancedBufferAttribute(pos, 3),
    mag: new THREE.InstancedBufferAttribute(mag, 1),
    seed: new THREE.InstancedBufferAttribute(seed, 1),
  })
  const stars = new THREE.Sprite(starMaterial)
  stars.count = count
  stars.frustumCulled = false
  stars.renderOrder = -2
  // 空と星も遠景のレイヤー（ふだんのカメラだけ）。床の映り込みには入れない（昼に床が空の色で明るくなりすぎず、暗い床と光のラインのままにする）
  sky.layers.set(OUTDOOR_LAYER)
  stars.layers.set(OUTDOOR_LAYER)
  return { sky, stars, starMaterial }
}

let skyCache: ReturnType<typeof createSky> | null = null
/** 空の球と星（初めて呼んだときに作る。あとは同じ物） */
export const skyParts = () => (skyCache ??= createSky())

/** 毎コマ: 星の明るさと、星の空の回転（恒星時） */
export function updateStars(_renderer: WebGPURenderer) {
  const { stars, starMaterial } = skyParts()
  // 星の大きさは CSS の px（描画の画素の比は PointsNodeMaterial が掛ける。前の uPixelRatio は要らない）
  starMaterial.uniforms.uStars.value = outdoor.stars
  stars.visible = outdoor.stars > 0.002
  if (stars.visible) {
    // 北のずれ → 天の北極を北の空（高度 = 緯度）へ傾ける → 恒星時で回す（東から昇って西へ沈む向き）
    _qNorth.setFromAxisAngle(Y, (-SITE.northOffsetDeg * Math.PI) / 180)
    _qTilt.setFromAxisAngle(X, ((SITE.latitude - 90) * Math.PI) / 180)
    _qSpin.setFromAxisAngle(Y, -localSiderealAngle(outdoor.time.utcMs))
    stars.quaternion.copy(_qNorth).multiply(_qTilt).multiply(_qSpin)
  }
}
