import * as THREE from 'three'
import { Break, Continue, Fn, If, Loop, abs, cameraPosition, dot, exp, float, floor, fract, int, inverseSqrt, ivec2, length, max, normalize, smoothstep, sqrt, texture, uniform, uniformArray, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SITE } from '../../../core/town'
import { outdoor } from '../../environment/daylight'
import { outdoorPaint } from '../paint'

/**
 * 夜の灯りが壁と地面を照らす（ライトの表 = 地面の格子ごとの「近い灯りの表」）。
 *
 * 町の灯り（街灯・提灯・足元灯・港の作業灯・店先・名前のある建物の灯具・停留所の灯り）は 2 万を超えるので、ライトとしては置けない
 * （three のライトを足すと、すべてのシェーダーの計算が増え、作り直しにもなる）。そこで、細かさの中心のまわり（TABLE_SIZE m 四方）を
 * CELL m の升に分け、升ごとに「その升をいちばん照らす灯り」を SLOTS 個まで選んで 1 枚の浮動小数の画像に書く（CPU で 1 回。細かさの中心が動いたら作り直す）。
 * 画素のシェーダーは自分の升の SLOTS 個だけを読み、灯りの向き（N・L）と距離の減衰で照らす（`townLamps(位置, 法線)`）。
 *
 * - 画像の 1 画素 = 1 つの灯り: xyz = シーンの位置、w = 種類 + 強さ / 16（強さは 0〜16）
 * - 種類（LAMP）ごとの色・点き具合・届く距離は uniform（時刻で毎コマ変わる）
 * - 遠くは描かない（カメラからの距離でうすめる）。窓から見た遠くの町は今までどおり地面の画像の照り返し（金色の絨毯を崩さない）
 */

/** 灯りの種類（照らし方の決まり。色・点き具合・届く距離は LAMP_STYLE） */
export const LAMP = { street: 1, lantern: 2, foot: 3, port: 4, shop: 5, named: 6, stop: 7 } as const
export type LampKind = (typeof LAMP)[keyof typeof LAMP]

/** 種類ごとの色（sRGB）・強さの倍率・届く距離（m） */
const LAMP_STYLE: Record<LampKind, { color: string; gain: number; radius: number }> = {
  [LAMP.street]: { color: '#ffc27a', gain: 2.4, radius: 26 },
  [LAMP.lantern]: { color: '#ff9a52', gain: 1.5, radius: 10 },
  [LAMP.foot]: { color: '#ffb866', gain: 0.9, radius: 6 },
  [LAMP.port]: { color: '#ffdcae', gain: 2.2, radius: 60 },
  // 店先は間口ごとに並ぶので、強いと路地が昼のように一様に明るくなる（段階 5 の色の仕上げで 1.6・11m → 0.95・9m。灯りの溜まりが残るように）
  [LAMP.shop]: { color: '#ffd2a0', gain: 0.95, radius: 9 },
  [LAMP.named]: { color: '#ffc988', gain: 1.6, radius: 16 },
  [LAMP.stop]: { color: '#ffe8cc', gain: 1.3, radius: 9 },
}

export interface Lamp {
  /** 町の平面座標と標高 */
  x: number
  y: number
  z: number
  kind: LampKind
  /** 強さ（0〜16。種類の倍率に掛ける） */
  power: number
}

const LAB = SITE.labFloorElevation
/** 表の升の大きさ（m）・升の数（一辺）・升ごとの灯りの数 */
const CELL = 4
const CELLS = 384
const SLOTS = 8
const KINDS = 8

/** 種類ごとの色 × 点き具合 × 強さ（rgb）と届く距離（a）。updateLampUniforms が毎コマ書き、uLampKind が毎コマ GPU へ写す */
const lampKinds = Array.from({ length: KINDS }, () => new THREE.Vector4())

/** 表の仮の画像（表を作る前に、読む側の材質を組み立てる時の物。浮動小数の 1 画素） */
function placeholderTable() {
  const t = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType)
  t.needsUpdate = true
  return t
}

/**
 * 灯りの表の uniform（ノード。WebGPU への移行（第 1 段）から TSL の uniform・TextureNode。value は前と同じく読み書きできる。
 * uLampKind は配列の uniform で、中身は .array（Vector4 の配列）を書く）
 */
