import * as THREE from 'three'
import { thinUniforms } from './thin'
import { ENTRANCE, insideHall, ROOM } from '../../core/lab/plan'
import { SITE, TOWN_QUALITY } from '../../core/town'
import { insideLab, LOOKOUT, PARABOLA } from '../../core/site'
import { outdoor } from '../environment/daylight'
import { sharedTime } from '../materials/shared'
import { createBeamMaterial, createDomeMaterial, createLightsSprite, createStructureMaterial, LIGHT_KINDS, setTownDirection, syncOutdoorUniforms } from './materials'
import { beamGeometry } from './shapes'
import { skyParts } from './sky'
import { OUTDOOR_LAYER } from './layers'
import { collectInstances, instancedBuildingMesh, polyBuildingsGeometry } from './town/buildingKit'
import { buildInfraGeometry, buildWaterGeometry, gardenDomeMesh, structurePlacements } from './town/infraMeshes'
import { createSoranowa } from './town/soranowa'
import { Grass } from './town/grass'
import { createTransitMaterial } from './transit/transitMaterial'
import { transitClock } from './transit/clock'
import { LIGHT_KIND, lightsGeometry } from './town/lights'
import { buildTerrainGeometry, terrainGeometrySteps, terrainHeight, terrainOptions } from './town/terrain'
import { townData } from './town/townData'
import { TownShadows, depthMaterial } from './town/shadows'
import { siteGroundUniforms, createGroundMaterial, createTownBuildingDepthMaterial, createTownBuildingMaterial, propsCenter, createWaterMaterial, createWindowSprites, groundTexture, groundUniforms } from './town/townMaterials'
import { createTreeMaterials, shrubMesh, treeMeshes } from './town/trees'
import { createPropMaterials, propMeshes, shopFrontLamps } from './town/props'
import { LAMP, buildLampTable, lampTableSteps, lampUniforms, setLampFade, updateLampUniforms, type Lamp } from './town/lamps'
import { lampsFromNamed, lampsFromTiles } from './town/lampSources'
import { createTransit } from './transit/transit'
import { onTramPlatform, setupTramNet } from './transit/trams'
import { boatLandings, buildLandings, landingSurfaces } from './transit/landings'
import { labShrubs } from './town/landmarks'
import { createNamedTown } from './named/createNamed'
import { setNamedPads } from './named/grade'
import { createTownTextures } from './town/townTextures'
import { createLabSite, replacedTownLight, type LabSite } from './site/createSite'
import { designedY, site } from './site/siteModel'
import { interiors } from './interior/interiors'
import { townWalk } from '../walk/townWalk'
import { townSolids } from '../walk/townSolids'
import { townStairAnchors } from '../../core/interiors'
import { townDoorOpeners, townFocus, townOptions, type TownFrame } from '../townHost'

/**
 * ラボの外の景色: 空と星（sky.ts）と、町の地図データ（sync-town が書いた、アセットの根の town/）から組み立てた桜見町。
 *
 * 部品（town/）: 地形（高さ画像。ラボを中心にした放射状の格子）・地面の色（道・街区・公園・海辺を塗った画像）・海と川と運河と池・
 * 岸壁と防波堤・鉄道（築堤・高架・灯町の石造アーチ）とホーム・道の橋・ケーブルの線路と 2 両の車体・建物（型 × インスタンス 8 回と、
 * 形のある建物 1 回）・遠くの窓明かりの点・木（4 回）・構造物（クレーン・灯台・大パラボラなど 1 回）・観覧車ソラノワ・ガーデンドーム・
 * 夜の灯り・汐見島灯台の光の帯。設計は docs/design/town.md。
 *
 * 床の映り込みのパスには入れず（layers.ts）、外が見える窓がカメラの視野に無いときは、まるごと描かない。
 * 時刻の見た目は outdoor（world/environment/daylight.ts）を共有 uniform に写して、シェーダーで計算する。
 * データが無いときは空と、ラボの外観・まわりのセットとその影だけ（画面とコンソールに `pnpm sync:town` の案内。ui/TownNotice.tsx）。
 *
 * three の形（5-5。前の Landscape.tsx）: landscape() で根の群（子は空の球・星・町の群）をモジュールに 1 つだけ作る（作り直さず、捨てない。
 * 町の形・外の光・空と同じ）。使う側は、根を場面に置き、attach(camera)（ふだんのカメラに遠景のレイヤーを足す）→ start()（?debug の道具・
 * 地図データの読み込み）を呼び、毎コマ update(f)（町を組み立てる・影・中のある建物・灯り・交通）と、カメラを動かしたあとで updateView(f)
 * （窓の見え隠れ・細かさの中心）を呼ぶ。町の口（world/createTown.ts）の buildOutdoor・attach・start と、毎コマの段 town.update（−50）・
 * town.view（0）から呼ぶ
 */

/** 町の画質の段の描き方（地図の引数 townQuality。使うときに読む） */
const townQualityConfig = () => TOWN_QUALITY[townOptions().townQuality]
const debug = () => townOptions().debug
const LAB = SITE.labFloorElevation

/** 部屋の中の物の後に描く（壁に隠れた遠景の画素を、深度のテストで早めに捨てる） */
const ORDER = 10

