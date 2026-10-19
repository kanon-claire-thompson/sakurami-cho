import * as THREE from 'three/webgpu'
import { Fn, abs, atan, cameraPosition, clamp, cross, dot, exp, float, floor, fract, fwidth, length, max, min, mix, normalize, pow, reflect, select, sin, smoothstep, sqrt, step, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { SITE } from '../../core/town'
import type { Outdoor } from '../environment/daylight'
import { fbm, oNoise, outdoorUniforms, skyColorBase } from '../outdoor/materials'
import type { OutdoorPaint, PaintSurface } from '../outdoor/paint'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>
type V3 = Node<'vec3'>

/**
 * 町のアニメ塗り（scene/anime/。既定の塗り。?paint=real で前の見た目）: 地図（sakurami-cho）の外の塗りの口（world/outdoor/paint.ts の OutdoorPaint）に入れる式と、
 * 町の時刻の配色の表（TOWN_TIMES）。src/townBinding.ts が町の材質を作る前に入れ、LabAnime.tsx が毎コマ時刻の配色を書く（updateTownPaint）。
 *
 * ラボの塗り（material.ts）は「画面の色」で書くが、町は前と同じく太陽・空の光（地図の outdoorUniforms。時刻で連続に変わる）を元にした HDR の色のまま
 * （外へ出たときの自動露出・ラボの窓からの明るさの釣り合いが前と同じになるように）、それを次のように描き替える:
 * - 光: 光の当たる側（太陽の光 × keyGain + 空の光 × skyGain。夜は月の光）と、影（光の当たる側 × shade の色。青紫・藍）の 2 段。境目は面の向きと
 *   町の太陽の影の地図（物が落とす影）で、くっきり分ける。木は 3 段（影・中間・光）。面の色は彩度を上げる（sat）
 * - 空: 前の空の色を高さの帯（BANDS 段）で塗り分け、雲は形のはっきりした塊（光の当たる側と影の 2 段、夕方は縁が金）、太陽と月は平らな円
 * - 空気遠近: 遠いほど地平線の空の色へ（前より少し強く・淡い色）
 * - 窓: 昼は空の色の平らなガラスに斜めのハイライトの帯、夜は点いた窓が平らな暖色・消えた窓は紺
 * - 水: 平らな水の色と、空の帯の映り、形の決まったハイライトの帯（反射の計算はしない）
 * - 滝（ガーデンドーム）: 縦の流れの帯（3 段の青）と形の決まった白いハイライト（口の縁・縦の帯・滝つぼの泡）。しぶきは白い塊、霧はやわらかい粒（fall・particle）
 * - 灯り: 街灯などが面を照らす光を 2 段の光だまり（形のあるにじみ）、光の点は芯と控えめな平らな輪
 * - 中のある建物の中: 照度を部屋のまわりの明るさを基準に 2 段（光の色は残す）
 * 町の灯りの色・窓明かりは地図の色のまま（街灯は暖色。シアンはラボだけ・夜に緑に光るのはドームとラボの Qコアだけ、の設定を変えない）
 */

/** 町の時刻の配色の名前（朝夕は dawn・dusk、日没のあとの群青の時間は blue（宵）） */
export type TownTimeName = 'day' | 'dawn' | 'dusk' | 'blue' | 'night' | 'deep'

/** 町の時刻の配色の 1 行（色は倍率。'#ffffff' = そのまま） */
export interface TownTime {
  /** 光の当たる側の色と、太陽の光・空の光の掛け方 */
  key: string
  keyGain: number
  skyGain: number
  /** 影の色（光の当たる側に掛ける。青紫・藍）と、影の色の彩度（1 = そのまま。宵・夜の影の側の壁が彩度の高い青紫一色にならないように） */
  shade: string
  shadeSat: number
  /** 夜の月の光（空の光に対する倍率） */
  moon: number
  /** 面の色の彩度（1 = そのまま） */
  sat: number
  /** 空の色に掛ける色・空の彩度 */
  sky: string
  skySat: number
  /** 雲の光の当たる側・影の色（前の雲の色に掛ける）・縁の金の強さ */
  cloudLit: string
  cloudShade: string
  cloudRim: number
  /** 空気遠近の色（前の色に掛ける）と、溶け込む距離の倍率（小さいほど強い） */
  haze: string
  hazeK: number
  /** 昼の窓のガラスの色（空の色に掛ける）・夜の消えた窓（空の光に掛ける）・点いた窓の明るさ */
  glass: string
  dark: string
  windowLit: number
  /** 水の色に掛ける色・ハイライトの帯の強さ */
  water: string
  waterBand: number
}

/**
 * 町の時刻の配色の表（仮の決め: 2026-10-19。設定資料 vol2 第 5 章「時間帯と天気による町の色」から）
 * - day   … 昼（太陽 14° より上）。全体に明るく彩度が高い。空は青、影は薄い青紫
 * - dawn  … 早朝（太陽 −7°〜14°、午前）。空は薄い桃色から水色、港は青灰、丘は影
 * - dusk  … 夕方（太陽 −7°〜14°、午後）。空は橙から紫、雲の縁が金、町全体が橙に染まる。影は藍
 * - blue  … 宵（太陽 −16°〜−7°）。空は群青、窓明かりと街灯の琥珀
 * - night … 夜（太陽 −16° より下）。濃紺に星、町の灯りの金
 * - deep  … 深夜（0〜3 時）。漆黒に近い紺、町の灯りはまばら（点く割合は地図の時刻のまま）
 */
export const TOWN_TIMES: Record<TownTimeName, TownTime> = {
  day: {
    key: '#fff8ee', keyGain: 0.82, skyGain: 0.62, shade: '#b4b8e6', shadeSat: 1, moon: 0, sat: 1.25,
    sky: '#f2f6ff', skySat: 1.1, cloudLit: '#ffffff', cloudShade: '#c8cdf0', cloudRim: 0.15,
    haze: '#eef2ff', hazeK: 0.8, glass: '#b4c6e6', dark: '#3a4a7a', windowLit: 0.5, water: '#e8f4ff', waterBand: 0.7,
  },
  dawn: {
    key: '#ffe2d4', keyGain: 0.85, skyGain: 0.7, shade: '#acaee0', shadeSat: 0.95, moon: 0, sat: 1.2,
    sky: '#ffeef4', skySat: 1.12, cloudLit: '#ffe6ee', cloudShade: '#a8a8dc', cloudRim: 0.5,
    haze: '#f4e8f4', hazeK: 0.75, glass: '#c0c4ea', dark: '#3a4278', windowLit: 0.5, water: '#e0e8ff', waterBand: 0.8,
  },
  dusk: {
    key: '#ffc896', keyGain: 0.72, skyGain: 0.68, shade: '#a298d8', shadeSat: 0.95, moon: 0, sat: 1.3,
    sky: '#fff0e6', skySat: 1.15, cloudLit: '#ffd8a8', cloudShade: '#9c84c8', cloudRim: 1.0,
    haze: '#ffe0cc', hazeK: 0.75, glass: '#e8c0b0', dark: '#3c3878', windowLit: 0.55, water: '#ffe4d4', waterBand: 1.0,
  },
  blue: {
    key: '#c8d0ff', keyGain: 0.6, skyGain: 0.9, shade: '#aaaee0', shadeSat: 0.6, moon: 0.6, sat: 1.25,
    sky: '#e8ecff', skySat: 1.15, cloudLit: '#c8b8f0', cloudShade: '#7068b8', cloudRim: 0.4,
    haze: '#c8ccff', hazeK: 0.8, glass: '#8c98d8', dark: '#2a2c6c', windowLit: 0.6, water: '#c8d4ff', waterBand: 0.8,
  },
  night: {
    key: '#c8d4ff', keyGain: 0.3, skyGain: 1.0, shade: '#b0b2e2', shadeSat: 0.55, moon: 1.0, sat: 1.2,
    sky: '#eef0ff', skySat: 1.12, cloudLit: '#b0b8e8', cloudShade: '#5a5ca0', cloudRim: 0.2,
    haze: '#d0d4ff', hazeK: 0.85, glass: '#7880c0', dark: '#20245c', windowLit: 0.6, water: '#c8d0ff', waterBand: 0.6,
  },
  deep: {
    key: '#bcc8ff', keyGain: 0.25, skyGain: 1.0, shade: '#a8a8de', shadeSat: 0.55, moon: 0.9, sat: 1.15,
    sky: '#e4e4ff', skySat: 1.1, cloudLit: '#a0a8e0', cloudShade: '#4c4c94', cloudRim: 0.1,
    haze: '#c8c8f8', hazeK: 0.85, glass: '#6a70b0', dark: '#1a1c50', windowLit: 0.6, water: '#c0c8ff', waterBand: 0.5,
  },
}

/** 空の高さの帯の数 */
const BANDS = 9

const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b)

