import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  OnBeforeObjectUpdate,
  abs,
  attribute,
  buffer,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  fwidth,
  instanceIndex,
  instancedBufferAttribute,
  instancedDynamicBufferAttribute,
  int,
  length,
  mat3,
  mat4,
  max,
  min,
  mix,
  mod,
  modelWorldMatrix,
  normalGeometry,
  normalWorldGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  smoothstep,
  step,
  transpose,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { colorUniform, oHash, oNoise, outdoorHaze, outdoorUniforms, unlit, withUniforms } from '../materials'
import { townLight } from '../town/facades'
import { townShadow } from '../town/shadows'
import { townLamps } from '../town/lamps'
import { markPaint, outdoorPaint, paintEmit } from '../paint'

type Node<T = unknown> = THREE.Node<T>

/**
 * 交通の物（車両・船・線路・架線柱・停留所・信号・街灯の柱）の材質（TSL）。町と同じ光（太陽・空・町の影・空気遠近・夜の灯りの表）。
 *
 * 頂点: 位置・法線・色（質感を染める色。リニア）・aMat（x = 質感の種類 TM、y = 種類ごとの値）。site/builder.ts の GeoBuilder で作る。
 * 車両はインスタンス（instanceMatrix と iInfo = (x: 前照灯 +1 / 尾灯 -1 / なし 0, y: 車内の灯り 0〜1, z: 系統の色の番号, w: 種)）。
 *
 * - 塗装: 太陽のハイライトと空の映り込み（つや）、下ほど汚れ
 * - 客室の窓: 車内の箱（床・天井と灯り・向かいの窓と座席・手すり）を視差で描く（インテリアマッピング）。夜は車内の灯りで光る
 * - 行き先の表示: 系統の色の帯と、橙の点の文字（いつも光る）
 */

export const TM = {
  paint: 0,
  /** 窓（y < 0.5 客室（床の高さ = y × 10 m）・1 停留所や建物のガラス・2 運転台の前面） */
  glass: 1,
  metal: 2,
  /** 黒い物（台車・床下・ゴム。y = つや） */
  dark: 3,
  /** 屋根庭（多肉植物と苔） */
  garden: 4,
  /** 行き先の表示（y = 表示の左の端の局所の座標） */
  sign: 5,
  head: 6,
  tail: 7,
  /** 木（y = 色の濃さ） */
  wood: 8,
  /** 光る物（y = 強さ。灯りの点き具合 uLampOn に従う） */
  lamp: 9,
  /** コンクリート（y = 目地の間隔 m） */
  concrete: 10,
  /** 石（砂利・御影石） */
  stone: 11,
  /** 系統の色で塗る（停留所の標識。y = 系統の番号） */
  line: 12,
  /** 信号の灯（y = 色（0 赤・1 黄・2 青）+ 4 × 組（0 / 1）+ 8 × 位相の秒（0〜79）） */
  signal: 13,
  /** 布・座席（y = 色の番号） */
  cloth: 14,
  /** 観覧車のゴンドラの屋根の色（インスタンスの種で 5 色。y = つや） */
  tint: 15,
} as const

/** 系統の色（0 = なし、1〜4 = 緑電、5 = ヒノテツ、6 = 運河バス、7 = 連絡船）。中身は uLineColors.array（Color の配列）を書く */
const lineColors = Array.from({ length: 8 }, () => new THREE.Color(0.5, 0.5, 0.5))

export const transitUniforms = {
  /** 系統の色（配列の uniform。中身は .array（THREE.Color の配列）を書く） */
  uLineColors: uniformArray(lineColors, 'color' as const),
  /** 街灯・停留所の灯り・車内の灯りの点き具合（0〜1）と、夜の明るさの倍率 */
  uLampOn: uniform(0),
  uLightGain: uniform(1),
  /** 信号の時計（交通の時計の秒） */
  uSignalT: uniform(0),
}

/** 系統の色の配列の uniform の型（細かい車両の材質が受ける） */
export type LineColorsNode = typeof transitUniforms.uLineColors

