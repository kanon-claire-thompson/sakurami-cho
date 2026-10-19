import * as THREE from 'three/webgpu'
import {
  Fn,
  abs,
  If,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  float,
  fract,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  step,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import { SITE } from '../../../core/town'
import { outdoor } from '../../environment/daylight'
import { outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { GeoBuilder } from '../site/builder'
import { Fleet } from '../transit/fleet'
import { TM } from '../transit/transitMaterial'
import type { TownStructure } from './townData'
import { depthMaterial } from './shadows'
import { markPaint, outdoorPaint, paintEmit, paintFlat } from '../paint'
import { HUB_Y as CONFIG_HUB_Y, SORANOWA } from '../../../core/soranowa'
import { wheel } from './soranowaWheel'
import { DetailedCabins, cabinUniforms } from './soranowaCabin'

/**
 * 大観覧車ソラノワ（vol2 3-9: 直径 100m・地上高さ 107.5m・ゴンドラ 60 基、一周約 15 分、営業 11:00〜22:00。白い鉄骨のホイール。
 * 夜はスポーク全体が LED で光り、外周の光の高さが潮位を、スポークを流れる光の速さが風速を表す）。
 *
 * - ホイール: 外周は内外 2 本の弦材と斜めの格子のトラスを左右 2 面、面の間のつなぎ材、軸の両端のフランジから外周へ張る交差したスポークの綱（左右 64 本ずつ）
 * - 支柱: 左右の A 字の脚（鋼管）とつなぎ、基礎
 * - ゴンドラ 60 基: 外周の外に吊り、いつも水平（インスタンスを毎コマ置き直す）。色はパステルの 5 色、夜は中の灯り
 * - 遠くでは細い部材を画面で 1px 以上の線で描く（回っても、ちらつかない）。近く（中心から 450m まで）は鋼管の形
 * - 回り方は交通の時計（営業の間だけ回る。止まっている間は最後の角度）。光は日が沈んでから 22 時まで。角度は town/soranowaWheel.ts が決める
 *   （花音が乗っている間は営業時間の外でも回る。docs/design/town.md §17）
 * - カメラの近く（34m まで）のゴンドラと、花音が乗っているゴンドラは、細かい形（town/soranowaCabin.ts。中・長いす・引き戸・透けるガラス）に替える
 */

/** 細かい形にする距離（m）と数 */
const DETAIL = { distance: 34, max: 8 }

const LAB = SITE.labFloorElevation
const SPOKES = 64
const RIM_SEG = 180
/** 外周の内外の弦材の半径の差と、左右の面の間隔の半分（m） */
const RIM_DEPTH = 2.4
const RIM_HALF = 3.2
const HUB_HALF = 6
/** ゴンドラを吊る軸の、外の弦材からの距離（m） */
const PIVOT = 0.7
/** 左右の面のつなぎの半径（ゴンドラが振れる範囲 = 吊る軸から 3.85m より内側） */
const BRACE_R = 50 - 3.6

/** 線（細い部材・スポーク）の頂点の形と、LED の値（x = 種類 0 鉄骨・1 スポーク・2 外周、y = スポークの根元からの割合） */
class LineBatch {
  pos: number[] = []
  other: number[] = []
  side: number[] = []
  width: number[] = []
  led: number[] = []
  idx: number[] = []
  seg(a: readonly number[], b: readonly number[], width: number, kind: number, la: number, lb: number) {
    const i0 = this.pos.length / 3
    const corners: [readonly number[], readonly number[], number, number][] = [
      [a, b, -1, la],
      [a, b, 1, la],
      [b, a, 1, lb],
      [b, a, -1, lb],
    ]
    for (const [p, q, s, l] of corners) {
      this.pos.push(p[0], p[1], p[2])
      this.other.push(q[0], q[1], q[2])
      this.side.push(s)
      this.width.push(width)
      this.led.push(kind, l)
    }
    this.idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2)
  }
  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('aOther', new THREE.Float32BufferAttribute(this.other, 3))
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(this.side, 1))
    g.setAttribute('aWidth', new THREE.Float32BufferAttribute(this.width, 1))
    g.setAttribute('aLed', new THREE.Float32BufferAttribute(this.led, 2))
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}

