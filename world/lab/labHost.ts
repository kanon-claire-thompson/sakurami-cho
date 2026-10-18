import type { LabSlotContent } from './kit'
import type { BaseStationChannels } from './kits/baseStation'
import type { HoloTableChannels } from './kits/holoTable'
import type { PrinterJob, WorkbenchChannels } from './kits/workbench'
import type { ScreenDraw } from './screens'

/**
 * ラボの口（docs/design/map-split.md §6 の「段 4」。案の §4.2 の labHost.ts。world/townHost.ts と同じ考え方）。
 * ラボが使う側（アプリ）から受け取る中身と入力の値をここにまとめる。値は使う側が起動のときに入れる（kanon-lab は src/townBinding.ts）。
 * ラボは作る時に読む（town.buildLab（world/createTown.ts）が照明を作る時など）。
 *
 * 4-3 では照明の分だけ: 基地局の入力の値（照明のコアの脈が読む）と、照明の差し込み口 stage の中身。画面の中身などは区切りごとに足す。
 * 4-5 から、createLab がキットごとに読む（channels の置き場所の id の物を kit.bindChannels に、slots の「置き場所の id.差し込み口の名前」の物を kit.slots に）。
 * 4-6 から、画面の中身（screens の「置き場所の id.画面の名前」の物を、キットが画面を作る時に入れる）。基地局の入力の値は基地局のキットの channels
 * （照明のコアの光はそのキットの channels を読む）。
 * 4-7 から、作業台の入力の値（channels.workshop の printer。3D プリンタの様子）。
 * 4-8 から、開発デスクの画面の中身（screens の 'devDesk.center' など。キットの既定は飾りの画面）。
 * 4-9 から、ホロテーブルの入力の値（channels.holoTable の projection。投影の中身を出す目標）と投影の中身（slots の 'holoTable.projection'）。
 * 4-10 から、ギャラリーのケースの差し込み口（slots の 'gallery.case.3' など。既定の展示では KB-γ。kanon-lab は R3F の portal で入れるのでここには入れない）
 */

export type { BaseStationChannels, HoloTableChannels, PrinterJob, WorkbenchChannels }

export interface LabHostOptions {
  /** 入力の値（置き場所の id ごと）。読むたびに見る（getter の付いた物を渡せば、使う側の値をそのまま読める） */
  channels: {
    /** 基地局（リングの加速・通信のグリーン・フラッシュ・演出の脈） */
    baseStation?: Partial<BaseStationChannels>
    /** ホロテーブル（投影の中身を出す目標。0〜1） */
    holoTable?: Partial<HoloTableChannels>
    /** 作業台（3D プリンタの様子。使う側の物を参照で渡せば、その値をそのまま読む） */
    workshop?: Partial<WorkbenchChannels>
    /** ほかの置き場所のキットの入力の値（キットの channels の名前） */
    [id: string]: object | undefined
  }
  /** 差し込み口の中身を作る関数（ラボを作るたびに呼ぶ） */
  slots: {
    /** 照明の差し込み口 stage（光の並びの、基地局の光のあと） */
    'lighting.stage'?: () => LabSlotContent
    /** ホロテーブルの投影の中身（根の群の子。キットが毎コマ、根を動かす前に update を呼ぶ） */
    'holoTable.projection'?: () => LabSlotContent
    /** ギャラリーのケースの回る台の中身（既定の展示では case.3 が KB-γ。キットが毎コマ、台を回す前に update を呼ぶ） */
    'gallery.case.3'?: () => LabSlotContent
    /** キットの差し込み口（「置き場所の id.差し込み口の名前」） */
    [name: string]: (() => LabSlotContent) | undefined
  }
  /** 画面の中身（「置き場所の id.画面の名前」。'baseStation.castor' など）。無い画面はキットの既定の中身（4-6） */
  screens?: {
    [name: string]: ScreenDraw | undefined
  }
  /**
   * 床の映り込み（high のとき）を描くか（既定 true）。false なら作った時から止める（毎コマ場面をもう 1 回描かない。床は映り込みの無い PBR の床）。
   * 使う側が床を自分の素材で描くとき（トゥーン調など）に。あとから lab.shell.floor.setReflection でも切り替えられる
   */
  floorReflection?: boolean
}

const options: LabHostOptions = { channels: {}, slots: {}, screens: {} }

/** ラボの口に入れる（使う側が起動のとき、ラボを作る前に。入れた名前だけ差し替える） */
export function configureLab(next: {
  channels?: LabHostOptions['channels']
  slots?: LabHostOptions['slots']
  screens?: LabHostOptions['screens']
  floorReflection?: boolean
}) {
  if (next.channels) Object.assign(options.channels, next.channels)
  if (next.slots) Object.assign(options.slots, next.slots)
  if (next.screens) Object.assign(options.screens!, next.screens)
  if (next.floorReflection !== undefined) options.floorReflection = next.floorReflection
}

/** ラボの口に入っている物（ラボを作る時に読む） */
export function labOptions(): Readonly<LabHostOptions> {
  return options
}