/** 町を組み立てる（データを読み終えたあと 1 回だけ） */
function createTown(anisotropy: number) {
  const quality = townQualityConfig()
  const plainDepth = depthMaterial()
  const manifest = townData.manifest!
  // 町を歩く共通の仕組み（道のグラフ・石段・橋の路面。world/walk/townWalk.ts）。石段の下の地形を下げるので、地形の格子より先に
  // 石段のわきの縁石・擁壁を付けない所は、名前のある建物の外形と敷地（トンプソン家の門の前など）
  const keepOut = (townData.named?.buildings ?? []).filter((b) => b.drawn).flatMap((b) => [b.ring, ...b.sites.map((st) => st.ring)])
  townWalk.init(townData.walk, townData.infra, townStairAnchors(), keepOut)
  // 運河バスの乗り場（岸の石段・桟橋の乗船の段。transit/landings.ts）: 歩ける面。舟の横付け・乗る仕組み・駅員ロボが使う
  if (townData.infra?.transit) {
    boatLandings.list = buildLandings(townData.infra, townData.infra.transit, (x, y) => townData.heightAt(x, y), (x, y) => townData.waterAt(x, y))
    townWalk.setExtraSurfaces('landings', landingSurfaces(boatLandings.list))
  }
  // ラボのまわりのセットの形の決まり（小道・地形を均す）を、地図データで作り直す（地形の格子より先に）
  site.build()
  const infra = townData.infra!
  const tiles = townData.tiles
  const ground = townData.ground!

  // 地面の画像と範囲（シェーダーの uniform は地面と海が共有）
  const ext = (e: (typeof manifest.ground)['center']['extent']) => new THREE.Vector4(e.xmin, e.ymax, e.width * e.pixel_m, e.height * e.pixel_m)
  groundUniforms.uGroundC.value = groundTexture(ground.center.albedo, true, anisotropy)
  groundUniforms.uAuxC.value = groundTexture(ground.center.aux, false, anisotropy)
  groundUniforms.uGroundO.value = groundTexture(ground.overview.albedo, true, anisotropy)
  groundUniforms.uAuxO.value = groundTexture(ground.overview.aux, false, anisotropy)
  groundUniforms.uExtC.value.copy(ext(manifest.ground.center.extent))
  groundUniforms.uExtO.value.copy(ext(manifest.ground.overview.extent))
  setTownDirection(...manifest.landmarks.townCenter)
  createTownTextures(townData.textures, anisotropy)

  // 作り直した広場（ひらき見晴らし台）: 地図の広場の石畳を、作った台の外では芝に戻す
  const plaza = infra.site?.plazas.find((p) => p.id === 'plaza.miharashidai')
  if (plaza) {
    const cx = plaza.ring.reduce((s, q) => s + q[0], 0) / plaza.ring.length
    const cy = plaza.ring.reduce((s, q) => s + q[1], 0) / plaza.ring.length
    const r = plaza.ring.reduce((s, q) => s + Math.hypot(q[0] - cx, q[1] - cy), 0) / plaza.ring.length
    siteGroundUniforms.uUnpave.value.set(cx, -cy, r, 0)
    siteGroundUniforms.uKeep.value.set(LOOKOUT.center[0], LOOKOUT.center[1], LOOKOUT.radius)
  }
  // 地形（名前のある建物の入口の前と、緑電の停留所のホームのまわりを均してから。緑電の線路の高さは均す前の地形から決める）
  setNamedPads(townData.named)
  setupTramNet(infra.transit)
  const groundMat = createGroundMaterial()
  groundMat.uniforms.uGroundDetail.value = quality.groundDetail
  const terrain = new THREE.Mesh(buildTerrainGeometry(terrainOptions(quality.terrainBearingStep, quality.terrainRadius)), groundMat)
  terrain.frustumCulled = false
  terrain.name = 'townTerrain'
  terrain.userData.shadowMaterial = plainDepth

  // 海（水平線まで。陸の所は描かない）と、川・運河・池
  const seaMat = createWaterMaterial(true)
  const seaGeo = new THREE.CircleGeometry(38000, 192).rotateX(-Math.PI / 2).translate(0, -LAB, 0)
  seaGeo.deleteAttribute('uv')
  const sea = new THREE.Mesh(seaGeo, seaMat)
  sea.frustumCulled = false
  sea.name = 'townSea'
  const waterMat = createWaterMaterial(false)
  const water = new THREE.Mesh(buildWaterGeometry(infra), waterMat)

  // 名前のある建物と構造物（named/。近くは細かい形、遠くは町の建物のシェーダーの安い形）。作った建物は地図データの自動の形から外す
  const polyMat = createTownBuildingMaterial(false)
  polyMat.uniforms.uInterior.value = quality.interior ? 1 : 0
  const polyDepth = createTownBuildingDepthMaterial(false)
  const named = townData.named ? createNamedTown(townData.named, infra, (x, y) => townData.heightAt(x, y), polyMat, polyDepth, quality.namedNear, ORDER) : null
  named?.rebuild([0, 0])
  // 中のある建物の中の決まり（花音の通り道・高さ。形は近づいたときに作る。interior/）。木を置く前に（建物のまわりの木を除く）
  interiors.init(townData.named, (x, z, step) => townWalk.groundY(x, z, 0, step))
  const skip = (namedIndex: number) => named?.skip(namedIndex) ?? false
  // 町の当たりの形（カメラの確かめ）の木も、描く木と同じ所に（ラボの前のセット・中のある建物の敷地の木の置き直し。§7 の 175）
  townSolids.setTreeAdjust(treeOnSite)
  // 建物: 型 × インスタンス（屋根の形ごと）と、形のある建物
  const { byRoof, all } = collectInstances(tiles, [0, 0], undefined, skip)
  const buildingMat = createTownBuildingMaterial(true)
  buildingMat.uniforms.uInterior.value = quality.interior ? 1 : 0
  const buildingDepth = createTownBuildingDepthMaterial(true)
  const buildings = [...byRoof.entries()].map(([roof, set]) => instancedBuildingMesh(roof, set, buildingMat, buildingDepth))
  const polys = new THREE.Mesh(polyBuildingsGeometry(tiles.flatMap((t) => t.meta.polys).filter((p) => p.namedIndex < 0 || !skip(p.namedIndex))), polyMat)
  polys.frustumCulled = false
  polys.name = 'townBuildings:poly'
  polys.userData.shadowMaterial = polyDepth
  // 遠くの窓明かりの点（Sprite を 1 棟 16 個。town/townMaterials.ts）
  const sprites = createWindowSprites(all)
  const spriteMat = sprites.material
  sprites.visible = quality.windowSprites

  // 木
  const treeMat = createTreeMaterials()
  const trees = treeMeshes(tiles, treeMat, quality.nearTreeDistance, quality.treeShare, [0, 0], treeOnSite)
  // ラボの前の斜面の植え込み（細かさの中心が動いても変えない。小道・セットの上は除く）
  const shrubs = shrubMesh(labShrubs(manifest, ground.center.aux, (x, y) => terrainHeight(x, y), (x, y) => treeOnSite(x, y, 0) === null), treeMat)

  // 草むら（カメラの近くの草の葉。town/grass.ts）。ラボのセット・小道・中のある建物の中には置かない
  const grass = new Grass(
    {
      radius: quality.grassRadius,
      heightAt: (x, y) => terrainHeight(x, y),
      allowed: (x, y) => {
        const z = -y
        if (insideLab(x, z, 3) || (x > -11 && x < 11 && z > -15 && z < 11)) return false
        if (Math.abs(x) < 400 && Math.abs(z) < 400 && (designedY(x, z) !== null || site.pathAt(x, z, 0.6))) return false
        return !interiors.grassBlocked(x, z) && !onTramPlatform(x, y, 0.5)
      },
    },
    OUTDOOR_LAYER,
  )

  // 建物の小物（ベランダ・ひさし・看板・室外機・屋上の塔屋と給水塔とアンテナ）
  const propMats = createPropMaterials()
  propsCenter.value.set(0, 0, quality.detailRadius)
  const props = propMeshes(tiles, propMats, [0, 0], quality.detailRadius, quality.roofPropsRadius, skip)

  // 構造物（岸壁・鉄道・橋・ケーブルの線路・クレーン・灯台・大パラボラ・テラスなど）
  const structureMat = createStructureMaterial()
  const infraParts = buildInfraGeometry(infra, !!named, townWalk.stairs)
  // 町の石段のわきの擁壁の裏の植え込み（§7 の 172）。楓坂の斜面にまとまっているので、カメラが近く（外接の箱から STAIR_SHRUB_NEAR m）のときだけ描く
  const stairShrubs = shrubMesh(infraParts.stairShrubs, treeMat)
  const stairShrubBox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const sh of infraParts.stairShrubs) {
    stairShrubBox[0] = Math.min(stairShrubBox[0], sh.x)
    stairShrubBox[1] = Math.min(stairShrubBox[1], sh.y)
    stairShrubBox[2] = Math.max(stairShrubBox[2], sh.x)
    stairShrubBox[3] = Math.max(stairShrubBox[3], sh.y)
  }
  if (debug()) console.info(`[sakurami-cho] 石段のわきの植え込みの低木: ${infraParts.stairShrubs.length}`)
  const structures = new THREE.Mesh(infraParts.geometry, structureMat)
  structures.frustumCulled = false
  structures.userData.shadowMaterial = plainDepth
  const place = structurePlacements(infra.structures)
  const extras: THREE.Object3D[] = []
  const domeMat = createDomeMaterial(16, 5)
  // ガーデンドームのガラスと骨はドームのシェーダー。基壇・入口・近くの骨は名前のある建物（named/kits/observatory.ts の gardenDome）
  if (place.dome) extras.push(gardenDomeMesh(place.dome, domeMat))
  // 観覧車ソラノワ（鋼管と線のホイール・支柱・ゴンドラ 60 基。town/soranowa.ts）
  const soranowa = place.soranowa ? createSoranowa(place.soranowa, createTransitMaterial(), OUTDOOR_LAYER) : null
  if (soranowa) extras.push(soranowa.group)
  if (soranowa && debug()) (window as unknown as { __soranowa: unknown }).__soranowa = soranowa

  // 夜の灯り（最後に汐見島灯台の閃光）と、灯台の光の帯
  const lh = place.lighthouse
  const extraLights = [...infraParts.lights]
  // 町の石段の足元灯（town/townStairsMesh.ts。§7 の 173）
  for (const l of infraParts.stairLights) extraLights.push({ x: l.x, y: l.y, z: l.z, kind: LIGHT_KIND.path, color: '#ffb866', size: 0.2, power: 1.1, seed: l.seed })
  if (lh) extraLights.push({ x: lh.x, y: lh.y, z: lh.focal, kind: LIGHT_KIND.lighthouse, color: '#fff8ea', size: 26, power: 7, seed: 0 })
  // ラボの前のセット（外観・テラス・石段・スロープ・小道・見晴らし台・街灯）
  const labSite = createLabSite(anisotropy, treeMat)
  extraLights.push(...labSite.lightItems)
  if (named) extraLights.push(...named.lights)
  // 交通（緑電・ヒノテツ・ケーブルカー・船・浮遊レーン）と線路・架線・停留所・信号・街灯の柱（transit/）
  const transit = createTransit(infra, tiles, replacedTownLight, quality.transitNear)
  if (transit) extraLights.push(...transit.lights)
  // 夜の灯りが壁と地面を照らす表（街灯・提灯・足元灯・港の作業灯・名前のある建物の灯具・店先・停留所）
  const lamps: Lamp[] = [
    ...lampsFromTiles(tiles, replacedTownLight),
    ...(named ? lampsFromNamed(named.lights) : []),
    ...shopFrontLamps(tiles, skip),
    ...(transit?.lamps ?? []),
    ...infraParts.stairLights.map((l) => ({ x: l.x, y: l.y, z: l.z, kind: LAMP.foot, power: 1.1 })),
  ]
  const lampInfo = buildLampTable(lamps, [0, 0])
  setLampFade(...quality.lampFade)
  if (debug()) (window as unknown as { __lamps: unknown }).__lamps = lampUniforms
  if (debug()) console.info(`[sakurami-cho] 灯りの表: 灯り ${lampInfo.lamps}・升 ${lampInfo.cells}・${Math.round(lampInfo.ms)}ms`)
  // 灯りは Sprite を灯りの数だけ並べる（WebGPU の点は 1px だけ。materials.ts の createLightsSprite）
  const lights = createLightsSprite(lightsGeometry(tiles, extraLights, replacedTownLight))
  lights.frustumCulled = false
  lights.renderOrder = -1
  const beamMat = createBeamMaterial()
  const beam = new THREE.Mesh(beamGeometry(9000), beamMat)
  beam.frustumCulled = false
  beam.renderOrder = -1
  beam.visible = false
  if (lh) beam.position.set(lh.x, lh.focal - LAB, -lh.y)
  const toLab = Math.atan2(-beam.position.x, -beam.position.z)

  const objects: THREE.Object3D[] = [terrain, sea, water, ...buildings, polys, ...props, ...trees, shrubs, stairShrubs, structures, ...extras, sprites, lights, beam, labSite.group, ...(named ? [named.group] : []), interiors.group, ...(transit ? [transit.group] : []), grass.group]
  for (const o of objects) prepare(o)
  const shadows = new TownShadows(quality.shadowSize, quality.shadowNear, quality.shadowFar, quality.shadowNearMax, quality.localShadow)
  return { objects, shadows, labSite, named, buildingDepth, stairShrubs, stairShrubBox, props, propMats, skip, terrain, buildings, trees, sprites, groundMat, seaMat, waterMat, buildingMat, polyMat, spriteMat, treeMat, structureMat, domeMat, soranowa, transit, grass, lamps, lights, beam, beamMat, toLab, hasBeam: !!lh, lodCenter: [0, 0] as [number, number], terrainCenter: [0, 0] as [number, number], lampCenter: [0, 0] as [number, number] }
}

