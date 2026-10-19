import * as THREE from 'three/webgpu'
import { cameraViewMatrix, float, luminance, materialReference, mix, normalView, uniform, vec3, vec4 } from 'three/tsl'
import type { VRM } from '@pixiv/three-vrm'
import { outdoor } from '../../world/environment/daylight'
import { outsideness } from '../../world/environment/outsideness'
import { DYNAMIC_CASTER_LAYER } from '../../world/anime/keyShadow'
import { FACE_LINE, LINE_ID, OUTLINE_LAYER } from '../../world/anime/outline'
import type { AnimeTimeName } from '../../world/anime/palette'
import { interiorLight } from '../../world/outdoor/interior/interiors'
import { outdoorLights } from '../../world/outdoor/outdoorLighting'
import { lampLightAt } from '../../world/outdoor/town/lamps'
import { isVrmMToon, type VrmMToon, type VrmRim } from './loadVrm'

/**
 * アニメ塗りのラボ・町に立つ VRM の MToon の合わせ（地図の既定。react の TownView が町の注目点の人の VRM に入れて、毎コマ光を書く）。
 * VRM のファイルは変えず、読み込んだあとの材質の値で。どの VRM にも既定の値で効き、使う側は材質ごと・mesh ごとの上書き（configureVrmAnime）を渡せる
 * （kanon-stream-video の花音は、材質の名前で決めた表を渡す）。
 *
 * ラボの塗り（下地 × 影の色の青紫・輪郭線）と町の塗りに合わせて、人が一段白く浮く・夜に暗く沈むのを抑える:
 * - 明暗の向き: MToon の明暗の境を、光ごとの向きでなく 1 つの向き（ラボのキーライトの向き。町では町の光の向き）で 1 本に分ける（lightFromKey）。
 *   光ごとの向きは明るさにだけ効かせ、光の色は鮮やかさを抑えて足し、光の和が明るい所はなだらかに抑える（knee）。光の当たる側には時刻の光の色の照り（glow。夕方は橙）
 * - 影の色を背景の影の色（青紫）へ寄せる（shadeColorFactor に掛ける）。明暗の境をくっきり（shadingToony）
 * - 露出（色に掛ける）を少し下げ、時刻ごとの倍率と、外の夜の倍率を掛ける
 * - 縁の光（parametric rim）を弱く。肌・髪は消す（推定。上書きで変えられる）
 * - 輪郭線: 背景と同じ後処理の線（world/anime/outline.ts）の層を mesh に足す。MToon の outline は太さ 0（後処理の線と二重になる）。
 *   目・眉・まつ毛・レンズには引かず、肌・口の中・髪は顔の線の引き方（FACE_LINE）、部位の境目は番号（LINE_ID）で引く（材質の名前から推定。上書きで変えられる）
 * - 外（町・名前のある建物の中・乗り物の中）にいる間は、明暗の向きを町の光の向き（外は太陽・月か夜にいちばん近い灯り、中のある建物の中は部屋の灯りと窓）へ移し、
 *   近くの町の灯りの照度の和（lampLightAt）をその色のままもう 1 つの光として足す
 * - ライトの影の地図を受けない（receiveShadow。髪の房・帽子のつばの影が粗いぎざぎざで落ちた）
 *
 * 光の値（明暗の向き・灯り・露出）はページに 1 組（町の注目点の人に合わせる）
 */