/** 系統の色（番号 k。0〜7） */
export const lineColor = (k: Node<'float'>) => transitUniforms.uLineColors.element(int(k.add(0.5))) as unknown as Node<'vec3'>

/* -------------------------------------------------------------------------- */
/* 交通の材質の共有の部品（TSL。細かい車両・ケーブルカー・ホバーも使う）               */
/* -------------------------------------------------------------------------- */

export const LUMA = vec3(0.2126, 0.7152, 0.0722)
export const lum = (c: Node<'vec3'>) => dot(c, LUMA)

const interleavedMatrices = new WeakMap<THREE.InstancedBufferAttribute, THREE.InstancedInterleavedBuffer>()

/**
 * インスタンスの行列（ノード）。three の InstancedMesh の扱い（accessors/Instance.js）と同じ置き方で、もう 1 つ読む
 * （three は位置と法線にしか使わないので、局所の視線・太陽の向きを出すのに使う）。小さければ uniform の配列（毎コマ送られる）、
 * 大きければ頂点ごとの値（版を合わせる）。呼ぶ側の Fn の中で使う
 */
export function instanceMatrixOf(builder: THREE.NodeBuilder, im: THREE.InstancedBufferAttribute): Node<'mat4'> {
  const count = Math.max(im.count, 1)
  const limit = (builder as unknown as { getUniformBufferLimit(): number }).getUniformBufferLimit()
  if (count * 64 <= limit) return (buffer(im.array, 'mat4', count) as unknown as { element(i: unknown): Node<'mat4'> }).element(instanceIndex)
  let il = interleavedMatrices.get(im)
  if (!il) {
    il = new THREE.InstancedInterleavedBuffer(im.array, 16, 1)
    interleavedMatrices.set(im, il)
  }
  const buf = il
  OnBeforeObjectUpdate(() => {
    if (buf.version !== im.version) buf.version = im.version
  })
  const fn = im.usage === THREE.DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute
  return mat4(fn(buf, 'vec4', 16, 0), fn(buf, 'vec4', 16, 4), fn(buf, 'vec4', 16, 8), fn(buf, 'vec4', 16, 12)) as unknown as Node<'mat4'>
}

/** 描く物（InstancedMesh か）を見てから式を組む材質（前の GLSL の #ifdef USE_INSTANCING の代わり。three はインスタンスの物ごとに組み立てる） */
export class ObjectNodeMaterial extends THREE.MeshBasicNodeMaterial {
  buildNodes: ((m: ObjectNodeMaterial, builder: THREE.NodeBuilder) => void) | null = null

  setup(builder: THREE.NodeBuilder) {
    this.buildNodes?.(this, builder)
    super.setup(builder)
  }
}

/**
 * 形の局所の座標への行列（回転だけ。大きさは 1）の転置 = 世界 → 局所の回転（頂点で計算する）。
 * object が InstancedMesh なら model × instance、でなければ model
 */
export function localFrame(builder: THREE.NodeBuilder) {
  const object = builder.object as THREE.InstancedMesh
  const m = object?.isInstancedMesh && object.instanceMatrix ? modelWorldMatrix.mul(instanceMatrixOf(builder, object.instanceMatrix)) : modelWorldMatrix
  return { m, rt: transpose(mat3(m)) }
}

/** 頂点の色・材質の番号（GeoBuilder の color・aMat） */
export const vertexColorAttr = () => attribute<'vec3'>('color', 'vec3')
export const matAttr = () => attribute<'vec2'>('aMat', 'vec2')

/** 見ている側へ向けた世界の法線（GLSL の if (!gl_FrontFacing) N = -N と同じ。three の normalWorld は両面の材質だと裏で向きを替えてあるので使わない） */
export const facingNormal = () => normalize(normalWorldGeometry).mul(faceDirection)

/* -------------------------------------------------------------------------- */
/* 交通の物の材質                                                              */
/* -------------------------------------------------------------------------- */

