import * as THREE from 'three/webgpu'
import {
  abs,
  clamp,
  dot,
  float,
  mat3,
  materialColor,
  max,
  min,
  mix,
  normalView,
  normalWorld,
  positionViewDirection,
  positionWorld,
  smoothstep,
  sqrt,
  step,
  texture,
  toneMappingExposure,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { METAL_ROLES, roleColor, roleOf, type AnimeRole } from './palette'

/**
 * アニメ塗りの素材（既定の塗り。scene/anime/LabAnime.tsx が、ラボの殻と什器・KB-001 の PBR の素材をこれに差し替える）。
 *
 * 光の計算は使わない（光を受けない MeshBasicNodeMaterial）。物ごとの下地（配色の表 palette.ts の役割の色）に時刻の配色（色味・明るさ）を掛け、
 * 1 つの決めた光の向き（キーライト。時刻で変わる）との N·L と、その光の影の地図（keyShadow.ts。物が落とす影）で、光の当たる側と影の 2 段に
 * くっきり塗り分ける（MToon と同じ考え）。その上に、
 * - ネオンの照り返し: ネオン・モニタ・ホロ・Qコアの近くの面に、光源の色の、境目のくっきりした帯を 2 段（光源の位置・色・強さは neon.ts が毎コマ書く）
 * - 金属の縁のハイライト: 金属（palette.ts の METAL_ROLES）の、視線に対して寝た面（縁・丸い物の輪郭の内側）に細く明るい帯
 * を塗り足す。部屋の点光源・環境の映り込み・床の映り込み・ガラスの映り込み・霧は使わない。
 * 色は「画面に出る色」（トーンマッピング・露出のあと）で書き、最後に ACES の逆に通して露出で割る（夜・夕方で露出が変わっても塗りの色は変わらない）。
 * 光る物（発光・画面・ホロ）・花音・町・窓の外は触らない
 */

/** ネオンの照り返しの光源の数（neon.ts が書く。足りない分は強さ 0） */
export const NEON_COUNT = 8

/** 素材の式が読む値（全部の差し替えた素材で共有。LabAnime.tsx が毎コマ書く。window.__ANIME__ から書き換えて確かめる） */
export function createAnimeUniforms() {
  return {
    /** 時刻の配色: 下地に掛ける色味×明るさ・影の色・光の当たる側の色（画面のリニアの値） */
    base: uniform(new THREE.Vector3(1, 1, 1)),
    shade: uniform(new THREE.Vector3(0.4, 0.4, 0.6)),
    key: uniform(new THREE.Vector3(1, 1, 1)),
    /** キーライトの向き（世界の座標。光が来る方向） */
    keyDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
    /** 影の境目（N·L）と、境目のなめらかさ（半分の幅。ごく狭く） */
    threshold: uniform(0.3),
    softness: uniform(0.012),
    /** 物が落とす影の地図（keyShadow.ts）: 使うか（0 / 1）・世界 → 地図の行列・地図の 1 画素の大きさ（uv）・偏り */
    shadowOn: uniform(0),
    shadowMatrix: uniform(new THREE.Matrix4()),
    shadowTexel: uniform(1 / 2048),
    shadowBias: uniform(0.0015),
    /** ネオンの照り返しの強さ（時刻）と、光源（xyz = 位置・w = 帯の外の半径（m））・色（rgb = 画面の色・a = 強さ） */
    neon: uniform(1),
    neonPos: uniformArray(Array.from({ length: NEON_COUNT }, () => new THREE.Vector4(0, -100, 0, 0)), 'vec4'),
    neonColor: uniformArray(Array.from({ length: NEON_COUNT }, () => new THREE.Vector4(0, 0, 0, 0)), 'vec4'),
    /** 金属の縁: 強さ（時刻）・縁とみなす角度（1 − |N·V| の下限）・明るさ */
    rim: uniform(1),
    rimStart: uniform(0.74),
    rimAmount: uniform(0.42),
  }
}
export type AnimeUniforms = ReturnType<typeof createAnimeUniforms>

/** 影の地図（keyShadow.ts が作る深さのテクスチャ。動かない物と動く物の 2 枚） */
export interface AnimeShadowTexture {
  depth: THREE.DepthTexture
  dynamicDepth: THREE.DepthTexture
}

/** 色の式の種類（全部の素材で、種類ごとに 1 つのノードを共有する。地図を持つ物は素材ごと） */
type Variant = 'plain' | 'metal'

/** 色の式を作る所（素材の式の部品を共有する） */
export class AnimeShading {
  readonly u: AnimeUniforms
  private readonly shadowTex: THREE.TextureNode
  private readonly dynamicShadowTex: THREE.TextureNode
  private readonly nodes = new Map<Variant, THREE.Node<'vec4'>>()

  constructor(u: AnimeUniforms, shadow: AnimeShadowTexture) {
    this.u = u
    this.shadowTex = texture(shadow.depth)
    this.dynamicShadowTex = texture(shadow.dynamicDepth)
  }

  /** 種類ごとの色の式（materialColor は素材ごとの color を読む） */
  node(variant: Variant): THREE.Node<'vec4'> {
    let n = this.nodes.get(variant)
    if (!n) {
      n = vec4(this.paint(vec3(materialColor), variant === 'metal'), 1.0)
      this.nodes.set(variant, n)
    }
    return n
  }

  /** 地図を持つ物（content）の色の式（地図の a で切り抜く。素材ごと） */
  mapNode(map: THREE.Texture): THREE.Node<'vec4'> {
    const t = texture(map).toVar()
    return vec4(this.paint(t.rgb.mul(materialColor), false), t.a)
  }

  /** 物が落とす影（1 = 光が届く・0 = 影）。地図の外は光が届く */
  private shadowed(): THREE.Node<'float'> {
    const u = this.u
    // 法線の向きへ少し押し出してから地図に写す（面が自分の影を拾うまだらを防ぐ）
    const p = positionWorld.add(normalWorld.mul(u.shadowTexel.mul(40.0)))
    const c = u.shadowMatrix.mul(vec4(p, 1.0))
    const q = vec2(c.x.mul(0.5).add(0.5), c.y.mul(-0.5).add(0.5))
    const ref = c.z.sub(u.shadowBias)
    const d = u.shadowTexel.mul(0.75)
    // 動かない物と動く物の地図の、近い方の深さと比べる
    const tap = (dx: number, dy: number) => {
      const at = q.add(vec2(d.mul(dx), d.mul(dy)))
      return step(ref, min(this.shadowTex.sample(at).r, this.dynamicShadowTex.sample(at).r))
    }
    const lit = tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25)
    // 4 点の平均を境目で切る（2 値。縁だけ 1 画素ほどなめらかに）
    const hard = smoothstep(0.3, 0.7, lit)
    const inside = step(0.0, q.x).mul(step(q.x, 1.0)).mul(step(0.0, q.y)).mul(step(q.y, 1.0)).mul(step(c.z, 1.0))
    return mix(float(1), hard, inside.mul(u.shadowOn))
  }

  /** ネオンの照り返し（画面の色に足す色）。光源ごとに、帯の外（半径 w）と内（半径の半分）の 2 段 */
  private neon(): THREE.Node<'vec3'> {
    const u = this.u
    let sum: THREE.Node<'vec3'> = vec3(0)
    for (let i = 0; i < NEON_COUNT; i++) {
      const lp = u.neonPos.element(i) as unknown as THREE.Node<'vec4'>
      const lc = u.neonColor.element(i) as unknown as THREE.Node<'vec4'>
      const to = lp.xyz.sub(positionWorld)
      const dist = to.length()
      // 光源の方を向いた面だけ（裏・真横は塗らない）
      const facing = step(0.3, dot(normalWorld, to.div(max(dist, 1e-4))))
      const outer = step(dist, lp.w)
      const inner = step(dist, lp.w.mul(0.5))
      const band = outer.mul(0.4).add(inner.mul(0.6)).mul(facing)
      sum = sum.add(lc.rgb.mul(lc.a.mul(band)))
    }
    return sum.mul(u.neon)
  }

  /** 下地（画面の色）を塗り分けて、トーンマッピングの前の色にする */
  private paint(base0: THREE.Node<'vec3'>, metal: boolean): THREE.Node<'vec3'> {
    const u = this.u
    const base = base0.mul(u.base).toVar()
    const ndl = dot(normalWorld, u.keyDir)
    const lit = smoothstep(u.threshold.sub(u.softness), u.threshold.add(u.softness), ndl).mul(this.shadowed())
    let c: THREE.Node<'vec3'> = mix(base.mul(u.shade), base.mul(u.key), lit)
    // ネオンの照り返し: 下地の明るさに応じて足す（暗い面ほど色が乗って見える。白飛びしないよう、画面の色で 0.97 までに収める）
    c = c.add(this.neon().mul(base.add(0.12)))
    if (metal) {
      // 金属の縁: 視線に対して寝た面（1 − |N·V| が rimStart から上）に、光の色寄りの明るい帯。光の当たる側を強く
      const nv = abs(dot(normalView, positionViewDirection)).oneMinus()
      const edge = smoothstep(u.rimStart, u.rimStart.add(0.03), nv).mul(lit.mul(0.6).add(0.4)).mul(u.rim).mul(u.rimAmount)
      c = mix(c, max(c, u.key.mul(0.85)), edge)
    }
    return inverseAces(c)
  }
}

