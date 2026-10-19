import * as THREE from 'three/webgpu'
import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  abs,
  acos,
  attribute,
  cameraPosition,
  clamp,
  cross,
  dot,
  float,
  floor,
  fract,
  int,
  length,
  max,
  mix,
  modelWorldMatrix,
  normalLocal,
  normalize,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { oHash, oNoise, outdoorHaze, outdoorUniforms, skyColor, unlit, withUniforms } from '../materials'
import { arrayUniform, bAlb, bNrm, namedSurface, surfaceVaryings, type SurfaceState } from '../named/namedMaterial'
import { shadowTap, townShadow, townShadowUniforms } from '../town/shadows'
import { markPaint, outdoorPaint, paintEmit, paintFlat } from '../paint'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>
type V3 = Node<'vec3'>

/**
 * 中のある建物の中のシェーダー（町の段階 4 の後半）。
 *
 * - 面の質感は外観と同じ（namedMaterial の NAMED_SURFACE。NM の 0〜26）に、中の質感（IM の 27〜）を足したもの
 * - 光（建物ごとに uniform を持つ。interiors.ts が毎コマ書く）:
 *   1. 窓の光: 窓（長方形）ごとの「面光源」。画素から見た窓の形の立体角（ランバートの多角形の式）× 窓の明るさ（空の光。太陽の側の窓は明るい）。
 *      同じ組（部屋）の窓だけ（壁の向こうの部屋の窓の光は入らない）
 *   2. 太陽の直射: 窓から差し込む日なた。花音のまわりの細かい影の地図（town/shadows.ts の local。建物の外観と中の形が影を落とす）で
 *      日なたかを見る（地図の外は日なたにしない）
 *   3. 部屋の灯り: 灯りごとの点光源（距離の 2 乗で弱まる・傘の向き・スポットの向き）。同じ組の灯りだけ。つやのある面にはハイライト
 *   4. まわりの明るさ: 組ごとの照り返し（窓の光・日なた・灯りの合計から。interiors.ts が計算）
 * - 外から窓越しに見たときも同じ光（夜は点いた部屋が電球色に光る）。遠くはかすむ（outdoorHaze）
 *
 * WebGPU（WebGPURenderer＋TSL）への移行（第 2 段）: どの材質も TSL（NodeMaterial）。面は namedMaterial.ts の namedSurface に、中の質感
 * （interiorSurface）を足して使う。建物ごとの uniform は createInteriorUniforms（数は uniform のノード、配列は value が JS の配列の arrayUniform）
 */

/** 中の質感の番号（NM の続き。kitBuilder の aMat.x） */
export const IM = {
  /** 布（ソファ・椅子の張り地）。aux = 柄（0 無地・1 チェック・2 縞） */
  fabric: 27,
  /** 敷物（ラグ）。aux = 柄（0 無地・1 縞・2 縁取り） */
  rug: 28,
  /** 本の背（棚の本の列。面の横の向きに背が並ぶ）。aux = 色の種 */
  books: 29,
  /** 画面のガラス（黒くつやがある。消えた画面・テレビ） */
  screen: 30,
  /** 樹脂（つやのある・ない）。aux = つや */
  plastic: 31,
  /** 天井の星図（藍色の地に金の星と星座線。律の手描き） */
  starmap: 32,
  /** 板の床（フローリング）。aux = 板の幅 m（向きは面の横） */
  woodFloor: 33,
  /** 革（椅子の座面・ソファ） */
  leather: 34,
  /** 段ボール（屋根裏の箱） */
  cardboard: 35,
  /** 塗り壁（中の壁。ローラーの跡のごく薄いむら） */
  paintWall: 36,
  /** 陶器（洗面台・便器・浴槽・カップ） */
  ceramic: 37,
  /** 寝具（布団・枕。しわ） */
  bedding: 38,
  /** 黒い鉄のフレーム（ロフトベッド・照明） */
  steelBlack: 39,
} as const


/** 窓・灯り・組の数の上限 */
export const MAX_IWIN = 28
export const MAX_ILAMP = 28
export const MAX_IGROUP = 16

