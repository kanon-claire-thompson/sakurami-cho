/**
 * 形を捨てる仕組みの見張り（world/dispose.ts の disposeGeometries）: 木の下の mesh の形は捨て、three の全部の Sprite が共有する形（板 1 枚）は捨てない。
 * 前は中のある建物を片付けるときに Sprite の形も捨てていて、空の星などほかの Sprite が壊れたバッファで描き続け、WebGPU の送りが毎コマ捨てられた
 * （kanon-stream-video の撮影で遠くへ跳んだあと「used in submit while destroyed」で画が止まった）
 */
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { disposeGeometries } from '../world/dispose'

describe('disposeGeometries', () => {
  test('mesh の形は捨て、Sprite の共有の形は捨てない', () => {
    const root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial())
    const other = new THREE.Sprite(new THREE.SpriteMaterial())
    expect(sprite.geometry).toBe(other.geometry)
    const inner = new THREE.Group()
    inner.add(sprite)
    root.add(mesh, inner)
    const disposed: string[] = []
    mesh.geometry.addEventListener('dispose', () => disposed.push('mesh'))
    sprite.geometry.addEventListener('dispose', () => disposed.push('sprite'))
    disposeGeometries(root)
    expect(disposed).toEqual(['mesh'])
  })
})