export const lampUniforms = {
  /** 表の画像（buildLampTable が value を替える） */
  uLampTable: texture(placeholderTable()),
  /** x, y = 表の左下の角（シーンの x, z）、z = 升の大きさ、w = 使うか（0 / 1） */
  uLampInfo: uniform(new THREE.Vector4(0, 0, CELL, 0)),
  /** 種類ごとの色 × 点き具合 × 強さ（rgb）と届く距離（a） */
  uLampKind: uniformArray(lampKinds, 'vec4' as const),
  /** カメラからの距離でうすめる [始まり, 終わり]（m。画質の段ごと。setLampFade） */
  uLampFade: uniform(new THREE.Vector2(260, 700)),
  /** どれかの灯りが点いているか（昼は 0 で、画素のシェーダーは表を読まない） */
  uLampAny: uniform(0),
}

type V3 = Node<'vec3'>

/**
 * 升の表の SLOTS 個の灯りを順に読む（表の左下の角からの升・灯りが無くなったら終わる）。each(灯り: xyz = 位置、w = 種類 + 強さ / 16) を呼ぶ。
 * 町の外・カメラから遠い・灯りが消えている間は何もしない。fade = カメラからの距離でうすめる割合（each の結果に掛けるのは呼ぶ側）
 */
function eachLamp(wp: V3, each: (t: Node<'vec4'>, fade: Node<'float'>) => void) {
  const u = lampUniforms
  If(u.uLampInfo.w.greaterThanEqual(0.5).and(u.uLampAny.greaterThanEqual(0.5)), () => {
    const fade = smoothstep(u.uLampFade.x, u.uLampFade.y, length(wp.sub(cameraPosition))).oneMinus().toVar()
    const c = floor(wp.xz.sub(u.uLampInfo.xy).div(u.uLampInfo.z)).toVar()
    If(fade.greaterThan(0.0).and(c.x.greaterThanEqual(0.0)).and(c.y.greaterThanEqual(0.0)).and(c.x.lessThan(CELLS)).and(c.y.lessThan(CELLS)), () => {
      const base = ivec2(int(c.x).mul(SLOTS), int(c.y)).toVar()
      Loop(SLOTS, ({ i }: { i: Node<'int'> }) => {
        const t = u.uLampTable.load(base.add(ivec2(i, 0))).toVar()
        If(t.w.lessThanEqual(0.0), () => {
          Break()
        })
        each(t, fade)
      })
    })
  })
}

/** townLamps の中身: skipNamed = 1 なら名前のある建物の灯具（named）を除く、wrap = 面の向きの回り込み */
export const townLampsEx = Fn(([wp, N, skipNamed, wrap]: [V3, V3, Node<'float'>, Node<'float'>]) => {
  const falloff = outdoorPaint()?.lampFalloff
  const acc = vec3(0.0).toVar()
  eachLamp(wp, (t, fade) => {
    const kind = floor(t.w).toVar()
    If(skipNamed.greaterThan(0.5).and(abs(kind.sub(6.0)).lessThan(0.5)), () => {
      Continue()
    })
    const k = lampUniforms.uLampKind.element(int(kind)).toVar()
    If(dot(k.xyz, k.xyz).lessThan(1e-8), () => {
      Continue()
    })
    const power = fract(t.w).mul(16.0)
    const L = t.xyz.sub(wp).toVar()
    const d2 = dot(L, L).toVar()
    const R = k.w.toVar()
    If(d2.greaterThan(R.mul(R)), () => {
      Continue()
    })
    const d = sqrt(d2).toVar()
    const l = L.div(max(d, 1e-3)).toVar()
    // 灯具は下向き（上は暗い）。面の向き（回り込み wrap）と距離の減衰
    const spot = smoothstep(-0.25, 0.55, l.y).mul(0.7).add(0.3)
    const ndl = max(dot(N, l), 0.0).mul(wrap.oneMinus()).add(wrap)
    const att0 = power.div(d2.mul(0.09).add(1.0)).mul(smoothstep(R.mul(0.45), R, d).oneMinus())
    // 外の塗り（paint.ts）の lampFalloff を入れたら、減り方はそちら
    const att = falloff ? falloff(att0, power, d, R) : att0
    acc.addAssign(k.xyz.mul(att).mul(ndl).mul(spot).mul(fade))
  })
  return acc
})