/** 線の材質（画面で 1.2px より細くしない・細い所はうすく。夜は LED。TSL。頂点は線の両側へ画面の幅だけ広げる） */
function createWheelLineMaterial() {
  const u = outdoorUniforms
  const uniforms = {
    uPx: uniform(500),
    uLed: uniform(0),
    uTide: uniform(0.5),
    uWind: uniform(0.5),
    uFlow: uniform(0),
    /** 外周のいちばん下・直径（ワールドの y と m。外周の光の高さ） */
    uRim: uniform(new THREE.Vector2(0, 100)),
    /** 鉄骨の線を描くか（近くは鋼管の形なので、スポーク以外は描かない） */
    uSteel: uniform(1),
  }
  const m = markPaint(unlit('soranowaLines', { transparent: true, depthWrite: false, side: THREE.DoubleSide }), 'light')
  const paint = outdoorPaint()
  const flat = paintFlat()
  const aOther = attribute<'vec3'>('aOther', 'vec3')
  const aSide = attribute<'float'>('aSide', 'float')
  const aWidth = attribute<'float'>('aWidth', 'float')
  const aLed = attribute<'vec2'>('aLed', 'vec2')
  // 頂点: 画面で 1.2px より細くならない幅で、線の両側へ広げる（細すぎる所はうすく、見えない線はクリップの外へ）
  const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1.0)).xyz.toVar()
  const wo = modelWorldMatrix.mul(vec4(aOther, 1.0)).xyz
  const d = max(cameraViewMatrix.mul(vec4(wp, 1.0)).z.negate(), 0.1).toVar()
  const px = aWidth.mul(uniforms.uPx).div(d).toVar()
  const w = max(px, 1.2).div(uniforms.uPx).mul(d)
  const alpha = clamp(px.div(1.2), 0.0, 1.0).mul(select(aLed.x.lessThan(0.5), uniforms.uSteel, 1.0)).toVar()
  const dir = normalize(wo.sub(wp))
  const side = normalize(cross(dir, normalize(cameraPosition.sub(wp))))
  // 外の塗り（paint.ts）の flat: 外周の LED の帯（kind 2）は、外の弦材の鋼管（半径 0.42m）の手前へ 0.6m 出す（鋼管に隠れて帯が縁しか見えなかった）
  const lift = flat ? select(aLed.x.greaterThan(1.5), normalize(cameraPosition.sub(wp)).mul(0.6), vec3(0.0)) : vec3(0.0)
  const moved = wp.add(side.mul(aSide).mul(w).mul(0.5)).add(lift)
  const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(moved, 1.0))
  m.vertexNode = select(alpha.lessThan(0.001), vec4(0.0, 0.0, -2.0, 1.0), clip)
  const vAlpha = varying(alpha)
  const vWorld = varying(wp)
  const vLed = varying(aLed)
  const col = Fn(() => {
    // 白い鉄骨（空の光と太陽。線なので向きは平均）
    const c = (paint?.light ? paint.light(vec3(0.78, 0.79, 0.8), vec3(0.0, 1.0, 0.0), float(1.0), float(1.0), 'structure') : vec3(0.78, 0.79, 0.8).mul(u.uSkyLight.mul(0.9).add(u.uSunLight.mul(0.45)))).toVar()
    const a = vAlpha
    const thin = min(3.0, float(1.0).div(max(a, 0.05)))
    if (flat) {
      // 外の塗り（paint.ts）の flat: 形のくっきりした色の帯。いつも光る分（前は 0.45）が細い綱のうすさの倍率（thin。3 倍まで）で白くつぶれ、流れる光の帯が
      // 見えなかった（スポークが一様な白い線）。綱は暗い鋼の色、いつもの光はごく弱く、流れる帯は琥珀（先頭は明るい白に近い色）。外周は潮位の高さまで琥珀の帯、
      // その上は鋼の色（潮位の線は白く 1 段明るい）
      const thinF = min(thin, 1.6)
      If(vLed.x.greaterThan(0.5).and(vLed.x.lessThan(1.5)), () => {
        const f = fract(vLed.y.mul(2.5).sub(uniforms.uFlow)).toVar()
        const band = step(0.7, f).toVar()
        const head = step(0.93, f)
        const base = smoothstep(0.04, 0.5, vLed.y).mul(0.75).add(0.25)
        const led = mix(vec3(0.06, 0.05, 0.04), mix(vec3(1.0, 0.42, 0.1).mul(1.3), vec3(1.0, 0.78, 0.45).mul(1.9), head), band)
        c.assign(mix(c.mul(0.42), vec3(0.0), band.mul(uniforms.uLed)))
        c.addAssign(paintEmit(led.mul(base).mul(uniforms.uLed).mul(thinF)))
      }).ElseIf(vLed.x.greaterThan(1.5), () => {
        const h = vWorld.y.sub(uniforms.uRim.x).div(uniforms.uRim.y)
        const lit = step(h, uniforms.uTide).toVar()
        const line = step(abs(h.sub(uniforms.uTide)), 0.012)
        const led = mix(vec3(0.03), vec3(1.0, 0.6, 0.26).mul(1.3), lit).add(vec3(1.0, 0.95, 0.85).mul(line).mul(1.6))
        c.assign(mix(c, vec3(0.0), max(lit, line).mul(uniforms.uLed)))
        c.addAssign(paintEmit(led.mul(uniforms.uLed).mul(thinF)))
      })
    } else {
      If(vLed.x.greaterThan(0.5).and(vLed.x.lessThan(1.5)), () => {
        // スポーク: 根元から外へ光が流れる（流れる速さ = 風速）。いつもほのかに光り、流れる所が明るい
        const pulse = smoothstep(0.7, 1.0, fract(vLed.y.mul(2.5).sub(uniforms.uFlow))).toVar()
        // 画素より細い遠くの綱は、うすい分だけ明るく（線の数が多いので、白い円盤にならないよう上限は 3 倍）
        // 軸のそばは綱が集まって白くつぶれるので、根元ほど暗く
        const base = smoothstep(0.04, 0.5, vLed.y).mul(0.75).add(0.25)
        c.addAssign(paintEmit(mix(vec3(1.0, 0.86, 0.66), vec3(1.0, 0.7, 0.4), pulse).mul(pulse.mul(2.6).add(0.45)).mul(base).mul(uniforms.uLed).mul(thin)))
      }).ElseIf(vLed.x.greaterThan(1.5), () => {
        // 外周: 下から潮位の高さまで光る
        const h = vWorld.y.sub(uniforms.uRim.x).div(uniforms.uRim.y)
        const lit = smoothstep(uniforms.uTide.sub(0.015), uniforms.uTide.add(0.015), h).oneMinus()
        c.addAssign(paintEmit(vec3(1.0, 0.94, 0.84).mul(lit.mul(2.4).add(0.25)).mul(uniforms.uLed).mul(thin)))
      })
    }
    return outdoorHaze(c, vWorld)
  })()
  m.colorNode = col
  m.opacityNode = vAlpha
  return withUniforms(m, uniforms)
}