/** 1 棟ぶんの中の光の uniform（interiors.ts が毎コマ書く。数は uniform のノード、配列は value の要素を書く） */
export function createInteriorUniforms() {
  return {
    uIWinA: arrayUniform(Array.from({ length: MAX_IWIN }, () => new THREE.Vector4(0, -1e5, 0, -1)), 'vec4'),
    uIWinU: arrayUniform(Array.from({ length: MAX_IWIN }, () => new THREE.Vector4()), 'vec4'),
    uIWinV: arrayUniform(Array.from({ length: MAX_IWIN }, () => new THREE.Vector4()), 'vec4'),
    uIWinL: arrayUniform(Array.from({ length: MAX_IWIN }, () => new THREE.Vector3()), 'vec3'),
    uIWinN: uniform(0),
    uILampP: arrayUniform(Array.from({ length: MAX_ILAMP }, () => new THREE.Vector4(0, -1e5, 0, -1)), 'vec4'),
    uILampC: arrayUniform(Array.from({ length: MAX_ILAMP }, () => new THREE.Vector4()), 'vec4'),
    uILampD: arrayUniform(Array.from({ length: MAX_ILAMP }, () => new THREE.Vector4(0, -1, 0, 0.1)), 'vec4'),
    uILampR: arrayUniform(Array.from({ length: MAX_ILAMP }, () => 1), 'float'),
    uILampOn: arrayUniform(Array.from({ length: MAX_ILAMP }, () => 0), 'float'),
    uILampN: uniform(0),
    uIAmb: arrayUniform(Array.from({ length: MAX_IGROUP }, () => new THREE.Vector3()), 'vec3'),
    /** 窓ガラス越しの太陽の強さ（0〜1） */
    uISun: uniform(0.85),
    /** 中から見たガラスの映り込みの色（部屋の明るさ） */
    uIRefl: uniform(new THREE.Vector3()),
    /** 画面の明るさ */
    uIScreen: uniform(1.6),
    /** ガラスの温室（1 = 太陽と空の光が町の影の地図ごと入る。ガーデンドーム） */
    uIGlass: uniform(0),
  }
}

export type InteriorUniforms = ReturnType<typeof createInteriorUniforms>