/** three の ACES（ToneMappingFunctions.js の acesFilmicToneMapping）の行列の逆（TSL の mat3(9 つの数) は Matrix3.set と同じく行の順） */
const ACES_IN_INV = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777).invert()
const ACES_OUT_INV = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602).invert()

/**
 * 画面の色（トーンマッピングのあとのリニアの色）から、トーンマッピングの前の色に戻す（ACES の逆。露出でも割る）。
 * 下地・影の色を「画面にこの色で出る」値で書けるようにする
 */
export function inverseAces(display: THREE.Node<'vec3'>): THREE.Node<'vec3'> {
  const y = vec3(clamp(mat3(ACES_OUT_INV).mul(display), 0.0, 0.97)).toVar()
  // RRTAndODTFit の逆: (x² + a x − b) = y (k x² + k d x + e) を x について解く
  const a = 0.0245786
  const b = 0.000090537
  const k = 0.983729
  const d = 0.432951
  const e = 0.238081
  const qa = float(1).sub(y.mul(k))
  const qb = float(a).sub(y.mul(k * d))
  const qc = float(b).add(y.mul(e))
  const x = vec3(qb.negate().add(sqrt(max(qb.mul(qb).add(qa.mul(qc).mul(4)), 0.0))).div(qa.mul(2)))
  const lin = vec3(mat3(ACES_IN_INV).mul(max(x, vec3(0.0)))).mul(0.6)
  return min(lin.div(max(toneMappingExposure as unknown as THREE.Node<'float'>, 1e-4)), vec3(1e3))
}

