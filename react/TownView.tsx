import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'
import { useTexture } from '@react-three/drei'
import type { Town } from '../world/createTown'
import type { Lab } from '../world/lab/createLab'
import { labOptions } from '../world/lab/labHost'
import type { LabPlacement } from '../core/lab/placements'
import { labTextureUrls, type LabFloorTextures, type LabTextureUrls } from '../world/lab/textures'
import type { LabTextures } from '../world/materials/labMaterials'
import { townOptions, type TownFrame } from '../world/townHost'
import { LabContext, LabMaterialsContext, useLab } from './labHooks'
import { LabAnimeView } from './AnimeView'

/**
 * 町の R3F の薄い包み（docs/design/map-split.md §7 の「5-6 で作った形」。案の §2.5）。中身は three の形の町の口（world/createTown.ts）で、
 * ここは React の時期（Suspense・useMemo・effect・useFrame）に合わせて作る・付ける・毎コマ呼ぶだけ。町の毎コマの 4 つの段を、使う側の木の
 * 決まった位置に置く:
 *
 * - TownClock: town.begin（優先度 −90。時計と外の状態。Suspense の外に置き、ラボのテクスチャを待つ間も進める）
 * - TownExposure: town.exposure（優先度 0.95。カメラ・撮影の構図・揺れのあと、描く前）
 * - TownRoot: テクスチャ（共有 7 枚と床 3 枚）を読み終えるまで待ち（Suspense の内側に置く。待つのはここだけ）、ラボを 1 回だけ作って
 *   （town.buildLab）子に配る。照明の差し込み口・キットの入力の値と差し込み口はラボの口（world/lab/labHost.ts の configureLab）から。
 *   捨てるのは本当に外したときだけ
 * - TownView: ラボの照明・外の光・遠景・殻・什器を場面に置き（この順。外の光と遠景は描く時に town.buildOutdoor。モジュールに 1 つで、作り直さず
 *   捨てない）、場面に付け（layout effect で town.attach）、地図データを読み始める（effect で town.start）。毎コマは town.update（優先度 −50）と
 *   town.view（優先度 0。カメラを動かしたあと）。TownRoot の最初の子に置く
 *
 * 空気（光の筋・ほこり）と差し込み口の portal は LabView.tsx（LabAtmosphere・LabSlot）
 */

/** TownRoot が受けた町（TownView が読む） */
const TownContext = createContext<Town | null>(null)

/** TownRoot の内側の町（React の速い更新が効くように、ここからは部品だけを出す） */
function useTown(): Town {
  const v = useContext(TownContext)
  if (!v) throw new Error('useTown は TownRoot の内側で使ってください')
  return v
}

/** 毎コマ update を呼ぶ（priority の順で。同じ優先度は置いた位置の購読の順） */
function useTownFrame(update: (f: TownFrame) => void, priority: number) {
  const frame = useRef<TownFrame>({ time: 0, dt: 0, camera: null!, renderer: null!, scene: null! })
  useFrame(({ clock, camera, gl, scene }, delta) => {
    const f = frame.current
    f.time = clock.elapsedTime
    f.dt = delta
    f.camera = camera
    f.renderer = gl as unknown as WebGPURenderer
    f.scene = scene
    update(f)
  }, priority)
}

/** 町の時計と外の状態（town.begin。Canvas の中に 1 つだけ、Suspense の外に置く。乗る仕組み（RideDriver の −79）・花音より前） */
export function TownClock({ town }: { town: Town }) {
  useTownFrame((f) => town.begin(f), -90)
  return null
}

/** 露出（town.exposure。Canvas の中に 1 つだけ置く。中は 1 のまま、外へ出るとなめらかに外の明るさへ） */
export function TownExposure({ town }: { town: Town }) {
  useTownFrame((f) => town.exposure(f), 0.95)
  return null
}

/**
 * アセットの根の textures/ 以下のテクスチャ（assets/textures/。出典は assets/textures/CREDITS.md。置き場所と下ごしらえは world/lab/textures.ts）。置き場は地図の引数 assetBase
 * （world/townHost.ts）から、初めて使うときに決める。決めたあとは同じ物を返す（useTexture の結果が描くたびに変わって、ラボを作り直さないように）
 */
