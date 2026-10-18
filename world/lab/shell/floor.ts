import * as THREE from 'three/webgpu'
import { Fn, clamp, materialColor, materialRoughness, max, min, mix, reflector, smoothstep, texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import { ROOM } from '../../../core/lab/plan'
import type { LabFloorTextures } from '../textures'

/**
 * ラボの床（docs/design/map-split.md §6 の「段 4」・4-4。前の Room.tsx の Floor）。品質が high なら、濡れたコンクリートのような、
 * なめらかにぼけた映り込み（前は drei の MeshReflectorMaterial を写した物）。low ならふつうの PBR の床。
 *
 * WebGPU への移行（第 2 段）: 映り込みは TSL の reflector()（three の ReflectorNode）で撮り、ぼかし（drei の BlurPass・ConvolutionMaterial の
 * 4 点の Kawase。深さで中心へ寄せる）は QuadMesh と NodeMaterial で同じ式に、床の色の混ぜ方（drei の MeshReflectorMaterial の
 * emissivemap_fragment の後ろに足していた式）は colorNode で同じ式にした。
 *
 * 描く順は前と同じ: 毎コマ、殻の更新の初め（照明と町の遠景のあと、什器・KB-001・配信の部品の更新より前。案の E2・E3）に renderReflection を呼び、
 * 床を隠す → 床で折り返したカメラ（斜めの近い面で床の下を切る）で場面を撮る → ぼかす → 戻す。reflector() は既定では床を描くときに撮るが、
 * そうするとぼかしを挟めないので、撮る所（ReflectorBaseNode.updateBefore）をここから呼び、自動では撮らない（updateBeforeType = NONE）。
 * 映るのは、什器などの前のコマの姿と、光と花音の今のコマの姿（前と同じ）。
 *
 * ぼかし（convolutionMaterial）と床の色の混ぜ方（createReflector の colorNode）は、drei（@react-three/drei 10.7.9）の materials/ConvolutionMaterial.js・
 * BlurPass.js・MeshReflectorMaterial.js の式を写した物（MIT License, Copyright (c) 2020 react-spring。全文は下）。
 *
 * 前と違う所: 撮る先の大きさは描画の大きさ（reflector() の決まり。前は 1024 px の正方形）。ぼかしの幅は前と同じく画面の割合（blur の 520・260 px 分）
 * なので、見た目のぼけ方は変わらない。折り返したカメラは前と同じく 0 番のレイヤーだけを見る（遠景のレイヤー OUTDOOR_LAYER などは映さない）
 */

/*
 * MIT License（drei から写した所: convolutionMaterial・createReflector の colorNode の式）
 *
 * Copyright (c) 2020 react-spring
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** 映り込みの値（前の Room.tsx の MeshReflectorMaterial に渡していた物） */
const REFLECTOR = {
  color: '#a3abb4',
  roughness: 0.62,
  metalness: 0,
  resolution: 1024,
  blur: [520, 260] as [number, number],
  mixBlur: 0.9,
  mixStrength: 7,
  mixContrast: 1,
  mirror: 0.8,
  depthScale: 0.8,
  minDepthThreshold: 0.25,
  maxDepthThreshold: 1.4,
  depthToBlurRatioBias: 0.4,
  /** drei の既定の値（前は渡していなかった物） */
  distortion: 1,
  reflectorOffset: 0,
}

export interface LabFloor {
  readonly mesh: THREE.Mesh
  /** 床の映り込みを描く（high で映り込みを止めていないときだけ。low・止めているときは何もしない） */
  renderReflection(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): void
  /** 映り込みを描いているか（high で setReflection(false) していないとき） */
  readonly reflection: boolean
  /**
   * 映り込みを止める・戻す（high のときだけ効く。low はいつも映り込み無し）。止めている間は毎コマの映り込みの描画（場面をもう 1 回描く・ぼかす）をせず、
   * 床の素材を映り込みの無い PBR の床（low と同じ素材。名前 labFloor）に替える。使う側が床を自分の素材で描くとき（トゥーン調など）に、重さを減らす口
   */
  setReflection(on: boolean): void
  /** 撮る先・ぼかし・素材・形を捨てる（床のテクスチャは使う側の物なので捨てない） */
  dispose(): void
}

type ShadowLight = THREE.Light & { shadow: THREE.LightShadow }
const _held: ShadowLight[] = []
/** 映り込みを撮るときに一度でも見た光（初めて見たコマは止めない。まだ描いていない影の地図（仮の大きさのテクスチャ）を映り込みで読まないように） */
const _seen = new WeakSet<THREE.Light>()

/** 場面の、影を毎コマ描き直す光の autoUpdate を止める（止めた光を返す。呼んだ側が戻す） */
function holdShadows(scene: THREE.Object3D): ShadowLight[] {
  _held.length = 0
  scene.traverse((o) => {
    const l = o as ShadowLight
    if (!l.isLight || !l.castShadow || !l.shadow?.autoUpdate) return
    if (!_seen.has(l)) {
      _seen.add(l)
      return
    }
    l.shadow.autoUpdate = false
    _held.push(l)
  })
  return _held
}

/** 床を作る。textures は下ごしらえした床のテクスチャ（textures.ts の prepareLabFloorTextures） */
export function createLabFloor(o: { textures: LabFloorTextures; quality: 'high' | 'low' }): LabFloor {
  const geometry = new THREE.PlaneGeometry(ROOM.width, ROOM.depth)
  if (o.quality !== 'high') {
    const material = plainFloorMaterial(o.textures)
    const mesh = floorMesh(geometry, material)
    return {
      mesh,
      renderReflection() {},
      reflection: false,
      setReflection() {},
      dispose() {
        geometry.dispose()
        material.dispose()
      },
    }
  }
  const reflection = createReflector(o.textures.map)
  const mesh = floorMesh(geometry, reflection.material)
  mesh.add(reflection.target)
  /** 映り込みを止めたときの床の素材（初めて止めた時に作る） */
  let plain: THREE.MeshStandardMaterial | null = null
  let on = true
  return {
    mesh,
    renderReflection: (renderer, scene, camera) => {
      if (on) reflection.render(mesh, renderer, scene, camera)
    },
    get reflection() {
      return on
    },
    setReflection(next) {
      if (next === on) return
      on = next
      plain ??= plainFloorMaterial(o.textures)
      mesh.material = on ? reflection.material : plain
    },
    dispose() {
      geometry.dispose()
      reflection.dispose()
      plain?.dispose()
    },
  }
}

/** 映り込みの無い PBR の床（low の床と、high で映り込みを止めたときの床） */
function plainFloorMaterial(textures: LabFloorTextures) {
  return new THREE.MeshStandardMaterial({ ...textures, name: 'labFloor', color: '#8d949c', normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.55, metalness: 0 })
}

function floorMesh(geometry: THREE.BufferGeometry, material: THREE.Material) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(0, 0, ROOM.centerZ)
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  return mesh
}