/** 鋼管（2 点を結ぶ 6 角の筒） */
function tube(g: GeoBuilder, a: THREE.Vector3, b: THREE.Vector3, r: number, color: string, mat: number = TM.paint, aux = 0.55) {
  const d = new THREE.Vector3().subVectors(b, a)
  const len = d.length()
  if (len < 1e-3) return
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize())
  const m = new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1))
  g.lathe(
    [
      [r, 0],
      [r, len],
    ],
    6,
    m,
    color,
    mat,
    aux,
  )
}

/** ゴンドラ（幅 2.7・高さ 2.9・奥行き 2.5m。原点 = 吊り金具の軸。下へ吊る） */
function gondolaGeometry(near: boolean) {
  const g = new GeoBuilder()
  const w = 1.35
  const d = 1.25
  const y0 = -3.6
  const y1 = -0.75
  if (!near) {
    g.boxMinMax(-w, y0, -d, w, y0 + 0.9, d, '#f2f0ea', TM.paint, 0.6)
    g.boxMinMax(-w, y0 + 0.9, -d, w, y1 - 0.4, d, '#ffffff', TM.glass, 1)
    g.boxMinMax(-w, y1 - 0.4, -d, w, y1, d, '#ffffff', 15, 0.6)
    return g.build()
  }
  // 丸みのある箱: 下の白い腰・大きな窓の帯・色の屋根（角を落とした 8 角の断面を z へ）
  const prof: [number, number][] = [
    [-w + 0.35, y0],
    [w - 0.35, y0],
    [w, y0 + 0.4],
    [w, y1 - 0.45],
    [w - 0.3, y1],
    [-w + 0.3, y1],
    [-w, y1 - 0.45],
    [-w, y0 + 0.4],
  ]
  const n = prof.length
  for (let i = 0; i < n; i++) {
    const [ax, ay] = prof[i]
    const [bx, by] = prof[(i + 1) % n]
    // 横の面: 窓の帯（腰の上〜屋根の下）を分ける
    const bands: [number, number, string, number, number][] = [
      [y0 - 1, y0 + 0.95, '#f2f0ea', TM.paint, 0.6],
      [y0 + 0.95, y1 - 0.5, '#ffffff', TM.glass, 1],
      [y1 - 0.5, y1 + 1, '#ffffff', 15, 0.6],
    ]
    for (const [b0, b1, c, m, aux] of bands) {
      const lo = Math.max(Math.min(ay, by), b0)
      const hi = Math.min(Math.max(ay, by), b1)
      if (hi - lo < 1e-3) continue
      const t0 = ay === by ? 0 : (lo - ay) / (by - ay)
      const t1 = ay === by ? 1 : (hi - ay) / (by - ay)
      const p0 = [ax + (bx - ax) * t0, lo]
      const p1 = [ax + (bx - ax) * t1, hi]
      const pa = ay === by ? [ax, ay] : p0
      const pb = ay === by ? [bx, by] : p1
      g.quad([pa[0], pa[1], d], [pb[0], pb[1], d], [pb[0], pb[1], -d], [pa[0], pa[1], -d], c, m, aux)
    }
  }
  // 前後の面（窓の帯はガラス）
  for (const s of [1, -1]) {
    const z = s * d
    const face = (y0f: number, y1f: number, c: string, m: number, aux: number) => {
      const xs = (y: number) => (y < y0 + 0.4 ? w - 0.35 + 0.35 * ((y - y0) / 0.4) : y > y1 - 0.45 ? w - 0.3 * ((y - (y1 - 0.45)) / 0.45) : w)
      const a: [number, number, number] = [-xs(y0f), y0f, z]
      const b: [number, number, number] = [xs(y0f), y0f, z]
      const c2: [number, number, number] = [xs(y1f), y1f, z]
      const d2: [number, number, number] = [-xs(y1f), y1f, z]
      if (s > 0) g.quad(a, b, c2, d2, c, m, aux)
      else g.quad(b, a, d2, c2, c, m, aux)
    }
    face(y0, y0 + 0.4, '#f2f0ea', TM.paint, 0.6)
    face(y0 + 0.4, y0 + 0.95, '#f2f0ea', TM.paint, 0.6)
    face(y0 + 0.95, y1 - 0.5, '#ffffff', TM.glass, 1)
    face(y1 - 0.5, y1 - 0.45, '#ffffff', 15, 0.6)
    face(y1 - 0.45, y1, '#ffffff', 15, 0.6)
  }
  // 窓の縦の桟と、吊り金具（腕と軸）
  for (const x of [-0.45, 0.45]) for (const s of [1, -1]) g.box([x, (y0 + 0.95 + y1 - 0.5) / 2, s * (d + 0.01)], [0.06, y1 - 0.5 - y0 - 0.95, 0.03], '#dcdcdc', TM.metal)
  g.box([0, y1 + 0.35, 0], [0.18, 0.7, 0.18], '#c8c8c8', TM.metal)
  g.cylinder([0, 0, -0.5], 0.12, 1.0, 8, '#bdbdbd', TM.metal, 0, true)
  // 中の灯り（夜。窓の上の帯）
  g.box([0, y1 - 0.6, 0], [w * 1.4, 0.05, d * 1.4], '#fff0d8', TM.lamp, 1.6)
  return g.build()
}