/** 時刻の配色の重み（足すと 1）。太陽の高さ（度）・午前か・夜中の度合いから */
export function townWeights(o: Pick<Outdoor, 'sun' | 'deepNight' | 'time'>, out: Record<TownTimeName, number>): Record<TownTimeName, number> {
  const alt = o.sun.altitude
  const day = smooth(4, 14, alt)
  const night = 1 - smooth(-16, -9, alt)
  const rest = Math.max(0, 1 - day - night)
  const low = rest * smooth(-7, 1, alt)
  const morning = o.time.hours < 12 ? 1 : 0
  const deep = night * THREE.MathUtils.clamp(o.deepNight, 0, 1)
  out.day = day
  out.dawn = low * morning
  out.dusk = low * (1 - morning)
  out.blue = rest - low
  out.night = night - deep
  out.deep = deep
  return out
}

const vec3u = (v = new THREE.Vector3(1, 1, 1)) => uniform(v)

/** 町の塗りの式が読む値（updateTownPaint が毎コマ書く。色はリニアの倍率） */
export const townPaintUniforms = {
  key: vec3u(),
  keyGain: uniform(0.8),
  skyGain: uniform(0.65),
  shade: vec3u(new THREE.Vector3(0.6, 0.6, 0.8)),
  shadeSat: uniform(1),
  moon: uniform(0),
  sat: uniform(1.2),
  sky: vec3u(),
  skySat: uniform(1.2),
  cloudLit: vec3u(),
  cloudShade: vec3u(),
  cloudRim: uniform(0.2),
  haze: vec3u(),
  hazeK: uniform(0.8),
  glass: vec3u(),
  dark: vec3u(),
  windowLit: uniform(1),
  water: vec3u(),
  waterBand: uniform(0.7),
  /** 月の向き（世界の座標）・満ち欠け（0 = 新月・0.5 = 満月）・夜の度合い（月を見せる） */
  moonDir: vec3u(new THREE.Vector3(0, 0.5, 0.86)),
  moonPhase: uniform(0.5),
  moonShow: uniform(0),
  /** 光と影の境目（N·L）・境目のなめらかさ（半分の幅） */
  threshold: uniform(0.02),
  softness: uniform(0.02),
}

const _c = new THREE.Color()
const lin = (hex: string) => (_c.set(hex), new THREE.Vector3(_c.r, _c.g, _c.b))
/** 表の色をリニアにして持つ（毎コマ文字列を読まない） */
const TABLE = Object.fromEntries(
  Object.entries(TOWN_TIMES).map(([k, t]) => [
    k,
    {
      ...t,
      keyV: lin(t.key),
      shadeV: lin(t.shade),
      skyV: lin(t.sky),
      cloudLitV: lin(t.cloudLit),
      cloudShadeV: lin(t.cloudShade),
      hazeV: lin(t.haze),
      glassV: lin(t.glass),
      darkV: lin(t.dark),
      waterV: lin(t.water),
    },
  ]),
) as Record<TownTimeName, TownTime & Record<'keyV' | 'shadeV' | 'skyV' | 'cloudLitV' | 'cloudShadeV' | 'hazeV' | 'glassV' | 'darkV' | 'waterV', THREE.Vector3>>

/** 天の北極の向き（シーンの座標。北は −z） */
const POLE = new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(SITE.latitude)), -Math.cos(THREE.MathUtils.degToRad(SITE.latitude))).normalize()
/** 新月の基準（2000-01-06 18:14 UTC）と朔望月（日） */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14)
const SYNODIC_DAYS = 29.530588853
const _q = new THREE.Quaternion()