/** 中の質感（namedSurface の中から、id が 26.5 を超える面で呼ばれる） */
function interiorSurface(s: SurfaceState) {
  const { id, aux, uv, fw, px, seed, nk, n1, albedo, tn, ao, gloss, metal, emit } = s
  albedo.assign(s.color)
  tn.assign(vec3(0.0, 0.0, 1.0))
  metal.assign(0.0)
  const fine = smoothstep(0.002, 0.01, px).oneMinus().toVar()
  const addTn = (d: Node<'vec2'>) => tn.assign(vec3(tn.xy.add(d), tn.z))
  If(id.lessThan(27.5), () => {
    // 布: 織り目と、柄（チェック・縞）
    const w = sin(uv.mul(900.0)).toVar()
    albedo.mulAssign(w.x.mul(w.y).mul(fine).mul(0.06).add(0.9).add(oNoise(uv.mul(14.0).add(seed)).sub(0.5).mul(0.08)))
    If(aux.greaterThan(0.5).and(aux.lessThan(1.5)), () => {
      const c = step(0.5, fract(uv.mul(6.0))).toVar()
      albedo.mulAssign(abs(c.x.sub(c.y)).mul(0.18).add(0.82).add(c.x.mul(c.y).mul(0.08)))
    }).ElseIf(aux.greaterThan(1.5), () => {
      albedo.mulAssign(step(0.5, fract(uv.x.mul(7.0))).mul(0.15).add(0.85))
    })
    gloss.assign(0.03)
  })
    .ElseIf(id.lessThan(28.5), () => {
      // 敷物: 毛足のざらつき・柄
      const pile = oNoise(uv.mul(60.0).add(seed)).mul(0.6).add(oNoise(uv.mul(160.0)).mul(0.4)).toVar()
      albedo.mulAssign(pile.mul(0.32).add(0.78))
      If(aux.greaterThan(0.5).and(aux.lessThan(1.5)), () => {
        albedo.mulAssign(step(0.5, fract(uv.x.mul(2.2))).mul(0.2).add(0.8))
      }).ElseIf(aux.greaterThan(1.5), () => {
        const d = min2(fract(uv.x.mul(0.5)), fract(uv.y.mul(0.5)))
        albedo.assign(mix(albedo, albedo.mul(vec3(1.25, 1.05, 0.85)), smoothstep(0.0, 0.02, abs(d.sub(0.06))).oneMinus().mul(0.8)))
      })
      addTn(vec2(oNoise(uv.mul(90.0)), oNoise(uv.mul(90.0).add(7.0))).sub(0.5).mul(0.6).mul(nk))
      ao.mulAssign(pile.mul(0.08).add(0.92))
      gloss.assign(0.01)
    })
    .ElseIf(id.lessThan(29.5), () => {
      // 本の背: 背ごとの色・幅・背の帯（題名）・すき間
      const wBook = 0.032
      const shelfRow = floor(uv.y.div(0.33)).toVar()
      const x = uv.x.div(wBook).add(oHash(vec2(shelfRow, aux)).mul(7.0)).toVar()
      const bi = floor(x.add(sin(floor(x).mul(1.7)).mul(0.4))).toVar()
      const f = fract(x).toVar()
      const h = oHash(vec2(bi, aux.mul(13.0).add(shelfRow))).toVar()
      const k = floor(h.mul(5.99)).toVar()
      const pal = select(
        k.lessThan(0.5),
        vec3(0.42, 0.1, 0.08),
        select(
          k.lessThan(1.5),
          vec3(0.1, 0.15, 0.32),
          select(k.lessThan(2.5), vec3(0.78, 0.72, 0.58), select(k.lessThan(3.5), vec3(0.14, 0.28, 0.16), select(k.lessThan(4.5), vec3(0.62, 0.42, 0.14), vec3(0.08, 0.08, 0.09)))),
        ),
      )
      const c = pal.mul(oHash(vec2(bi, 3.0)).mul(0.5).add(0.75)).toVar()
      const row = fract(uv.y.div(0.33)).toVar()
      const band = step(0.62, row).mul(step(row, 0.7)).add(step(0.18, row).mul(step(row, 0.21)))
      c.assign(mix(c, vec3(0.85, 0.75, 0.45), band.mul(0.55).mul(step(0.45, oHash(vec2(bi, 9.0))))))
      const gap = smoothstep(0.0, 0.08, f).mul(smoothstep(0.92, 1.0, f).oneMinus())
      albedo.assign(c.mul(mix(0.35, 1.0, gap.mul(fine).add(fine.oneMinus().mul(0.8)))))
      gloss.assign(0.1)
    })
    .ElseIf(id.lessThan(30.5), () => {
      // 消えた画面: 黒いつやのあるガラス
      albedo.assign(vec3(0.012, 0.013, 0.016))
      gloss.assign(0.85)
    })
    .ElseIf(id.lessThan(31.5), () => {
      // 樹脂
      albedo.mulAssign(n1.mul(0.06).add(0.96))
      gloss.assign(aux.mul(0.6).add(0.1))
    })
    .ElseIf(id.lessThan(32.5), () => {
      // 天井の星図（藍色の地に金の星と星座線。刷毛のむら）
      const q = uv.mul(1.6).toVar()
      const base = vec3(0.045, 0.07, 0.19)
        .mul(oNoise(uv.mul(0.9).add(seed)).mul(0.3).add(0.85))
        .mul(oNoise(vec2(uv.x.mul(9.0), uv.y.mul(0.6))).mul(0.08).add(0.94))
        .toVar()
      const cell = floor(q).toVar()
      const fq = fract(q).sub(0.5).toVar()
      const st = float(0.0).toVar()
      for (let i = 0; i < 3; i++) {
        const o = vec2(oHash(cell.add(i * 7.1)), oHash(cell.add(i * 3.3 + 1.9))).sub(0.5)
        const r = pow(oHash(cell.add(i * 5.7)), 4.0).mul(0.03).add(0.012).toVar()
        st.assign(max(st, smoothstep(r.mul(0.3), r, length(fq.sub(o.mul(0.9)))).oneMinus()))
      }
      // 星座線: 大きな格子の星どうしを結ぶ細い金の線
      const big = floor(uv.mul(0.55)).toVar()
      const big1 = big.add(vec2(1.0, 0.0)).toVar()
      const a = big.add(vec2(oHash(big), oHash(big.add(2.0)))).div(0.55).toVar()
      const b = big1.add(vec2(oHash(big1), oHash(big1.add(2.0)))).div(0.55).toVar()
      const pa = uv.sub(a).toVar()
      const ba = b.sub(a).toVar()
      const tt = clamp(dot(pa, ba).div(dot(ba, ba)), 0.0, 1.0)
      const ln = length(pa.sub(ba.mul(tt)))
      const on = step(0.35, oHash(big.add(5.0))).toVar()
      const line = smoothstep(0.004, 0.012, ln).oneMinus().mul(on).toVar()
      const node = max(smoothstep(0.02, 0.05, length(uv.sub(a))).oneMinus(), smoothstep(0.02, 0.05, length(uv.sub(b))).oneMinus()).mul(on).toVar()
      const gold = vec3(0.95, 0.72, 0.3)
      albedo.assign(mix(base, gold, clamp(st.mul(0.9).add(line.mul(0.55)).add(node), 0.0, 1.0)))
      emit.assign(st.add(node).mul(0.06))
      gloss.assign(0.05)
      metal.assign(clamp(st.mul(0.5).add(line.mul(0.4)).add(node.mul(0.6)), 0.0, 0.6))
    })
    .ElseIf(id.lessThan(33.5), () => {
      // 板の床: 板の幅 aux、長さの違う板の継ぎ目、板ごとの色、木目（質感の木）、つや
      const pw = max(aux, 0.08).toVar()
      const row = floor(uv.y.div(pw)).toVar()
      const lx = uv.x.div(1.2).add(oHash(vec2(row, 3.0)).mul(3.0)).toVar()
      const plank = floor(lx)
      const t = bAlb(vec2(uv.x.mul(0.6), fract(uv.y.div(pw)).add(row.mul(0.37)).mul(0.15)), 0)
      albedo.mulAssign(mix(vec3(1.0), t.mul(1.1), 0.8).mul(oHash(vec2(plank, row)).mul(0.3).add(0.82)))
      const sy = abs(fract(uv.y.div(pw)).sub(0.5)).mul(pw)
      const sx = abs(fract(lx).sub(0.5)).mul(1.2)
      const e = pw.mul(0.5).sub(0.0025)
      const seam = max(smoothstep(e.sub(fw.y), e.add(fw.y), sy).oneMinus(), smoothstep(float(0.598).sub(fw.x), 0.6, sx).oneMinus())
      albedo.mulAssign(seam.mul(0.45).mul(fine).oneMinus())
      tn.assign(bNrm(vec2(uv.x.mul(0.6), uv.y.mul(0.15)), 0).mul(vec3(0.35, 0.35, 1.0)))
      gloss.assign(0.32)
    })
    .ElseIf(id.lessThan(34.5), () => {
      // 革
      albedo.mulAssign(oNoise(uv.mul(40.0).add(seed)).mul(0.16).add(0.88))
      addTn(vec2(oNoise(uv.mul(70.0)), oNoise(uv.mul(70.0).add(3.0))).sub(0.5).mul(0.3).mul(nk))
      gloss.assign(0.35)
    })
    .ElseIf(id.lessThan(35.5), () => {
      // 段ボール（テープの帯）
      albedo.mulAssign(oNoise(uv.mul(8.0).add(seed)).mul(0.14).add(0.88))
      const tape = smoothstep(0.022, 0.026, abs(fract(uv.x.mul(2.0).add(seed)).sub(0.5)).mul(0.5)).oneMinus()
      albedo.assign(mix(albedo, vec3(0.72, 0.62, 0.42), tape.mul(0.6)))
      gloss.assign(0.04)
    })
    .ElseIf(id.lessThan(36.5), () => {
      // 塗り壁（ローラーの跡のごく薄いむら）
      albedo.mulAssign(oNoise(vec2(uv.x.mul(3.0), uv.y.mul(0.8)).add(seed)).mul(0.04).add(0.97).add(oNoise(uv.mul(40.0)).sub(0.5).mul(0.02)))
      If(aux.greaterThan(0.5), () => {
        albedo.mulAssign(step(0.5, fract(uv.x.mul(4.0))).mul(0.04).add(0.96))
      })
      gloss.assign(0.04)
    })
    .ElseIf(id.lessThan(37.5), () => {
      // 陶器
      albedo.mulAssign(n1.mul(0.03).add(0.98))
      gloss.assign(0.8)
    })
    .ElseIf(id.lessThan(38.5), () => {
      // 寝具（しわ）
      const wr = oNoise(vec2(uv.x.mul(6.0), uv.y.mul(2.0)).add(seed)).mul(0.6).add(oNoise(uv.mul(15.0)).mul(0.4))
      albedo.mulAssign(wr.mul(0.22).add(0.84))
      addTn(vec2(oNoise(uv.mul(8.0)), oNoise(uv.mul(8.0).add(5.0))).sub(0.5).mul(0.5).mul(nk))
      gloss.assign(0.02)
    })
    .Else(() => {
      // 黒い鉄のフレーム（粉体塗装）
      albedo.mulAssign(n1.mul(0.08).add(0.95))
      gloss.assign(0.28)
      metal.assign(0.25)
    })
}