/** 交通の物の色（instanced = InstancedMesh で描くか。前の GLSL の USE_INSTANCING） */
function transitColor(builder: THREE.NodeBuilder) {
  const object = builder.object as THREE.InstancedMesh
  const instanced = !!(object?.isInstancedMesh && object.instanceMatrix)
  const u = outdoorUniforms
  const tu = transitUniforms
  const vInfo = instanced ? attribute<'vec4'>('iInfo', 'vec4') : vec4(0.0, 0.0, 0.0, 0.5)
  // 汚れ・むら・質感の写真・車内の奥（インテリアマッピング）・照り返しは描かない（窓は外の塗りの window・光る物は emit）
  const paintWindow = outdoorPaint().window
  return Fn(() => {
    const wp = positionWorld.toVar()
    const N = facingNormal().toVar()
    const vLocal = positionGeometry.toVar()
    const vLocalN = normalGeometry.toVar()
    const mat = matAttr().toVar()
    const id = floor(mat.x.add(0.5)).toVar()
    const aux = mat.y.toVar()
    const info = vec4(vInfo).toVar()
    const V = normalize(cameraPosition.sub(wp)).toVar()
    const dist = length(cameraPosition.sub(wp)).toVar()
    const albedo = vertexColorAttr().toVar()
    const gloss = float(0.1).toVar()
    const metal = float(0.0).toVar()
    const emit = vec3(0.0).toVar()
    const ao = float(1.0).toVar()
    const result = vec3(0.0).toVar()
    const done = float(0.0).toVar()
    // 局所の座標の投影（質感・模様）
    const an = abs(vLocalN).toVar()
    const p = select(an.y.greaterThan(0.7), vLocal.xz, select(an.x.greaterThan(an.z), vLocal.zy, vLocal.xy)).toVar()
    const wuv = select(abs(N.y).greaterThan(0.7), wp.xz, select(abs(N.x).greaterThan(abs(N.z)), wp.zy, wp.xy)).toVar()
    // 車両の下ほど暗い（床下・台車のまわり）
    if (instanced) ao.assign(mix(0.55, 1.0, smoothstep(0.1, 1.0, vLocal.y)))
    If(id.lessThan(0.5), () => {
      // 塗装（aux = つや）
      gloss.assign(aux.mul(0.6).add(0.25))
    })
      .ElseIf(id.lessThan(1.5), () => {
        // 窓
        // 窓の式（車内の灯りが点いていれば灯りの色）。窓の中の位置は局所の座標から
        const lit = info.y.mul(tu.uLampOn).mul(select(aux.lessThan(0.5), 1.0, 0.0))
        const cell = fract(vec2(select(an.x.greaterThan(an.z), vLocal.z, vLocal.x).mul(0.8), vLocal.y.mul(0.9)))
        result.assign(outdoorHaze(paintWindow(lit, vec3(1.0, 0.86, 0.66).mul(1.6), N, V, cell), wp))
        done.assign(1.0)
      })
      .ElseIf(id.lessThan(2.5), () => {
        // ステンレス・アルミ（細かい筋）
        metal.assign(1.0)
        gloss.assign(0.55)
      })
      .ElseIf(id.lessThan(3.5), () => {
        gloss.assign(aux.mul(0.4).add(0.05))
      })
      .ElseIf(id.lessThan(4.5), () => {
        // 屋根庭: 多肉植物と苔の 2 色の塊
        albedo.assign(mix(vec3(0.035, 0.07, 0.022), vec3(0.09, 0.07, 0.03), smoothstep(0.62, 0.66, oNoise(p.mul(2.7).add(3.0)))))
        gloss.assign(0.03)
      })
      .ElseIf(id.lessThan(5.5), () => {
        // 行き先の表示（aux = 表示の左の端の局所の座標）: 系統の色の四角と、橙の点の文字（いつも光る。昼はうすく見える）
        const lc = lineColor(info.z)
        const along = select(an.x.greaterThan(an.z), vLocal.z, vLocal.x).toVar()
        const uu = abs(along.sub(aux)).toVar()
        const q = vec2(along, vLocal.y).mul(28.0).toVar()
        const cellId = floor(q).toVar()
        // 点（3.6cm ごと）と文字の升（点 5 × 7）は、画素より細かくなる遠くで平均の明るさへ移す（前は 20m ほど先から点が画素の間に落ちたり乗ったりして、
        // 走る電車の行き先がチカチカした）。fq = 1 画素あたりの点の数
        const fq = max(fwidth(q.x), fwidth(q.y)).toVar()
        const dotm = mix(smoothstep(0.25, 0.42, length(fract(q).sub(0.5))).oneMinus(), 0.35, smoothstep(0.35, 0.7, fq))
        const ch = mix(
          step(0.4, oHash(floor(cellId.div(vec2(5.0, 7.0))).add(info.z.mul(3.1)))).mul(step(0.3, oHash(cellId.add(info.z)))),
          0.42,
          smoothstep(0.15, 0.3, fq),
        )
        albedo.assign(vec3(0.01))
        emit.assign(vec3(1.0, 0.55, 0.12).mul(dotm).mul(ch).mul(1.4).mul(step(0.26, uu)))
        emit.addAssign(lc.mul(1.3).mul(step(0.22, uu).oneMinus()).mul(step(0.03, uu)))
        gloss.assign(0.6)
      })
      .ElseIf(id.lessThan(6.5), () => {
        // 前照灯（前の車両だけ）
        const on = step(0.5, info.x)
        albedo.assign(vec3(0.6))
        emit.assign(vec3(1.0, 0.95, 0.85).mul(on).mul(tu.uLampOn.mul(6.0).add(1.5)))
        gloss.assign(0.9)
      })
      .ElseIf(id.lessThan(7.5), () => {
        const on = step(info.x, -0.5)
        albedo.assign(vec3(0.12, 0.01, 0.01))
        emit.assign(vec3(1.0, 0.06, 0.04).mul(on).mul(tu.uLampOn.mul(2.4).add(0.6)))
        gloss.assign(0.9)
      })
      .ElseIf(id.lessThan(8.5), () => {
        gloss.assign(0.15)
      })
      .ElseIf(id.lessThan(9.5), () => {
        // 光る物（灯具・提灯）
        const vc = vertexColorAttr()
        emit.assign(vc.mul(aux).mul(tu.uLampOn).mul(tu.uLightGain))
        albedo.assign(vc.mul(0.4))
        gloss.assign(0.3)
        // 停留所の屋根の下（とゴンドラの天井）の大きな灯りの板（白に近い色・aux 1.6）は、下から見ると面全体が光る平らな白い板に
        // 見えたので、金属の天井板（継ぎ目の線と、灯りのまわりの明るい輪の 2 段）に、決まった間隔の丸い灯り（1.5m ごと）を並べる
        If(aux.greaterThan(1.55).and(aux.lessThan(1.65)).and(vc.b.greaterThan(0.6)).and(N.y.lessThan(-0.7)), () => {
          const q = fract(wuv.div(1.5)).sub(0.5).toVar()
          const r = length(q)
          const disc = step(r, 0.1)
          const pool = step(r, 0.25)
          const seam = step(0.47, max(abs(q.x), abs(q.y)))
          const on = tu.uLampOn.mul(tu.uLightGain)
          albedo.assign(mix(vec3(0.5, 0.52, 0.52), vec3(0.22, 0.23, 0.24), seam))
          emit.assign(vc.mul(on).mul(disc.mul(2.4).add(pool.mul(disc.oneMinus()).mul(0.22)).add(seam.oneMinus().mul(0.05))))
        })
      })
      .ElseIf(id.lessThan(10.5), () => {
        If(aux.greaterThan(0.01), () => {
          const g = abs(fract(wuv.div(aux).add(0.5)).sub(0.5)).mul(aux)
          const joint = smoothstep(0.004, fwidth(wuv.x).add(0.012), min(g.x, g.y)).oneMinus()
          albedo.mulAssign(joint.mul(0.35).mul(smoothstep(30.0, 120.0, dist).oneMinus()).oneMinus())
        })
        gloss.assign(0.06)
      })
      .ElseIf(id.lessThan(11.5), () => {
        gloss.assign(0.04)
      })
      .ElseIf(id.lessThan(12.5), () => {
        albedo.assign(lineColor(aux).mul(0.8))
        gloss.assign(0.4)
      })
      .ElseIf(id.lessThan(13.5), () => {
        // 信号の灯: 80 秒の周期で、組 0 は 0〜35 秒が青・35〜38 秒が黄、組 1 は 40 秒ずれる
        const colorId = mod(aux, 4.0).toVar()
        const group = mod(floor(aux.div(4.0)), 2.0)
        const tt = mod(tu.uSignalT.add(floor(aux.div(8.0))).add(group.mul(40.0)), 80.0).toVar()
        const state = select(tt.lessThan(35.0), 2.0, select(tt.lessThan(38.0), 1.0, 0.0))
        const on = step(0.5, abs(state.sub(colorId))).oneMinus()
        const c = select(colorId.lessThan(0.5), vec3(1.0, 0.08, 0.04), select(colorId.lessThan(1.5), vec3(1.0, 0.6, 0.05), vec3(0.05, 1.0, 0.55))).toVar()
        albedo.assign(c.mul(0.08))
        emit.assign(c.mul(on).mul(tu.uLampOn.mul(3.0).add(1.6)))
        gloss.assign(0.8)
      })
      .ElseIf(id.lessThan(14.5), () => {
        // 布
        gloss.assign(0.03)
      })
      .Else(() => {
        // ゴンドラの屋根（パステルの 5 色）
        const k = floor(fract(info.w.mul(5.0).add(0.01)).mul(5.0)).toVar()
        albedo.assign(
          select(
            k.lessThan(0.5),
            vec3(0.62, 0.16, 0.14),
            select(k.lessThan(1.5), vec3(0.14, 0.3, 0.52), select(k.lessThan(2.5), vec3(0.62, 0.5, 0.12), select(k.lessThan(3.5), vec3(0.16, 0.42, 0.26), vec3(0.55, 0.3, 0.42)))),
          ),
        )
        gloss.assign(aux.mul(0.6).add(0.25))
      })
    If(done.lessThan(0.5), () => {
      const sh = townShadow(wp, N).toVar()
      const col = townLight(albedo.mul(metal.mul(-0.6).add(1.0)), N, ao, sh, 'vehicle').toVar()
      // つやの照り返し・映り込みは描かない
      // 夜: 町の灯り
      col.addAssign(albedo.mul(townLamps(wp, N)))
      col.assign(outdoorHaze(col, wp))
      col.addAssign(paintEmit(emit).mul(exp(dist.negate().div(u.uHazeDist.mul(1.5)))))
      result.assign(col)
    })
    return result
  })()
}