/** 今の重み（確かめる用に LabAnime の __ANIME__ から見える） */
export const townWeightsNow: Record<TownTimeName, number> = { day: 1, dawn: 0, dusk: 0, blue: 0, night: 0, deep: 0 }

/**
 * 毎コマ: 時刻の配色を混ぜて uniform に書き、月の向きと満ち欠けを出す（月は太陽を天の北極のまわりに満ち欠けの分だけ東へ回した向き。
 * 黄道からの外れは見ない、見た目のための近い値）
 */
export function updateTownPaint(o: Outdoor) {
  const w = townWeights(o, townWeightsNow)
  const u = townPaintUniforms
  const acc = {
    key: new THREE.Vector3(), shade: new THREE.Vector3(), sky: new THREE.Vector3(), cloudLit: new THREE.Vector3(), cloudShade: new THREE.Vector3(),
    haze: new THREE.Vector3(), glass: new THREE.Vector3(), dark: new THREE.Vector3(), water: new THREE.Vector3(),
  }
  let shadeSat = 0
  let keyGain = 0, skyGain = 0, moon = 0, sat = 0, skySat = 0, cloudRim = 0, hazeK = 0, windowLit = 0, waterBand = 0
  for (const name of Object.keys(TABLE) as TownTimeName[]) {
    const k = w[name]
    if (k <= 0) continue
    const t = TABLE[name]
    acc.key.addScaledVector(t.keyV, k)
    acc.shade.addScaledVector(t.shadeV, k)
    acc.sky.addScaledVector(t.skyV, k)
    acc.cloudLit.addScaledVector(t.cloudLitV, k)
    acc.cloudShade.addScaledVector(t.cloudShadeV, k)
    acc.haze.addScaledVector(t.hazeV, k)
    acc.glass.addScaledVector(t.glassV, k)
    acc.dark.addScaledVector(t.darkV, k)
    acc.water.addScaledVector(t.waterV, k)
    keyGain += t.keyGain * k
    shadeSat += t.shadeSat * k
    skyGain += t.skyGain * k
    moon += t.moon * k
    sat += t.sat * k
    skySat += t.skySat * k
    cloudRim += t.cloudRim * k
    hazeK += t.hazeK * k
    windowLit += t.windowLit * k
    waterBand += t.waterBand * k
  }
  u.key.value.copy(acc.key)
  u.shade.value.copy(acc.shade)
  u.sky.value.copy(acc.sky)
  u.cloudLit.value.copy(acc.cloudLit)
  u.cloudShade.value.copy(acc.cloudShade)
  u.haze.value.copy(acc.haze)
  u.glass.value.copy(acc.glass)
  u.dark.value.copy(acc.dark)
  u.water.value.copy(acc.water)
  u.keyGain.value = keyGain
  u.shadeSat.value = shadeSat
  u.skyGain.value = skyGain
  u.moon.value = moon
  u.sat.value = sat
  u.skySat.value = skySat
  u.cloudRim.value = cloudRim
  u.hazeK.value = hazeK
  u.windowLit.value = windowLit
  u.waterBand.value = waterBand
  // 月
  const days = (o.time.utcMs - NEW_MOON_MS) / 86400_000
  const phase = (((days / SYNODIC_DAYS) % 1) + 1) % 1
  u.moonPhase.value = phase
  _q.setFromAxisAngle(POLE, -phase * Math.PI * 2)
  u.moonDir.value.copy(o.sunDir).applyQuaternion(_q).normalize()
  u.moonShow.value = THREE.MathUtils.clamp(o.night * 1.2, 0, 1) * THREE.MathUtils.smoothstep(u.moonDir.value.y, -0.02, 0.06)
}

/* -------------------------------------------------------------------------- */
/* 式                                                                           */
/* -------------------------------------------------------------------------- */

const LUMA = vec3(0.2126, 0.7152, 0.0722)
const lum = (c: V3) => dot(c, LUMA)
/** 彩度を k 倍に（明るさは変えない） */
const saturate = (c: V3, k: F) => max(mix(vec3(lum(c)), c, k), vec3(0.0))

/** 光の当たる側の光（太陽か、夜は月）と光の向き */
function keyLight() {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const sunUp = smoothstep(-0.03, 0.05, o.uSunDir.y)
  const dir = normalize(mix(u.moonDir, o.uSunDir, sunUp))
  const amb = o.uSkyLight.mul(u.skyGain)
  const key = mix(o.uSkyLight.mul(u.moon), o.uSunLight.mul(u.keyGain), sunUp).mul(u.key)
  return { sunUp, dir, lit: amb.add(key) }
}

/** 光の式（光の当たる側と影の 2 段。木は 3 段） */
function light(albedo: V3, N: V3, ao: F, sh: F, surface: PaintSurface): V3 {
  const u = townPaintUniforms
  const k = keyLight()
  const a = saturate(albedo, u.sat)
  const ndl = dot(N, k.dir)
  // 物が落とす影は、太陽があるときだけ（夜の太陽の影の地図は地平線の下の向き）
  const shq = mix(float(1.0), smoothstep(0.4, 0.6, sh), k.sunUp)
  const q = smoothstep(u.threshold.sub(u.softness), u.threshold.add(u.softness), ndl).mul(shq)
  const shade = saturate(k.lit.mul(u.shade), u.shadeSat)
  let tone: V3 = mix(shade, k.lit, q)
  if (surface === 'tree' || surface === 'grass') {
    // 木: 影・中間・光の 3 段（樹冠の丸みの法線で、上と光の側が明るい塊）
    const q2 = smoothstep(0.42, 0.48, ndl).mul(shq)
    const mid = mix(shade, k.lit, 0.62)
    tone = mix(shade, mix(mid, k.lit, q2), q)
  }
  // 環境光の遮りは 2 段（通りの底・軒の下が一段暗い）
  const aoq = mix(0.8, 1.0, smoothstep(0.6, 0.7, ao))
  return a.mul(tone).mul(aoq)
}

/** 空気遠近（遠いほど地平線の淡い色へ） */
function haze(col: V3, wp: V3): V3 {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const dv = wp.sub(cameraPosition)
  const d = length(dv)
  const f = exp(d.negate().div(o.uHazeDist.mul(u.hazeK))).oneMinus()
  return mix(col, saturate(o.uHaze.mul(u.haze), float(1.15)), f)
}