/**
 * ラボのまわりの木: 小道・テラスなどセットの上の木は置かず（null）、均した地面の高さに置き直す。ラボから遠い木はそのまま
 */
function treeOnSite(x: number, y: number, z: number): number | null {
  // 中のある建物（トンプソン家など）の敷地と前の歩ける所には置かない
  if (interiors.treeBlocked(x, -y)) return null
  if (Math.abs(x) > 300 || Math.abs(y) > 300) return z
  const sz = -y
  if (designedY(x, sz) !== null || insideLab(x, sz, 2.5)) return null
  // ラボの殻（北の部屋・放熱器まで）と大パラボラのまわりは空ける
  if (x > -11 && x < 11 && sz > -10.5 && sz < 10) return null
  if (Math.hypot(x - PARABOLA.center[0], sz - PARABOLA.center[1]) < PARABOLA.clear) return null
  const hit = site.pathAt(x, sz, 1.2)
  if (hit) return null
  return terrainHeight(x, y)
}

function prepare(o: THREE.Object3D) {
  // ラボの前のセット・名前のある建物は、中の物ごとにレイヤーと描く順を決めてある（createSite.ts・named/createNamed.ts）
  if (o.name === 'labSite' || o.name === 'named' || o.name === 'interiors' || o.name === 'transit' || o.name === 'soranowa' || o.name === 'grass') return
  o.layers.set(OUTDOOR_LAYER)
  // 描く順: 建物 → 木・構造物 → 地形 → 海（手前の物を先に描いて、隠れた地面・海の画素を深度のテストで捨てる）
  if (o.renderOrder === 0) o.renderOrder = o.name.startsWith('townBuildings') ? ORDER : o.name === 'townTerrain' ? ORDER + 2 : o.name === 'townSea' ? ORDER + 3 : ORDER + 1
}

