import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { pass, renderOutput, uniform } from 'three/tsl'
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js'
import type { VRM } from '@pixiv/three-vrm'
import { outdoor } from '../world/environment/daylight'
import { labAnime } from '../world/anime/labAnime'
import { animeOutline } from '../world/anime/outline'
import { townFocus, townOptions } from '../world/townHost'
import { applyVrmAnime, updateVrmAnime } from '../character/avatar/vrmAnime'
import type { VrmRim } from '../character/avatar/loadVrm'
import { useLab } from './labHooks'

/**
 * アニメ塗りの R3F の包み（地図の既定の見た目）:
 *
 * - LabAnimeView（TownView が中に置く。使う側は置かなくてよい）: ラボの殻と什器の素材をアニメ塗りに差し替え（world/anime/labAnime.ts）、毎コマ
 *   ラボと町の時刻の配色・ネオンの照り返しを書き、描く直前にキーライトの影の地図を描く。町の注目点の人（town.setFocus に渡した Character）の VRM の MToon も
 *   合わせ（character/avatar/vrmAnime.ts。輪郭線の層と影の層も）、毎コマその人の位置の光を書く
 * - AnimeRender（使う側が、自分で gl.render する代わりに置く。後処理を自分で組まないアプリ向け）: 場面を描いて、アニメ塗りの輪郭線（ラボの物・人と町の線。
 *   world/anime/outline.ts）を引き、トーンマッピングと sRGB をかけて出す（three の RenderPipeline）。後処理を自分で組むアプリ（kanon-stream-video）は、
 *   animeOutline を自分の後処理の中に入れる
 */

/** 見直す間隔（コマ）。キットがあとから素材を差し替えた物・あとから足した物も拾う */
const RESCAN_FRAMES = 30

/** 町の注目点の人の見た目の VRM と縁の光（Character の visual・rim。無ければ null） */
function focusVrm(): { vrm: VRM; rim: VrmRim | null } | null {
  const f = townFocus() as { visual?: { vrm?: VRM | null } | null; rim?: VrmRim }
  const vrm = f.visual?.vrm
  return vrm ? { vrm, rim: f.rim ?? null } : null
}

/** ラボのアニメ塗りと、注目点の人の VRM の合わせ（TownView の中。優先度 −45 と、描く直前の 0.98） */
export function LabAnimeView() {
  const lab = useLab()
  const anime = useMemo(() => labAnime(), [])
  const state = useMemo(() => ({ frame: 0, vrm: null as VRM | null }), [])
  useEffect(() => () => anime.restore(), [anime, lab])

  useFrame(() => {
    if (state.frame++ % RESCAN_FRAMES === 0) anime.scanLab(lab)
    // 注目点の人: 読み込んだ VRM の MToon を合わせ、輪郭線と影の層を足す
    const v = focusVrm()
    if (v && v.vrm !== state.vrm) {
      state.vrm = v.vrm
      applyVrmAnime(v.vrm, v.rim)
    }
    anime.sync()
    anime.update(outdoor)
    updateVrmAnime(townFocus().position, anime.uniforms.keyDir.value, anime.weights, anime.uniforms.key.value)
  }, -45)

  useFrame(({ gl, scene }) => {
    // 準備ができる（使う側の時計の ready）までは、動かない物の地図も毎コマ描く（読み込み直後に 1〜2 コマだけ描いた地図は、影が抜けたまま残った）
    if (!townOptions().clock.ready()) anime.shadow.invalidate()
    anime.renderShadow(gl as unknown as THREE.WebGPURenderer, scene, lab)
  }, 0.98)
  return null
}

/**
 * 描く（優先度 1。three の RenderPipeline）: 場面 → アニメ塗りの輪郭線 → トーンマッピング・sRGB（レンダラの toneMapping・露出のまま）→ 縁のなめらかさ（SMAA。
 * antialias。場面は多重サンプルなしで描くので、Canvas の antialias は効かない）。0 より大きい優先度の購読があると R3F は自分で描かないので、
 * 使う側の gl.render の代わりにこれを置く
 */
export function AnimeRender({ antialias = true }: { antialias?: boolean }) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const built = useMemo(() => {
    const scenePass = pass(scene, camera, { samples: 0 })
    const pixelRatio = uniform(1)
    const lines = animeOutline(scenePass.getTextureNode('output'), scenePass.getViewZNode(), scenePass.getTextureNode('depth'), scene, camera, pixelRatio)
    const out = renderOutput(lines.color)
    const aa = antialias ? smaa(out) : null
    const pipeline = new THREE.RenderPipeline(gl, aa ?? out)
    // トーンマッピングと sRGB は上でかける（縁のなめらかさをその後にするため）
    pipeline.outputColorTransform = false
    return { scenePass, pixelRatio, lines, pipeline, aa }
  }, [gl, scene, camera, antialias])
  useEffect(
    () => () => {
      built.pipeline.dispose()
      built.lines.dispose()
      built.scenePass.dispose()
      built.aa?.dispose()
    },
    [built],
  )
  useFrame(() => {
    built.pixelRatio.value = gl.getPixelRatio()
    built.lines.update(camera)
    built.pipeline.render()
  }, 1)
  return null
}