/** townLamps(ワールドの位置, 法線) → 照度（albedo を掛ける前） */
export const townLamps = Fn(([wp, N]: [V3, V3]) => townLampsEx(wp, N, float(0.0), float(0.08)))

/**
 * 水面に映る灯り（段階 5 の色の仕上げ）: 映った向き R の近くに灯りがあれば、その光（さざ波の法線で揺れて縦に伸びる）。
 * 灯りは升の表の 8 つ（その升を照らす灯り）。映り込みは照らす範囲より遠くまで見えるので、届く距離の 2 倍まで
 */
export const townLampsMirror = Fn(([wp, R]: [V3, V3]) => {
  const acc = vec3(0.0).toVar()
  eachLamp(wp, (t, fade) => {
    const k = lampUniforms.uLampKind.element(int(floor(t.w))).toVar()
    If(dot(k.xyz, k.xyz).lessThan(1e-8), () => {
      Continue()
    })
    const power = fract(t.w).mul(16.0)
    const L = t.xyz.sub(wp).toVar()
    const d2 = dot(L, L).toVar()
    const Rr = k.w.mul(2.0).toVar()
    If(d2.greaterThan(Rr.mul(Rr)), () => {
      Continue()
    })
    const l = L.mul(inverseSqrt(max(d2, 1e-4))).toVar()
    // 横には細く、縦に長い光の筋（水面のさざ波は縦の向きに映りを引き伸ばす）。dAz ≒ 方位の差の 2 乗 / 2、dEl = 高さの向きの差
    const dAz = dot(normalize(R.xz.add(vec2(1e-5))), normalize(l.xz.add(vec2(1e-5)))).oneMinus()
    const dEl = R.y.sub(l.y)
    const spec = exp(dAz.div(-0.00009).sub(dEl.mul(dEl).div(0.006))).mul(5.0).add(exp(dAz.div(-0.0018).sub(dEl.mul(dEl).div(0.05))).mul(0.35))
    acc.addAssign(k.xyz.mul(spec).mul(power).div(d2.mul(0.004).add(1.0)).mul(fade))
  })
  return acc
})
const _c = new THREE.Color()

/**
 * 表を作る（細かさの中心 center（平面座標）のまわり）。lamps は町じゅうの灯り（範囲の外は使わない）
 */
export function buildLampTable(lamps: readonly Lamp[], center: [number, number]) {
  const g = lampTableSteps(lamps, center)
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
  }
}