/** 石段のわきの植え込みの低木を描く距離（m。低木のまとまりの外接の箱から） */
const STAIR_SHRUB_NEAR = 300

/** 細かさの中心を動かすまでの距離（m）。撮影でカメラが窓の外の遠くへ出たときだけ動く（ラボの中のカメラでは動かない） */
const RELOD_DISTANCE = 500
/**
 * 町の中（ラボから 200m より遠く）を歩く・撮るときは、地形の格子の中心をカメラの近くに保つ（120m 動いたら作り直す。§7 の 152）。
 * 地形の格子は中心から遠いほど粗いので、離れたままだと足元の地面と花音の足がずれる。作り直しは 1 コマに TERRAIN_BUDGET_MS ずつ進める
 */
const RELOD_DISTANCE_TERRAIN = 120
/** 建物の型・木・小物・名前のある建物・交通の細かさの中心は、町の中では 300m 動いたら（どれも細かく描く範囲が 450m 以上ある） */
const RELOD_DISTANCE_DETAIL = 300
/** 地形の格子を作る手順に 1 コマで使う時間（ms） */
const TERRAIN_BUDGET_MS = 5
/** 夜の灯りの表（1.5km 四方）は、中心が 300m 動いたときだけ作り直す */
const LAMP_TABLE_MOVE = 300