export const VRM_ANIME = {
  /** 影の色に掛ける色（画面の sRGB）と、影の境目のずらし・くっきりさ（MToon の shadingShift・shadingToony に足す・その値にする） */
  shadeTint: '#c4bcec',
  shadingShift: 0,
  shadingToony: 0.95,
  /** 色・影の色に掛ける露出と、時刻ごとの倍率（夜・夜中はラボの下地が暗いので、人も少し落とす。配色の重みで混ぜる） */
  exposure: 0.8,
  timeExposure: { day: 1, dusk: 0.96, night: 0.92, deep: 0.88 },
  /** 縁の光（rim.color）に掛ける倍率 */
  rim: 0.5,
  /** MToon の outline の太さの倍率（0 = 描かない。線は後処理の線で引く） */
  outlineWidth: 0,
  /** 肌に掛ける強さ（0 = 合わせない・1 = ほかの部位と同じ。影の色・露出を元の値との間で混ぜる） */
  skin: 0.5,
  /** 明暗の向き: 光ごとの向きでなく、1 つの向きで明暗を分ける。光ごとの向きは明るさにだけ facing の割合で効かせる */
  facing: 0.4,
  /** 人に当たる光の明るさの倍率と、光の色の鮮やかさ（0 = 白い光・1 = ライトの色のまま。ネオン・天井のシアンの光で服が青緑に染まりすぎないように） */
  light: 1,
  lightSaturation: 0.45,
  /** 光の当たる量を抑える目安（時刻ごと。光の和の明るさが knee を越えた分をなだらかに抑える） */
  knee: { day: 4, dusk: 3, night: 12, deep: 12 },
  /** 色に掛ける、時刻の配色の光の色の色味の強さ（弱く） */
  keyTint: 0.15,
  /** 光の当たる側に足す、時刻の配色の光の色の照り（光の当たる側の明るさに比べて足す。時刻ごとの強さ。夕方は橙の照り） */
  glow: { day: 0.1, dusk: 0.35, night: 0.06, deep: 0.04 },
  /** ライトの影の地図を受けるか */
  receiveShadow: false,
  /**
   * 町での光。townLamp: 外にいる間、近くの町の灯りの照度の和を、その色のままもう 1 つの光として足す倍率。townSaturation: 外にいる間のライトの色の鮮やかさ
   * （lightSaturation の代わり）。townExposure: 外にいる間の夜（night・deep の重み）の露出の倍率（夜の町で顔が読めるように）
   */
  townLamp: 0.9,
  townSaturation: 0.8,
  townExposure: 1.18,
} as const

/** 材質ごとの合わせ方（上書き。省いた欄は既定） */
export interface VrmAnimeMaterialRule {
  /** 合わせない（元の値のまま。目・レンズなど） */
  keep?: boolean
  /** 合わせる強さ（0〜1。肌は VRM_ANIME.skin） */
  weight?: number
  /** 明暗の境目のずらし（shadingShift に足す） */
  shift?: number
  /** 影の色を「色 × ratio」へ amount だけ寄せる（影の色が暗すぎる材質） */
  shadeLift?: { ratio: number; amount: number }
  /** 縁の光を消す */
  noRim?: boolean
}

/** mesh ごとの輪郭線の引き方（上書き） */
export interface VrmAnimeLineRule {
  /** 輪郭線を引かない（層に入れない） */
  none?: boolean
  /** 顔の線の引き方（内側の折れの線なし・外形は大きな段差だけ。outline.ts の FACE_LINE） */
  face?: boolean
  /** 部位の番号（1〜15。番号の違う物どうしの境目に線を引く。outline.ts の LINE_ID） */
  id?: number
}

/** 上書き（材質の名前（MToon の outline の写しの「 (Outline)」を除いた物）と mesh から。null を返せば既定の推定） */
export interface VrmAnimeOverrides {
  material?: (name: string) => VrmAnimeMaterialRule | null
  line?: (mesh: THREE.Mesh, name: string) => VrmAnimeLineRule | null
}

let overrides: VrmAnimeOverrides = {}

/** 上書きを入れる（VRM を読み込む前に。null で既定の推定に戻す。合わせ終えた材質は変わらない） */
export function configureVrmAnime(next: VrmAnimeOverrides | null) {
  overrides = next ?? {}
}

/* -------------------------------------------------------------------------- */
/* 部位の推定（材質の名前から。VRoid の名前（N00_000_00_EyeIris_00_EYE など）と、よくある名前）                */
/* -------------------------------------------------------------------------- */

/** 目・眉・まつ毛・レンズ（合わせない・線を引かない） */
const EYE = /eye|iris|pupil|highlight|lash|brow|lens|瞳|白目|まつ毛|眉/i
/** 肌・顔・口の中（弱く合わせる・顔の線・縁の光なし） */
const SKIN = /skin|face|body|mouth|teeth|tongue|肌|顔|口/i
/** 髪（顔の線・縁の光なし） */
const HAIR = /hair|髪/i