/** ぼかしの 1 回分（drei の ConvolutionMaterial と同じ式。4 点を斜めに読み、深さで中心へ寄せる。kernel は回ごとの広がり） */
type Tex = THREE.TextureNode<'vec4'>

function convolutionMaterial(input: Tex, depth: Tex, kernel: number, u: ReturnType<typeof blurUniforms>) {
  const m = new THREE.NodeMaterial()
  m.name = 'labFloorBlur'
  m.depthTest = false
  m.depthWrite = false
  m.blending = THREE.NoBlending
  m.toneMapped = false
  m.fog = false
  m.lights = false
  m.fragmentNode = Fn(() => {
    const vUv = uv().toVar()
    const dUv = u.texelSize.mul(kernel).add(u.texelSize.mul(0.5)).toVar()
    // USE_DEPTH（depthScale > 0）のとき: 近い物ほどぼかさない
    const d = depth.sample(vUv).r
    const depthFactor = clamp(smoothstep(u.minDepthThreshold, u.maxDepthThreshold, d.oneMinus()).mul(u.depthScale).add(0.25), 0.0, 1.0).toVar()
    const tap = (dx: number, dy: number) => input.sample(mix(vec2(vUv.x.add(dUv.x.mul(dx)), vUv.y.add(dUv.y.mul(dy))), vUv, depthFactor))
    return tap(-1, 1).add(tap(1, 1)).add(tap(1, -1)).add(tap(-1, -1)).mul(0.25)
  })()
  return m
}