/** 地形の格子の中心を center へ動かす手順（輪ごとに yield。できたら差し替える） */
function* terrainSteps(t: Town, center: [number, number]): Generator<void> {
  const quality = townQualityConfig()
  const t0 = performance.now()
  t.terrainCenter = center
  const geo = yield* terrainGeometrySteps(terrainOptions(quality.terrainBearingStep, quality.terrainRadius, center))
  t.terrain.geometry.dispose()
  t.terrain.geometry = geo
  t.shadows.invalidate()
  if (debug()) console.info(`[sakurami-cho] 地形の格子の中心を (${Math.round(center[0])}, ${Math.round(center[1])}) へ（${Math.round(performance.now() - t0)}ms）`)
}

/**
 * 細かさ（建物の型・木の形・小物・名前のある建物・交通・灯りの表）の中心を center へ動かして、作り直す手順。1 つ進むごとに yield する
 * （町の中を歩く間は 1 コマに 1 手順ずつ進め、1 コマが長くならないようにする。カットで遠くへ移ったときは、同じコマで全部進める）
 */
function* relodSteps(t: Town, group: THREE.Group, center: [number, number]): Generator<string> {
  const quality = townQualityConfig()
  const t0 = performance.now()
  const times: string[] = []
  let last = t0
  const mark = (name: string) => {
    const now = performance.now()
    times.push(`${name} ${Math.round(now - last)}`)
    last = now
    return name
  }
  t.lodCenter = center
  const tiles = townData.tilesFor(center)
  const { byRoof } = collectInstances(tiles, center, undefined, t.skip, false)
  const buildings = [...byRoof.entries()].map(([roof, set]) => instancedBuildingMesh(roof, set, t.buildingMat, t.buildingDepth))
  swap(group, t.buildings, buildings)
  t.buildings = buildings
  yield mark('建物')
  const trees = treeMeshes(tiles, t.treeMat, quality.nearTreeDistance, quality.treeShare, center, treeOnSite)
  swap(group, t.trees, trees)
  t.trees = trees
  yield mark('木')
  propsCenter.value.set(center[0], center[1], quality.detailRadius)
  const props = propMeshes(tiles, t.propMats, center, quality.detailRadius, quality.roofPropsRadius, t.skip)
  swap(group, t.props, props)
  t.props = props
  yield mark('小物')
  t.named?.rebuild(center)
  yield mark('名前のある建物')
  if (t.transit) {
    const g = t.transit.relodSteps(center)
    while (!g.next().done) yield '交通の途中'
  }
  yield mark('交通')
  if (Math.hypot(center[0] - t.lampCenter[0], center[1] - t.lampCenter[1]) > LAMP_TABLE_MOVE || Math.hypot(center[0], center[1]) < 1) {
    yield* lampSteps(t.lamps, center)
    t.lampCenter = center
    yield mark('灯りの表')
  }
  t.shadows.invalidate()
  if (debug()) console.info(`[sakurami-cho] 細かさの中心を (${Math.round(center[0])}, ${Math.round(center[1])}) へ（${Math.round(performance.now() - t0)}ms: ${times.join('・')}）`)
}

/** 灯りの表を作る手順（途中は '灯りの表の途中' を yield） */
function* lampSteps(lamps: Lamp[], center: [number, number]): Generator<string> {
  const g = lampTableSteps(lamps, center)
  while (!g.next().done) yield '灯りの表の途中'
}

/** 古い形を外して新しい形を入れる */
function swap(group: THREE.Group, old: THREE.Object3D[], next: THREE.Object3D[]) {
  for (const m of old) {
    group.remove(m)
    ;(m as THREE.Mesh).geometry?.dispose()
  }
  for (const m of next) {
    prepare(m)
    group.add(m)
  }
}

/** 中心を動かす手順の途中（地形の格子と、ほかの細かさ） */
let terrainJob: Generator<void> | null = null
let relodJob: Generator<string> | null = null
/** ?debug: 細かさの中心の様子（window.__lod()）と町の当たりの形（window.__solids）。初めて描くときに 1 回（地図の引数を入れたあと） */
let debugInstalled = false
function installDebug() {
  if (debugInstalled) return
  debugInstalled = true
  if (!debug() || typeof window === 'undefined') return
  Object.assign(window as unknown as Record<string, unknown>, {
    __lod: () => ({ terrain: townCache?.terrainCenter, lod: townCache?.lodCenter, lamp: townCache?.lampCenter, terrainJob: !!terrainJob, relodJob: !!relodJob }),
    // 町の当たりの形（カメラの確かめ。__solids.blocker(x, y, z, margin)）
    __solids: townSolids,
    // 町の地面の高さ・歩く道（__townWalk.groundY(x, z)・__townData.heightAt(x, y)）
    __townWalk: townWalk,
    __townData: townData,
  })
}