type Part = 'eye' | 'skin' | 'hair' | 'other'
function partOf(name: string): Part {
  if (EYE.test(name)) return 'eye'
  if (HAIR.test(name)) return 'hair'
  if (SKIN.test(name)) return 'skin'
  return 'other'
}

/** 既定の材質の合わせ方（推定） */
function guessMaterial(name: string): VrmAnimeMaterialRule {
  const part = partOf(name)
  if (part === 'eye') return { keep: true }
  if (part === 'skin') return { weight: VRM_ANIME.skin, noRim: true }
  if (part === 'hair') return { noRim: true }
  return {}
}

/** 推定の部位の番号（肌 1・髪 2、ほかは材質ごとに 3〜14） */
const otherIds = new Map<string, number>()
function guessLine(name: string): VrmAnimeLineRule {
  const part = partOf(name)
  if (part === 'eye') return { none: true }
  if (part === 'skin') return { face: true, id: 1 }
  if (part === 'hair') return { face: true, id: 2 }
  let id = otherIds.get(name)
  if (id === undefined) otherIds.set(name, (id = 3 + (otherIds.size % 12)))
  return { id }
}

const materialRule = (name: string) => overrides.material?.(name) ?? guessMaterial(name)
const lineRule = (mesh: THREE.Mesh, name: string) => overrides.line?.(mesh, name) ?? guessLine(name)

/** VRM の材質の名前（MToon の outline の写しは「 (Outline)」が付く） */
export function vrmMaterialName(m: THREE.Material) {
  return m.name.replace(/ \(Outline\)$/, '')
}

/* -------------------------------------------------------------------------- */
/* 光の式                                                                        */
/* -------------------------------------------------------------------------- */

const done = new WeakSet<object>()
/** 合わせた材質の、時刻の倍率を掛ける前の色・影の色 */
const bases = new Map<VrmMToon, { color: THREE.Color; shade: THREE.Color }>()
let lastExposure = 1
const lastKey = new THREE.Color(1, 1, 1)
/** 合わせた材質が増えたか（次の updateVrmAnime で書く） */
let dirty = true

/** 人に当たる光の明るさの倍率（光の式の中でライトの色に掛ける） */
const vrmLight = uniform(VRM_ANIME.light)
const vrmSaturation = uniform(VRM_ANIME.lightSaturation)
const vrmKnee = uniform(VRM_ANIME.knee.dusk)
/** 明暗を分ける向き（世界の座標。ラボのキーライトの向きと町の光の向きを、外にいる度合いで混ぜた物） */
const vrmKeyDir = uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize())
/** 近くの町の灯りの照度の色（リニア。外にいる間だけ）と、人から灯りへの向き（世界の座標） */
const vrmLampColor = uniform(new THREE.Vector3())
const vrmLampDir = uniform(new THREE.Vector3(0, 1, 0))
/** 光の当たる側に足す照りの色 */
const vrmGlow = uniform(new THREE.Vector3())

type LightData = { lightDirection: THREE.Node<'vec3'>; lightColor: THREE.Node<'vec3'> } & Record<string, unknown>
type Model = { direct(data: LightData, builder: unknown): void; indirect(builder: unknown): void }

/**
 * MToon の光の式を、明暗の向きだけ 1 つの向きにする（three-vrm の MToon の光の式をそのまま使い、渡す光の向きを替える）。
 * ラボには向きの違う光が 30 ほどあり（天井のスポット・ネオンの照り返しなど）、光ごとの向きで明暗を分けると、どこかの光が当たって
 * ほとんど全部が光の当たる側になった。明暗の境は背景と同じキーライトの向きで 1 本にし、光ごとの向きは明るさにだけ効かせる（光の色はそのまま足す）
 */
