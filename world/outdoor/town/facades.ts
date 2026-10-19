/**
 * 建物の外壁の型（TSL）。建物のシェーダー（townMaterials.ts の createTownBuildingMaterial）と遠くの窓明かりの点が使う。
 *
 * 外壁の型（FACADE_TYPE）は、インスタンスの値（外壁の種類・用途・印・階数・町並みの型・種）から頂点のシェーダーで 1 棟ごとに決める:
 * 0 木造の家（板張り・雨戸）/ 1 モルタルの家 / 2 （予備）/ 3 煉瓦（縦長の窓・アーチ・石の帯・軒蛇腹）/ 4 石造（1 階の目地・窓まわり・帯・軒蛇腹）/
 * 5 RC の集合住宅（正面のベランダ・掃き出し窓・隣との仕切り）/ 6 事務所（腰壁と連窓・縦の柱形）/ 7 カーテンウォール（方立てと腰のガラス）/
 * 8 工場・倉庫（波板・高い窓・シャッター）/ 9 学校（連窓・正面の廊下のベランダ）。1 階の店（印 shop）は、どの型でも正面の 1 階を店先にする。
 *
 * 窓は「階 × 間口」の格子。ガラスの色は外の塗り（paint.ts の window）、窓枠・格子・閉めた雨戸は形のまま。点き方は WINDOW_RULES（遠くの窓明かりの点と同じ答え）。
 * 窓が画素より小さい遠くでは、窓の面積と点いている割合の平均で描く（ちらつかない）。外壁はデータの色の平らな塗り（質感の写真・汚れは描かない）。
 */

import { Fn, If, abs, float, floor, fract, mod, select, vec2 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { oHash } from '../materials'
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
 * 光（太陽・空・環境光の遮り）: townLight(albedo, 法線, 環境光の遮り ao, 影 sh, 面の種類)（影は shadows.ts の townShadow）。
 * 外の塗り（paint.ts の light）に面の種類（surface。省けば other）と一緒に渡す
 */
export const townLight = (albedo: Node<'vec3'>, N: Node<'vec3'>, ao: Node<'float'> | number, sh: Node<'float'> | number, surface: PaintSurface = 'other'): Node<'vec3'> =>
  outdoorPaint().light(albedo, N, typeof ao === 'number' ? float(ao) : ao, typeof sh === 'number' ? float(sh) : sh, surface)