type Town = ReturnType<typeof createTown>

/** ?debug のとき、町の部品ごとの三角形・インスタンスの数と、組み立てにかかった時間をコンソールに出す */
function logTown(t: Town, ms: number) {
  const tris = (o: THREE.Object3D) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (!g || (o as THREE.Points).isPoints) return 0
    const per = (g.index ? g.index.count : g.attributes.position.count) / 3
    const inst = (g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry ? (g as THREE.InstancedBufferGeometry).instanceCount : (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1
    return per * inst
  }
  const sum = (list: THREE.Object3D[]) => Math.round(list.reduce((s, o) => s + tris(o), 0))
  const rows = {
    建物: sum(t.buildings) + sum(t.objects.filter((o) => o.name === 'townBuildings:poly')),
    地形: sum([t.terrain]),
    木: sum(t.trees),
    ほか: sum(t.objects.filter((o) => !(t.buildings as THREE.Object3D[]).includes(o) && !(t.trees as THREE.Object3D[]).includes(o) && o !== t.terrain && o.name !== 'townBuildings:poly')),
  }
  console.info(`[sakurami-cho] 町を組み立てました（${Math.round(ms)}ms・部品 ${t.objects.length}・タイル ${townData.tiles.length}）三角形:`, rows)
}
let townCache: Town | null = null
/** 町の影の地図を描き直した、中のある建物の版（interiors.shadowVersion） */
let shadowSeen = 0

const _local = new THREE.Vector2()
/** 町のデータが無いときの、ラボの外観とセット（決めた面と作り直した小道だけ） */
let fallbackSite: LabSite | null = null
/**
 * 町のデータが無いときの影の地図（ラボの外観とセットの太陽の影。町があるときと同じ仕組みで、地図に入るのがラボの外観とセットだけになる）。
 * セットのシェーダーは町の影の地図を読むので、無いと描けない（深さのテクスチャでない物を比較の sampler で読む誤りになる）
 */
let fallbackShadows: TownShadows | null = null
const _dir = new THREE.Vector3()
const _view = new THREE.Vector2()
const _center = new THREE.Vector2()

/**
 * 外が見える窓（南のガラス壁と見学エントランスの扉・西と東のハイサイドの窓）。カメラの視野にどれも入っていないときは、
 * 遠景（空も）をまるごと描かない（遠景は部屋を囲むほど大きいので、ふつうの視錐台カリングでは外れない。配信メインなど北を向く画で軽くする）。
 * 少し大きめの箱にして、見え始めの判定に余裕を持たせる
 */
const WINDOW_BOXES = [
  new THREE.Box3(new THREE.Vector3(ENTRANCE.glassFrom - 0.3, -0.3, ROOM.south - 0.3), new THREE.Vector3(ROOM.halfWidth, ROOM.height + 0.3, ROOM.south + 0.3)),
  ...[-1, 1].map(
    (s) => new THREE.Box3(new THREE.Vector3(s * ROOM.halfWidth - 0.3, 2.3, ROOM.north), new THREE.Vector3(s * ROOM.halfWidth + 0.3, 4.7, ROOM.south)),
  ),
]
const _frustum = new THREE.Frustum()
const _vp = new THREE.Matrix4()

/** カメラの視野に、外が見える窓が入っているか（カメラが部屋の外にいるときは、いつも見える） */
function windowsInView(camera: THREE.Camera) {
  camera.updateMatrixWorld()
  const p = camera.position
  if (!insideHall(p.x, p.z, 0.5) || p.y > ROOM.height + 0.5 || p.y < -0.5) return true
  _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_vp)
  return WINDOW_BOXES.some((b) => _frustum.intersectsBox(b))
}

/**
 * 毎コマ（優先度 −50。花音を動かしたあと・外の光の前）: データを読み終えたら町を組み立て、太陽の影の地図・中のある建物・灯り・交通を進める
 */