function lightFromKey(m: VrmMToon, keyView: THREE.Node<'vec3'>, lampView: THREE.Node<'vec3'>) {
  const mat = m as unknown as { setupLightingModel(builder: unknown): Model }
  const setup = mat.setupLightingModel.bind(mat)
  const facing = VRM_ANIME.facing
  mat.setupLightingModel = (builder) => {
    const inner = setup(builder)
    const model = Object.create(inner) as Model
    /** 光の明るさの和（光の当たる量を抑えるのに使う） */
    const sum = float(0).toVar('KanonLightSum')
    model.direct = (data, b) => {
      const w = normalView.dot(data.lightDirection).clamp(0, 1).mul(facing).add(1 - facing)
      const c = data.lightColor
      const color = mix(vec3(luminance(c)), c, vrmSaturation).mul(w).mul(vrmLight)
      ;(sum as unknown as { addAssign(v: THREE.Node<'float'>): void }).addAssign(luminance(color))
      inner.direct({ ...data, lightDirection: keyView, lightColor: color }, b)
    }
    model.indirect = (b) => {
      const ctx = (b as { context: { reflectedLight: { directDiffuse: THREE.Node<'vec3'>; directSpecular: THREE.Node<'vec3'> } } }).context
      // ここまでに全部の光が足してある（three の LightingModel.start は光を足してから indirect を呼ぶ）。光の和が明るい所だけをなだらかに抑える
      // （下地の色の明るさでは抑えない。抑えると光の当たる側だけが沈んで、明暗の差が減った）
      // 近くの町の灯り（外にいる間）をもう 1 つの光として、その色のまま足す（明暗の向きは灯りの向き）
      inner.direct({ lightDirection: lampView, lightColor: vrmLampColor, reflectedLight: ctx.reflectedLight } as unknown as LightData, b)
      ;(sum as unknown as { addAssign(v: THREE.Node<'float'>): void }).addAssign(luminance(vrmLampColor))
      const d = ctx.reflectedLight.directDiffuse
      const shift = materialReference('shadingShiftFactor', 'float') as unknown as THREE.Node<'float'>
      const feather = float(1).sub(materialReference('shadingToonyFactor', 'float') as unknown as THREE.Node<'float'>)
      const lit = normalView.dot(keyView).add(shift).add(feather).div(feather.mul(2)).clamp()
      // 光の当たる側（MToon の明暗の境と同じ式。境目のずらしの地図は使わない）に、時刻の光の色の照りを光の明るさに比べて足す
      const k = sum.div(vrmKnee).add(1)
      const compressed = d.div(k)
      ;(d as unknown as { assign(v: THREE.Node<'vec3'>): void }).assign(compressed.add(vrmGlow.mul(lit).mul(luminance(compressed))))
      // 縁の光（光の色に掛かる分）も同じだけ抑える（抑えないと、窓際の頬に縁の光が白い帯で浮いた）
      const sp = ctx.reflectedLight.directSpecular
      ;(sp as unknown as { assign(v: THREE.Node<'vec3'>): void }).assign(sp.div(k))
      inner.indirect.call(model, b)
    }
    return model
  }
}

/** 素材（の 1 つ）が透けるか */
const isTransparent = (m: THREE.Material | THREE.Material[]) => (Array.isArray(m) ? m.some((x) => x.transparent) : m.transparent)

/**
 * 読み込んだ VRM の MToon を合わせる（同じ材質には 1 回だけ。rim は縁の光の色を持つ物（Character の rim））と、mesh に輪郭線の層・動く物の影の層
 * （ラボのキーライトの影。world/anime/keyShadow.ts）を足す。明暗の向き・光は updateVrmAnime が毎コマ書く
 */