const min2 = (a: F, b: F) => a.min(b)

/** 窓の多角形の 1 辺の形の係数（ランバートの多角形の式） */
const edgeFF = (a: V3, b: V3, N: V3) => {
  const c = cross(a, b).toVar()
  const l = length(c).toVar()
  return select(l.lessThan(1e-6), 0.0, acos(clamp(dot(a, b), -1.0, 1.0)).mul(dot(c.div(max(l, 1e-6)), N)))
}

/** 中の光（窓の光・太陽・灯り・まわりの明るさ）。呼ぶ側の Fn の中で式を組む（u は 1 棟ぶんの uniform） */
function interiorLight(u: InteriorUniforms) {
  const o = outdoorUniforms
  /** 窓の光の照度（窓の明るさ × 形の立体角）。group が同じ窓だけ */
  const windowLight = (wp: V3, N: V3, group: F) => {
    const acc = vec3(0.0).toVar()
    Loop(MAX_IWIN, ({ i }: { i: Node<'int'> }) => {
      If(i.greaterThanEqual(int(u.uIWinN)), () => {
        Break()
      })
      const A = u.uIWinA.node.element(i).toVar()
      If(abs(A.w.sub(group)).greaterThan(0.5), () => {
        Continue()
      })
      const p0 = A.xyz
      const U = u.uIWinU.node.element(i).xyz.toVar()
      const V = u.uIWinV.node.element(i).xyz.toVar()
      const r0 = normalize(p0.sub(wp)).toVar()
      const r1 = normalize(p0.add(U).sub(wp)).toVar()
      const r2 = normalize(p0.add(U).add(V).sub(wp)).toVar()
      const r3 = normalize(p0.add(V).sub(wp)).toVar()
      const s = edgeFF(r0, r1, N).add(edgeFF(r1, r2, N)).add(edgeFF(r2, r3, N)).add(edgeFF(r3, r0, N))
      acc.addAssign(u.uIWinL.node.element(i).mul(max(s.negate(), 0.0)).mul(0.15915))
    })
    return acc
  }

  /** 窓から差し込む太陽（花音のまわりの細かい影の地図で日なたか） */
  const interiorSun = (wp: V3, N: V3) => {
    const su = townShadowUniforms
    const res = float(0.0).toVar()
    If(su.uShadowLocalInfo.y.greaterThanEqual(0.5).and(o.uSunDir.y.greaterThanEqual(-0.02)), () => {
      const ndl = dot(N, o.uSunDir).toVar()
      If(ndl.greaterThan(0.0), () => {
        const slope = clamp(sqrt(max(ndl.mul(ndl).oneMinus(), 0.0)).div(max(ndl, 0.05)), 0.0, 6.0)
        const p = wp.add(N.mul(su.uShadowLocalInfo.x.mul(slope.add(1.5)))).add(o.uSunDir.mul(su.uShadowLocalInfo.x.mul(1.5)))
        const t = shadowTap(su.uShadowLocal, su.uShadowM2, p, su.uShadowTexel.z)
        res.assign(t.s.mul(t.inside).mul(ndl).mul(smoothstep(-0.02, 0.06, o.uSunDir.y)))
      })
    })
    return res
  }

  /** 灯りの照度（拡散）と、つやの照り返し（spec）。group が同じ灯りだけ */
  const lampLight = (wp: V3, N: V3, V: V3, group: F, gloss: F) => {
    const acc = vec3(0.0).toVar()
    const spec = vec3(0.0).toVar()
    const pw = mix(6.0, 120.0, gloss).toVar()
    Loop(MAX_ILAMP, ({ i }: { i: Node<'int'> }) => {
      If(i.greaterThanEqual(int(u.uILampN)), () => {
        Break()
      })
      const P = u.uILampP.node.element(i).toVar()
      const on = u.uILampOn.node.element(i).toVar()
      If(abs(P.w.sub(group)).greaterThan(0.5).or(on.lessThan(0.001)), () => {
        Continue()
      })
      const L = P.xyz.sub(wp).toVar()
      const R = u.uILampR.node.element(i).toVar()
      const d2 = dot(L, L).toVar()
      If(d2.greaterThan(R.mul(R)), () => {
        Continue()
      })
      const d = sqrt(d2).toVar()
      const l = L.div(max(d, 1e-4)).toVar()
      const C = u.uILampC.node.element(i).toVar()
      const kind = C.w.toVar()
      const Dd = u.uILampD.node.element(i).toVar()
      const D = Dd.xyz
      const r0 = Dd.w
      const down = l.y.negate().toVar()
      const k = select(
        kind.lessThan(0.5),
        1.0,
        select(
          kind.lessThan(1.5),
          mix(0.22, 1.0, smoothstep(-0.1, 0.6, down)),
          select(
            kind.lessThan(2.5),
            mix(0.05, 1.0, smoothstep(-0.05, 0.5, down)),
            select(
              kind.lessThan(3.5),
              abs(l.y).mul(0.55).add(0.45),
              select(kind.lessThan(4.5), smoothstep(0.55, 0.85, dot(l.negate(), D)).add(0.04), select(kind.lessThan(5.5), 1.0, max(dot(l.negate(), D), 0.0).mul(0.9).add(0.1))),
            ),
          ),
        ),
      )
      const fall = k.mul(smoothstep(R.mul(0.55), R, d).oneMinus()).div(d2.add(r0.mul(r0))).toVar()
      const c = C.rgb.mul(on).toVar()
      const ndl = max(dot(N, l), 0.0).toVar()
      acc.addAssign(c.mul(ndl).mul(fall))
      const H = normalize(l.add(V))
      spec.addAssign(c.mul(pow(max(dot(N, H), 0.0), pw)).mul(pw.add(2.0)).div(8.0).mul(fall).mul(ndl))
    })
    return { acc, spec }
  }

  /** 中の光をまとめて（albedo・法線 N・視線 V・環境光の遮り ao・つや・金属・組） */
  const interiorShade = (wp: V3, N: V3, V: V3, albedo: V3, ao: F, gloss: F, metal: F, group: F) => {
    const g = int(clamp(group, 0.0, MAX_IGROUP - 1).add(0.5))
    const amb = u.uIAmb.node.element(g).toVar()
    const lamp = lampLight(wp, N, V, group, gloss)
    const up = N.y.mul(0.5).add(0.5).toVar()
    const win = vec3(0.0).toVar()
    const diffuse = vec3(0.0).toVar()
    If(u.uIGlass.greaterThan(0.5).and(group.lessThan(0.5)), () => {
      // ガラスの温室（組 0 = ドームの大きな空間）: 太陽（町の影の地図・花音のまわりの細かい影）と空の光がガラス越しに入る。地面の照り返し
      const sh = townShadow(wp, N)
      const ndl = max(dot(N, o.uSunDir), 0.0)
      const sky = o.uSkyLight.mul(up.mul(0.55).add(0.3)).toVar()
      const bounce = o.uSunLight.mul(vec3(0.85, 0.9, 0.66)).mul(max(o.uSunDir.y, 0.0).mul(0.14).add(0.05)).mul(up.mul(-0.6).add(1.0))
      win.assign(sky.mul(0.6))
      diffuse.assign(o.uSunLight.mul(ndl).mul(sh).mul(0.86).add(sky.add(bounce).mul(ao)).add(lamp.acc).add(amb.mul(ao).mul(up.mul(0.35).add(0.75))))
    }).Else(() => {
      win.assign(windowLight(wp, N, group))
      const sun = interiorSun(wp, N)
      diffuse.assign(win.mul(mix(0.75, 1.0, ao)).add(o.uSunLight.mul(u.uISun).mul(sun)).add(lamp.acc).add(amb.mul(ao).mul(up.mul(0.35).add(0.75))))
    })
    // 外の塗り（paint.ts）の interior を入れたら、光はそちら（つやの照り返し・映り込みは足さない）
    const paint = outdoorPaint()
    if (paint?.interior) return paint.interior(albedo.mul(metal.mul(-0.6).add(1.0)), diffuse, amb, N, ao)
    const col = albedo.mul(metal.mul(-0.6).add(1.0)).mul(diffuse).toVar()
    const f0 = mix(0.04, 0.7, metal).toVar()
    const fres = f0.add(f0.oneMinus().mul(pow(clamp(dot(N, V).oneMinus(), 0.0, 1.0), 5.0))).toVar()
    col.addAssign(lamp.spec.mul(gloss).mul(fres).mul(2.0).mul(mix(vec3(1.0), albedo.mul(2.0), metal)))
    // 映り込み: 窓の光と部屋の明るさをぼんやり
    col.addAssign(amb.mul(1.2).add(win.mul(0.35)).mul(fres).mul(mix(gloss.mul(0.5), 0.9, metal)).mul(ao).mul(mix(vec3(1.0), albedo.mul(2.5), metal)))
    return col
  }

  return { interiorShade }
}

