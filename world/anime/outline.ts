import * as THREE from 'three/webgpu'
import { Discard, Fn, If, abs, clamp, dot, frontFacing, normalViewGeometry, float, floor, max, mix, mod, pass, perspectiveDepthToViewZ, screenSize, smoothstep, step, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'

/** 輪郭線を引く物の層（アニメ塗りに差し替えたラボの物と VRM の人物に足す（labAnime.ts・character/avatar/vrmAnime.ts）。後処理の輪郭線の描画はこの層だけを描く） */
export const OUTLINE_LAYER = 27
/**
 * mesh.userData にこの名前で true を置くと、その物には内側の折れの線を引かず、外形の線は大きな段差（外形）だけに引く（OUTLINE.faceOuter）。
 * 人物の肌と口の中・髪（kanon-stream-video の花音で、口・鼻の折れや口の小さな凹みに線が出て、口が二重・縫い目のように見えた）。顔の外形の線は残す
 */
export const FACE_LINE = 'animeFaceLine'
/**
 * mesh.userData にこの名前で 1〜15 の番号を置くと、番号の違う物どうしの境目に外形の線を引く（どちらも番号を持つときだけ。ラボの物は番号なし）。
 * 人物の髪（FACE_LINE で内側の折れの線を引かない）と顔・帽子などの境目の線を、奥行きの差が小さくても引くため
 */
export const LINE_ID = 'animeLineId'

/** 輪郭線の値: 外形（深さの差）の太さ・内側の折れ（法線の差）の太さ（書き出しの画素）・線の濃さ・線の色（面の色に掛ける暗さと色味）・折れとみなす角度・外形とみなす奥行きの差 */
export const OUTLINE = {
  outer: 1.8,
  inner: 1.0,
  amount: 0.9,
  innerAmount: 0.7,
  dark: 0.2,
  tint: '#55507a',
  /** 折れとみなす 1 − cos の範囲・外形とみなす奥行きの差（逆数の 2 階差 × 奥行き）の範囲 */
  normalRange: [0.18, 0.32] as [number, number],
  depthRange: [0.03, 0.06] as [number, number],
  /** FACE_LINE の物の外形の線: 奥行きの差に掛ける倍率（小さいほど、大きな段差にだけ引く） */
  faceOuter: 0.25,
  /**
   * 町の線（ラボの物の層の外 = 窓の外・外の町・名前のある建物の中・乗り物）: 場面の深さだけで引く外形と折れの線。
   * width = 太さ（書き出しの画素）・amount = 濃さ・range = 線とみなす奥行きの差の範囲（ラボより大きな段差だけ）・
   * fade = この距離（m）から薄く細くし、2 つ目の距離より遠くは引かない・bright = 画面の色の明るさがここを越える所（光る物・灯り）には引かない
   */
  town: { width: 1.3, amount: 0.75, range: [0.05, 0.11] as [number, number], fade: [120, 900] as [number, number], bright: [0.9, 1.6] as [number, number] },
}

/**
 * アニメ塗りの輪郭線（後処理。地図の既定の見た目の一部。react の AnimeRender・kanon-stream-video の scene/Effects.tsx が組み込む）: ラボの物（差し替えた物 = 層 OUTLINE_LAYER）の輪郭線と、
 * 町の線を引く。
 *
 * ラボの物だけを、法線を色にする素材で別に描き（深さと法線）、その深さの逆数の 2 階差（平らな面では 0。奥行きの段差・外形で大きい）で外形の太い線を、
 * 法線の差で内側の折れの細い線を引く。線は画面の画素の幅なので、遠くでも同じ太さ。線の色は面の色を暗くして色味を付けた色（黒一色にしない）。
 * 線を引くのは、画面に見えている物がラボの物のとき（場面の深さとラボだけの深さが同じ所）。使う側の人物（VRM）・物も層に入れれば同じく引く
 * （character/avatar/vrmAnime.ts が VRM の mesh に層を足す）。
 * 窓の外・外の町（地図の町の材質。層に入れない）は、場面の深さだけで外形と角の折れの線を引く（町の線 townLineEdge。OUTLINE.town。遠くほど細く薄く、
 * 遠すぎる所・光る物には引かない）
 */
export interface AnimeLines {
  color: THREE.Node<'vec4'>
  /** カメラの近い・遠い面（毎コマ書く） */
  near: THREE.UniformNode<'float', number>
  far: THREE.UniformNode<'float', number>
  /** 輪郭線の値（開発ツールから書き換えて確かめる用） */
  uniforms: {
    outer: THREE.UniformNode<'float', number>
    inner: THREE.UniformNode<'float', number>
    amount: THREE.UniformNode<'float', number>
    innerAmount: THREE.UniformNode<'float', number>
    dark: THREE.UniformNode<'float', number>
    ids: THREE.UniformNode<'float', number>
    /** 町の線の濃さ・太さ・薄くし始める距離・引かない距離 */
    town: THREE.UniformNode<'float', number>
    townWidth: THREE.UniformNode<'float', number>
    townNear: THREE.UniformNode<'float', number>
    townFar: THREE.UniformNode<'float', number>
  }
  update(camera: THREE.Camera): void
  dispose(): void
}

export function animeOutline(
  color: THREE.Node<'vec4'>,
  sceneViewZ: THREE.Node<'float'>,
  sceneDepth: THREE.TextureNode,
  scene: THREE.Scene,
  camera: THREE.Camera,
  pixelRatio: THREE.UniformNode<'float', number>,
): AnimeLines {
  // 法線を色にする素材（three の MeshNormalNodeMaterial は sRGB から直すので、そのままの値を出す物を作る）
  const normalMat = new THREE.MeshBasicNodeMaterial()
  normalMat.fog = false
  normalMat.lights = false
  // a: 線の引き方（1 = ふつう（番号なし）。番号 LINE_ID のある物は (番号 + 顔なら 16) / 64。描く物ごとに書く）
  const code = uniform(1).onObjectUpdate(({ object }) => {
    const id = Number(object?.userData[LINE_ID] ?? 0)
    const face = object?.userData[FACE_LINE] === true
    if (!id) return face ? 16 / 64 : 1
    return (id + (face ? 16 : 0)) / 64
  })
  // 番号のある物（人物）で素材が両面の物（服・髪。袖の内側・髪の板の裏）だけ裏の面も描く（場面と同じ面を描かないと、袖の口・髪の板の裏が抜けて、
  // 線が二重・ぎざぎざに出た）。ラボの物は前のまま表だけ
  const twoSided = uniform(0).onObjectUpdate(({ object }) => {
    const m = (object as THREE.Mesh | undefined)?.material
    return object?.userData[LINE_ID] && (Array.isArray(m) ? m[0]?.side : m?.side) === THREE.DoubleSide ? 1 : 0
  })
  normalMat.fragmentNode = Fn(() => {
    If(frontFacing.not().and(twoSided.lessThan(0.5)), () => {
      Discard()
    })
    return vec4(normalViewGeometry.mul(0.5).add(0.5), code)
  })()
  // 表の面だけ（場面の素材の多くは表だけを描く。両面にすると、カメラが板の裏にいるとき、場面では見えない板の裏が線の描画だけに入って、
  // その向こうの花音に横線が出た（開発デスクの寄りの画。モニタの裏））。両面の素材の物は上で裏も描く
  normalMat.side = THREE.DoubleSide
  // a を混ぜずにそのまま書く（混ぜると、a が 1 でない物（花音・顔）で、先に描いたうしろの物の法線が透けて、シャツの上にうしろの物の線が出た）
  normalMat.blending = THREE.NoBlending
  const layers = new THREE.Layers()
  layers.set(OUTLINE_LAYER)
  const labPass = pass(scene, camera, { samples: 0 })
  labPass.setLayers(layers)
  labPass.overrideMaterial = normalMat
  labPass.transparent = false

  const v = OUTLINE
  const near = uniform(0.1)
  const far = uniform(1000)
  const u = {
    outer: uniform(v.outer),
    inner: uniform(v.inner),
    amount: uniform(v.amount),
    innerAmount: uniform(v.innerAmount),
    dark: uniform(v.dark),
    ids: uniform(1),
    town: uniform(v.town.amount),
    townWidth: uniform(v.town.width),
    townNear: uniform(v.town.fade[0]),
    townFar: uniform(v.town.fade[1]),
  }
  const tint = new THREE.Color(v.tint)
  const tl = Math.max(1e-4, tint.r * 0.2126 + tint.g * 0.7152 + tint.b * 0.0722)
  const lineTint = vec3(tint.r / tl, tint.g / tl, tint.b / tl)

  const depthTex = labPass.getTextureNode('depth')
  const normalTex = labPass.getTextureNode('output')
  const p = uv()
  const px = vec2(pixelRatio).div(screenSize)
  // 奥行き（正の値）
  const z = (q: THREE.Node<'vec2'>) => perspectiveDepthToViewZ(depthTex.sample(q).r, near, far).negate()
  const nrm = (q: THREE.Node<'vec2'>) => normalTex.sample(q).rgb.mul(2.0).sub(1.0).normalize()

  const zc = z(p).toVar()
  // 線の引き方の番号（a × 64。ふつうの物は 64）・顔（FACE_LINE）でないか（1 = ふつう・0 = 顔）・物の番号（0 = なし）
  const codeAt = (q: THREE.Node<'vec2'>) => floor(normalTex.sample(q).a.mul(64).add(0.5))
  const cc = codeAt(p).toVar()
  const plain = float(1).sub(step(16, cc).mul(step(cc, 63))).toVar()
  const idOf = (c: THREE.Node<'float'>) => mod(c, 16).mul(step(c, 63))
  const idc = idOf(cc).toVar()
  // 外形: 深さの逆数の 2 階差（平らな面では 0）× 奥行き
  const o = px.mul(u.outer)
  const ox = vec2(o.x, 0.0)
  const oy = vec2(0.0, o.y)
  const inv = (q: THREE.Node<'vec2'>) => float(1).div(max(z(q), 1e-4))
  const ic = float(1).div(max(zc, 1e-4))
  const lap = abs(inv(p.add(ox)).add(inv(p.sub(ox))).sub(ic.mul(2))).add(abs(inv(p.add(oy)).add(inv(p.sub(oy))).sub(ic.mul(2))))
  const depthEdge = smoothstep(v.depthRange[0], v.depthRange[1], lap.mul(zc).mul(mix(float(v.faceOuter), float(1), plain)))
  // 番号の違う物どうしの境目（どちらも番号を持つとき）
  const idEdge = (q: THREE.Node<'vec2'>) => {
    const other = idOf(codeAt(q))
    return step(0.5, abs(other.sub(idc))).mul(step(0.5, other)).mul(step(0.5, idc))
  }
  const outerEdge = max(depthEdge, max(max(idEdge(p.add(ox)), idEdge(p.sub(ox))), max(idEdge(p.add(oy)), idEdge(p.sub(oy)))).mul(u.ids))
  // 内側の折れ: 法線の差（1 − cos の大きい方）
  const i = px.mul(u.inner)
  const ix = vec2(i.x, 0.0)
  const iy = vec2(0.0, i.y)
  const nc = nrm(p).toVar()
  const dn = max(
    max(float(1).sub(dot(nc, nrm(p.add(ix)))), float(1).sub(dot(nc, nrm(p.sub(ix))))),
    max(float(1).sub(dot(nc, nrm(p.add(iy)))), float(1).sub(dot(nc, nrm(p.sub(iy))))),
  )
  const innerEdge = smoothstep(v.normalRange[0], v.normalRange[1], dn).mul(u.innerAmount).mul(plain)
  // 見えている物がラボの物か（場面の深さとラボだけの深さが同じ。背景（遠い面）は除く）
  const zm = sceneViewZ.negate()
  const visible = step(abs(zc.sub(zm)), zc.mul(0.02).add(0.02)).mul(step(zc, far.mul(0.9)))
  const labEdge = clamp(max(outerEdge, innerEdge), 0.0, 1.0).mul(visible).mul(u.amount)
  // 町の線（ラボだけの深さに物が無い所 = 窓の外・外にいるときの町だけ）
  const noLab = step(far.mul(0.9), zc).mul(step(zm, far.mul(0.9)))
  const townEdge = townLineEdge({ color, zm, sceneDepth, near, far, px, mask: noLab, amount: u.town, width: u.townWidth, fadeNear: u.townNear, fadeFar: u.townFar })
  const edge = max(labEdge, townEdge)
  // 線の色: 面の色を暗くして色味を付ける
  const base = color.rgb
  const line = base.mul(u.dark).mul(lineTint)
  const out = vec4(mix(base, line, edge), color.a)

  return {
    color: out,
    near,
    far,
    uniforms: u,
    update(cam) {
      const c = cam as THREE.PerspectiveCamera
      near.value = c.near
      far.value = c.far
    },
    dispose() {
      labPass.dispose()
      normalMat.dispose()
    },
  }
}

/** 町の線の引数（townLineEdge） */
export interface TownLineInput {
  /** 場面の色（HDR のリニア。光る物・灯りには引かない） */
  color: THREE.Node<'vec4'>
  /** 今の画素の奥行き（正の値。m） */
  zm: THREE.Node<'float'>
  /** 場面の深さ（pass の depth） */
  sceneDepth: THREE.TextureNode
  near: THREE.Node<'float'>
  far: THREE.Node<'float'>
  /** 1 書き出し画素の uv の大きさ（vec2(pixelRatio) / screenSize） */
  px: THREE.Node<'vec2'>
  /** 引く所（1 = 引く。ラボの物の上などを 0 に） */
  mask: THREE.Node<'float'>
  /** 濃さ・太さ（書き出しの画素）・薄くし始める距離・引かない距離（m） */
  amount: THREE.Node<'float'>
  width: THREE.Node<'float'>
  fadeNear: THREE.Node<'float'>
  fadeFar: THREE.Node<'float'>
}

/**
 * 町の線（0〜1。線の濃さ）: 場面の深さの逆数の 2 階差で（外形と、角の折れの両方に出る）。遠くほど細く薄く（fade）、空（遠い面）と光る物・灯り
 * （画面の色が明るい所）には引かない。値は OUTLINE.town（range・bright）
 */
export function townLineEdge(i: TownLineInput): THREE.Node<'float'> {
  const v = OUTLINE.town
  const p = uv()
  const zs = (q: THREE.Node<'vec2'>) => perspectiveDepthToViewZ(i.sceneDepth.sample(q).r, i.near, i.far).negate()
  const fadeT = smoothstep(i.fadeNear, i.fadeFar, i.zm).toVar()
  const t = i.px.mul(i.width.mul(fadeT.mul(-0.45).add(1.0)))
  const tx = vec2(t.x, 0.0)
  const ty = vec2(0.0, t.y)
  const invS = (q: THREE.Node<'vec2'>) => float(1).div(max(zs(q), 1e-4))
  const ics = float(1).div(max(i.zm, 1e-4))
  const lapS = abs(invS(p.add(tx)).add(invS(p.sub(tx))).sub(ics.mul(2))).add(abs(invS(p.add(ty)).add(invS(p.sub(ty))).sub(ics.mul(2))))
  const townEdge0 = smoothstep(v.range[0], v.range[1], lapS.mul(i.zm))
  const glow = smoothstep(v.bright[0], v.bright[1], dot(i.color.rgb, vec3(0.2126, 0.7152, 0.0722))).oneMinus()
  return townEdge0.mul(i.mask).mul(glow).mul(fadeT.oneMinus()).mul(i.amount)
}