/** 表を作る手順（升の行を 32 行作るごとに yield。町の中を歩く間は 1 コマに少しずつ。landscape.ts）。最後に結果を返す */
export function* lampTableSteps(lamps: readonly Lamp[], center: [number, number]): Generator<void, { ms: number; cells: number; lamps: number }> {
  const t0 = performance.now()
  const half = (CELLS * CELL) / 2
  // シーンの座標: x = 東、z = -北。表の左下（x, z が小さい角）
  const ox = Math.round((center[0] - half) / CELL) * CELL
  const oz = Math.round((-center[1] - half) / CELL) * CELL
  // 灯りを 32m の升に分ける
  const B = 32
  const nb = Math.ceil((CELLS * CELL) / B) + 2
  const buckets: number[][] = Array.from({ length: nb * nb }, () => [])
  const sx = new Float32Array(lamps.length)
  const sy = new Float32Array(lamps.length)
  const sz = new Float32Array(lamps.length)
  lamps.forEach((l, i) => {
    sx[i] = l.x
    sy[i] = l.z - LAB
    sz[i] = -l.y
    const bx = Math.floor((sx[i] - ox) / B) + 1
    const bz = Math.floor((sz[i] - oz) / B) + 1
    if (bx < 0 || bz < 0 || bx >= nb || bz >= nb) return
    buckets[bz * nb + bx].push(i)
  })
  const data = new Float32Array(CELLS * SLOTS * CELLS * 4)
  const score = new Float32Array(SLOTS)
  const pick = new Int32Array(SLOTS)
  let used = 0
  for (let cz = 0; cz < CELLS; cz++) {
    if (cz % 32 === 31) yield
    for (let cx = 0; cx < CELLS; cx++) {
      const px = ox + (cx + 0.5) * CELL
      const pz = oz + (cz + 0.5) * CELL
      let n = 0
      const bx = Math.floor((px - ox) / B) + 1
      const bz = Math.floor((pz - oz) / B) + 1
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = bx + dx
          const zz = bz + dz
          if (xx < 0 || zz < 0 || xx >= nb || zz >= nb) continue
          for (const i of buckets[zz * nb + xx]) {
            const l = lamps[i]
            const R = LAMP_STYLE[l.kind].radius + CELL
            const ddx = sx[i] - px
            const ddz = sz[i] - pz
            const d2 = ddx * ddx + ddz * ddz
            if (d2 > R * R) continue
            const s = (l.power * LAMP_STYLE[l.kind].gain) / (1 + d2 * 0.09) * (1 - Math.min(1, Math.sqrt(d2) / R) ** 2)
            if (n < SLOTS) {
              score[n] = s
              pick[n] = i
              n++
            } else {
              let m = 0
              for (let k = 1; k < SLOTS; k++) if (score[k] < score[m]) m = k
              if (s > score[m]) {
                score[m] = s
                pick[m] = i
              }
            }
          }
        }
      }
      if (n) used++
      const row = (cz * CELLS * SLOTS + cx * SLOTS) * 4
      for (let k = 0; k < n; k++) {
        const i = pick[k]
        const l = lamps[i]
        data[row + k * 4] = sx[i]
        data[row + k * 4 + 1] = sy[i]
        data[row + k * 4 + 2] = sz[i]
        data[row + k * 4 + 3] = l.kind + Math.min(15.99, Math.max(0.01, l.power)) / 16
      }
    }
  }
  cpuTable.data = data
  cpuTable.ox = ox
  cpuTable.oz = oz
  const old = lampUniforms.uLampTable.value
  const tex = new THREE.DataTexture(data, CELLS * SLOTS, CELLS, THREE.RGBAFormat, THREE.FloatType)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  lampUniforms.uLampTable.value = tex
  lampUniforms.uLampInfo.value.set(ox, oz, CELL, 1)
  old?.dispose()
  return { ms: performance.now() - t0, cells: used, lamps: lamps.length }
}

/** 表の CPU の写し（花音を照らす灯りを選ぶ。lampNear） */
const cpuTable = { data: null as Float32Array | null, ox: 0, oz: 0 }

/** lampNear が選んだ灯りの種類（LAMP。選べなかったら 0） */
export const lampNearInfo = { kind: 0 as LampKind | 0 }

/**
 * シーンの点 (x, y, z) をいちばん明るく照らす町の灯り（表の升の灯りのうち、今の点き具合・強さ・距離で。点いていなければ null）。
 * 夜に町の中を歩く花音の灯り（outdoorLighting.ts の updateLamp）が使う。out に灯りの位置を入れ、照らす強さ（0〜）を返す（種類は lampNearInfo）
 */
export function lampNear(x: number, y: number, z: number, out: THREE.Vector3): number {
  lampNearInfo.kind = 0
  const d = cpuTable.data
  if (!d || lampUniforms.uLampAny.value < 0.5) return 0
  const cx = Math.floor((x - cpuTable.ox) / CELL)
  const cz = Math.floor((z - cpuTable.oz) / CELL)
  if (cx < 0 || cz < 0 || cx >= CELLS || cz >= CELLS) return 0
  const row = (cz * CELLS * SLOTS + cx * SLOTS) * 4
  let best = 0
  for (let k = 0; k < SLOTS; k++) {
    const w = d[row + k * 4 + 3]
    if (w <= 0) break
    const kind = Math.floor(w)
    const kk = lampKinds[kind]
    const on = kk ? Math.max(kk.x, kk.y, kk.z) : 0
    if (on < 1e-4) continue
    const power = (w - kind) * 16
    const dx = d[row + k * 4] - x
    const dy = d[row + k * 4 + 1] - y
    const dz = d[row + k * 4 + 2] - z
    const d2 = dx * dx + dy * dy + dz * dz
    const R = kk.w
    if (d2 > R * R) continue
    const s = (on * power) / (1 + d2 * 0.09)
    if (s > best) {
      best = s
      out.set(d[row + k * 4], d[row + k * 4 + 1], d[row + k * 4 + 2])
      lampNearInfo.kind = kind as LampKind
    }
  }
  return best
}

