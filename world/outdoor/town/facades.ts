/**
 * 建物の外壁の型（TSL）。建物のシェーダー（townMaterials.ts の createTownBuildingMaterial）と遠くの窓明かりの点が使う。
 *
 * 外壁の型（FACADE_TYPE）は、インスタンスの値（外壁の種類・用途・印・階数・町並みの型・種）から頂点のシェーダーで 1 棟ごとに決める:
 * 0 木造の家（板張り・雨戸）/ 1 モルタルの家 / 2 （予備）/ 3 煉瓦（縦長の窓・アーチ・石の帯・軒蛇腹）/ 4 石造（1 階の目地・窓まわり・帯・軒蛇腹）/
 * 5 RC の集合住宅（正面のベランダ・掃き出し窓・隣との仕切り）/ 6 事務所（腰壁と連窓・縦の柱形）/ 7 カーテンウォール（方立てと腰のガラス）/
 * 8 工場・倉庫（波板・高い窓・シャッター）/ 9 学校（連窓・正面の廊下のベランダ）。1 階の店（印 shop）は、どの型でも正面の 1 階を店先にする。
 *
 * 窓は「階 × 間口」の格子。窓の中は部屋の奥行きを描く（インテリアマッピング: 窓の額縁の奥行き（見込み）→ ガラス → 部屋の箱（奥の壁・横の壁・床・天井・家具の影）、
 * カーテン・レース・ブラインド・閉めた雨戸）。昼は暗い部屋と空の映り込み、夜は点いた部屋が電球色に光る（点き方は WINDOW_RULES。遠くの窓明かりの点と同じ答え）。
 * 窓が画素より小さい遠くでは、窓の面積と点いている割合の平均で描く（ちらつかない）。
 * 外壁は CC0 の実写の質感（townTextures.ts）をデータの色で染め、汚れ（足元・窓の下の雨だれ・上端の筋・まだら）と色あせを建物ごとにばらつかせる。
 */