/** 中の面と家具 */
export function createInteriorSurfaceMaterial(u: InteriorUniforms) {
  const m = markPaint(unlit('interiorSurfaces', { side: THREE.FrontSide }), 'interior')
  // 中の面は汚れない（aExt.w は 0）
  const v = surfaceVaryings(0)
  m.colorNode = Fn(() => {
    const L = interiorLight(u)
    const wp = v.world
    const s = namedSurface(v, interiorSurface)
    const V = normalize(cameraPosition.sub(wp))
    const col = L.interiorShade(wp, s.Nd, V, s.albedo, s.ao, s.gloss, s.metal, v.ext.y).toVar()
    col.addAssign(paintEmit(s.albedo.mul(s.emit).mul(4.0).add(vec3(1.0, 0.85, 0.55).mul(s.emit).mul(0.5))))
    return outdoorHaze(col, wp)
  })()
  return withUniforms(m, u)
}

/** 光る物（電球・傘・画面の縁の光）。aMat = (灯りの番号, 強さ)。消えているときは昼の色（まわりの明るさ） */
export function createInteriorGlowMaterial(u: InteriorUniforms) {
  const o = outdoorUniforms
  const m = markPaint(unlit('interiorGlow'), 'glow')
  const v = surfaceVaryings(0)
  m.colorNode = Fn(() => {
    const li = int(clamp(v.mat.x, 0.0, MAX_ILAMP - 1).add(0.5))
    const on = u.uILampOn.node.element(li)
    const g = int(clamp(v.ext.y, 0.0, MAX_IGROUP - 1).add(0.5)).toVar()
    const day = v.color.mul(0.65).mul(u.uIAmb.node.element(g).mul(1.6).add(0.01)).toVar()
    // ガラスの温室（組 0）は、消えた灯具も空の光で見える
    If(u.uIGlass.greaterThan(0.5).and(g.equal(0)), () => {
      day.addAssign(v.color.mul(o.uSkyLight.mul(0.55).add(o.uSunLight.mul(max(normalize(v.normal).y, 0.0)).mul(0.12))))
    })
    const col = mix(day, paintEmit(v.color.mul(v.mat.y)), clamp(on, 0.0, 1.0))
    return outdoorHaze(col, v.world)
  })()
  return withUniforms(m, u)
}

