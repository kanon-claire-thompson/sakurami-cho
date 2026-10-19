import type * as THREE from 'three/webgpu'
import { abs, clamp, float, fract, max, min, step } from 'three/tsl'

type Node<T = unknown> = THREE.Node<T>
type F = Node<'float'>

/**
 * 看板の文字の形: 文字の升の中の位置 q（0〜1。左下が 0）と升ごとの乱数 h（0〜1）から、
 * 横の画（上・中・下）・縦の画（左・中・右）・斜めの画を乱数で組んだ、漢字・かなに見える形（1 = 画の上）。
 * 前の看板の文字は升ごとに点けるか消すかの白い四角だったので、遠くからは白い四角の並びに見えた。画は升の 1 割強の太さで、縁はくっきり
 * （細かくなりすぎる遠くは、呼ぶ側が今までどおり消す）。
 * fw = 1 画素あたりの q の変わり（fwidth。渡せば画を 1 画素の幅の箱で平均する（縁がなめらかになり、細い画は薄くなる）。渡さなければ前と同じくっきりした縁）。
 * 画は升の 0.15 の太さなので、升が 10 画素くらいより小さい所では、縁を切ったままだと画が画素の間に落ちたり乗ったりして、カメラが動くとチカチカした
 */
export function glyph(qx: F, qy: F, h: F, fw?: F): F {
  const bit = (k: number) => step(0.5, fract(h.mul(2 ** k).add(k * 0.137)))
  // |d| ≤ w なら 1。fw があれば、1 画素の幅の箱で平均した覆う割合（細い画は遠くで薄くなる。0.5 の灰色の筋にならない）
  const within = (d: F, w: number) => {
    if (!fw) return step(d, w)
    const r = max(fw.mul(0.6), 1e-5)
    return clamp(min(d.add(r), w).sub(max(d.sub(r), -w)), 0.0, r.mul(2.0)).div(r.mul(2.0))
  }
  const inX = fw ? within(abs(qx.sub(0.5)), 0.38) : step(0.12, qx).mul(step(qx, 0.88))
  const inY = fw ? within(abs(qy.sub(0.5)), 0.4) : step(0.1, qy).mul(step(qy, 0.9))
  const hBar = (y: number) => within(abs(qy.sub(y)), 0.075).mul(inX)
  const vBar = (x: number) => within(abs(qx.sub(x)), 0.075).mul(inY)
  // 中の縦か中の横のどちらかはいつも引く（画の無い升・点だけの升にならないように）
  const midV = bit(0)
  const strokes = [
    hBar(0.82).mul(bit(1)),
    hBar(0.5).mul(max(midV.oneMinus(), bit(2))),
    hBar(0.18).mul(bit(3)),
    vBar(0.2).mul(bit(4)),
    vBar(0.5).mul(midV),
    vBar(0.8).mul(bit(5)),
    // 斜めの画（はらい）: 左上から右下か、右上から左下
    within(abs(qx.add(qy).sub(1.0)), 0.09).mul(inX).mul(inY).mul(bit(6)).mul(bit(1).oneMinus()),
  ]
  let m: F = float(0.0)
  for (const s of strokes) m = max(m, s)
  return min(m, 1.0)
}
