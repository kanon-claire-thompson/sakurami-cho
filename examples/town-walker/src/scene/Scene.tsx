import { Suspense, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PALETTE } from 'sakurami-cho/world'
import { AnimeRender, LabAtmosphere, RideDriver, TownClock, TownExposure, TownRoot, TownView } from 'sakurami-cho/react'
import { sceneHook, walkerState } from '../debug'
import { loadingLabBuilt, loadingReady } from '../loading'
import { DEBUG, town, townState, walker } from '../town'
import type { WebGPURenderer } from 'three/webgpu'
import { vrmPending } from '../vrm'
import { gpuState } from '../gpu'
import { QUALITY } from '../quality'
import { updateMiniMap } from '../townMap'
import { Controls } from './Controls'
import { FollowCam } from './FollowCam'
import { WalkerDriver, WalkerView } from './Walker'

/** 乗り物に乗る人（歩く人 1 人） */
const RIDERS = [walker]

/**
 * 例のアプリの場面（町とラボと歩く人）。毎コマの順（R3F の useFrame の優先度。小さい方が先。kanon-lab の docs/design/map-split.md §8）:
 *
 *   −90   TownClock     町の時計と外の状態（town.begin。Suspense の外）
 *   −79   RideDriver    乗る仕組み（ケーブルの線・緑電と運河バスの運行・誰も乗っていない間のホバー → 乗る人ごと）
 *   −59   Controls      WASD の向きを歩く人へ（カメラの向きから）・クリックの行き先の印
 *   −58   WalkerDriver  歩く人を進める（updateLocomotion。乗っている間は drivers.motion の driveRides、ほかは drivers.travel の旅程か WASD・クリック）と、
 *                       旅程の様子（travel.ts の updateTravel）
 *   −50   TownView      遠景と外の光（town.update。TownRoot の最初の子）
 *    −1   FollowCam     追うカメラ（人の位置が決まったあと、町の view の前）
 *   −45   TownView      アニメ塗り（LabAnimeView: ラボの塗りの見直し・ラボと町の時刻の配色・歩く人の VRM の合わせと光）
 *     0   TownView      ラボ・星・遠景の窓・殻・什器（town.view。カメラを動かしたあと）、歩く人の見た目（CharacterView・仮の体）、準備の合図
 *   0.5   MapFrame      小さい地図（townMap.ts の updateMiniMap。下絵をずらして矢印を回すだけ。#1）
 *  0.95   TownExposure  露出（town.exposure。描く前）
 *  0.98   TownView      アニメ塗りのキーライトの影の地図（LabAnimeView）
 *     1   AnimeRender   描く（場面 → アニメ塗りの輪郭線 → トーンマッピング → SMAA。地図の react の AnimeRender。0 より大きい優先度の購読があると、
 *                       R3F は自分で描かないので、ここで描く）
 */
export function Scene() {
  return (
    <>
      <color attach="background" args={[PALETTE.background]} />
      {/* 部屋の中の薄い霧（kanon-lab と同じ）。外の遠景のシェーダーは霧を使わず、自前の空気遠近でかすむ */}
      <fogExp2 attach="fog" args={[PALETTE.fog, 0.028]} />
      <TownClock town={town} />
      <RideDriver characters={RIDERS} />
      <Controls />
      <WalkerDriver />
      <FollowCam />
      <WalkerView />
      <MapFrame />
      <TownExposure town={town} />
      <AnimeRender antialias={QUALITY.lab === 'high'} />
      <Suspense fallback={null}>
        {/* ラボのテクスチャを読み終えるまでここで待つ。置き場所の表は省いて地図の既定（LAB_PLACEMENTS）、ラボの口（configureLab）も入れない（画面は既定の飾り） */}
        <TownRoot town={town}>
          <TownView />
          <LabAtmosphere />
          <ReadySignal />
        </TownRoot>
      </Suspense>
    </>
  )
}

/** 小さい地図（優先度 0.5。歩く人・乗り物・カメラが動いたあと。DOM の下絵をずらすだけで、3D の画は描かない） */
function MapFrame() {
  useFrame(() => updateMiniMap(), 0.5)
  return null
}

/**
 * 準備の合図（町の地図データを読み終えて（か、無いと分かって）、しまった VRM を読み終えて（か、無い・読めないと分かって）、描画の土台が WebGPU・実の GPU で、
 * 場面の材質の先のコンパイル（compileAsync）を済ませてから 30 コマ描いたら。?debug の __walker.ready と html の data-walker-ready）。
 * 読み込み中の進み具合（../loading）にも、ラボを作り終えた（これが付いてから 2 コマ目。1 コマ目を描くときに素材のシェーダーを組み立てるので、それを含める）・
 * 準備ができた（進み具合を消す）を知らせる
 */
function ReadySignal() {
  const settled = useRef(0)
  const drawn = useRef(0)
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    sceneHook.gl = gl as unknown as WebGPURenderer
    sceneHook.scene = scene
    return () => {
      sceneHook.gl = null
      sceneHook.scene = null
    }
  }, [gl, scene])
  // 読み込みの間に、場面の全部の材質のパイプラインを先に作る（WebGPU の最初のコンパイルは数秒かかる。準備ができたの条件に入れる）
  const compiled = useRef<'no' | 'running' | 'done'>('no')
  useFrame(({ gl: r, scene: s, camera }) => {
    walkerState.frames++
    if (++drawn.current === 2) loadingLabBuilt()
    if (walkerState.ready || townState.status === 'idle' || townState.status === 'loading' || vrmPending()) return
    // 描画の土台が WebGPU・実の GPU でなければ、準備ができたにしない（src/gpu.ts が画面とコンソールに理由を出す）
    if (gpuState.ok !== true) return
    if (compiled.current === 'no') {
      compiled.current = 'running'
      const t0 = performance.now()
      ;(r as unknown as WebGPURenderer)
        .compileAsync(s, camera)
        .catch((e: unknown) => console.error('[town-walker] 材質の先のコンパイルに失敗しました', e))
        .finally(() => {
          compiled.current = 'done'
          if (DEBUG) console.info(`[town-walker] 先のコンパイル ${Math.round(performance.now() - t0)}ms`)
        })
    }
    if (compiled.current !== 'done') return
    if (++settled.current >= 30) {
      walkerState.ready = true
      document.documentElement.dataset.walkerReady = '1'
      loadingReady()
    }
  })
  return null
}