/** 絵の板（アトラス）。aPic = (光り方, 組, 環境光の遮り) */
export function createInteriorPictureMaterial(u: InteriorUniforms, atlas: THREE.Texture) {
  const m = markPaint(unlit('interiorPictures'), 'interior')
  const uAtlas = texture(atlas)
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz))
  const vUv = varying(attribute<'vec2'>('aUv', 'vec2'))
  const vPic = varying(attribute<'vec3'>('aPic', 'vec3'))
  m.colorNode = Fn(() => {
    const L = interiorLight(u)
    const wp = positionWorld
    const N = normalize(vNormal).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    // アトラスは sRGB（ハードウェアがリニアにして読む）。前の GLSL と同じく、さらに 2.2 乗する（前の見た目のまま）
    const albedo = pow(max(uAtlas.sample(vUv).rgb, 0.0), vec3(2.2)).toVar()
    const mode = floor(vPic.x.add(0.5)).toVar()
    const col = vec3(0.0).toVar()
    If(mode.greaterThan(0.5).and(mode.lessThan(1.5)), () => {
      // 画面: 灯りに関係なく光る。少しの映り込み
      col.assign(paintEmit(albedo.mul(u.uIScreen)).add(L.interiorShade(wp, N, V, vec3(0.02), float(1.0), float(0.8), float(0.0), vPic.y).mul(0.5)))
    }).Else(() => {
      col.assign(L.interiorShade(wp, N, V, albedo.mul(0.92), vPic.z, select(mode.greaterThan(1.5), 0.3, 0.12), float(0.0), vPic.y))
    })
    return outdoorHaze(col, wp)
  })()
  return withUniforms(m, { ...u, uAtlas })
}

