import * as THREE from 'three/webgpu'
import { min, mix, select, vec4 } from 'three/tsl'
import { outdoorUniforms } from './materials'
import { townLight } from './town/facades'
import { outdoorPaint } from './paint'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>
type V3 = Node<'vec3'>

/**
 * 乗り物の車室・ゴンドラ・温室などの材質が共通に使う部品。外の面は外の塗り（paint.ts）の面の光の式（light。'vehicle' など）、
 * 中の面は中のある建物の中の光の式（interior）、透けるガラスは glass に通す
 */

/** 車室の面の光: 中（inside）は中の光の式（E = 灯り・窓から入る光の照度、amb = まわりの明るさ）、外は面の光の式 */
export function cabinLight(albedo: V3, N: V3, ao: F, sh: F, inside: Node<'bool'>, E: V3, amb: V3, surface: 'vehicle' | 'other' = 'vehicle'): V3 {
  const out = townLight(albedo, N, ao, sh, surface)
  return select(inside, outdoorPaint().interior(albedo, E, amb, N, ao), out)
}

/** 透けるガラス（rgb と透け a。外の塗りの glass）。camIn = カメラが中にいるか（中から見るガラスは外が見えるようにうすく） */
export function flatGlass(N: V3, V: V3, wp: V3, room: V3, camIn?: Node<'bool'>): Node<'vec4'> {
  const g = outdoorPaint().glass(N, V, wp, room).toVar()
  // 中から見るガラスは、帯の濃さ（透けの差）も消して一様にうすく（ゴンドラの中から見ると、すぐ前のガラスの斜めの帯が窓いっぱいの太い帯に見えた）
  if (camIn) g.assign(select(camIn, vec4(mix(g.rgb, room.add(outdoorUniforms.uSkyLight.mul(0.05)), 0.6), min(g.a, 0.2).mul(0.45)), g))
  return g
}