/**
 * シーンの点 (x, y, z) を照らす町の灯りの照度の和（表の升の灯りの全部。色 × 点き具合 × 強さ ÷ 距離の減衰 × 届く距離の縁の消え。面の向きは見ない）。
 * 使う側が人物に町の灯りの色を乗せるのに使う（kanon-lab のアニメ塗りの花音）。out に照度の色（リニア）、dir に灯りの向きの照度の重みの和（点から灯りへ。
 * 単位にする）を入れ、照度の明るさ（輝度）を返す。灯りが点いていない・表の外なら 0
 */
export function lampLightAt(x: number, y: number, z: number, out: THREE.Vector3, dir: THREE.Vector3): number {
  out.set(0, 0, 0)
  dir.set(0, 1, 0)
  const d = cpuTable.data
  if (!d || lampUniforms.uLampAny.value < 0.5) return 0
  const cx = Math.floor((x - cpuTable.ox) / CELL)
  const cz = Math.floor((z - cpuTable.oz) / CELL)
  if (cx < 0 || cz < 0 || cx >= CELLS || cz >= CELLS) return 0
  const row = (cz * CELLS * SLOTS + cx * SLOTS) * 4
  let wx = 0
  let wy = 0
  let wz = 0
  for (let k = 0; k < SLOTS; k++) {
    const w = d[row + k * 4 + 3]
    if (w <= 0) break
    const kind = Math.floor(w)
    const kk = lampKinds[kind]
    if (!kk || Math.max(kk.x, kk.y, kk.z) < 1e-6) continue
    const power = (w - kind) * 16
    const dx = d[row + k * 4] - x
    const dy = d[row + k * 4 + 1] - y
    const dz = d[row + k * 4 + 2] - z
    const d2 = dx * dx + dy * dy + dz * dz
    const R = kk.w
    if (d2 > R * R) continue
    const dist = Math.sqrt(d2)
    const edge = 1 - THREE.MathUtils.smoothstep(dist, R * 0.45, R)
    const att = (power / (1 + d2 * 0.09)) * edge
    out.x += kk.x * att
    out.y += kk.y * att
    out.z += kk.z * att
    const lum = (kk.x * 0.2126 + kk.y * 0.7152 + kk.z * 0.0722) * att
    const inv = 1 / Math.max(dist, 1e-3)
    wx += dx * inv * lum
    wy += dy * inv * lum
    wz += dz * inv * lum
  }
  const len = Math.hypot(wx, wy, wz)
  if (len > 1e-6) dir.set(wx / len, wy / len, wz / len)
  return out.x * 0.2126 + out.y * 0.7152 + out.z * 0.0722
}

/** カメラからの距離でうすめる範囲（m）。配信（high）は窓から見える近くの斜面まで、撮影（film）は町の中の画のため遠くまで */
export function setLampFade(from: number, to: number) {
  lampUniforms.uLampFade.value.set(from, to)
}

/** 毎コマ: 種類ごとの色 × 点き具合（時刻の表）× 強さ */
export function updateLampUniforms() {
  const o = outdoor
  const on: Record<LampKind, number> = {
    [LAMP.street]: o.lights.street,
    [LAMP.lantern]: o.lights.path,
    [LAMP.foot]: o.lights.path,
    [LAMP.port]: o.lights.port,
    [LAMP.shop]: o.lights.shop,
    [LAMP.named]: o.lights.path,
    [LAMP.stop]: o.lights.street,
  }
  const k = lampKinds
  lampUniforms.uLampAny.value = Math.max(...Object.values(on)) * o.lightGain > 0.002 ? 1 : 0
  for (const [id, st] of Object.entries(LAMP_STYLE)) {
    const i = Number(id) as LampKind
    _c.set(st.color).multiplyScalar(st.gain * on[i] * o.lightGain)
    k[i]!.set(_c.r, _c.g, _c.b, st.radius)
  }
}
