import { Canvas } from '@react-three/fiber'
import { gpuRenderer } from './gpu'
import { QUALITY } from './quality'
import { Scene } from './scene/Scene'
import { MiniMap } from './ui/MiniMap'
import { TownMap } from './ui/TownMap'
import { TownNotice } from './ui/TownNotice'
import { TownPanel } from './ui/TownPanel'
import { TravelPanel } from './ui/TravelPanel'
import { VrmPanel } from './ui/VrmPanel'
import { WalkNotice } from './ui/WalkNotice'
import { WarpFade } from './ui/WarpFade'
import './index.css'

/**
 * 例のアプリのルート（3D の Canvas と、上に重ねる UI。6-2: VRM を選ぶ・落とす。6-3: 歩き方の案内。6-4: 行き先の一覧と旅程。6-5: ワープ（一覧は右上のパネルの札、暗転の幕は 3D の画とパネルの間）。
 * 6-6: 時刻と画質（左、VRM のつまみの下）・町の地図データの案内（上の真ん中）。#1: 小さい地図（右下。スマホの幅では右上）と、押すと開く全体の地図（いちばん上に重ねる））。
 * Canvas の設定は kanon-lab と同じ考え方: 影は percentage（PCF）、near 0.05・far 40000（外の遠景は湾の向こうの山並み 26km・空の球 30km まで）。
 * 描くのは地図の AnimeRender（場面を描き先に描いて、アニメ塗りの輪郭線を引く後処理。scene/Scene.tsx）なので、縁は Canvas の antialias ではなく、その最後の SMAA で
 * なめらかにする（Canvas の多重サンプルは切る）。?quality=low では描く細かさ（dpr）を 1 にし、SMAA も切る（kanon-lab の low が MSAA を落とすのと同じ考え。仮）
 */
export default function App() {
  return (
    <div className="app">
      <Canvas
        shadows="percentage"
        dpr={QUALITY.lab === 'high' ? [1, 1.5] : 1}
        // 描画は WebGPURenderer（非同期に作って確かめる。src/gpu.ts）
        gl={gpuRenderer(false)}
        camera={{ fov: 50, near: 0.05, far: 40000 }}
        // 場面の根は動かさない（行列を固める。ラボの殻と什器の動かない物も固めてあるので、描くたびの行列の計算は動く物の下だけ。WebGPU への移行の第 3 段）
        scene={{ matrixAutoUpdate: false }}
      >
        <Scene />
      </Canvas>
      <WarpFade />
      <div className="left-column">
        <VrmPanel />
        <TownPanel />
      </div>
      <TravelPanel />
      <TownNotice />
      <WalkNotice />
      <MiniMap />
      <TownMap />
    </div>
  )
}
