import { attribute, cameraViewMatrix, float, max, min, modelViewMatrix, positionGeometry, select, uniform, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * 細い形（格子の桟・手すりの子柱・細い腕。断面の 2 つの向きが THIN_MAX m 以下で、長さがその THIN_RATIO 倍以上の棒）を、画素より細くなる遠くで
 * 画素の幅まで太らせる（名前のある建物の形 named/kitBuilder.ts・小物 town/props.ts）。
 *
 * 形が画素より細いと、三角形が画素の中心に乗ったり外れたりして、カメラが少し動くだけで線が切れたり出たりする（チカチカ。WebGPU の後処理は
 * 多重サンプルを読めないので MSAA を使っていない）。塗りの式では平均できない（三角形が描かれない画素には式が走らない）ので、頂点で太らせる:
 * 頂点ごとに「細い向きの、中心の線からの差」（aThin.xyz）と断面の半分の幅（aThin.w）を持たせ、中心の線の奥行きでの 1 画素の大きさ
 * （描いている画の画素。本番の書き出しの描く細かさ ssaa でもその画素）から、断面が minPx 画素より細ければ、その幅まで外へ広げる。
 * 近く（断面が画素より太い所）は前とまったく同じ形。広げる倍率は THIN_MAX_SCALE まで（それより遠い物は画素の何分の 1 にもならない）
 */
export const THIN_MAX = 0.06
export const THIN_RATIO = 3
export const THIN_MAX_SCALE = 8
/** 細い形を太らせる幅（画素） */
export const THIN_PX = 1

/** 頂点の位置（positionNode に入れる）。aThin の無い頂点（0）はそのまま */
export function thinWidened(minPx = THIN_PX): Node<'vec3'> {
  const t = attribute<'vec4'>('aThin', 'vec4')
  const center = positionGeometry.sub(t.xyz)
  // 中心の線の奥行きでの、描いている画の 1 画素の大きさ（m）
  const pixel = pixelAt(modelViewMatrix.mul(vec4(center, 1.0)).z.negate())
  const scale = min(max(float(1.0), pixel.mul(minPx * 0.5).div(max(t.w, 1e-4))), THIN_MAX_SCALE)
  return positionGeometry.add(t.xyz.mul(scale.sub(1.0)))
}

/**
 * 奥行き 1m で 1m が何画素か（描いている画の高さ ÷ (2 tan(画角/2))。landscape.ts が毎コマ書く。窓明かりの点の uPx と同じ値）。
 * （頂点の式の中では three の screenSize が描き先の大きさにならなかったので、自分で持つ）
 */
export const thinUniforms = { uPx: uniform(500) }

/** 奥行き viewZ（m）での、描いている画の 1 画素の大きさ（m） */
function pixelAt(viewZ: Node<'float'>) {
  return max(viewZ, 0.01).div(thinUniforms.uPx)
}

/**
 * インスタンスの箱（小物 town/props.ts。単位の箱を size 倍する）の大きさを、細い向き（THIN_MAX 以下で、いちばん長い向きがその THIN_RATIO 倍以上）だけ、
 * 箱の中心 center（シーン）の奥行きで minPx 画素まで太らせる（細い向きが 2 つの棒だけ）（THIN_MAX_SCALE 倍まで）
 */
export function thinSize(size: Node<'vec3'>, center: Node<'vec3'>, minPx = THIN_PX): Node<'vec3'> {
  const viewZ = cameraViewMatrix.mul(vec4(center, 1.0)).z.negate()
  const want = pixelAt(viewZ).mul(minPx)
  const long = max(max(size.x, size.y), size.z)
  const thin = (d: Node<'float'>) => d.lessThanEqual(THIN_MAX).and(long.greaterThanEqual(d.mul(THIN_RATIO)))
  // 棒（細い向きが 2 つ）だけ（板を太らせると、裏の壁へ食い込んだり手前へ浮いたりする）
  const rod = select(thin(size.x), 1.0, 0.0).add(select(thin(size.y), 1.0, 0.0)).add(select(thin(size.z), 1.0, 0.0)).equal(2.0)
  const widen = (d: Node<'float'>) => select(rod.and(thin(d)), min(max(d, want), d.mul(THIN_MAX_SCALE)), d)
  return vec3(widen(size.x), widen(size.y), widen(size.z))
}

/**
 * 塗りの式で描く縦の格子（間隔 pitch の座標 along の、fract の真ん中から外を桟にして、ほかを抜く）の、桟の見える幅の半分（fract の単位）。
 * 桟が minPx 画素より細くなる遠くでは、その幅まで太らせる（抜く・抜かないが画素ごとに入れ替わってチカチカしないように）
 */
export function barHalfWidth(base: number, fw: Node<'float'>, pitch: number, minPx = THIN_PX): Node<'float'> {
  return max(float(base), fw.div(pitch).mul(minPx * 0.5))
}
