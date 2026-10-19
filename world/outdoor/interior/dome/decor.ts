import * as THREE from 'three'
import { disposeGeometries } from '../../../dispose'
import { sceneOf } from '../../../../core/interiors'
import { outdoor } from '../../../environment/daylight'
import { createTreeMaterials, TREE, treeMeshesFromList, type TreeItem as TownTree } from '../../town/trees'
import type { DecorContext, InteriorDecor } from '../types'
import { createDomeGlassMaterial, domeGlassGeometry } from './glass'
import { angDiff, chunkAt, coreRadius, DEG, DOME, planting, rng, type TreeKind } from './layout'
import { createPlantMaterials, PlantWriter, writePlant } from './plants'
import { createFallMaterial, createMistSprite, createPoolMaterial, fallCurtain, fallGeometry, fallSheet, poolGeometry } from './water'

/**
 * ガーデンドームの、共通の形の外の物（中を作るときに 1 回作る）: 木（町の木の仕組み）・新しい形の植物（dome/plants.ts）・池の水面・
 * 大滝と細い滝・滝つぼのしぶき・雲霧林の霧・透けるガラスの半球。毎コマ: 季節（秋のレイアウトの紅葉）・葉脈ライティング・夜の照り返し・霧の濃さ
 */

const LAB = 116

/** 木の種類 → 町の木の種類・色のばらつき */
function townKind(k: TreeKind, tint: number): { kind: number; tint: number; shrub: boolean } {
  switch (k) {
    case 'maple':
      return { kind: TREE.maple, tint: tint * 0.5, shrub: false }
    case 'ginkgo':
      return { kind: TREE.maple, tint: 0.85 + tint * 0.15, shrub: false }
    case 'sakura':
      return { kind: TREE.sakura, tint, shrub: false }
    case 'conifer':
      return { kind: TREE.conifer, tint, shrub: false }
    case 'broadDark':
      return { kind: TREE.broadleaf, tint: tint * 0.25, shrub: false }
    case 'camphor':
      return { kind: TREE.broadleaf, tint: 0.3 + tint * 0.3, shrub: false }
    case 'pittosporum':
      return { kind: TREE.broadleaf, tint: 0.5 + tint * 0.3, shrub: true }
    case 'azalea':
    case 'camellia':
    case 'shrub':
      return { kind: TREE.broadleaf, tint: tint * 0.6, shrub: true }
    default:
      return { kind: TREE.broadleaf, tint: 0.35 + tint * 0.5, shrub: false }
  }
}

/** 秋のレイアウト（秋分〜冬至）の紅葉の度合い（ドームの中は季節のレイアウトで、外の楓坂より早い） */
function domeAutumn(doy: number) {
  // 秋分 266 → 290 で盛り、冬至 355 で次のレイアウトへ
  if (doy < 260 || doy > 358) return 0
  return Math.min(1, (doy - 260) / 22) * (1 - Math.max(0, (doy - 350) / 8))
}

