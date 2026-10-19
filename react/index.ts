/**
 * 入口 react（R3F の薄い包み。React・R3F を使ってよいのはここだけ。docs/design/map-split.md §7）。
 * この入口だけは kanon-lab も index から読む（sakurami-cho/react。読み込みの時に three の物を作らない）。
 * 並びは 5-8 の前に kanon-lab が読んでいた順（labHooks → CharacterView → labElements → LabView → RideDriver → TownView）。
 * labElements は R3F の JSX（<hologramMaterial>）の登録（extend）なので、読むだけで登録される
 */
export * from './labHooks'
export * from './CharacterView'
import './labElements'
export * from './LabView'
export * from './RideDriver'
export * from './TownView'
export * from './AnimeView'