import { Fn, If, abs, clamp, dot, float, floor, fract, length, max, min, mix, mod, select, sign, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { oHash, outdoorUniforms } from '../materials'
import { outdoorPaint, type PaintSurface } from '../paint'

/** 外壁の型の番号（GLSL の facadeType と同じ） */
export const FACADE_TYPE = { woodHouse: 0, mortarHouse: 1, brick: 3, stone: 4, apartment: 5, office: 6, curtainWall: 7, factory: 8, school: 9 } as const

type F = Node<'float'>

/** 印のビットが立っているか（補間された値は整数から少しずれるので、丸めてから） */
export const hasFlag = (flags: F, bit: number) => mod(floor(floor(flags.add(0.5)).add(0.5).div(bit)), 2.0).greaterThan(0.5)
/** a と b が同じ整数の値か（|a − b| < 0.5） */
export const near = (a: F, b: number) => abs(a.sub(b)).lessThan(0.5)

/**
 * 窓の並びと、点いているかの決め方（建物のシェーダーと遠くの窓明かりの点が同じ答えを出す。TSL。前の GLSL の WINDOW_RULES）。
 * use: 0 住宅・1 併用・2 商業・3 事務所・4 港・5 工房・6 公共・7 ラボ・8 学校・9 宗教。flags: 2 高架下・4 屋上緑化・8 花・16 店・32 倉庫・64 高い・128 生け垣
 */
/** 外壁の型（1 棟ごと。FACADE_TYPE） */
export const facadeType = Fn(([facade, use, flags, floors, style, seed]: [F, F, F, F, F, F]) => {
  const r = float(1.0).toVar()
  const oldTown = near(style, 2.0).or(near(style, 7.0)).or(near(style, 1.0)).toVar()
  const officeUse = near(use, 3.0).or(near(use, 6.0)).or(near(use, 7.0)).or(near(use, 2.0).and(floors.greaterThan(4.5)))
  If(near(facade, 4.0), () => {
    r.assign(7.0)
  })
    .ElseIf(hasFlag(flags, 32.0).or(near(facade, 6.0)), () => {
      r.assign(8.0)
    })
    .ElseIf(near(use, 8.0).and(floors.greaterThan(1.5)), () => {
      r.assign(9.0)
    })
    .ElseIf(near(facade, 3.0).or(near(facade, 7.0)).and(oldTown.or(floors.lessThan(4.5)).or(fract(seed.mul(5.7)).lessThan(0.5))), () => {
      r.assign(3.0)
    })
    // 石の外壁は、古い町（洋風・島・和）と低い建物だけ石造。中層の町の「石のような色」の壁は RC の集合住宅・事務所にする
    .ElseIf(near(facade, 2.0).and(oldTown.or(floors.lessThan(2.5)).or(near(use, 6.0)).or(near(use, 9.0))), () => {
      r.assign(4.0)
    })
    .ElseIf(officeUse.and(floors.greaterThan(2.5)), () => {
      r.assign(6.0)
    })
    .ElseIf(
      use
        .lessThan(2.5)
        .and(floors.greaterThan(2.5))
        .and(floors.greaterThan(3.5).or(fract(seed.mul(7.31)).lessThan(0.6)).or(near(style, 3.0)).or(near(style, 4.0))),
      () => {
        r.assign(5.0)
      },
    )
    .ElseIf(near(facade, 2.0).or(near(facade, 3.0)), () => {
      r.assign(select(near(facade, 3.0), 3.0, 1.0))
    })
    .ElseIf(near(facade, 0.0), () => {
      r.assign(0.0)
    })
  return r
})

/** 窓の間口の目安（m） */
export const bayTarget = Fn(([type]: [F]) =>
  select(
    near(type, 7.0),
    1.5,
    select(near(type, 8.0), 6.0, select(near(type, 9.0), 3.6, select(near(type, 6.0), 3.0, select(near(type, 5.0), 3.3, select(near(type, 3.0), 3.1, select(near(type, 4.0), 3.0, 2.9)))))),
  ),
)

/** その用途・階の窓が点いている割合（w = 窓・o = 事務所・s = 店の点き具合の uniform） */
export function occupancy(use: F, flags: F, floorIndex: F, front: Node<'bool'>, type: F, w: F, o: F, s: F) {
  return select(
    hasFlag(flags, 16.0).and(floorIndex.lessThan(0.5)).and(front),
    s,
    select(near(type, 8.0), o.mul(0.35), select(near(use, 3.0).or(use.greaterThan(5.5).and(use.lessThan(9.5))), o, select(use.greaterThan(3.5).and(use.lessThan(5.5)), o.mul(0.5), w))),
  )
}

/** 窓ごとの乱数（窓の列 bi・階 fi・壁の向き side・建物の種 seed） */
export const windowHash = Fn(([bi, fi, side, seed]: [F, F, F, F]) => oHash(vec2(bi.add(side.mul(37.0)).add(seed.mul(311.0)), fi.add(seed.mul(71.0)))))

/** 外壁の質感の層（townTextures.ts の BUILDING_LAYER。前の GLSL の FACADE_KIND） */
export const wallLayer = Fn(([facade, type, seed]: [F, F, F]) => {
  const r = float(1.0).toVar()
  If(near(facade, 0.0), () => {
    r.assign(0.0)
  })
    .ElseIf(near(facade, 2.0).and(near(type, 4.0)), () => {
      r.assign(2.0)
    })
    .ElseIf(near(facade, 2.0), () => {
      r.assign(select(fract(seed.mul(3.77)).lessThan(0.45), 6.0, 1.0))
    })
    .ElseIf(near(facade, 3.0).or(near(facade, 7.0)), () => {
      r.assign(3.0)
    })
    .ElseIf(near(facade, 6.0), () => {
      r.assign(5.0)
    })
    .ElseIf(near(facade, 4.0), () => {
      r.assign(4.0)
    })
    .ElseIf(near(type, 8.0), () => {
      r.assign(5.0)
    })
    .ElseIf(near(type, 5.0).or(near(type, 6.0)).and(fract(seed.mul(3.77)).lessThan(0.38)), () => {
      r.assign(6.0)
    })
    .ElseIf(near(facade, 5.0), () => {
      r.assign(4.0)
    })
  return r
})

/** 汚れやすさ（町並みの型と種から。古い町ほど汚れ、新しい高層はきれい） */
export const dirtOf = Fn(([style, seed]: [F, F]) => {
  const b = select(
    near(style, 1.0),
    0.65,
    select(near(style, 2.0), 0.75, select(near(style, 3.0), 0.5, select(near(style, 4.0), 0.18, select(near(style, 5.0), 0.32, select(near(style, 6.0), 0.85, select(near(style, 7.0), 0.7, 0.45)))))),
  )
  return b.mul(fract(seed.mul(91.7)).mul(0.9).add(0.55))
})

/**
 * 光（太陽・空・照り返し・環境光の遮り）: townLight(albedo, 法線, 環境光の遮り ao, 影 sh, 面の種類)（影は shadows.ts の townShadow）。
 * 太陽の直射（影 sh）と空の光（ao）と、地面の照り返し（下を向くほど・太陽が高いほど暖色）。
 * 外の塗り（paint.ts）の light を入れたら、そちらに面の種類（surface。省けば other）と一緒に渡す
 */
export const townLight = (albedo: Node<'vec3'>, N: Node<'vec3'>, ao: Node<'float'> | number, sh: Node<'float'> | number, surface: PaintSurface = 'other'): Node<'vec3'> => {
  const p = outdoorPaint()
  if (p?.light) return p.light(albedo, N, typeof ao === 'number' ? float(ao) : ao, typeof sh === 'number' ? float(sh) : sh, surface)
  return townLightBase(albedo, N, ao, sh)
}

/** 前の townLight の式（TSL の Fn。外の塗りの式から読める） */
export const townLightBase = Fn(([albedo, N, ao, sh]: [Node<'vec3'>, Node<'vec3'>, Node<'float'>, Node<'float'>]) => {
  const u = outdoorUniforms
  const ndl = max(dot(N, u.uSunDir), 0.0)
  const up = N.y.mul(0.5).add(0.5)
  const sky = u.uSkyLight.mul(up.mul(0.5).add(0.22))
  const bounce = u.uSunLight.mul(vec3(0.95, 0.82, 0.66)).mul(max(u.uSunDir.y, 0.0).mul(0.16).add(0.06)).mul(up.mul(-0.6).add(1.0))
  return albedo.mul(u.uSunLight.mul(ndl.mul(sh)).add(sky.add(bounce).mul(ao)))
})
/**
 * 窓の奥の部屋（インテリアマッピング）。p = 開口の中の位置（m。左下が 0）、sz = 開口の大きさ、rd = 接空間の視線（x 壁に沿って・y 上・z 壁の奥へ）、
 * reveal = 額縁の見込み（m）、yF・yC = 開口の下端から床・天井まで（m）、D = 部屋の奥行き、rs = 部屋の乱数、lit = 点いているか、lamp = 灯りの色。
 * 戻り値: color = 光を当てたあとの色。見込みに当たったら hitR = 1 と見込みの面の向き revealN（接空間）。
 *
 * TSL（WebGPU への移行の第 2 段）: 前の GLSL の out の引数を返すため、Fn ではなく、呼ぶ側の Fn の中で式を組み立てる関数（呼んだ所に式が入る）。
 * 呼ぶのは建物（townMaterials.ts）と名前のある建物（namedMaterial.ts）の 1 か所ずつ
 */
export function roomInterior(
  p: Node<'vec2'>,
  sz: Node<'vec2'>,
  rd0: Node<'vec3'>,
  reveal: Node<'float'> | number,
  yF: Node<'float'>,
  yC: Node<'float'>,
  D: Node<'float'>,
  rs: Node<'float'>,
  lit: Node<'float'>,
  lamp: Node<'vec3'>,
  office: Node<'float'>,
) {
  const u = outdoorUniforms
  const rv = typeof reveal === 'number' ? float(reveal) : float(reveal)
  const color = vec3(0.0).toVar()
  const hitR = float(0.0).toVar()
  const revealN = vec2(0.0).toVar()
  const rdz = max(rd0.z, 0.03).toVar()
  const rxy = vec2(select(abs(rd0.x).lessThan(1e-4), 1e-4, rd0.x), select(abs(rd0.y).lessThan(1e-4), 1e-4, rd0.y)).toVar()
  const pg = p.add(rd0.xy.mul(rv.div(rdz))).toVar()
  If(pg.x.lessThan(0.0).or(pg.x.greaterThan(sz.x)).or(pg.y.lessThan(0.0)).or(pg.y.greaterThan(sz.y)), () => {
    const tb = mix(vec2(0.0), sz, step(0.0, rxy)).sub(p).div(rxy).toVar()
    hitR.assign(1.0)
    revealN.assign(select(tb.x.lessThan(tb.y), vec2(sign(rxy.x).negate(), 0.0), vec2(0.0, sign(rxy.y).negate())))
  }).Else(() => {
    const o = vec3(pg, rv).toVar()
    const ex = fract(rs.mul(5.3)).mul(1.4).add(0.9)
    const bmin = vec3(ex.negate(), yF, rv)
    const bmax = vec3(sz.x.add(ex), yC, rv.add(D))
    const r = vec3(rxy, rdz).toVar()
    const tb = mix(bmin, bmax, step(0.0, r)).sub(o).div(r).toVar()
    const t = min(tb.x, min(tb.y, tb.z)).toVar()
    const h = o.add(r.mul(t)).toVar()
    const depth = clamp(h.z.sub(rv).div(D), 0.0, 1.0).toVar()
    // 部屋の色（壁は白・生成り・薄い色、床は木・畳・灰色のカーペット、天井は白）
    const k1 = fract(rs.mul(13.1)).toVar()
    const k2 = fract(rs.mul(7.7)).toVar()
    const wallC = mix(vec3(0.62, 0.58, 0.5), vec3(0.5, 0.52, 0.5), k1).mul(mix(0.75, 1.05, k2)).toVar()
    If(k2.greaterThan(0.86), () => {
      wallC.assign(mix(vec3(0.45, 0.5, 0.42), vec3(0.55, 0.45, 0.38), k1))
    })
    const floorC = select(k1.lessThan(0.35), vec3(0.32, 0.2, 0.11), select(k1.lessThan(0.6), vec3(0.42, 0.4, 0.22), vec3(0.22, 0.22, 0.23))).toVar()
    If(office.greaterThan(0.5), () => {
      wallC.assign(vec3(0.55, 0.56, 0.55))
      floorC.assign(vec3(0.16, 0.17, 0.19))
    })
    const c = vec3(0.0).toVar()
    const add = vec3(0.0).toVar()
    const back = t.equal(tb.z).toVar()
    const flr = t.equal(tb.y).and(r.y.lessThan(0.0)).toVar()
    const ceil = t.equal(tb.y).and(r.y.greaterThan(0.0)).toVar()
    If(back, () => {
      c.assign(wallC)
      // 家具の影（棚・ソファ・机）と、壁の額
      const fx = fract(h.x.mul(0.29).add(rs.mul(3.1)))
      const fh = mix(0.8, 1.9, step(0.55, fract(rs.mul(17.3))))
      If(h.y.sub(yF).lessThan(fh).and(fx.lessThan(0.5)), () => {
        c.assign(mix(vec3(0.16, 0.11, 0.07), vec3(0.3, 0.28, 0.25), fract(rs.mul(29.0))))
      }).ElseIf(abs(h.y.sub(yF).sub(1.55)).lessThan(0.25).and(abs(fract(h.x.mul(0.21).add(rs)).sub(0.6)).lessThan(0.08)), () => {
        c.assign(mix(vec3(0.5, 0.3, 0.2), vec3(0.2, 0.3, 0.45), k1))
      })
      If(office.greaterThan(0.5).and(h.y.sub(yF).lessThan(0.75)), () => {
        c.assign(vec3(0.25, 0.25, 0.27))
      })
    })
      .ElseIf(flr, () => {
        c.assign(floorC)
      })
      .ElseIf(ceil, () => {
        c.assign(vec3(0.7, 0.69, 0.66))
      })
      .Else(() => {
        c.assign(wallC.mul(0.9))
        // 横の壁の家具
        If(h.y.sub(yF).lessThan(0.9).and(h.z.sub(rv).greaterThan(D.mul(0.35))), () => {
          c.assign(mix(vec3(0.2, 0.14, 0.09), vec3(0.35, 0.33, 0.3), k2))
        })
      })
    // 昼: 窓からの光（奥ほど暗い。床は窓の近くが明るい）
    const dayL = u.uSkyLight.mul(0.7).add(u.uSunLight.mul(0.09)).mul(mix(1.0, 0.3, depth)).toVar()
    If(flr, () => {
      dayL.mulAssign(depth.oneMinus().mul(0.8).add(1.0))
    })
    // 夜: 天井の灯り（点いている部屋だけ）
    const lp = vec3(sz.x.mul(0.5), yC.sub(0.1), rv.add(D.mul(0.45))).toVar()
    const dl = h.sub(lp)
    const lf = float(1.0).div(dot(dl, dl).mul(0.35).add(1.0)).toVar()
    const nightL = lamp.mul(lit).mul(lf.mul(1.5).add(0.35)).toVar()
    If(ceil, () => {
      nightL.assign(lamp.mul(lit).mul(lf.mul(0.8).add(0.4)))
      If(office.greaterThan(0.5), () => {
        // 事務所の天井の照明の列
        const rowsZ = abs(fract(h.z.sub(rv).div(1.8)).sub(0.5))
        const rowsX = abs(fract(h.x.div(2.4)).sub(0.5))
        add.addAssign(vec3(2.2).mul(lit).mul(smoothstep(0.02, 0.08, rowsZ).oneMinus()).mul(smoothstep(0.3, 0.42, rowsX).oneMinus()))
      }).Else(() => {
        add.addAssign(lamp.mul(2.4).mul(lit).mul(smoothstep(0.12, 0.32, length(h.xz.sub(lp.xz))).oneMinus()))
      })
    })
    color.assign(c.mul(dayL.add(nightL)).add(add))
  })
  return { color, hitR, revealN }
}