/**
 * 透けるガラス（窓・扉・棚）。外から見ると空と町を映し（ラボの外のガラスと同じ）、中から見ると部屋の明るさをうっすら映す
 * （夜は外が暗いので、中の映り込みが強い）。法線は外向き（中から見ると裏）
 */
export function createInteriorGlassMaterial(u: InteriorUniforms) {
  const o = outdoorUniforms
  const m = markPaint(unlit('interiorGlass', { transparent: true, depthWrite: false, side: THREE.DoubleSide }), 'window')
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz))
  const glass = paintFlat() ? outdoorPaint()?.glass : undefined
  if (glass) {
    // 外の塗り（paint.ts）の flat: 外から見るガラスは塗りの式、中から見るガラスは部屋の明るさの平らな映り（映り込み・きらめき・くもりは描かない）
    m.colorNode = Fn(() => {
      const wp = positionWorld
      const N = normalize(vNormal).toVar()
      const V = normalize(cameraPosition.sub(wp)).toVar()
      const out = vec4(0.0).toVar()
      If(dot(N, V).greaterThan(0.0), () => {
        out.assign(glass(N, V, wp, vec3(0.0)))
      }).Else(() => {
        const dark = smoothstep(0.02, 0.4, dot(o.uSkyLight, vec3(0.33))).oneMinus()
        out.assign(vec4(u.uIRefl, dark.mul(0.1).add(0.08)))
      })
      return vec4(outdoorHaze(out.rgb, wp), out.a)
    })()
    return withUniforms(m, u)
  }
  m.colorNode = Fn(() => {
    const alpha = float(0.0).toVar()
    const wp = positionWorld
    const N = normalize(vNormal).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const ndv = dot(N, V).toVar()
    const fres = pow(clamp(abs(ndv).oneMinus(), 0.0, 1.0), 5.0).mul(0.95).add(0.05).toVar()
    const smudge = oNoise(wp.xy.mul(2.3).add(wp.z)).mul(0.5).add(oNoise(wp.zy.mul(9.0)).mul(0.5)).toVar()
    const col = vec3(0.0).toVar()
    If(ndv.greaterThan(0.0), () => {
      const R = reflect(V.negate(), N).toVar()
      const refl = vec3(0.0).toVar()
      If(R.y.greaterThan(0.0), () => {
        refl.assign(skyColor(R))
      }).Else(() => {
        refl.assign(mix(skyColor(vec3(R.x, 0.02, R.z)).mul(0.45), o.uSkyLight.mul(0.25).add(o.uSunLight.mul(0.03)), smoothstep(0.0, 0.25, R.y.negate())))
      })
      const spec = pow(max(dot(R, o.uSunDir), 0.0), 900.0).mul(30.0).mul(smoothstep(-0.02, 0.05, o.uSunDir.y))
      col.assign(refl.add(o.uSunLight.mul(spec)))
      alpha.assign(clamp(fres.mul(0.85).add(0.05).add(smudge.mul(0.03)), 0.0, 0.9))
    }).Else(() => {
      // 中から: 部屋の明るさの映り込み（外が暗いほど強く見える）
      col.assign(u.uIRefl)
      const dark = smoothstep(0.02, 0.4, dot(o.uSkyLight, vec3(0.33))).oneMinus()
      alpha.assign(clamp(fres.mul(0.7).add(0.03).add(dark.mul(0.1)).add(smudge.mul(0.03)), 0.0, 0.85))
    })
    // 色と透け具合（alpha は材質の不透明度に掛かる）
    return vec4(outdoorHaze(col, wp), alpha)
  })()
  return withUniforms(m, u)
}
