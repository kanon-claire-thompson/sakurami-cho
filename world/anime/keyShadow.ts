import * as THREE from 'three/webgpu'
import type { AnimeUniforms } from './material'

/**
 * アニメ塗りのキーライトの影の地図（物が落とす影: 机の下・機材の足元・花音の足元など）。
 *
 * キーライトの向き（時刻で変わる。palette.ts）から、ラボの箱を囲む正射影のカメラで、影を落とす物だけを深さだけ描く。素材の式（material.ts の shadowed）が
 * この深さと比べて、くっきり 2 値の影にする。地図は同じカメラで 2 枚:
 * - 動かない物（CASTER_LAYER。labAnime.ts が、差し替えたラボの物のうち動かない物（部屋の殻・ガラス・半透明を除く）に付ける）: 光の向き・箱が変わったときだけ描く
 *   （合わせた動かない形が百数十。毎コマ描くと配信の重さが 1 割ほど増えた）
 * - 動く物（DYNAMIC_CASTER_LAYER。花音・KB-001・ラボの動く部品（sakurami-cho の markDynamic の物。ロボットアーム・扉など））: 毎コマ描く（数十）
 * どちらの地図も 2048 画素（ラボの箱で 1 画素 ≒ 1.5 cm）
 */
export const CASTER_LAYER = 28
export const DYNAMIC_CASTER_LAYER = 29

/** 影の地図の大きさ（画素）。ラボ（約 22 × 30 m） */
const SIZE = 2048
const DYNAMIC_SIZE = 2048

/** 動かない物の地図を描き直すときに続けて描くコマの数（念のため 2 コマ。1 コマ目に見え隠れの決まっていない物があっても拾う） */
const STATIC_REDRAW_FRAMES = 2

const _corners = Array.from({ length: 8 }, () => new THREE.Vector3())
const _v = new THREE.Vector3()
const _size = new THREE.Vector3()
const _box = new THREE.Box3()

export interface KeyShadow {
  /** 動かない物・動く物の深さ */
  readonly depth: THREE.DepthTexture
  readonly dynamicDepth: THREE.DepthTexture
  /** ラボの箱（影の地図に入れる範囲。殻と什器を囲む箱） */
  setBounds(box: THREE.Box3): void
  /** 動かない物の地図をこの次に描き直す（あとから足した物を拾ったとき） */
  invalidate(): void
  /**
   * 描く（動かない物は光の向き・箱が変わったか invalidate のあとだけ、動く物は毎コマ）。描いたら行列を uniform に書く。
   * show は描く間だけ見えるようにする物（sakurami-cho の lab.cull が、カメラから見えないコマに什器を隠す。隠れたコマに動かない物の地図を描くと、
   * 什器の影が抜けたまま残った（撮影の窓際の初めのコマ））
   */
  render(renderer: THREE.WebGPURenderer, scene: THREE.Scene, keyDir: THREE.Vector3, show: readonly THREE.Object3D[]): void
  /** 確かめる用（光の向き・カメラ・動かない物の地図を描いた回数） */
  info(): { dir: number[]; camera: number[]; staticDraws: number; near: number; far: number }
  dispose(): void
}

function depthTarget(size: number) {
  const depth = new THREE.DepthTexture(size, size)
  depth.type = THREE.FloatType
  const target = new THREE.RenderTarget(size, size, { depthBuffer: true, depthTexture: depth, type: THREE.UnsignedByteType, generateMipmaps: false })
  return { depth, target }
}

export function createKeyShadow(u: AnimeUniforms): KeyShadow {
  const fixed = depthTarget(SIZE)
  const moving = depthTarget(DYNAMIC_SIZE)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
  // 深さだけを描く素材（色は書かない。花音の骨の変形は three が物ごとに足す）
  const depthMat = new THREE.MeshBasicNodeMaterial()
  depthMat.colorWrite = false
  depthMat.fog = false
  depthMat.lights = false
  depthMat.side = THREE.DoubleSide
  const bounds = new THREE.Box3(new THREE.Vector3(-12, -1, -16), new THREE.Vector3(12, 8, 16))
  const lastDir = new THREE.Vector3()
  /** 動かない物の地図を、あと何コマ描くか（描き直すときは続けて数コマ。下の render の注） */
  let staticFrames = STATIC_REDRAW_FRAMES
  let staticDraws = 0
  u.shadowTexel.value = 1 / SIZE

  /** 光の向きに合わせて、箱の 8 つの角を囲む正射影のカメラを置く */
  function fit(dir: THREE.Vector3) {
    const center = bounds.getCenter(_v)
    const radius = bounds.getSize(_size).length() / 2
    camera.position.copy(center).addScaledVector(dir, radius + 2)
    camera.up.set(0, 1, 0)
    if (Math.abs(dir.y) > 0.999) camera.up.set(0, 0, 1)
    camera.lookAt(center)
    camera.updateMatrixWorld()
    const inv = camera.matrixWorldInverse
    _box.makeEmpty()
    let i = 0
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) _box.expandByPoint(_corners[i++]!.set(x, y, z).applyMatrix4(inv))
    camera.left = _box.min.x
    camera.right = _box.max.x
    camera.bottom = _box.min.y
    camera.top = _box.max.y
    camera.near = Math.max(0.05, -_box.max.z - 0.5)
    camera.far = -_box.min.z + 0.5
    camera.updateProjectionMatrix()
  }

  function draw(renderer: THREE.WebGPURenderer, scene: THREE.Scene, target: THREE.RenderTarget, layer: number) {
    camera.layers.set(layer)
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
  }

  return {
    depth: fixed.depth,
    dynamicDepth: moving.depth,
    setBounds(box) {
      bounds.copy(box)
      staticFrames = STATIC_REDRAW_FRAMES
    },
    invalidate() {
      staticFrames = STATIC_REDRAW_FRAMES
    },
    render(renderer, scene, keyDir, show) {
      if (lastDir.angleTo(keyDir) > 0.005 || lastDir.lengthSq() === 0) {
        lastDir.copy(keyDir)
        staticFrames = STATIC_REDRAW_FRAMES
      }
      const prevTarget = renderer.getRenderTarget()
      const prevMRT = renderer.getMRT()
      const prevOverride = scene.overrideMaterial
      const prevBackground = scene.background
      const prevAuto = renderer.autoClear
      renderer.setMRT(null)
      renderer.autoClear = true
      scene.overrideMaterial = depthMat
      scene.background = null
      const hidden = show.filter((o) => !o.visible)
      for (const o of hidden) o.visible = true
      try {
        if (staticFrames > 0) {
          fit(lastDir)
          staticFrames--
          staticDraws++
          draw(renderer, scene, fixed.target, CASTER_LAYER)
        }
        draw(renderer, scene, moving.target, DYNAMIC_CASTER_LAYER)
      } finally {
        for (const o of hidden) o.visible = false
        scene.overrideMaterial = prevOverride
        scene.background = prevBackground
        renderer.setRenderTarget(prevTarget)
        renderer.setMRT(prevMRT)
        renderer.autoClear = prevAuto
      }
      // 描いた後の行列（WebGPU の深さ 0〜1 の射影。three は描くときにカメラの座標系を合わせて射影を作り直す）
      u.shadowMatrix.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      u.shadowOn.value = 1
    },
    info() {
      return { dir: lastDir.toArray(), camera: camera.position.toArray(), staticDraws, near: camera.near, far: camera.far }
    },
    dispose() {
      fixed.target.dispose()
      fixed.depth.dispose()
      moving.target.dispose()
      moving.depth.dispose()
      depthMat.dispose()
    },
  }
}
