import * as THREE from 'three'
import { glowMaterial, overlayGlowMaterial, type LabMaterials } from '../../materials/labMaterials'
import { cachedCanvasTexture, FONTS, radialGlowTexture, roundedRectPath } from '../../textures/canvas'
import type { Vec3 } from '../../../core/lab/plan'
import { mesh } from './object'
import { markDynamic } from '../../staticMerge'
import { instancedMesh } from '../../instancing'

/**
 * ラボの細かい部品を three で作る（docs/design/map-split.md §6 の「段 4」・4-2。案の §3.2）。
 * 前の R3F の部品（scene/parts/details.tsx。4-13 で消した）と同じ形・素材・既定の値で、作る物の数も同じ（GlowBox ごとに BoxGeometry を 1 つ、
 * Bolts ごとに CylinderGeometry を 1 つ、Sticker・StickyNote・GlowSprite ごとに板の形と素材を 1 つ。テクスチャはキーで使い回す）。
 * kanon-lab の R3F の部品（scene/stream/StageMark.tsx）は、ここの部品を <primitive> で置く
 */

/* -------------------------------------------------------------------------- */
/* 発光する棒（LED ライン・スリット）                                           */
/* -------------------------------------------------------------------------- */

export interface GlowBoxOptions {
  position?: Vec3
  rotation?: Vec3
  size: Vec3
  color: THREE.ColorRepresentation
  intensity: number
  /** 面に重ねて置く（面より必ず手前に描く。materials/labMaterials.ts の overlayGlowMaterial） */
  overlay?: boolean
}

/** GlowBox の素材（色・強さごとに使い回す） */
export function glowBoxMaterial(color: THREE.ColorRepresentation, intensity: number, overlay = false): THREE.MeshBasicMaterial {
  return overlay ? overlayGlowMaterial(color, intensity) : glowMaterial(color, intensity)
}

/** 発光する直方体。LED ライン・スリット・インジケータに使う（形は 1 単位の箱を size で伸ばす） */
export function glowBox(o: GlowBoxOptions): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(), glowBoxMaterial(o.color, o.intensity, o.overlay ?? false), { p: o.position, r: o.rotation, s: o.size })
}

/* -------------------------------------------------------------------------- */
/* ボルト（InstancedMesh）                                                      */
/* -------------------------------------------------------------------------- */

const AXIS_ROT: Record<'x' | 'y' | 'z', THREE.Euler> = {
  x: new THREE.Euler(0, 0, Math.PI / 2),
  y: new THREE.Euler(0, 0, 0),
  z: new THREE.Euler(Math.PI / 2, 0, 0),
}

export interface BoltsOptions {
  positions: readonly Vec3[]
  /** ボルトの軸方向（頭が向く方向） */
  axis: 'x' | 'y' | 'z'
  radius?: number
  /** 省けば mats.steel */
  material?: THREE.Material
}

/** 六角ボルトの頭の形 */
export function boltGeometry(radius = 0.012): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(radius, radius, radius * 0.7, 6)
}

/** ボルトの行列を入れる（六角の向きを少しずつばらつかせる） */
export function placeBolts(mesh: THREE.InstancedMesh, positions: readonly Vec3[], axis: 'x' | 'y' | 'z') {
  const q = new THREE.Quaternion().setFromEuler(AXIS_ROT[axis])
  const m = new THREE.Matrix4()
  const s = new THREE.Vector3(1, 1, 1)
  positions.forEach((p, i) => {
    const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 1.7) % 1.05)
    m.compose(new THREE.Vector3(...p), q.clone().multiply(twist), s)
    mesh.setMatrixAt(i, m)
  })
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
}

/** 六角ボルトの頭をまとめて描く（1 ドローコール。影は落とさず受けない） */
export function bolts(o: BoltsOptions, mats: LabMaterials): THREE.InstancedMesh {
  const m = instancedMesh(boltGeometry(o.radius), o.material ?? mats.steel, o.positions.length)
  placeBolts(m, o.positions, o.axis)
  return m
}

/* -------------------------------------------------------------------------- */
/* ラベル・ステッカー・付箋                                                     */
/* -------------------------------------------------------------------------- */

export interface StickerOptions {
  text: string
  sub?: string
  position?: Vec3
  rotation?: Vec3
  /** 横幅（m）。高さは aspect から決まる */
  width: number
  aspect?: number
  background?: string
  color?: string
  font?: 'display' | 'mono' | 'jp'
  /** 角丸の半径（テクスチャ幅に対する割合） */
  radius?: number
  /** 光らせる（emissive）かどうか */
  glow?: number
}

type StickerLook = Required<Pick<StickerOptions, 'aspect' | 'background' | 'color' | 'font' | 'radius'>> & Pick<StickerOptions, 'text' | 'sub'>