export interface Soranowa {
  group: THREE.Group
  /** 細かいゴンドラ（花音のまわりの細かい影の地図に入れる） */
  cabins: DetailedCabins
  update(camera: THREE.Camera, t: number, px: number): void
}

const _cam = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _info: [number, number, number, number] = [0, 1, 0, 0]
const _ci: [number, number, number, number] = [0, 0, 0, 0]
const _camLocal = new THREE.Vector3()
const _gInv = new THREE.Matrix4()

export function createSoranowa(s: Extract<TownStructure, { type: 'soranowa' }>, material: THREE.Material, layer: number): Soranowa {
  const R = s.diameter / 2
  const hubY = s.height - R - 2
  // 乗る仕組み（core/soranowa.ts）の決まった値と、町のデータが合っているか
  if (Math.hypot(s.x - SORANOWA.x, s.y - SORANOWA.y) > 0.05 || Math.abs(s.axis - SORANOWA.axis) > 1e-4 || Math.abs(hubY - CONFIG_HUB_Y) > 0.01 || s.gondolas !== SORANOWA.gondolas)
    console.warn('[soranowa] 町のデータの観覧車が core/soranowa.ts の値と違います（乗り降りの位置がずれます）', s)
  const white = '#e6e7e5'
  const group = new THREE.Group()
  group.name = 'soranowa'
  group.position.set(s.x, s.z - LAB, -s.y)
  group.rotation.y = s.axis
  // 回る部分（局所の xy がホイールの面、z が軸）
  const wheelGroup = new THREE.Group()
  wheelGroup.position.y = hubY
  group.add(wheelGroup)

  // 鋼管（近く）と線（遠く・スポーク）
  const solid = new GeoBuilder()
  const lines = new LineBatch()
  const P = (r: number, a: number, z: number) => new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z)
  for (const side of [-1, 1]) {
    const z = side * RIM_HALF
    for (let i = 0; i < RIM_SEG; i++) {
      const a0 = (i / RIM_SEG) * Math.PI * 2
      const a1 = ((i + 1) / RIM_SEG) * Math.PI * 2
      // 外の弦材（LED の帯）と内の弦材
      tube(solid, P(R, a0, z), P(R, a1, z), 0.42, white)
      tube(solid, P(R - RIM_DEPTH, a0, z), P(R - RIM_DEPTH, a1, z), 0.32, white)
      lines.seg(P(R, a0, z).toArray(), P(R, a1, z).toArray(), 0.9, 2, 0, 0)
      lines.seg(P(R - RIM_DEPTH, a0, z).toArray(), P(R - RIM_DEPTH, a1, z).toArray(), 0.65, 0, 0, 0)
      // 斜めの格子（内外の弦材を結ぶ）
      const inner = i % 2 === 0 ? a0 : a1
      const outer = i % 2 === 0 ? a1 : a0
      tube(solid, P(R - RIM_DEPTH, inner, z), P(R, outer, z), 0.16, white)
      lines.seg(P(R - RIM_DEPTH, inner, z).toArray(), P(R, outer, z).toArray(), 0.32, 0, 0, 0)
    }
  }
  // 左右の面のつなぎ（ゴンドラとゴンドラの間ごと）と、ゴンドラを吊る軸の棒（外周の外）。
  // つなぎは、ゴンドラが軸のまわりで振れる範囲（軸から 3.85m）より内側の BRACE_R で渡す（各面の内の弦材から下ろした柱の先）。
  // 前は外の弦材と内の弦材の高さで渡していて、ホイールの上半分でゴンドラの中を通っていた（中から見て分かった。docs/design/town.md §7 の 118）
  for (let i = 0; i < s.gondolas; i++) {
    const a = ((i + 0.5) / s.gondolas) * Math.PI * 2
    for (const z of [-RIM_HALF, RIM_HALF]) {
      tube(solid, P(R - RIM_DEPTH, a, z), P(BRACE_R, a, z), 0.17, white)
      lines.seg(P(R - RIM_DEPTH, a, z).toArray(), P(BRACE_R, a, z).toArray(), 0.34, 0, 0, 0)
    }
    tube(solid, P(BRACE_R, a, -RIM_HALF), P(BRACE_R, a, RIM_HALF), 0.18, white)
    lines.seg(P(BRACE_R, a, -RIM_HALF).toArray(), P(BRACE_R, a, RIM_HALF).toArray(), 0.36, 0, 0, 0)
    const g = (i / s.gondolas) * Math.PI * 2
    tube(solid, P(R + PIVOT, g, -RIM_HALF), P(R + PIVOT, g, RIM_HALF), 0.14, '#c8c9c8', TM.metal, 0)
    for (const z of [-RIM_HALF, RIM_HALF]) tube(solid, P(R, g, z), P(R + PIVOT, g, z), 0.14, white)
  }
  // スポーク（軸の両端のフランジから、反対の面の外周の内の弦材へ交差して張る綱。LED）
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * Math.PI * 2
    for (const side of [-1, 1]) {
      const hub = P(2.6, a + side * 0.05, side * HUB_HALF)
      const rim = P(R - RIM_DEPTH, a, -side * RIM_HALF * 0.6)
      lines.seg(hub.toArray(), rim.toArray(), 0.14, 1, 0, 1)
    }
  }
  // 軸（ハブ）とフランジ
  const hubM = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, -HUB_HALF)
  solid.lathe(
    [
      [0.01, 0],
      [3.2, 0],
      [3.2, 0.6],
      [2.2, 0.8],
      [2.2, HUB_HALF * 2 - 0.8],
      [3.2, HUB_HALF * 2 - 0.6],
      [3.2, HUB_HALF * 2],
      [0.01, HUB_HALF * 2],
    ],
    16,
    hubM,
    '#cfd1d2',
    TM.paint,
    0.6,
  )
  const solidMesh = new THREE.Mesh(solid.build(), material)
  solidMesh.name = 'soranowa:wheel'
  const lineMat = createWheelLineMaterial()
  const lineMesh = new THREE.Mesh(lines.build(), lineMat)
  lineMesh.name = 'soranowa:lines'
  lineMesh.renderOrder = 14
  wheelGroup.add(solidMesh, lineMesh)

  // 支柱（左右の A 字の脚とつなぎ・基礎）。動かない
  const legs = new GeoBuilder()
  const axle = (side: number) => new THREE.Vector3(0, hubY, side * (HUB_HALF + 0.6))
  for (const side of [-1, 1]) {
    const top = axle(side)
    const feet = [-1, 1].map((sx) => new THREE.Vector3(sx * 27, 0, side * 13))
    for (const f of feet) {
      tube(legs, f, top, 1.15, white)
      legs.box([f.x, 0.6, f.z], [4, 1.2, 4], '#a9a59c', TM.concrete, 0)
    }
    // 脚のつなぎ（横の梁 3 段）
    for (const k of [0.25, 0.5, 0.72]) {
      const a = feet[0].clone().lerp(top, k)
      const b = feet[1].clone().lerp(top, k)
      tube(legs, a, b, 0.5, white)
    }
    // 軸受けの箱
    legs.box([0, hubY, top.z], [3.2, 3.2, 1.6], '#cfd1d2', TM.paint, 0.6)
  }
  // 左右の A 字をつなぐ梁（前後の面の間）
  for (const sx of [-1, 1]) {
    const a = new THREE.Vector3(sx * 27, 0, -13).lerp(axle(-1), 0.25)
    const b = new THREE.Vector3(sx * 27, 0, 13).lerp(axle(1), 0.25)
    tube(legs, a, b, 0.45, white)
  }
  const legMesh = new THREE.Mesh(legs.build(), material)
  legMesh.name = 'soranowa:legs'
  // 支柱は動かないので町の太陽の影を落とす（回るホイールとゴンドラは落とさない）
  legMesh.userData.shadowMaterial = depthMaterial()
  group.add(legMesh)

  // ゴンドラ（いつも水平。インスタンス）
  const gondolas = new Fleet('gondola', gondolaGeometry(true), gondolaGeometry(false), material, s.gondolas, 420)
  for (const m of gondolas.meshes) {
    group.add(m)
    m.layers.set(layer)
    m.renderOrder = 11
  }
  for (const m of [solidMesh, legMesh]) {
    m.frustumCulled = false
    m.layers.set(layer)
    m.renderOrder = 11
  }
  lineMesh.frustumCulled = false
  lineMesh.layers.set(layer)

  // 細かいゴンドラ（カメラの近くと、花音が乗っている 1 基）
  const cabins = new DetailedCabins(DETAIL.max + 1)
  const cabinDepth = depthMaterial()
  for (const m of cabins.meshes) {
    group.add(m)
    m.layers.set(layer)
    if (m.material === cabins.material) m.userData.shadowMaterial = cabinDepth
  }
  const detailed: { i: number; d: number }[] = []

  return {
    group,
    cabins,
    update(camera, t, px) {
      const o = outdoor
      // 角度は town/soranowaWheel.ts（営業 11:00〜22:00 の間だけ回る。15 分で一周。花音が乗っている間は営業時間の外も回る）
      const angle = wheel.angle
      wheelGroup.rotation.z = angle
      camera.getWorldPosition(_cam)
      group.updateMatrixWorld()
      _camLocal.copy(_cam).applyMatrix4(_gInv.copy(group.matrixWorld).invert())
      const dist = _cam.distanceTo(_p.setFromMatrixPosition(group.matrixWorld).setY(_p.y + hubY))
      // 近くは鋼管の形、遠くは線（回っても、ちらつかない）
      const near = dist < 450
      solidMesh.visible = near
      lineMat.uniforms.uSteel.value = near ? 0 : 1
      lineMat.uniforms.uPx.value = px
      lineMat.uniforms.uLed.value = o.soranowa
      lineMat.uniforms.uTide.value = 0.12 + 0.82 * o.tide
      // 風速（データが無いので、時刻でゆっくり変わる 0.3〜0.9）
      const wind = 0.6 + 0.3 * Math.sin(t / 1700) * Math.cos(t / 4100)
      lineMat.uniforms.uWind.value = wind
      lineMat.uniforms.uFlow.value = (t * (0.25 + wind * 0.6)) % 1000
      lineMat.uniforms.uRim.value.set(group.position.y + hubY - R, R * 2)
      cabinUniforms.uLed.value = o.soranowa
      // 細かい形にするゴンドラ: 花音が乗っている 1 基と、カメラに近いもの（34m まで・8 基まで）
      detailed.length = 0
      for (let i = 0; i < s.gondolas; i++) {
        const a = (i / s.gondolas) * Math.PI * 2 + angle
        _p.set(Math.cos(a) * (R + PIVOT), hubY + Math.sin(a) * (R + PIVOT) - 2.2, 0).applyMatrix4(group.matrixWorld)
        const d = _cam.distanceTo(_p)
        if (i === wheel.rideIndex) detailed.push({ i, d: -1 })
        else if (d < DETAIL.distance) detailed.push({ i, d })
      }
      detailed.sort((x, y) => x.d - y.d)
      if (detailed.length > DETAIL.max) detailed.length = DETAIL.max
      // 中の灯り: 夜の営業の間（LED と同じ）。乗っているゴンドラは暗ければいつも
      const dark = 1 - THREE.MathUtils.smoothstep(o.daylight, 0.1, 0.45)
      const lampOn = Math.min(1, o.soranowa * 1.15)
      wheel.cabinLamp = Math.max(lampOn, dark)
      // ゴンドラ: 外周の外の吊り金具の位置に、水平に（乗っているゴンドラは揺らさない）
      gondolas.begin()
      cabins.begin()
      for (let i = 0; i < s.gondolas; i++) {
        const a = (i / s.gondolas) * Math.PI * 2 + angle
        const ridden = i === wheel.rideIndex
        const sway = ridden ? 0 : 0.02 * Math.sin(t * 0.6 + i)
        _m.makeRotationZ(sway)
        _m.setPosition(Math.cos(a) * (R + PIVOT), hubY + Math.sin(a) * (R + PIVOT), 0)
        _p.setFromMatrixPosition(_m).applyMatrix4(group.matrixWorld)
        const seed = ((i * 0.618) % 1 + 1) % 1
        if (detailed.some((q) => q.i === i)) {
          _ci[0] = ridden ? wheel.cabinLamp : lampOn
          _ci[1] = seed
          _ci[2] = -Math.cos(a)
          _ci[3] = -Math.sin(a)
          if (cabins.add(_m, _ci, ridden ? wheel.door : 0, _camLocal)) continue
        }
        _info[0] = 0
        _info[1] = o.soranowa > 0.01 ? 1 : 0
        _info[3] = seed
        gondolas.add(_m, _info, _cam.distanceTo(_p))
      }
      gondolas.end()
      cabins.end()
    },
  }
}
