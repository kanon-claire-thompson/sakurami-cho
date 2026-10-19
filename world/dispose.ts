import * as THREE from 'three'

/**
 * 物の木の下の形（geometry）を全部捨てる。ただし Sprite の形は捨てない。
 *
 * three の Sprite は、全部の Sprite が 1 つの形（板 1 枚）を共有する。1 つの Sprite の形を dispose すると、WebGPU のバッファが
 * 壊されるのに、空の星・霧の粒・光の点など、ほかの Sprite の描く物はその壊れたバッファを持ったまま描き続け、毎コマ
 * 「Buffer used in submit while destroyed」になって、そのコマの描画がまるごと捨てられる（画が止まる）。
 * 前は、中のある建物を片付けるとき（ガーデンドームの霧の粒の Sprite）にこれが起きていた（kanon-stream-video の撮影で遠くへ跳んだあと）
 */
export function disposeGeometries(root: THREE.Object3D) {
  root.traverse((o) => {
    if ((o as THREE.Sprite).isSprite) return
    ;(o as THREE.Mesh).geometry?.dispose()
  })
}