function updateLandscape(root: THREE.Group, townGroup: THREE.Group, f: TownFrame) {
  const { camera, renderer: gl, dt: delta } = f
  // データを読み終えたら、町を組み立てる（1 回だけ。描画の流れの中で組み立てるので、撮影モードでも同じコマで出る）
  if (!townCache && townData.status === 'loading' && townData.infra && townData.tilesPlanned > 0 && townData.tiles.length >= townData.tilesPlanned) {
    const t0 = performance.now()
    townCache = createTown(gl.getMaxAnisotropy())
    if (debug()) logTown(townCache, performance.now() - t0)
    for (const o of townCache.objects) townGroup.add(o)
    townData.markReady()
  } else if (townCache && townGroup.children.length === 0) {
    for (const o of townCache.objects) townGroup.add(o)
  }
  syncOutdoorUniforms()
  const t = townCache
  // 町のデータが無い・形が違う: ラボの外観とセットと、その影の地図だけ作る（地形の高さは仮）
  if (!t && !fallbackSite && (townData.status === 'missing' || townData.status === 'outdated' || townData.status === 'error')) {
    createTownTextures(null, gl.getMaxAnisotropy())
    fallbackSite = createLabSite(gl.getMaxAnisotropy(), null)
    townGroup.add(fallbackSite.group)
    const quality = townQualityConfig()
    fallbackShadows = new TownShadows(quality.shadowSize, quality.shadowNear, quality.shadowFar, quality.shadowNearMax, quality.localShadow)
  }
  fallbackSite?.update()
  const shadows = t?.shadows ?? fallbackShadows
  if (!shadows) return
  // 太陽の影の地図（太陽が少し動いたとき・カメラが動いたときだけ描き直す）
  if (root.visible) {
    camera.getWorldDirection(_dir)
    _view.set(_dir.x, _dir.z)
    if (_view.lengthSq() < 1e-6) _view.set(0, 1)
    _view.normalize()
    _center.set(camera.position.x, camera.position.z)
    shadows.update(gl, townGroup, _center, _view, outdoor.sunDir)
    // 花音のまわりの細かい影（外にいるときだけ。花音・KB-001・ラボの外観とセット）
    const k = townFocus().position
    _local.set(k.x, k.z)
    shadows.updateLocal(gl, insideLab(k.x, k.z, -0.3) ? null : _local, outdoor.sunDir, k.y)
  }
  if (!t) return
  t.labSite.update()
  t.named?.update()
  {
    const [x0, y0, x1, y1] = t.stairShrubBox
    const cx = camera.position.x
    const cy = -camera.position.z
    const dx = Math.max(x0 - cx, 0, cx - x1)
    const dy = Math.max(y0 - cy, 0, cy - y1)
    t.stairShrubs.visible = Number.isFinite(x0) && Math.hypot(dx, dy) < STAIR_SHRUB_NEAR
  }
  // 中のある建物（近づいたら中を作る・扉・灯り・窓の光）。ガラスの温室の中を作った・壊したら、町の影の地図を描き直す
  interiors.update(camera, delta, townFocus(), townDoorOpeners())
  if (interiors.shadowVersion !== shadowSeen) {
    shadowSeen = interiors.shadowVersion
    t.shadows.invalidate()
  }
  const o = outdoor
  const glow = o.lights.street * 0.11 * o.lightGain
  t.groundMat.uniforms.uTownGlow.value = glow
  t.seaMat.uniforms.uTownGlow.value = glow * 0.6
  t.waterMat.uniforms.uTownGlow.value = glow
  t.propMats.material.uniforms.uShop.value = o.lights.shop
  t.propMats.material.uniforms.uLightGain.value = o.lightGain
  for (const m of [t.buildingMat, t.polyMat, t.spriteMat]) {
    m.uniforms.uWindows.value = o.lights.window
    m.uniforms.uOffice.value = o.lights.office
    m.uniforms.uShop.value = o.lights.shop
    m.uniforms.uLightGain.value = o.lightGain
  }
  t.treeMat.uniforms.uAutumn.value = o.autumn
  t.treeMat.uniforms.uSpring.value = o.spring
  t.domeMat.uniforms.uDome.value = o.dome
  t.structureMat.uniforms.uClock.value = o.clockFace * 2.2
  t.structureMat.uniforms.uWindows.value = o.lights.window * 1.4
  t.structureMat.uniforms.uPath.value = o.lights.path
  t.structureMat.uniforms.uLightGain.value = o.lightGain

  // 汐見島灯台: 10 秒で 1 回転する光の帯。ラボの方を向いた瞬間が閃光
  const period = 10
  const phase = ((sharedTime.value % period) / period) * Math.PI * 2
  t.beam.rotation.y = t.toLab + phase
  let diff = Math.abs(((phase + Math.PI) % (Math.PI * 2)) - Math.PI)
  diff = Math.min(diff, Math.PI * 2 - diff)
  const flash = Math.exp(-((diff / 0.075) ** 2))
  // ラボの方を向く前後は帯を消す（円錐の殻がカメラを横切るコマで、画面全体が一瞬明るくなるため。ラボの方を向いたことは閃光で見せる）
  const beam = o.lighthouse * THREE.MathUtils.smoothstep(diff, 0.1, 0.2)
  t.beamMat.uniforms.uBeam.value = beam
  t.beam.visible = t.hasBeam && beam > 0.01

  // 灯り
  const lm = t.lights.material
  const on = lm.uniforms.uOn.array as number[]
  on[LIGHT_KIND.window] = o.lights.window
  on[LIGHT_KIND.street] = o.lights.street
  on[LIGHT_KIND.port] = o.lights.port
  on[LIGHT_KIND.path] = o.lights.path
  on[LIGHT_KIND.far] = o.lights.far
  on[LIGHT_KIND.cable] = o.lights.cable
  on[LIGHT_KIND.aviation] = o.lights.port
  on[LIGHT_KIND.clock] = o.clockFace
  on[LIGHT_KIND.lighthouse] = o.lighthouse
  on[LIGHT_KIND.beacon] = o.lighthouse
  const gain = lm.uniforms.uKindGain.array as number[]
  gain[LIGHT_KIND.lighthouse] = 0.04 + flash
  lm.uniforms.uGain.value = o.lightGain
  const cam = camera as THREE.PerspectiveCamera
  const h = gl.domElement.height
  const px = h / (2 * Math.tan(((cam.fov ?? 45) * Math.PI) / 360))
  lm.uniforms.uPx.value = px
  thinUniforms.uPx.value = px
  // 交通（交通の時計で動く）と、夜の灯りの表の色と点き具合
  // 遠景を描かないコマ（北を向く配信の画など）は、時計だけ進めて車両を並べない（CPU を使わない）
  const shown = root.visible
  t.transit?.update(camera, delta, px, shown)
  if (shown) {
    t.soranowa?.update(camera, transitClock.sec, px)
    t.grass.update(camera, 0.8 + 0.4 * Math.sin(transitClock.sec / 900))
  }
  updateLampUniforms()
  lm.uniforms.uPixelRatio.value = gl.getPixelRatio()
  t.lights.visible = on.some((v, i) => i < LIGHT_KINDS && v > 0.001)
  t.spriteMat.uniforms.uPx.value = px
  t.spriteMat.uniforms.uPixelRatio.value = gl.getPixelRatio()
  // 遠くの窓明かりの点は、窓明かりが点いている間だけ描く（昼は頂点の計算もしない）
  t.sprites.visible = townQualityConfig().windowSprites && Math.max(o.lights.window, o.lights.office, o.lights.shop) > 0.005
}