/** 空（高さの帯で塗り分けた前の空の色） */
function sky(d: V3): V3 {
  const u = townPaintUniforms
  const h = max(d.y, 0.0)
  const t = pow(h, 0.55).mul(BANDS)
  const tb = floor(t).add(smoothstep(0.7, 1.0, fract(t)))
  const hq = min(pow(tb.div(BANDS), 1 / 0.55), 1.0)
  const xz = normalize(d.xz.add(vec2(1e-5))).mul(sqrt(max(hq.mul(hq).oneMinus(), 0.0)))
  const dq = select(d.y.greaterThan(0.0), vec3(xz.x, hq, xz.y), d)
  return saturate(skyColorBase(dq).mul(u.sky), u.skySat)
}

/** 空の球の雲・太陽・月 */
function skyDome(d: V3, col: V3): V3 {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const out = vec3(col).toVar()
  const cs = dot(d, o.uSunDir)
  const above = smoothstep(-0.02, 0.0, d.y)
  // 太陽: 平らな円（前より大きく、縁はくっきり）と、まわりの平らな輪
  const disc = smoothstep(0.99955, 0.9996, cs)
  const ring = smoothstep(0.9965, 0.997, cs).mul(0.22)
  out.addAssign(o.uSunLight.mul(disc.mul(2.4).add(ring)).mul(above))
  // 雲: 形のはっきりした塊。光の当たる側と影の 2 段（太陽の側の密度と比べる）、太陽の側の縁は金
  const p = d.xz.div(d.y.add(0.12)).mul(1.1).add(vec2(o.uTime.mul(0.0035), o.uTime.mul(0.0012)))
  const n = fbm(p.mul(0.9))
  const edge = o.uCloudCover.oneMinus()
  const c = smoothstep(edge, edge.add(0.012), n).mul(smoothstep(0.015, 0.09, d.y))
  const sxz = normalize(o.uSunDir.xz.add(vec2(1e-5)))
  const n2 = fbm(p.add(sxz.mul(0.22)).mul(0.9))
  const lit = smoothstep(-0.006, 0.006, n.sub(n2))
  const toward = max(cs, 0.0)
  const rim = smoothstep(edge.add(0.012), edge.add(0.05), n).oneMinus().mul(pow(toward, 4.0)).mul(u.cloudRim)
  const litC = o.uCloudLit.mul(u.cloudLit)
  // 日が沈んだあと（太陽 −1°〜−8°で移る）は、雲の色を夜の空の色から作る（光の当たる側は空の色を淡く明るく、影は空の色を暗く）。夕方の雲の色（前の雲の色は
  // 橙）のままだと、宵・夜の雲の縁がこげ茶に見えた。縁の金も日が沈んだら消す
  const nightK = smoothstep(-0.14, -0.02, o.uSunDir.y).oneMinus()
  const litN = mix(col, vec3(lum(col)), 0.35).mul(1.5).add(vec3(0.006, 0.006, 0.01))
  const shadeN = col.mul(0.7)
  const cloudDay = mix(mix(litC, o.uCloudShade.mul(u.cloudShade), 0.6), litC, lit.mul(0.75).add(toward.mul(toward).mul(0.25)))
    .add(o.uCloudLit.mul(u.cloudRim).mul(step(0.5, rim)).mul(0.9).mul(nightK.oneMinus()))
  const cloud = mix(cloudDay, mix(shadeN, litN, lit.mul(0.7).add(0.15)), nightK)
  out.assign(mix(out, cloud, c.mul(0.95)))
  // 月: 平らな円と、満ち欠けの影（月の向きから太陽の側へずらした円で欠かす）
  const mc = dot(d, u.moonDir)
  const r = 0.0215
  const moon = smoothstep(Math.cos(r * 1.04), Math.cos(r), mc)
  const toSun = normalize(o.uSunDir.sub(u.moonDir.mul(dot(o.uSunDir, u.moonDir))).add(vec3(0.0, 1e-4, 0.0)))
  const off = abs(u.moonPhase.mul(2.0).sub(1.0)).oneMinus().mul(r * 2.3)
  const shadowC = normalize(u.moonDir.sub(toSun.mul(off)))
  const dark = smoothstep(Math.cos(r * 1.04), Math.cos(r), dot(d, shadowC))
  const maria = smoothstep(0.55, 0.62, oNoise(d.xz.mul(160.0).add(d.y.mul(90.0)))).mul(0.12)
  const moonCol = vec3(1.0, 0.95, 0.8).mul(float(0.9).sub(maria)).mul(mix(1.0, 0.08, dark))
  out.assign(mix(out, moonCol.mul(1.6), moon.mul(u.moonShow).mul(above)))
  return out
}

/** 窓（平らな色。昼は空の色のガラスと斜めのハイライトの帯、夜は点いた窓の暖色・消えた窓の紺）。shop = 1 階の店の正面のガラスなら shopGlass */
function windowGlass(lit: F, lamp: V3, N: V3, V: V3, cell: Node<'vec2'>, shop?: F): V3 {
  const plain = plainWindow(lit, lamp, N, V, cell)
  return shop ? select(shop.greaterThan(0.5), shopGlass(lit, lamp, cell), plain) : plain
}

const hash2 = (p: Node<'vec2'>) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453))

/**
 * |d| ≤ h なら 1 の帯を、1 画素の幅（fw = その座標の fwidth）の箱で平均した覆う割合（0〜1）。窓・店のガラスの模様の線と棚の段に使う。
 * 前は step で切っていたので、線・段が画素より細くなる所（数 m 先から）で画素の間に落ちたり乗ったりして、カメラが動くとチカチカした
 */
function cover(d: F, h: F | number, fw: F): F {
  const r = max(fw.mul(0.6), 1e-5)
  const hh = typeof h === 'number' ? float(h) : h
  return clamp(min(d.add(r), hh).sub(max(d.sub(r), hh.negate())), 0.0, r.mul(2.0)).div(r.mul(2.0))
}

/** 棚の品物の色の平均（itemC の割合で重みを付けた色。遠くで品物の升が画素より小さくなったら、これにする） */
const ITEM_AVG = vec3(0.494, 0.395, 0.328)