/** 交通の物の材質（車両はインスタンス。動かない物は 1 つの形） */
export function createTransitMaterial() {
  const m = markPaint(new ObjectNodeMaterial({ fog: false, side: THREE.FrontSide }), 'light')
  m.name = 'transit'
  m.buildNodes = (mat, builder) => {
    mat.colorNode = transitColor(builder)
  }
  return m
}

/**
 * 細い線（架線・吊架線・観覧車のスポークの綱・ケーブルカーの綱・提灯の綱）。線分ごとの四角を、画面で 1.2px より細くならない太さに広げ、
 * 本当の太さが細い所はうすくする（遠くの線がちらつかない）。頂点: position = 端の点、aOther = もう一方の端、aSide = ±1、aWidth = 太さ（m）
 */
export function createWireMaterial(color: THREE.ColorRepresentation) {
  const uniforms = { uColor: colorUniform(new THREE.Color(color)), uPx: uniform(500), uGlow: uniform(0), uGlowColor: colorUniform(new THREE.Color(1, 0.8, 0.5)) }
  const m = markPaint(unlit('transitWire', { transparent: true, depthWrite: false, side: THREE.DoubleSide }), 'light')
  const paint = outdoorPaint()
  const aOther = attribute<'vec3'>('aOther', 'vec3')
  const aSide = attribute<'float'>('aSide', 'float')
  const aWidth = attribute<'float'>('aWidth', 'float')
  const wp0 = modelWorldMatrix.mul(vec4(positionGeometry, 1.0)).xyz.toVar()
  const wo = modelWorldMatrix.mul(vec4(aOther, 1.0)).xyz
  const cp = cameraViewMatrix.mul(vec4(wp0, 1.0))
  const d = max(cp.z.negate(), 0.1).toVar()
  // 画面の太さ（px）
  const px = aWidth.mul(uniforms.uPx).div(d).toVar()
  const w = max(px, 1.2).div(uniforms.uPx).mul(d)
  const dir = normalize(wo.sub(wp0))
  const toCam = normalize(cameraPosition.sub(wp0))
  const sideV = normalize(cross(dir, toCam))
  const wp = wp0.add(sideV.mul(aSide).mul(w).mul(0.5)).toVar()
  m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(wp, 1.0))
  const vAlpha = varying(clamp(px.div(1.2), 0.0, 1.0))
  const vWorld = varying(wp0)
  const vAlong = varying(aSide)
  // 線の色は上向きの面の光（外の塗りの light。綱の向きは平均）。光る分は emit
  const col = paint.light(uniforms.uColor, vec3(0.0, 1.0, 0.0), float(1.0), float(1.0), 'structure').add(paintEmit(uniforms.uGlowColor.mul(uniforms.uGlow)))
  m.colorNode = outdoorHaze(col, vWorld)
  m.opacityNode = vAlpha.mul(abs(vAlong).mul(-0.3).add(1.0))
  return withUniforms(m, uniforms)
}