/**
 * 毎コマ（優先度 0。カメラを動かしたあと）: 窓が視野に無いときは遠景を描かない（CameraControls は優先度 -1 で動かす）。細かさの中心を動かす
 */
function updateLandscapeView(root: THREE.Group, townGroup: THREE.Group, f: TownFrame) {
  const { camera } = f
  root.visible = windowsInView(camera)
  // 撮影でカメラが遠くへ出たら、細かさの中心をカメラの近くへ（戻ったらラボへ）。カメラを動かした後で決めるので、
  // 撮影のカットの最初のコマから細かい形で描ける（前は 1 コマだけ遠くの安い形が見えた）
  const t = townCache
  // カメラの位置が一コマ発散したとき（CameraDirector が置き直す）は、細かさの中心を動かさない
  const sane = Number.isFinite(camera.position.x + camera.position.z) && Math.hypot(camera.position.x, camera.position.z) < 50000
  if (t && sane) {
    const [cx, cy] = [camera.position.x, -camera.position.z]
    const inRoom = insideHall(camera.position.x, camera.position.z, 1)
    const want: [number, number] = inRoom ? [0, 0] : [cx, cy]
    const moved = Math.hypot(want[0] - t.lodCenter[0], want[1] - t.lodCenter[1])
    // 町の中（ラボから 200m より遠く）か、町の中から戻ってくる途中
    const town = !inRoom && (Math.hypot(cx, cy) > 200 || Math.hypot(t.terrainCenter[0], t.terrainCenter[1]) > 200)
    // カメラが遠くへ跳んだ（カット・ラボへ戻った）: 同じコマで全部作り直す
    if (moved > (inRoom ? 1 : RELOD_DISTANCE) || (inRoom && Math.hypot(t.terrainCenter[0], t.terrainCenter[1]) > 1)) {
      if (town) townData.loadAllTiles()
      terrainJob = null
      relodJob = null
      for (const step of terrainSteps(t, want)) void step
      for (const step of relodSteps(t, townGroup, want)) void step
    } else if (town) {
      // 町の中を歩いて少しずつ離れた: 地形は 1 コマに数 ms ずつ、ほかは 1 コマに 1 手順ずつ（地形を作っている間は待つ）
      townData.loadAllTiles()
      if (!terrainJob && Math.hypot(want[0] - t.terrainCenter[0], want[1] - t.terrainCenter[1]) > RELOD_DISTANCE_TERRAIN) terrainJob = terrainSteps(t, want)
      if (!relodJob && moved > RELOD_DISTANCE_DETAIL) relodJob = relodSteps(t, townGroup, want)
    }
    // 1 コマに TERRAIN_BUDGET_MS まで（ほかの細かさは、地形を作り終えてから。手順 1 つは必ず進める）
    const t1 = performance.now()
    if (terrainJob) {
      while (performance.now() - t1 < TERRAIN_BUDGET_MS) {
        if (terrainJob.next().done) {
          terrainJob = null
          break
        }
      }
    } else if (relodJob) {
      do {
        if (relodJob.next().done) {
          relodJob = null
          break
        }
      } while (performance.now() - t1 < TERRAIN_BUDGET_MS)
    }
  }
}

/** 遠景を作る（landscape() から 1 回だけ） */
function createLandscape() {
  // 作る順は空の球 → 星 → 町の群 → 根の群（素材と、描く物の id の並びは前の R3F の木と同じ。前の R3F の <group> 2 つは、three の物を
  // あとのコミットで作っていたので、群 2 つの id だけ前より若い。群は描かないので、描く順には効かない。5-5）
  const { sky, stars } = skyParts()
  const townGroup = new THREE.Group()
  const root = new THREE.Group()
  root.add(sky, stars, townGroup)
  return {
    /** 根の群（子は空の球・星・町の群） */
    object: root,
    /** ふだんのカメラは遠景のレイヤーも見る（床の映り込みのカメラは見ない）。カメラが替わったら、また呼ぶ */
    attach(camera: THREE.Camera) {
      camera.layers.enable(OUTDOOR_LAYER)
    },
    /** ?debug の道具を出して、地図データを読み始める（attach のあと。何度呼んでもよい） */
    start() {
      installDebug()
      townData.start()
    },
    /** 毎コマ（優先度 −50） */
    update(f: TownFrame) {
      updateLandscape(root, townGroup, f)
    },
    /** 毎コマ（優先度 0。カメラを動かしたあと） */
    updateView(f: TownFrame) {
      updateLandscapeView(root, townGroup, f)
    },
  }
}

export type Landscape = ReturnType<typeof createLandscape>
let landscapeCache: Landscape | null = null
/** 遠景（初めて呼んだときに作る。あとは同じ物） */
export const landscape = (): Landscape => (landscapeCache ??= createLandscape())