export function applyVrmAnime(vrm: VRM, rim: VrmRim | null) {
  const tint = new THREE.Color(VRM_ANIME.shadeTint)
  const keyView = cameraViewMatrix.mul(vec4(vrmKeyDir, 0)).xyz.normalize()
  const lampView = cameraViewMatrix.mul(vec4(vrmLampDir, 0)).xyz.normalize()
  let changed = false
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    // ライトの影の地図を受けない（明暗は 1 つの向きで分ける）
    mesh.receiveShadow = VRM_ANIME.receiveShadow
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!isVrmMToon(mat) || done.has(mat)) continue
      done.add(mat)
      const m: VrmMToon = mat
      m.needsUpdate = true
      const rule = materialRule(vrmMaterialName(m))
      if (rule.keep) continue
      changed = true
      lightFromKey(m, keyView, lampView)
      // 強さ（肌は弱く: 影の色の色味・露出・くっきりさを元の値との間で混ぜる）
      const w = rule.weight ?? 1
      const shadeTint = new THREE.Color(1, 1, 1).lerp(tint, w)
      const exposure = 1 + (VRM_ANIME.exposure - 1) * w
      m.shadeColorFactor.multiply(shadeTint).multiplyScalar(exposure)
      m.color.multiplyScalar(exposure)
      m.shadingShiftFactor += VRM_ANIME.shadingShift * w + (rule.shift ?? 0)
      m.shadingToonyFactor += Math.max(0, VRM_ANIME.shadingToony - m.shadingToonyFactor) * w
      m.outlineWidthFactor *= VRM_ANIME.outlineWidth
      const lift = rule.shadeLift
      if (lift) m.shadeColorFactor.lerp(m.color.clone().multiplyScalar(lift.ratio), lift.amount)
      bases.set(m, { color: m.color.clone(), shade: m.shadeColorFactor.clone() })
    }
  })
  if (changed) dirty = true
  if (changed && rim && !done.has(rim)) {
    // 縁の光の色（外にいる度合いで混ぜる元の色）を弱める。今の材質にも書く
    done.add(rim)
    rim.color.multiplyScalar(VRM_ANIME.rim)
    for (const m of rim.tuned) m.parametricRimColorFactor.multiplyScalar(VRM_ANIME.rim)
  }
  if (changed && rim) {
    // 縁の光を消す材質は、外にいる度合いで色を書き直す一覧（rim.tuned）からも外す
    for (let i = rim.tuned.length - 1; i >= 0; i--) {
      const m = rim.tuned[i]!
      if (!materialRule(vrmMaterialName(m as unknown as THREE.Material)).noRim) continue
      m.parametricRimColorFactor.setRGB(0, 0, 0)
      rim.tuned.splice(i, 1)
    }
  }
  // 輪郭線の層・動く物の影の層・線の引き方
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    o.layers.enable(DYNAMIC_CASTER_LAYER)
    const first = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const name = first ? vrmMaterialName(first) : ''
    // 線の規則は材質のどれかが引かない・顔なら、その mesh 全体に（three の読み込みでは 1 つの材質ごとに 1 つの mesh）
    const rules = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => lineRule(mesh, vrmMaterialName(m)))
    if (!isTransparent(mesh.material) && !rules.some((r) => r.none)) o.layers.enable(OUTLINE_LAYER)
    if (rules.some((r) => r.face)) mesh.userData[FACE_LINE] = true
    mesh.userData[LINE_ID] = lineRule(mesh, name).id ?? 15
  })
}

const _key = new THREE.Color()
const WHITE = new THREE.Color(1, 1, 1)
/** 町の光（外にいる度合い 0〜1） */
const townState = { outside: 0 }
const _dir = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _townDir = new THREE.Vector3()
const _lamp = new THREE.Vector3()
const _lampDir = new THREE.Vector3()

/**
 * 毎コマ: 人の明暗の向きと町の灯り、時刻の倍率と光の色（ラボの塗りの時刻の配色のあと）。position = 人の位置（足元）、labKeyDir = ラボのキーライトの向き（世界）、
 * weights = ラボの時刻の配色の重み、key = 混ぜた時刻の配色の光の当たる側の色（画面のリニアの値）
 */
export function updateVrmAnime(position: THREE.Vector3, labKeyDir: THREE.Vector3, weights: Record<AnimeTimeName, number>, key: THREE.Vector3) {
  updateVrmTown(position, labKeyDir)
  updateVrmExposure(weights, key)
}

/**
 * 明暗の向きと町の灯り: 町（外・名前のある建物の中・乗り物の中）にいる度合いで、明暗の向きをラボのキーライトから町の光の向きへ移す。町の光の向きは、
 * 地図の外の光（outdoorLighting。外は太陽・月か夜にいちばん近い灯り、中のある建物の中は部屋の灯りと窓）の向き。外にいる間は、近くの町の灯りの照度の和
 * （灯りの表。lampLightAt）を、その色のままもう 1 つの光として足す
 */