/** ステッカーの絵（文字・地の色・形が同じならキーで使い回す） */
export function stickerTexture({ text, sub, aspect, background, color, font, radius }: StickerLook): THREE.CanvasTexture {
  const w = 512
  const h = Math.round(512 / aspect)
  return cachedCanvasTexture(`sticker:${text}:${sub}:${aspect}:${background}:${color}:${font}:${radius}`, w, h, (ctx) => {
    ctx.clearRect(0, 0, w, h)
    if (background !== 'transparent') {
      ctx.fillStyle = background
      roundedRectPath(ctx, 2, 2, w - 4, h - 4, radius * w)
      ctx.fill()
    }
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const size = sub ? h * 0.42 : h * 0.6
    ctx.font = `${font === 'display' ? '900 ' : ''}${size}px ${FONTS[font]}`
    // 横幅に収まるよう縮める
    const measured = ctx.measureText(text).width
    if (measured > w * 0.88) ctx.font = `${font === 'display' ? '900 ' : ''}${(size * w * 0.88) / measured}px ${FONTS[font]}`
    ctx.fillText(text, w / 2, sub ? h * 0.4 : h * 0.53)
    if (sub) {
      ctx.font = `${h * 0.2}px ${FONTS.mono}`
      ctx.globalAlpha = 0.8
      ctx.fillText(sub, w / 2, h * 0.76)
      ctx.globalAlpha = 1
    }
  })
}

/**
 * 文字入りのステッカー・ラベル。Canvas で描いたテクスチャを薄い板に貼る（ステッカーごとに素材を 1 つ）。
 * 表面に置くときは 1〜2mm 浮かせること（z-fighting 防止に polygonOffset も付けている）。
 */
export function sticker(o: StickerOptions): THREE.Mesh {
  const look: StickerLook = {
    text: o.text,
    sub: o.sub,
    aspect: o.aspect ?? 2.5,
    background: o.background ?? '#e9edf1',
    color: o.color ?? '#0b1522',
    font: o.font ?? 'display',
    radius: o.radius ?? 0.08,
  }
  const texture = stickerTexture(look)
  const glow = o.glow ?? 0
  const material =
    glow > 0
      ? new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          toneMapped: false,
          color: new THREE.Color(1, 1, 1).multiplyScalar(glow),
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        })
      : new THREE.MeshStandardMaterial({ name: 'sticker', map: texture, transparent: true, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 })
  return mesh(new THREE.PlaneGeometry(o.width, o.width / look.aspect), material, { p: o.position, r: o.rotation })
}

export interface StickyNoteOptions {
  position: Vec3
  rotation?: Vec3
  lines: string[]
  color?: string
  size?: number
}

/** 付箋の絵（文と色が同じならキーで使い回す） */
export function stickyNoteTexture(lines: readonly string[], color: string): THREE.CanvasTexture {
  return cachedCanvasTexture(`note:${lines.join('|')}:${color}`, 256, 256, (ctx, w, h) => {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    // 上端ののり部分を少し濃く
    ctx.fillStyle = 'rgba(0,0,0,0.06)'
    ctx.fillRect(0, 0, w, h * 0.16)
    ctx.fillStyle = '#1d2733'
    ctx.font = `bold 40px ${FONTS.jp}`
    ctx.textBaseline = 'top'
    lines.forEach((l, i) => ctx.fillText(l, 18, 50 + i * 54))
  })
}

/** 手書き風の付箋 */
export function stickyNote(o: StickyNoteOptions): THREE.Mesh {
  const size = o.size ?? 0.075
  const material = new THREE.MeshStandardMaterial({
    name: 'stickyNote',
    map: stickyNoteTexture(o.lines, o.color ?? '#f3e79b'),
    roughness: 0.8,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide,
  })
  return mesh(new THREE.PlaneGeometry(size, size), material, { p: o.position, r: o.rotation })
}

/* -------------------------------------------------------------------------- */
/* カメラを向く群・光のにじみ（ビルボード）                                     */
/* -------------------------------------------------------------------------- */

export interface Billboard {
  /** 置く群（位置はここ）。中身は inner に足す */
  readonly object: THREE.Group
  /** カメラを向く群 */
  readonly inner: THREE.Group
  /** カメラを向かせる（毎コマ。drei の Billboard の useFrame と同じ式） */
  update(camera: THREE.Camera): void
}

const _q = new THREE.Quaternion()

/**
 * いつもカメラを向く群（drei の Billboard と同じ形: 置く群 → カメラを向く群 → 中身）。向きは
 * 「置く群の行列を直す → 世界の向きの逆 × カメラの世界の向き」。親の向きはその時の値で見る（親より先に呼ぶと前のコマの親の向きになる。案の §1.2）
 */