export function domeDecor(ctx: DecorContext): InteriorDecor {
  const m = ctx.model
  const f = m.frame
  const S = (s: number, t: number, h: number) => sceneOf(f, s, t, h) as [number, number, number]
  const objects: THREE.Object3D[] = []
  const disposables: { dispose: () => void }[] = []
  const pl = planting()
  const nightAmb = ctx.uniforms.uIAmb.value[0]

  // --- 木（町の木の仕組み。ドームの中の木だけの光） ---
  const treeMats = createTreeMaterials()
  treeMats.uniforms.uWind.value = 0.25
  // 木と植物の「もう少しの光」: 夜は中の灯りの照り返し、昼はガラスの中で回る空の光（葉の下が真っ暗にならないように）
  const extraAmb = new THREE.Vector3()
  treeMats.uniforms.uExtraAmb.value = extraAmb
  const elevAt = (h: number) => f.z + h
  const tlist: (TownTree & { shrub?: boolean })[] = []
  const r = rng(4242)
  for (const t of pl.trees) {
    const tk = townKind(t.kind, t.tint)
    const [x, yPlan] = [S(t.s, t.t, 0)[0], -S(t.s, t.t, 0)[2]]
    tlist.push({ x, y: yPlan, z: elevAt(t.h) + 0.3, h: t.height, r: t.radius, kind: tk.kind, tint: tk.tint, seed: r(), shrub: tk.shrub })
  }
  // マングローブの樹冠（支柱根の上）
  for (const p of pl.plants)
    if (p.kind === 'mangrove') {
      const q = S(p.s, p.t, 0)
      tlist.push({ x: q[0], y: -q[2], z: elevAt(p.h + p.size * 0.35) + 0.3, h: p.size * 0.75, r: 2.0, kind: TREE.broadleaf, tint: 0.15, seed: r() })
    }
  const trees = treeMeshesFromList(tlist, treeMats)
  for (const tm of trees) {
    tm.renderOrder = 8
    objects.push(tm)
  }
  disposables.push(treeMats.near, treeMats.far, treeMats.nearDepth, treeMats.farDepth)

  // --- 新しい形の植物（所ごとの組にまとめる） ---
  const pm = createPlantMaterials(extraAmb)
  disposables.push(pm.material, pm.depth)
  const writers = new Map<string, PlantWriter>()
  const pr = rng(777)
  for (const p of pl.plants) {
    const key = chunkAt(p.s, p.t)
    let w = writers.get(key)
    if (!w) writers.set(key, (w = new PlantWriter()))
    writePlant(w, S, p, pr)
  }
  let plantTris = 0
  for (const [key, w] of writers) {
    if (!w.count) continue
    const mesh = new THREE.Mesh(w.build(), pm.material)
    mesh.name = `dome:plants:${key}`
    mesh.userData.shadowMaterial = pm.depth
    mesh.frustumCulled = true
    mesh.renderOrder = 8
    plantTris += w.idx.length / 3
    objects.push(mesh)
  }

  // --- 池の水面・大滝と細い滝・滝の口の岩棚 ---
  const poolMat = createPoolMaterial()
  poolMat.uniforms.uNightAmb.value = nightAmb
  const foamC = S(0, -(coreRadius(0) + 2.0), 0)
  poolMat.uniforms.uFoam.value.set(foamC[0], foamC[2], 0, 2.6)
  const pool = new THREE.Mesh(poolGeometry(S, DOME.pool.r0 - 0.5, DOME.pool.r1 + 0.05, DOME.pool.water), poolMat)
  pool.name = 'dome:pool'
  pool.renderOrder = 8
  pool.userData.noLocalShadow = true
  objects.push(pool)
  disposables.push(poolMat)
  const fallMat = createFallMaterial()
  fallMat.uniforms.uNightAmb.value = nightAmb
  disposables.push(fallMat)
  const fo = { pos: [] as number[], uv: [] as number[], idx: [] as number[] }
  const south = -Math.PI / 2
  // 大滝「天の水」: 口（h 18）→ 岩棚（h 12.2）→ 岩棚（h 6.6）→ 池
  fallCurtain(fo, S, 0, 0, south, coreRadius(18) + 0.3, 3.0, 17.7, 12.3, 0.9)
  fallCurtain(fo, S, 0, 0, south, coreRadius(12.2) + 1.2, 3.6, 12.1, 6.7, 0.8)
  fallCurtain(fo, S, 0, 0, south, coreRadius(6.6) + 1.6, 4.2, 6.5, DOME.pool.water, 0.9)
  // 核の段の植え込みから落ちる細い滝（東と西）
  for (const a of [-35 * DEG, -145 * DEG, 60 * DEG])
    fallCurtain(fo, S, 0, 0, a, coreRadius(9.4) + 0.7, 0.9, 9.3, DOME.pool.water, 0.5)
  // 枝の回廊・幹の回廊の縁から落ちる細い滝（下の植え込みの小さな池へ）
  const sheets: { a: number; r: number; h0: number; w: number }[] = [
    { a: 205 * DEG, r: DOME.L2.r0 - 0.25, h0: DOME.L2.h - 0.55, w: 1.0 },
    { a: -20 * DEG, r: DOME.L2.r0 - 0.25, h0: DOME.L2.h - 0.55, w: 0.8 },
    { a: 75 * DEG, r: DOME.L2.r0 - 0.25, h0: DOME.L2.h - 0.55, w: 0.9 },
    { a: 130 * DEG, r: DOME.L1.r0 - 0.25, h0: DOME.L1.h - 0.65, w: 0.8 },
    { a: -150 * DEG, r: DOME.L1.r0 - 0.25, h0: DOME.L1.h - 0.65, w: 0.7 },
  ]
  for (const sh of sheets) {
    const s = Math.cos(sh.a) * sh.r
    const t = Math.sin(sh.a) * sh.r
    fallSheet(fo, S, s, t, sh.a + Math.PI / 2, sh.a + Math.PI, sh.w, sh.h0, 0.05)
  }
  const falls = new THREE.Mesh(fallGeometry(fo), fallMat)
  falls.name = 'dome:falls'
  falls.renderOrder = 24
  falls.frustumCulled = false
  objects.push(falls)
  // 細い滝の下の小さな池（石の縁と水面）
  for (const sh of sheets) {
    const rr = sh.r - 0.6
    const c = [Math.cos(sh.a) * rr, Math.sin(sh.a) * rr] as const
    const g = poolGeometry((s, t, h) => S(c[0] + s, c[1] + t, h), 0.01, 1.4, 0.05, 24, 2)
    const pm2 = new THREE.Mesh(g, poolMat)
    pm2.name = 'dome:basin'
    pm2.renderOrder = 8
    objects.push(pm2)
  }

  // --- 霧（北の雲霧林の噴霧装置）と、滝つぼのしぶき ---
  const mp: number[] = []
  const ma: number[] = []
  const mr = rng(31)
  for (let i = 0; i < 520; i++) {
    const a = 90 * DEG + (mr() - 0.5) * 120 * DEG
    const rr = 21 + mr() * 36
    if (Math.abs(angDiff(a, 90 * DEG)) * rr < 2.5 && rr < 57) continue
    const h = 0.3 + mr() * mr() * 5
    mp.push(...S(Math.cos(a) * rr, Math.sin(a) * rr, h))
    ma.push(3 + mr() * 4, mr(), 0.05 + mr() * 0.07, 0)
  }
  for (let i = 0; i < 160; i++) {
    const a = south + (mr() - 0.5) * 0.45
    const rr = coreRadius(0) + 1.4 + mr() * 2.2
    mp.push(...S(Math.cos(a) * rr, Math.sin(a) * rr, 0.0 + mr() * 0.6))
    ma.push(0.6 + mr() * 1.2, mr(), 0.12 + mr() * 0.12, 1)
  }
  for (const sh of sheets) {
    for (let i = 0; i < 18; i++) {
      const rr = sh.r - 0.4 + (mr() - 0.5) * 0.8
      const a = sh.a + ((mr() - 0.5) * 1.2) / sh.r
      mp.push(...S(Math.cos(a) * rr, Math.sin(a) * rr, mr() * 0.4))
      ma.push(0.4 + mr() * 0.6, mr(), 0.1 + mr() * 0.1, 1)
    }
  }
  // 1px を超える点は Sprite（PointsNodeMaterial）を粒の数だけ並べる（WebGPU の点は 1px だけ）
  const mist = createMistSprite(mp, ma)
  const mistMat = mist.material
  mistMat.uniforms.uNightAmb.value = nightAmb
  disposables.push(mistMat)
  mist.name = 'dome:mist'
  mist.renderOrder = 25
  mist.frustumCulled = false
  objects.push(mist)

  // --- 透けるガラスの半球（外観の不透明なドームの代わり） ---
  const glassMat = createDomeGlassMaterial()
  disposables.push(glassMat)
  const glass = new THREE.Mesh(domeGlassGeometry(), glassMat)
  glass.name = 'dome:glass'
  const gc = S(0, 0, DOME.base)
  glass.position.set(gc[0], gc[1], gc[2])
  glass.scale.set(DOME.R - 0.05, DOME.H, DOME.R - 0.05)
  glass.renderOrder = 30
  glass.frustumCulled = false
  glass.userData.noLocalShadow = true
  objects.push(glass)

  void LAB
  void plantTris

  // --- 毎コマ ---
  const update = (_dt: number, camera: THREE.Camera) => {
    const o = outdoor
    const vein = o.dome * 1.6
    treeMats.uniforms.uAutumn.value = Math.max(o.autumn, domeAutumn(o.time.dayOfYear))
    treeMats.uniforms.uSpring.value = o.spring
    treeMats.uniforms.uVein.value = vein
    pm.uniforms.uVein.value = vein
    poolMat.uniforms.uVein.value = vein
    fallMat.uniforms.uVein.value = vein
    glassMat.uniforms.uDome.value = o.dome
    extraAmb.copy(nightAmb).addScaledVector(new THREE.Vector3(o.skyLight.r, o.skyLight.g, o.skyLight.b), 0.14)
    glassMat.uniforms.uInner.value.copy(nightAmb).multiplyScalar(1.2)
    // 霧の点の大きさ（画面の高さから）
    const cam = camera as THREE.PerspectiveCamera
    const hpx = typeof window !== 'undefined' ? window.innerHeight * (window.devicePixelRatio || 1) : 1080
    mistMat.uniforms.uPx.value = hpx / (2 * Math.tan(((cam.fov ?? 50) * Math.PI) / 360))
  }
  return {
    objects,
    update,
    dispose: () => {
      // Sprite の形（板 1 枚）は three の全部の Sprite が共有するので片付けない（霧の粒。disposeGeometries）
      for (const o of objects) disposeGeometries(o)
      for (const d of disposables) d.dispose()
    },
  }
}