/**
 * 店の正面のガラス（ショーウィンドウと扉）: 前は窓と同じ平らな 1 色（点いていればクリーム色の板）で、ガラスにも店にも見えなかった。ここでは
 * - 中: 奥の壁（点いていれば灯りの暖色。上ほど明るい）と、棚の段に並んだ品物の形（暗い暖色と、ところどころ色の付いた品物）・天井の灯り（白に近い丸）。
 *   消えていれば紺のガラスの奥に棚の形がうっすら
 * - 扉: 真ん中のガラスの戸（枠の線と取っ手。中は同じく見える）
 * - ガラス: 平らな色を薄く重ね、形の決まった斜めのハイライトの帯 2 本（夜は弱く）
 * 線・段・品物の縁は 1 画素の幅で平均し（cover）、品物の升（横 16・縦 7）が画素の 3 分の 1 くらいより小さくなる遠くでは、棚と品物を平均の色へ移す
 * （升ごとの乱数の色は平均できないので）。前は全部 step で切っていて、遠くの店先が細かい色の点の砂嵐になり、カメラが動くとチカチカした
 */
const shopGlassFn = Fn(([lit, lamp, cell]: [F, V3, Node<'vec2'>]) => {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const x = cell.x
  const y = cell.y
  const fw = max(fwidth(cell), vec2(1e-5)).toVar()
  // 品物の升の細かさ（1 = 升が画素より十分大きい。0 = 平均の色）
  const detail = smoothstep(0.6, 0.25, max(fw.x.mul(16.0), fw.y.mul(7.0))).toVar()
  const on = clamp01(lit)
  const hue = saturate(lamp.div(max(max(lamp.x, lamp.y), max(lamp.z, 1e-4))), float(1.2))
  const sky = mix(o.uHorizon, o.uMid, 0.5)
  const glass = mix(sky.mul(u.glass).mul(0.5), saturate(sky.mul(0.7).add(0.012).mul(u.dark), float(0.6)), smoothstep(0.2, 0.8, o.uNight)).toVar()
  // 奥の壁（点いていれば暖色。上ほど明るい 2 段）
  const back = hue.mul(u.windowLit).mul(mix(0.75, 1.0, cover(y.sub(0.81), 0.19, fw.y))).toVar()
  // 棚の段（3 段）と品物
  const ry = y.mul(7.0)
  const fry = fract(ry)
  const row = floor(ry).toVar()
  const shelfZone = cover(abs(y.sub(0.32)), 0.24, fw.y).toVar()
  // 板: 段の下 0.12（段の境 0 をまたぐ帯）。品物: 段の 0.12〜0.8
  const board = mix(float(0.12), cover(abs(fract(ry.sub(0.06).add(0.5)).sub(0.5)), 0.06, fw.y.mul(7.0)), detail).mul(shelfZone)
  const itemRow = cover(abs(fry.sub(0.46)), 0.34, fw.y.mul(7.0))
  const item = mix(float(0.44), step(0.35, hash2(vec2(floor(x.mul(16.0)), row))).mul(itemRow), detail).mul(shelfZone).toVar()
  const ih = hash2(vec2(floor(x.mul(16.0)).add(7.0), row.add(3.0)))
  const itemC = mix(ITEM_AVG, select(ih.lessThan(0.18), vec3(0.9, 0.35, 0.25), select(ih.lessThan(0.32), vec3(0.35, 0.7, 0.45), select(ih.lessThan(0.44), vec3(0.4, 0.55, 0.9), vec3(0.42, 0.3, 0.2)))), detail)
  // 天井の灯り（丸い白に近い灯り。遠くでは消す）
  const pend = cover(length(vec2(fract(x.mul(3.0)).sub(0.5).mul(1.6), y.sub(0.86))), 0.07, max(fw.x.mul(4.8), fw.y)).mul(detail)
  const roomLit = mix(mix(back, hue.mul(u.windowLit).mul(0.42), board), itemC.mul(hue).mul(u.windowLit).mul(0.8), item).add(hue.mul(pend).mul(1.4)).toVar()
  // 消えた店: ガラスの色の奥に棚の形がうっすら
  const roomOff = mix(glass, glass.mul(0.55), max(board, item.mul(0.7)))
  const room = mix(roomOff, mix(roomLit, glass, 0.12), on).toVar()
  // 扉（真ん中のガラスの戸）: 枠の線・取っ手
  const below = cover(abs(y.sub(0.465)), 0.465, fw.y)
  const door = cover(abs(x.sub(0.5)), 0.1, fw.x).mul(below).toVar()
  const frame = max(cover(abs(abs(x.sub(0.5)).sub(0.1)), 0.012, fw.x).mul(below), cover(abs(y.sub(0.93)), 0.012, fw.y).mul(cover(abs(x.sub(0.5)), 0.112, fw.x)))
  const handle = cover(abs(x.sub(0.575)), 0.006, fw.x).mul(cover(abs(y.sub(0.46)), 0.07, fw.y))
  room.assign(mix(room, room.mul(0.82), door))
  // 斜めのハイライトの帯（形の決まった 2 本。夜は弱く）
  const d = x.mul(2.2).add(y.mul(0.9))
  const fwd = fw.x.mul(1.1).add(fw.y.mul(0.45))
  const band = cover(abs(fract(d.mul(0.5).add(0.1)).sub(0.5)), 0.05, fwd).add(cover(abs(fract(d.mul(0.5).add(0.24)).sub(0.5)), 0.016, fwd))
  const hl = o.uSkyLight.mul(0.6).add(o.uSunLight.mul(0.1)).mul(u.glass).mul(o.uNight.mul(-0.6).add(1.0))
  const col = room.add(hl.mul(band)).toVar()
  const metal = vec3(0.07, 0.07, 0.075).mul(o.uSkyLight.mul(1.2).add(o.uSunLight.mul(0.15))).add(hue.mul(on).mul(0.04))
  col.assign(mix(col, metal, max(frame, handle)))
  return col
})
const shopGlass = (lit: F, lamp: V3, cell: Node<'vec2'>): V3 => shopGlassFn(lit, lamp, cell) as unknown as V3