function blurUniforms(R: typeof REFLECTOR) {
  return {
    /** 1 / ぼかしの幅（drei の setTexelSize(1 / width, 1 / height)） */
    texelSize: uniform(new THREE.Vector2(1 / R.blur[0], 1 / R.blur[1])),
    minDepthThreshold: uniform(R.minDepthThreshold),
    maxDepthThreshold: uniform(R.maxDepthThreshold),
    depthScale: uniform(R.depthScale),
  }
}

/**
 * 映り込みの素材と、描く手順。法線マップで映り込みを歪ませる（波打ったノイズになる）・ラフネスマップでぼかし量がまだらになるので、
 * 反射の側には色マップの色ムラだけを使う（前と同じ）
 */
function createReflector(map: THREE.Texture) {
  const R = REFLECTOR
  const hasBlur = R.blur[0] + R.blur[1] > 0
  // 撮る所（ReflectorBaseNode）。深さも撮る（近い物ほどくっきり映す）
  const refl = reflector({ depth: true, resolutionScale: 1 })
  const base = refl.reflector
  base.updateBeforeType = 'none'
  // 折り返したカメラは 0 番のレイヤーだけを見る（前の drei は new PerspectiveCamera() の既定のレイヤー）
  const getVirtualCamera = base.getVirtualCamera.bind(base)
  base.getVirtualCamera = (camera: THREE.Camera) => {
    const v = getVirtualCamera(camera)
    v.layers.set(0)
    return v
  }
  const depthNode = refl.getDepthNode()

  // ぼかし（drei の BlurPass: kernel [0, 1, 2, 2, 3] の 5 回。4 回を A・B に交互に描き、最後を out へ）
  const rtOptions = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false }
  const targetA = new THREE.RenderTarget(1, 1, rtOptions)
  const targetB = new THREE.RenderTarget(1, 1, rtOptions)
  const out = new THREE.RenderTarget(1, 1, rtOptions)
  const bu = blurUniforms(R)
  const KERNEL = [0, 1, 2, 2, 3]
  const firstInput = texture(new THREE.Texture()) as Tex
  // 深さは撮る先の DepthTexture に替える（形の上でも深さのテクスチャにしておく。シェーダーの宣言が深さのテクスチャになる）
  const blurDepth = texture(new THREE.DepthTexture(1, 1)) as Tex
  const passes = KERNEL.map((k, i) => {
    const input = i === 0 ? firstInput : (texture((i - 1) % 2 === 0 ? targetA.texture : targetB.texture) as Tex)
    const dest = i === KERNEL.length - 1 ? out : i % 2 === 0 ? targetA : targetB
    return { material: convolutionMaterial(input, blurDepth, k, bu), dest }
  })
  const quad = new THREE.QuadMesh(passes[0]!.material)

  // 床の素材（MeshStandardMaterial に drei の MeshReflectorMaterial の式を足した物）
  const material = new THREE.MeshStandardNodeMaterial()
  material.name = 'labFloorReflector'
  material.map = map
  material.color.set(R.color)
  material.roughness = R.roughness
  material.metalness = R.metalness
  const u = {
    mirror: uniform(R.mirror),
    mixBlur: uniform(R.mixBlur),
    mixStrength: uniform(R.mixStrength),
    mixContrast: uniform(R.mixContrast),
    minDepthThreshold: uniform(R.minDepthThreshold),
    maxDepthThreshold: uniform(R.maxDepthThreshold),
    depthScale: uniform(R.depthScale),
    depthToBlurRatioBias: uniform(R.depthToBlurRatioBias),
  }
  // 値（前の MeshReflectorMaterial の mirror・mixStrength などと同じ意味）は material.uniforms.<名前>.value で読み書きできる
  Object.assign(material, { uniforms: u })
  const blurTexture = texture(out.texture, refl.uvNode)
  material.colorNode = Fn(() => {
    const diffuse = vec4(materialColor as unknown as THREE.Node<'vec4'>).toVar()
    const baseC = refl.toVar()
    const blur = blurTexture.toVar()
    const merge = baseC.toVar()
    // USE_DEPTH: 近い物ほどくっきり（深さの .r × .a。深さのテクスチャの a は 1）
    const depthFactor = max(0.0001, min(1.0, smoothstep(u.minDepthThreshold, u.maxDepthThreshold, depthNode.r.oneMinus()).mul(u.depthScale))).toVar()
    if (hasBlur) {
      blur.mulAssign(min(1.0, depthFactor.add(u.depthToBlurRatioBias)))
      merge.mulAssign(min(1.0, depthFactor.add(0.5)))
      const blurFactor = min(1.0, u.mixBlur.mul(materialRoughness))
      merge.assign(mix(merge, blur, blurFactor))
    } else {
      merge.mulAssign(depthFactor)
    }
    const newMerge = merge.rgb.sub(0.5).mul(u.mixContrast).add(0.5)
    return vec4(diffuse.rgb.mul(min(1.0, u.mirror).oneMinus().add(newMerge.mul(u.mixStrength))), diffuse.a)
  })()

  const size = new THREE.Vector2()
  return {
    material,
    /** 床の向きを決める物（床の mesh の子にする。reflector() の決まり: 物の +z が鏡の面の法線） */
    target: refl.target,
    /** 映り込みを撮ってぼかす（床を隠して撮り、撮る先・MRT・自動の消去を戻す） */
    render(parent: THREE.Object3D, gl: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
      parent.updateMatrixWorld()
      const prevVisible = parent.visible
      parent.visible = false
      // 映り込みを撮る間は、毎コマ描き直す影の地図（作業台・舞台のスポット）を描き直さない（前のコマの地図を使う）。three の影の地図は
      // カメラごとに描き直すので、折り返したカメラで撮るとふだんのカメラと 2 回描いていた（WebGPU への移行の第 3 段。1 コマ約 3ms）。
      // 映り込みはぼかして混ぜるので、1 コマ前の影でも画は変わらない。描き直しを頼まれている地図（needsUpdate。太陽の影）はそのまま描く
      const held = holdShadows(scene)
      // 描くたびに場面の行列を計算しない使う側（matrixWorldAutoUpdate = false。kanon-lab）は、撮る前にここで計算する
      if (!scene.matrixWorldAutoUpdate) scene.updateMatrixWorld()
      try {
        // material は reflector() が撮る間だけ隠す物（床は親ごと隠しているので、ここでは同じ床の素材を渡す）
        base.updateBefore({ scene, camera, renderer: gl, material } as never)
      } finally {
        for (const l of held) l.shadow.autoUpdate = true
        parent.visible = prevVisible
      }
      if (!hasBlur) return
      const rt = base.renderTargets.get(base.getVirtualCamera(camera))
      if (!rt) return
      firstInput.value = rt.texture
      blurDepth.value = rt.depthTexture ?? blurDepth.value
      size.set(rt.width, rt.height)
      for (const t of [targetA, targetB, out]) if (t.width !== size.x || t.height !== size.y) t.setSize(size.x, size.y)
      const prevTarget = gl.getRenderTarget()
      const prevMRT = gl.getMRT()
      const prevAuto = gl.autoClear
      gl.setMRT(null)
      gl.autoClear = true
      try {
        for (const p of passes) {
          quad.material = p.material
          gl.setRenderTarget(p.dest)
          quad.render(gl)
        }
      } finally {
        gl.setRenderTarget(prevTarget)
        gl.setMRT(prevMRT)
        gl.autoClear = prevAuto
      }
    },
    dispose() {
      refl.dispose()
      depthNode.dispose()
      targetA.dispose()
      targetB.dispose()
      out.dispose()
      for (const p of passes) p.material.dispose()
      material.dispose()
    },
  }
}