/** 名前（素材・物と親を 3 段まで）を集める（配色の表を直すときの手がかり） */
export function namesOf(mesh: THREE.Object3D, material: THREE.Material): string {
  const names = [material.name]
  let o: THREE.Object3D | null = mesh
  for (let i = 0; i < 4 && o; i++, o = o.parent) names.push(o.name)
  return names.filter(Boolean).join(' / ')
}

/** 役割を決める（素材の名前の表 → 名前の無い物は、地図を持てば中身・色を物ごとに持てば tinted・ほかは元の色から） */
export function classify(material: THREE.MeshStandardMaterial, mesh: THREE.Mesh): AnimeRole {
  const role = roleOf(material.name)
  if (role !== 'auto') return role
  if (material.map) return 'content'
  const inst = mesh as THREE.InstancedMesh
  if ((inst.isInstancedMesh && inst.instanceColor) || material.vertexColors) return 'tinted'
  return 'auto'
}

/** 差し替える素材（光を受けない。色は役割の下地、地図は中身（content）だけ残す） */
export function createAnimeMaterial(src: THREE.MeshStandardMaterial, mesh: THREE.Mesh, shading: AnimeShading): { material: THREE.MeshBasicNodeMaterial; role: AnimeRole } {
  const role = classify(src, mesh)
  const m = new THREE.MeshBasicNodeMaterial()
  m.name = `anime:${role}:${src.name}`
  m.color.copy(roleColor(role, src.color))
  let colorNode = shading.node(METAL_ROLES.has(role) ? 'metal' : 'plain')
  if (role === 'content' && src.map) {
    // 地図の色 × 元の色（付箋の紙の色など）× 下地の明るさ
    m.color.multiply(src.color)
    colorNode = shading.mapNode(src.map)
  }
  m.side = src.side
  m.transparent = src.transparent
  m.opacity = src.opacity
  m.alphaTest = src.alphaTest
  m.alphaMap = src.alphaMap
  m.depthWrite = src.depthWrite
  m.depthTest = src.depthTest
  m.polygonOffset = src.polygonOffset
  m.polygonOffsetFactor = src.polygonOffsetFactor
  m.polygonOffsetUnits = src.polygonOffsetUnits
  m.vertexColors = src.vertexColors
  m.visible = src.visible
  // ワールドの物（作品・部品）の印刷・現れる演出のクリッピングと、透明度の演出の元の値（world/World.tsx。差し替えたあとは差し替えた素材を直接書く）
  m.clippingPlanes = src.clippingPlanes
  m.clipIntersection = src.clipIntersection
  m.clipShadows = src.clipShadows
  if (src.userData.baseOpacity !== undefined) {
    m.userData.baseOpacity = src.userData.baseOpacity
    m.userData.baseTransparent = src.userData.baseTransparent
  }
  m.fog = false
  m.colorNode = colorNode
  return { material: m, role }
}

