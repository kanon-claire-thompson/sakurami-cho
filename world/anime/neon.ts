import * as THREE from 'three/webgpu'
import { NEON_COUNT, type AnimeUniforms } from './material'

/**
 * アニメ塗りのネオンの照り返しの光源（material.ts の neon の uniform を毎コマ書く）。
 *
 * ラボの照明（sakurami-cho の lab.lighting.object。基地局のコアとシアンの光・ホロテーブル・KB-001 のドック・開発デスクのモニタの照り返し・サーバラック、
 * 差し込み口 stage の光）から、色の付いた点光源と面光源（彩度 MIN_SATURATION 以上。白い天井のスポットは除く）を光源の位置・色から自動で拾う。
 * 帯の半径は光の届く距離から（RADIUS）、強さは今の光の強さ ÷ 初めの強さ（配信で落とした光・Qコアの明るさ（core）・琥珀の色が効く）
 */

/** 拾う光の彩度の下限（(最大 − 最小) ÷ 最大。sRGB の値で。白っぽい補助光（#bcd4ff など）は拾わない） */
const MIN_SATURATION = 0.35
/** 帯の外の半径: 光の届く距離 × scale（max まで）。面光源は area */
const RADIUS = { scale: 0.26, max: 1.5, area: 1.0 }
/** 帯の色の強さ（画面の色。1 = 光源の色そのまま） */
const STRENGTH = 0.24

interface NeonSource {
  light: THREE.Light
  /** 初めに見た強さ（今の強さとの比で、落とした光・コアの明るさを効かせる） */
  base: number
  radius: number
}

const _c = new THREE.Color()
const _p = new THREE.Vector3()

export interface NeonLights {
  /** 光源を拾い直す（照明の物を作り直したとき・差し込み口の光が入ったとき） */
  scan(root: THREE.Object3D): void
  /** 毎コマ、位置・色・強さを uniform に書く */
  update(u: AnimeUniforms): void
  readonly count: number
}

export function createNeonLights(): NeonLights {
  let sources: NeonSource[] = []
  const known = new Map<THREE.Light, number>()
  return {
    get count() {
      return sources.length
    },
    scan(root) {
      const found: NeonSource[] = []
      root.traverse((o) => {
        const l = o as THREE.PointLight & THREE.RectAreaLight
        if (!(l.isPointLight || l.isRectAreaLight)) return
        _c.copy(l.color).convertLinearToSRGB()
        const hi = Math.max(_c.r, _c.g, _c.b)
        if (hi <= 0 || (hi - Math.min(_c.r, _c.g, _c.b)) / hi < MIN_SATURATION) return
        if (!known.has(l)) known.set(l, Math.max(l.intensity, 1e-4))
        const radius = l.isRectAreaLight ? RADIUS.area : Math.min(RADIUS.max, (l.distance || 4) * RADIUS.scale)
        found.push({ light: l, base: known.get(l)!, radius })
      })
      // 強い順（光の強さ × 帯の大きさ）に NEON_COUNT まで
      found.sort((a, b) => b.base * b.radius - a.base * a.radius)
      sources = found.slice(0, NEON_COUNT)
    },
    update(u) {
      for (let i = 0; i < NEON_COUNT; i++) {
        const pos = u.neonPos.array[i] as THREE.Vector4
        const col = u.neonColor.array[i] as THREE.Vector4
        const s = sources[i]
        if (!s || !s.light.visible) {
          pos.set(0, -100, 0, 0)
          col.set(0, 0, 0, 0)
          continue
        }
        s.light.getWorldPosition(_p)
        pos.set(_p.x, _p.y, _p.z, s.radius)
        // 光の色を明るさ 1 にそろえた色（いちばん強い成分を 1）
        _c.copy(s.light.color)
        const m = Math.max(_c.r, _c.g, _c.b, 1e-4)
        const k = THREE.MathUtils.clamp(s.light.intensity / s.base, 0, 1.5) * STRENGTH
        col.set(_c.r / m, _c.g / m, _c.b / m, k)
      }
    },
  }
}
