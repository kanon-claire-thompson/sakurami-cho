import * as THREE from 'three'
import { outdoor } from '../../environment/daylight'
import type { ClockSpec } from './kit'
import { markPaint } from '../paint'

/**
 * 時計の針（駅の時計塔・時計店の吊り時計）。文字盤は看板のアトラスの絵、針は黒い板で、町の時刻（outdoor.time）を指す。
 * createNamed の rebuild が近くの時計の針を作り、毎コマ tickClocks で回す
 */

interface Hands {
  hour: THREE.Object3D
  minute: THREE.Object3D
}

const list: Hands[] = []
const HAND_MAT = new THREE.MeshBasicMaterial({ color: '#141414', side: THREE.DoubleSide })

/** 時計の針を作る（戻り値を group に足す） */
export function createClockHands(c: ClockSpec) {
  const root = new THREE.Group()
  root.position.set(...c.center)
  root.lookAt(c.center[0] + c.out[0], c.center[1] + c.out[1], c.center[2] + c.out[2])
  const hand = (len: number, w: number, dz: number) => {
    const g = new THREE.PlaneGeometry(w, len * 1.18).translate(0, len * 0.41, dz)
    const pivot = new THREE.Group()
    // 針は平らな色の物の印（監査が読む。描き方は変わらない）
    pivot.add(new THREE.Mesh(g, markPaint(HAND_MAT, 'flat')))
    root.add(pivot)
    return pivot
  }
  const h = { hour: hand(c.radius * 0.5, c.radius * 0.07, 0.02), minute: hand(c.radius * 0.78, c.radius * 0.045, 0.035) }
  list.push(h)
  return root
}

export function clearClocks() {
  list.length = 0
}

/** 針を今の時刻に（lookAt の向きでは局所の z が外向き。時計回り = 局所の z のまわりに負の向き） */
export function tickClocks() {
  if (!list.length) return
  const hrs = outdoor.time.hours
  const m = (hrs % 1) * 60
  const h12 = hrs % 12
  for (const h of list) {
    h.minute.rotation.z = -(m / 60) * Math.PI * 2
    h.hour.rotation.z = -(h12 / 12) * Math.PI * 2
  }
}