/** 差し替えてよい素材か（PBR の物（ガラス・張り紙の半透明も）。発光・画面・ホロ・トーンマッピングしない物は外す） */
export function isAnimeTarget(m: THREE.Material): boolean {
  const s = m as THREE.MeshStandardMaterial & { isNodeMaterial?: boolean; fragmentNode?: unknown; outputNode?: unknown }
  if (!s.isMeshStandardMaterial) return false
  if (m.name.startsWith('anime:')) return false
  if (s.toneMapped === false) return false
  if (s.emissiveMap) return false
  if (s.emissive && s.emissiveIntensity > 0.2 && (s.emissive.r > 0 || s.emissive.g > 0 || s.emissive.b > 0)) return false
  if (s.isNodeMaterial && (s.fragmentNode || s.outputNode)) return false
  return true
}

/** 影を落とさない役割（部屋の殻: 床・壁・天井・中二階の床。光を遮ると部屋じゅうが影になる。ガラス） */
const NO_CAST: ReadonlySet<AnimeRole> = new Set(['floor', 'wall', 'backing', 'ceiling', 'deck', 'glass'])

/** 影を落とす物にしてよいか（部屋の殻・ガラス・半透明の物は落とさない） */
export function castsAnimeShadow(role: AnimeRole, m: THREE.Material): boolean {
  return !NO_CAST.has(role) && !m.transparent
}

/**
 * 毎コマ、元の素材の変わる値を写す（見え方・透明度）。透明度は元の素材の値が変わったときだけ写す（差し替えた素材を直接書く演出
 * （ワールドの物の現れる・消える。world/World.tsx の setFade）を上書きしない）。last = 前に写した元の透明度
 */
export function syncAnime(source: THREE.MeshStandardMaterial, anime: THREE.MeshBasicNodeMaterial, last: { opacity: number }) {
  anime.visible = source.visible
  if (source.opacity !== last.opacity) {
    last.opacity = source.opacity
    anime.opacity = source.opacity
  }
}