/** 窓（店でない窓）。斜めのハイライトの帯は 1 画素の幅で平均する（cover） */
function plainWindow(lit: F, lamp: V3, _N: V3, _V: V3, cell: Node<'vec2'>): V3 {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const glassDay = mix(o.uHorizon, o.uMid, 0.5).mul(u.glass).mul(0.55)
  const x = cell.x.add(cell.y.mul(0.65))
  const fw = max(fwidth(cell), vec2(1e-5))
  const fwx = fw.x.add(fw.y.mul(0.65)).mul(0.8)
  const band = cover(abs(fract(x.mul(0.8).add(0.1)).sub(0.5)), 0.08, fwx).add(cover(abs(fract(x.mul(0.8).add(0.27)).sub(0.5)), 0.025, fwx))
  const day = glassDay.mul(band.mul(0.9).add(1.0))
  const dark = mix(o.uHorizon, o.uMid, 0.5).mul(0.7).add(0.012).mul(u.dark)
  const glass = mix(day, dark, smoothstep(0.2, 0.8, o.uNight))
  // 点いた窓: 灯りの色味（いちばん強い成分を 1 にして彩度を上げる）× 明るさ
  const hue = saturate(lamp.div(max(max(lamp.x, lamp.y), max(lamp.z, 1e-4))), float(1.3))
  return mix(glass, hue.mul(u.windowLit), clamp01(lit))
}
const clamp01 = (x: F) => min(max(x, 0.0), 1.0)

/** 水面（平らな水の色・空の帯の映り・形の決まったハイライトの帯） */
function water(_N: V3, V: V3, wp: V3, sea: boolean, lamps: V3): V3 {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const tint = sea ? vec3(1.0) : vec3(0.8, 1.15, 0.9)
  const body = o.uWater.mul(tint).mul(o.uSkyLight.mul(0.9).add(o.uSunLight.mul(0.18))).mul(u.water)
  // 映り: 平らな水面の向きで、浅い角度ほど空の帯
  const up = vec3(0.0, 1.0, 0.0)
  const R = reflect(V.negate(), up)
  const graze = smoothstep(0.84, 0.86, V.y.oneMinus()).mul(0.3).add(smoothstep(0.95, 0.96, V.y.oneMinus()).mul(0.25)).add(0.3)
  const refl = sky(normalize(vec3(R.x, max(R.y, 0.02), R.z))).mul(o.uNight.mul(sea ? -0.45 : -0.68).add(1.0))
  const col = mix(body, refl, graze).toVar()
  // ハイライトの帯: カメラからの距離の輪（画面では横に細長いさざ波の帯。ゆっくり流れる）
  const rel = wp.xz.sub(cameraPosition.xz)
  const along = length(rel)
  const across = atan(rel.y, rel.x).mul(along)
  const t = o.uTime
  const s = oNoise(vec2(along.mul(0.55), across.mul(0.05).add(t.mul(0.04))))
  const band = step(0.84, s).mul(smoothstep(900.0, 300.0, length(wp.sub(cameraPosition)))).mul(smoothstep(0.55, 0.8, V.y.oneMinus()))
  const hl = o.uSkyLight.mul(1.1).add(o.uSunLight.mul(0.25))
  col.addAssign(hl.mul(band).mul(u.waterBand).mul(0.45))
  // 太陽の道（夕方は橙）: 太陽の映る向きの近くだけ、帯の切れ目で
  const sunPath = smoothstep(0.972, 0.976, dot(R, o.uSunDir)).mul(step(0.55, s)).mul(smoothstep(-0.02, 0.04, o.uSunDir.y))
  col.addAssign(o.uSunLight.mul(sunPath).mul(1.3))
  // 灯りの映り: 形のある筋（明るさを 2 段に）
  const ll = lum(lamps)
  const lampQ = lamps.div(max(ll, 1e-4)).mul(step(0.25, ll).mul(0.5).add(step(1.0, ll).mul(0.7)))
  col.addAssign(lampQ)
  return col
}

/**
 * 灯りが面を照らす強さ: 光だまりの 2 段。前は 2 段とも縁がくっきりした大きな円（芯 5m・外 11m）で、港の壁に大きな円の 2 段が硬く出た。
 * 芯 3.5m・中 6.5m ほどの控えめな大きさにし、境目は少しやわらかく、外にごくうすい 3 段目（11m。通りの地面が暗く沈まないように）
 */
function lampFalloff(att: F, power: F): F {
  const a = att.div(max(power, 1e-4))
  return power.mul(smoothstep(0.4, 0.55, a).mul(0.26).add(smoothstep(0.15, 0.26, a).mul(0.12)).add(smoothstep(0.06, 0.11, a).mul(0.07)))
}

/**
 * 灯りが照らした面の色: 面の色の彩度を少し落とし、暗い色は少し持ち上げてから照度を掛ける（灯りの暖色が乗る程度に。前の albedo × 照度は、
 * 煉瓦の壁で深い赤の大きな円のしみになった）
 */
function lampLight(albedo: V3, E: V3): V3 {
  return mix(albedo, vec3(max(lum(albedo), 0.12)), 0.45).mul(E)
}

/**
 * 光の点: 平らな芯と控えめな平らな輪。縁は 1 画素の幅でなめらかに（fwidth）。芯の半径が 1.6 画素より小さい遠くの灯りは、芯を 1.6 画素に広げて
 * そのぶん暗くする（光の量は同じ）。前は遠くの灯りの芯が直径 2 画素の明るい（2.2 倍）円で、画素の真ん中に乗るかで 1〜4 画素に変わり、
 * トーンマッピングと bloom の閾値で明るさの和まで変わって、窓・丘から見る町の夜景が、カメラが少し動くだけで細かくまたたいた
 */
function glow(r: F, core: F): F {
  const ringR = min(core.mul(2.4), 0.95)
  const fw = max(fwidth(r), 1e-4)
  const c = max(core, fw.mul(1.6))
  const k = core.div(c).pow(2.0)
  const w = max(fw.mul(0.75), c.mul(0.075))
  const w2 = max(fw.mul(0.75), 0.02)
  return smoothstep(c.add(w), c.sub(w), r).mul(k.mul(2.2)).add(smoothstep(ringR.add(w2), ringR.sub(w2), r).mul(0.14))
}