/** 細い線の形を作る道具（線分を足して、最後に 1 つの形に） */
export class WireBatch {
  private pos: number[] = []
  private other: number[] = []
  private side: number[] = []
  private width: number[] = []
  private idx: number[] = []
  /** シーンの座標の 2 点 */
  seg(a: readonly number[], b: readonly number[], width: number) {
    const i0 = this.pos.length / 3
    // 4 つの角: a の左右・b の左右（横の向きは端から見たもう一方の端への向きで決まるので、b の側は符号を反対にしてそろえる）
    const corners: [readonly number[], readonly number[], number][] = [
      [a, b, -1],
      [a, b, 1],
      [b, a, 1],
      [b, a, -1],
    ]
    for (const [p, q, s] of corners) {
      this.pos.push(p[0], p[1], p[2])
      this.other.push(q[0], q[1], q[2])
      this.side.push(s)
      this.width.push(width)
    }
    this.idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2)
  }
  get empty() {
    return this.pos.length === 0
  }
  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('aOther', new THREE.Float32BufferAttribute(this.other, 3))
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(this.side, 1))
    g.setAttribute('aWidth', new THREE.Float32BufferAttribute(this.width, 1))
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}


/** 車両の下の丸い影（地面・高架の上。昼は濃く、夜はうすく）。InstancedMesh の 1 枚の板 */
export function createBlobMaterial() {
  const uniforms = { uStrength: uniform(0.5) }
  const m = markPaint(unlit('transitBlob', { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), 'flat')
  const q = uv().mul(2.0).sub(1.0)
  // 長い車両の下: 横は狭く、前後は端だけうすく
  const a = smoothstep(0.55, 1.0, abs(q.x)).oneMinus().mul(smoothstep(0.85, 1.0, abs(q.y)).oneMinus())
  m.colorNode = vec3(0.0)
  m.opacityNode = a.mul(uniforms.uStrength)
  return withUniforms(m, uniforms)
}