function updateVrmTown(position: THREE.Vector3, labKey: THREE.Vector3) {
  const outside = THREE.MathUtils.clamp(outsideness(_pos.copy(position)), 0, 1)
  const { sun } = outdoorLights()
  _townDir.copy(sun.position).sub(sun.target.position)
  if (_townDir.lengthSq() < 1e-6) _townDir.copy(outdoor.sunDir)
  _townDir.normalize()
  const indoor = THREE.MathUtils.clamp(interiorLight.active, 0, 1)
  if (indoor > 0.001) _townDir.lerp(interiorLight.dir, indoor).normalize()
  _lamp.set(0, 0, 0)
  _lampDir.set(0, 1, 0)
  if (outside > 0.001 && indoor < 0.999) {
    lampLightAt(_pos.x, _pos.y + 1.3, _pos.z, _lamp, _lampDir)
    _lamp.multiplyScalar(1 - indoor)
  }
  townState.outside = outside
  _dir.copy(labKey).lerp(_townDir, outside)
  if (_dir.lengthSq() < 1e-6) _dir.copy(_townDir)
  vrmKeyDir.value.copy(_dir.normalize())
  vrmLampColor.value.copy(_lamp).multiplyScalar(VRM_ANIME.townLamp * outside)
  vrmLampDir.value.copy(_lampDir)
}

/** 時刻の倍率と光の色を掛ける（材質の色は変わったときだけ書く） */
function updateVrmExposure(weights: Record<AnimeTimeName, number>, key: THREE.Vector3) {
  // 光の和を抑える目安と照りは uniform なので毎コマ書く
  let k = 1 + (VRM_ANIME.townExposure - 1) * townState.outside * (weights.night + weights.deep)
  vrmSaturation.value = VRM_ANIME.lightSaturation + (VRM_ANIME.townSaturation - VRM_ANIME.lightSaturation) * townState.outside
  let kk = 0
  let g = 0
  let knee = 0
  for (const name of Object.keys(VRM_ANIME.timeExposure) as AnimeTimeName[]) {
    kk += VRM_ANIME.timeExposure[name] * weights[name]
    g += VRM_ANIME.glow[name] * weights[name]
    knee += VRM_ANIME.knee[name] * weights[name]
  }
  k *= kk
  vrmKnee.value = knee
  vrmGlow.value.copy(key).multiplyScalar(g)
  // 光の色は、いちばん明るい成分を 1 にそろえて、色味だけを掛ける
  _key.setRGB(key.x, key.y, key.z)
  _key.multiplyScalar(1 / Math.max(1e-4, _key.r, _key.g, _key.b))
  _key.lerpColors(WHITE, _key, VRM_ANIME.keyTint)
  const keyChanged = Math.abs(_key.r - lastKey.r) + Math.abs(_key.g - lastKey.g) + Math.abs(_key.b - lastKey.b) > 0.004
  if (Math.abs(k - lastExposure) < 0.003 && !keyChanged && bases.size > 0 && !dirty) return
  lastExposure = k
  lastKey.copy(_key)
  dirty = false
  for (const [m, b] of bases) {
    m.color.copy(b.color).multiplyScalar(k).multiply(_key)
    m.shadeColorFactor.copy(b.shade).multiplyScalar(k)
  }
}

/** 今の MToon の値（確かめる用） */
export function vrmAnimeMaterials(vrm: VRM | null) {
  const out: Record<string, unknown>[] = []
  vrm?.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!isVrmMToon(mat)) continue
      out.push({
        mesh: mesh.name,
        name: mat.name,
        outline: mat.isOutline,
        visible: mat.visible && mesh.visible,
        transparent: mat.transparent,
        opacity: mat.opacity,
        alphaTest: mat.alphaTest,
        side: mat.side,
        color: `#${mat.color.getHexString()}`,
        shade: `#${mat.shadeColorFactor.getHexString()}`,
        shift: mat.shadingShiftFactor,
        toony: mat.shadingToonyFactor,
        outlineMode: mat.outlineWidthMode,
        outlineWidth: mat.outlineWidthFactor,
        outlineColor: `#${mat.outlineColorFactor.getHexString()}`,
      })
    }
  })
  return out
}