/** 中のある建物の中: 照度を部屋のまわりの明るさを基準に 2 段（光の色は残す） */
function interior(albedo: V3, E: V3, amb: V3, _N: V3, ao: F): V3 {
  const u = townPaintUniforms
  const lE = lum(E)
  const lA = max(lum(amb), 1e-5)
  // 光の色味: 照度を明るさで割る（青い光は明るさの重みが小さいので、割ると青がとても強くなる。いちばん強い成分の 6 割より小さく割らない。
  // 前は宵のゴンドラの中の空の光で、枠が濃い青になった）
  const hue = E.div(max(max(lE, max(max(E.x, E.y), E.z).mul(0.6)), 1e-5))
  const q = smoothstep(1.3, 1.45, lE.div(lA))
  // 平らな 2 段に、照度そのものを少しだけ足す（灯りの近くと部屋の奥の差を少し残す。暗い店の中が真っ暗にならないように）
  const shade = hue.mul(lA.mul(1.4).add(lE.mul(0.4))).mul(u.shade.mul(0.35).add(0.65))
  const lit = hue.mul(lA.mul(2.6).add(lE.mul(0.4)))
  const aoq = mix(0.8, 1.0, smoothstep(0.6, 0.7, ao))
  return saturate(albedo, u.sat).mul(mix(shade, lit, q)).mul(aoq)
}

/**
 * 光る物の色（看板の文字・灯具・信号・前照灯・行き先の表示・LED・ネオン・ドームの葉脈・灯台の光の帯）: 色味は少し鮮やかに、明るさは膝（EMIT_KNEE）から上を
 * なだらかに抑える（にじみ（Bloom）のしきい値を大きく越えない。光る形は平らな色のまま見える）
 */
const EMIT_KNEE = 0.9
const emitFn = Fn(([col]: [V3]) => {
  const l = lum(col).toVar()
  const hue = col.div(max(l, 1e-5))
  const k = select(l.greaterThan(EMIT_KNEE), l.sub(EMIT_KNEE).mul(0.3).add(EMIT_KNEE), l)
  return saturate(hue, float(1.15)).mul(k)
})
// 式は関数にして呼ぶ（大きな材質の式で何度も呼ぶので、式を毎回並べない）
const emit = (col: V3): V3 => emitFn(col) as unknown as V3

/**
 * 透けるガラス（乗り物の窓・ショーウィンドウ・扉・温室のガラス）: 窓と同じ平らなガラスの色（昼は空の色・夜は紺）に向こうの灯り、
 * 面に沿った斜めのハイライトの帯 2 本（形が決まっている。帯の所は少し濃く）。浅い角度は 1 段濃く
 */
const glassFn = Fn(([N, V, wp, room]: [V3, V3, V3, V3]) => {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const sky = mix(o.uHorizon, o.uMid, 0.5)
  const day = sky.mul(u.glass).mul(0.55)
  // 夜のガラスは彩度を落とす（消えた窓の紺のままだと、乗り物の窓・ゴンドラのガラスが濃い青の板に見えた）
  const night = saturate(sky.mul(0.7).add(0.012).mul(u.dark), float(0.45))
  const base = mix(day, night, smoothstep(0.2, 0.8, o.uNight)).add(room.mul(0.35))
  // 面に沿った座標（水平の向き T と高さ）で斜めの帯
  const T = normalize(cross(vec3(0.0, 1.0, 0.0), N).add(vec3(1e-4, 0.0, 0.0)))
  const x = dot(wp, T).add(wp.y.mul(0.65))
  // 帯は細く（前は 0.4m と 0.13m の太い帯で、ゴンドラの中から見ると窓いっぱいの斜めの帯になった）
  const band = step(abs(fract(x.mul(0.35).add(0.1)).sub(0.5)), 0.03).add(step(abs(fract(x.mul(0.35).add(0.27)).sub(0.5)), 0.01))
  const hl = o.uSkyLight.mul(0.5).add(o.uSunLight.mul(0.08)).mul(u.glass)
  const col = base.add(hl.mul(band).mul(o.uNight.mul(-0.7).add(1.0)))
  const graze = step(abs(dot(N, V)), 0.3)
  // うすく（向こうの物・中の花音が見えるように）。帯の所と浅い角度だけ濃く
  const a = float(0.18).add(band.mul(0.2)).add(graze.mul(0.2))
  return vec4(col, min(a, 0.85))
})
const glass = (N: V3, V: V3, wp: V3, room: V3): Node<'vec4'> => glassFn(N, V, wp, room) as unknown as Node<'vec4'>

/**
 * 滝（ガーデンドームの大滝「天の水」・回廊の細い滝）: アニメの滝。前の flat の筋（縦横のどちらにも丸い値のノイズを 2 段で切った物）は、白とグレーの
 * まだら（迷彩柄）に見えた。ここでは:
 * - 縦の流れの帯: 横の位置で決まる帯（横に細かく・縦にとても長い値のノイズ。縦は横の 40 倍に引き伸ばす）を下へ流し、水の色・明るい水の 2 段に塗り分ける
 * - 形の決まった白いハイライト: 上の口の白い縁・縦の白い帯 3 本（少しだけ揺れる）・下の滝つぼの白い泡（縁はぎざぎざの形で、上下に少し揺れる）
 * - 不透明に近く（裏の岩が透けてグレーにならない）。幕の左右の縁だけ、くっきり切る
 */
const fallFn = Fn(([u, v, L, t, light]: [F, F, F, F, V3]) => {
  const y = v.mul(L).toVar()
  // 落ちるほど速い流れ（下へ）
  const flow = y.mul(0.03).sub(t.mul(v.mul(0.9).add(0.55)).mul(0.45)).toVar()
  const band = oNoise(vec2(u.mul(26.0), flow)).mul(0.7).add(oNoise(vec2(u.mul(61.0).add(5.0), flow.mul(1.7))).mul(0.3)).toVar()
  // 3 段の水の色（暗い筋・水・明るい筋）
  const lightBand = step(0.56, band)
  const darkBand = step(band, 0.36)
  // 縦の白い帯（決まった 3 本。上から下へ少し揺れる）
  const wob = oNoise(vec2(y.mul(0.08).sub(t.mul(0.6)), 3.0)).sub(0.5).mul(0.03)
  const hu = u.add(wob)
  const hl = step(abs(hu.sub(0.27)), 0.012).add(step(abs(hu.sub(0.55)), 0.018)).add(step(abs(hu.sub(0.79)), 0.01)).mul(step(0.05, v))
  // 上の口の白い縁と、下の滝つぼの白い泡（ぎざぎざの縁）
  const lip = step(v, 0.025)
  const foamEdge = float(0.88).sub(oNoise(vec2(u.mul(14.0), t.mul(1.3))).mul(0.08))
  const foam = step(foamEdge, v)
  const white = min(hl.add(lip).add(foam), 1.0)
  const dark = vec3(0.2, 0.4, 0.62)
  const water = vec3(0.34, 0.56, 0.76)
  const bright = vec3(0.66, 0.83, 0.94)
  const col = mix(mix(mix(water, dark, darkBand), bright, lightBand), vec3(0.97, 0.99, 1.0), white).mul(light)
  // 幕の左右の縁は、流れに沿ってぎざぎざに切る（四角い板に見えないように）
  const rag = oNoise(vec2(flow.mul(2.0), 11.0)).mul(0.05)
  const edge = step(rag.add(0.015), u).mul(step(u, float(0.985).sub(rag)))
  const a = mix(float(0.8), float(0.95), max(white, lightBand.mul(0.6))).mul(edge).mul(smoothstep(0.0, 0.02, v))
  return vec4(col, a)
})
const fall = (u: F, v: F, L: F, t: F, light: V3): Node<'vec4'> => fallFn(u, v, L, t, light) as unknown as Node<'vec4'>