export function billboard(position?: Vec3): Billboard {
  const object = new THREE.Group()
  if (position) object.position.fromArray(position)
  const inner = new THREE.Group()
  object.add(inner)
  // カメラを向く群（動く物。置く群は動かず、update が自分で行列を直す）
  markDynamic(inner)
  return {
    object,
    inner,
    update(camera) {
      object.updateMatrix()
      object.updateWorldMatrix(false, false)
      object.getWorldQuaternion(_q)
      camera.getWorldQuaternion(inner.quaternion).premultiply(_q.invert())
    },
  }
}

export interface GlowSpriteOptions {
  position?: Vec3
  size: number
  color: THREE.ColorRepresentation
  opacity?: number
}

/** 常にカメラを向く、放射状のにじみ。Bloom だけでは足りない光源の「空気の光」。update を毎コマ呼ぶ */
export function glowSprite(o: GlowSpriteOptions): Billboard {
  const b = billboard(o.position)
  const material = new THREE.MeshBasicMaterial({
    map: radialGlowTexture(),
    color: o.color,
    transparent: true,
    opacity: o.opacity ?? 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  })
  b.inner.add(mesh(new THREE.PlaneGeometry(), material, { s: o.size }))
  return b
}

/* -------------------------------------------------------------------------- */
/* 行列の配列からまとめて描く                                                   */
/* -------------------------------------------------------------------------- */

export interface MatrixInstancesOptions {
  matrices: readonly THREE.Matrix4[]
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** 既定 false */
  castShadow?: boolean
  /** 既定 true */
  receiveShadow?: boolean
}

/** 行列を順に入れる */
export function placeMatrices(mesh: THREE.InstancedMesh, matrices: readonly THREE.Matrix4[]) {
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
}

/** 行列の配列を InstancedMesh で描く（フィン・目盛り・ボルトなど繰り返しの部品用） */
export function matrixInstances(o: MatrixInstancesOptions): THREE.InstancedMesh {
  const m = instancedMesh(o.geometry, o.material, o.matrices.length)
  m.castShadow = o.castShadow ?? false
  m.receiveShadow = o.receiveShadow ?? true
  placeMatrices(m, o.matrices)
  return m
}

/* -------------------------------------------------------------------------- */
/* 位置・大きさ（・色）を並べてまとめて描く                                     */
/* -------------------------------------------------------------------------- */

/** BoxInstances の 1 個分。p = 中心、s = 大きさ（形の 1 単位に掛ける）、e = 回転（XYZ のオイラー角）、c = 色（マテリアルの色に掛かる） */
export interface InstanceItem {
  p: readonly [number, number, number]
  s: readonly [number, number, number]
  e?: readonly [number, number, number]
  c?: THREE.ColorRepresentation
}

/** BoxInstances の既定の形（1 単位の箱。全部で 1 つを使い回す） */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)

/** 位置・大きさ・回転（・色）を入れる。色はどれか 1 つに c があるときだけ入れる（無い物は白 = 素材の色のまま） */
export function placeBoxItems(mesh: THREE.InstancedMesh, items: readonly InstanceItem[]) {
  const colored = items.some((it) => it.c !== undefined)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const c = new THREE.Color()
  items.forEach((it, i) => {
    q.setFromEuler(e.set(...(it.e ?? [0, 0, 0])))
    m.compose(new THREE.Vector3(...it.p), q, new THREE.Vector3(...it.s))
    mesh.setMatrixAt(i, m)
    if (colored) mesh.setColorAt(i, c.set(it.c ?? '#ffffff'))
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
}

export interface BoxInstancesOptions {
  items: readonly InstanceItem[]
  material: THREE.Material
  /** 既定 UNIT_BOX */
  geometry?: THREE.BufferGeometry
  /** 既定 false */
  castShadow?: boolean
  /** 既定 true */
  receiveShadow?: boolean
  renderOrder?: number
}

/**
 * 同じマテリアルの直方体（や geometry に渡した単位の形）を、位置・大きさ・回転・色を並べて 1 回の描画で描く。
 * 扉の枠・ラックの筐体・家具など、同じ材質の部品が多いところで描画の回数を減らすのに使う
 */
export function boxInstances(o: BoxInstancesOptions): THREE.InstancedMesh {
  const m = instancedMesh(o.geometry ?? UNIT_BOX, o.material, o.items.length)
  m.castShadow = o.castShadow ?? false
  m.receiveShadow = o.receiveShadow ?? true
  if (o.renderOrder !== undefined) m.renderOrder = o.renderOrder
  placeBoxItems(m, o.items)
  return m
}