let textureUrls: LabTextureUrls | null = null
const labUrls = () => (textureUrls ??= labTextureUrls(townOptions().assetBase))

/** 外したあと、付け直されなければ捨てるラボ（StrictMode の付け直しを待つ） */
const pendingDispose = new Map<Lab, ReturnType<typeof setTimeout>>()

/**
 * テクスチャを読んで、ラボを作って子に配る。Suspense の内側に置くこと。
 * placements（置き場所の表。既定は LAB_PLACEMENTS）は変えない値を渡す（変わるとラボを作り直す）
 */
export function TownRoot({ town, children, placements }: { town: Town; children: ReactNode; placements?: readonly LabPlacement[] }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const get = useThree((s) => s.get)
  const urls = labUrls()
  const shared = useTexture(urls.shared) as unknown as LabTextures
  // 床（殻が下ごしらえして使う）もここで待っておく（中の部品が待って作り直されないように）
  const floor = useTexture(urls.floor) as unknown as LabFloorTextures

  // 画素の比は作った時の物で始め、変わったら LabAtmosphere が入れる
  const lab = useMemo(
    () =>
      town.buildLab({
        renderer: gl as unknown as WebGPURenderer,
        scene,
        textures: { shared, floor },
        pixelRatio: get().viewport.dpr,
        placements,
        host: labOptions(),
      }),
    [town, gl, scene, get, shared, floor, placements],
  )
  // 捨てるのは本当に外したときだけ（StrictMode の effect の 2 回目の「外す → 付け直す」では捨てない。捨てると、最初のコマで GPU に上げた
  // 形・撮る先・影の地図が一度消えて上げ直しになり、画に出ない所の形の数が撮るたびに揺れる。4-4 の殻と同じ。照明と空気も 4-5 からこの形）
  useEffect(() => {
    const t = pendingDispose.get(lab)
    if (t !== undefined) {
      clearTimeout(t)
      pendingDispose.delete(lab)
    }
    return () => {
      pendingDispose.set(
        lab,
        setTimeout(() => {
          pendingDispose.delete(lab)
          lab.dispose()
        }),
      )
    }
  }, [lab])

  return (
    <TownContext.Provider value={town}>
      <LabMaterialsContext.Provider value={lab.materials}>
        <LabContext.Provider value={lab}>{children}</LabContext.Provider>
      </LabMaterialsContext.Provider>
    </TownContext.Provider>
  )
}

/**
 * ラボの照明・外の光・遠景・殻・什器（前の LabLights・OutdoorLighting・Landscape・LabShell・LabKits の位置。TownRoot の最初の子に置く）。
 * 場面の木の並びは前と同じ: 照明の群 → 太陽 → 太陽の target → 空の光 → trigger → 遠景の根 → 殻 → 什器の群。
 * 中にアニメ塗りの LabAnimeView（AnimeView.tsx。ラボの殻と什器の塗り・時刻の配色・キーライトの影の地図・注目点の人の VRM の合わせ）も置く
 */
export function TownView() {
  const town = useTown()
  const lab = useLab()
  const outdoor = town.buildOutdoor()
  // ふだんのカメラ（床の映り込みのカメラではない）。替わったら付け直す
  const camera = useThree((s) => s.camera)
  useLayoutEffect(() => town.attach(lab, camera), [town, lab, camera])
  useEffect(() => town.start(), [town])
  useTownFrame((f) => town.update(f), -50)
  useTownFrame((f) => town.view(f), 0)
  return (
    <>
      <primitive object={lab.lighting.object} />
      {outdoor.lights.map((o) => (
        <primitive key={o.uuid} object={o} />
      ))}
      <primitive object={outdoor.landscape} />
      <primitive object={lab.shell.object} />
      <primitive object={lab.kits.object} />
      {/* 什器が見えないコマを調べる箱（何も描かない。world/lab/labCull.ts） */}
      <primitive object={lab.cull.proxy} />
      {/* アニメ塗り（ラボの殻と什器の素材の差し替え・時刻の配色・影の地図と、注目点の人の VRM の合わせ。AnimeView.tsx） */}
      <LabAnimeView />
    </>
  )
}