/**
 * 霧・しぶきの粒の形: しぶきは縁のくっきりした白い塊（ほぼ不透明。芯を一段明るく見せる 2 段）、霧はやわらかくうすい粒（重なっても、くっきりした丸の
 * まだらにならない）
 */
const particle = (r2: F, spray: F): F => {
  const splash = smoothstep(0.62, 0.68, r2).oneMinus().mul(0.75).add(smoothstep(0.2, 0.26, r2).oneMinus().mul(0.2))
  const haze = r2.oneMinus().mul(r2.oneMinus()).mul(0.45)
  return mix(haze, splash, spray)
}

/** 町のアニメ塗り（地図の外の塗りの口に入れる物） */
export const TOWN_PAINT: OutdoorPaint = {
  light,
  haze,
  sky,
  skyDome,
  window: windowGlass,
  water,
  lampFalloff,
  lampLight,
  glow,
  interior,
  emit,
  glass,
  fall,
  particle,
  flat: true,
}

/* -------------------------------------------------------------------------- */
/* ラボの外の KB-001 の配色（LabAnime.tsx が毎コマ読む）                              */
/* -------------------------------------------------------------------------- */

const ACES_IN = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777)
const ACES_OUT = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602)
const rrt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081)

/** three の ACES のトーンマッピング（CPU。material.ts の inverseAces の逆向き）: HDR のリニア → 画面のリニア */
export function acesDisplay(c: THREE.Vector3, exposure: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(c).multiplyScalar(exposure / 0.6).applyMatrix3(ACES_IN)
  out.set(rrt(out.x), rrt(out.y), rrt(out.z)).applyMatrix3(ACES_OUT)
  return out.set(THREE.MathUtils.clamp(out.x, 0, 1), THREE.MathUtils.clamp(out.y, 0, 1), THREE.MathUtils.clamp(out.z, 0, 1))
}

const _lit = new THREE.Vector3()
const _sun = new THREE.Vector3()
const _sky = new THREE.Vector3()
const _sh = new THREE.Vector3()

/**
 * 町の光の当たる側と影の色（画面のリニア。露出とトーンマッピングのあと）と光の向き: 町の塗りの光の式（keyLight・light）と同じ値を CPU で出す。
 * ラボの塗りの素材（material.ts。画面の色で書く）を外で町に合わせるのに使う（KB-001）
 */
export function townKeyDisplay(exposure: number, key: THREE.Vector3, shade: THREE.Vector3, dir: THREE.Vector3) {
  const o = outdoorUniforms
  const u = townPaintUniforms
  const sunDir = o.uSunDir.value
  const sunUp = THREE.MathUtils.smoothstep(sunDir.y, -0.03, 0.05)
  dir.copy(u.moonDir.value).lerp(sunDir, sunUp).normalize()
  const sl = o.uSunLight.value
  const kl = o.uSkyLight.value
  _sun.set(sl.r, sl.g, sl.b).multiplyScalar(u.keyGain.value)
  _sky.set(kl.r, kl.g, kl.b)
  // 光の当たる側 = 空の光 × skyGain + mix(空の光 × moon, 太陽 × keyGain, sunUp) × key
  _lit.copy(_sky).multiplyScalar(u.moon.value).lerp(_sun, sunUp).multiply(u.key.value).addScaledVector(_sky, u.skyGain.value)
  acesDisplay(_lit, exposure, key)
  _sh.copy(_lit).multiply(u.shade.value)
  // 影の色の彩度（光の式の saturate と同じ）
  const l = _sh.x * 0.2126 + _sh.y * 0.7152 + _sh.z * 0.0722
  const k = u.shadeSat.value
  _sh.set(Math.max(0, l + (_sh.x - l) * k), Math.max(0, l + (_sh.y - l) * k), Math.max(0, l + (_sh.z - l) * k))
  acesDisplay(_sh, exposure, shade)
}

/**
 * 中のある建物の部屋・車室の中の光（sakurami-cho の interiorLight の照度 E・まわり amb）を、町の塗りの中の光の式（interior）と同じ 2 段にした
 * 光の当たる側と影の色（画面のリニア）
 */
export function interiorKeyDisplay(E: THREE.Vector3, amb: THREE.Vector3, exposure: number, key: THREE.Vector3, shade: THREE.Vector3) {
  const lE = E.x * 0.2126 + E.y * 0.7152 + E.z * 0.0722
  const lA = Math.max(amb.x * 0.2126 + amb.y * 0.7152 + amb.z * 0.0722, 1e-5)
  _lit.copy(E).divideScalar(Math.max(lE, Math.max(E.x, E.y, E.z) * 0.6, 1e-5))
  _sh.copy(_lit).multiplyScalar(lA * 1.4 + lE * 0.4)
  const s = townPaintUniforms.shade.value
  _sh.multiply(_sun.set(s.x * 0.35 + 0.65, s.y * 0.35 + 0.65, s.z * 0.35 + 0.65))
  _lit.multiplyScalar(lA * 2.6 + lE * 0.4)
  acesDisplay(_lit, exposure, key)
  acesDisplay(_sh, exposure, shade)
}
