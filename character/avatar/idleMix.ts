/**
 * 何本かの待機（.vrma）を、決まった乱数とシーンの時計で切り替える順番（見た目 character/avatar/characterVisual.ts が、待機の .vrma の強さと再生する所に使う）。
 *
 * - 時刻 0 から「枠」を順に並べる。枠ごとに待機を 1 本選び（初めの枠は 1 本目 = animations.idle。続きは前の枠と違う物を、種と枠の番号から決まった乱数で）、
 *   その待機の長さを、枠が minSlot 秒以上になるまで繰り返す（待機の .vrma は切れ目なく繰り返せるループ）
 * - 枠の変わり目では、次の待機を fade 秒前から始めて、強さを smoothstep で入れ替える（前の待機はその間も繰り返して続く）
 * - 同じ時刻なら、いつ・何度計算しても同じ答え（撮影で同じ画になる）。枠の表は伸ばしながら覚えておくだけで、状態は持たない
 *
 * three を読まない（テストから使う）
 */

/** 待機を切り替える設定（visualConfig.ts の idleMix） */
export interface IdleMixConfig {
  /** 入れ替えにかける秒 */
  fade: number
  /** 1 つの枠の最短の秒（待機の長さがこれより短ければ、その待機を繰り返す） */
  minSlot: number
  /** 決まった乱数の種（使う側が変えると、別の順番になる） */
  seed: number
}

/** そのコマの待機 1 本の強さと、再生する所（秒。待機の長さで割った余りにして使う） */
export interface IdleMixEntry {
  index: number
  weight: number
  time: number
}

interface Slot {
  index: number
  /** 再生を始める時刻（前の枠との入れ替えの始まり。初めの枠は 0） */
  begin: number
  /** 枠の終わり（次の枠の入れ替えが終わる時刻） */
  end: number
}

/** 0〜1 の決まった乱数（整数の組から） */
function hash01(a: number, b: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

export class IdleMix {
  private readonly slots: Slot[] = []
  /** 前のコマの枠の番号 */
  private last = 0

  /** durations = 待機ごとの長さ（秒。0 番が animations.idle） */
  private readonly durations: readonly number[]
  private readonly config: IdleMixConfig

  constructor(durations: readonly number[], config: IdleMixConfig) {
    if (!durations.length) throw new Error('IdleMix: 待機が 1 本もありません')
    this.durations = durations
    this.config = config
  }

  /** 枠の長さ（その待機を minSlot 秒以上になるまで繰り返す） */
  private slotLength(index: number) {
    const d = Math.max(0.1, this.durations[index])
    return d * Math.max(1, Math.ceil((this.config.minSlot - 1e-6) / d))
  }

  private slot(k: number): Slot {
    const n = this.durations.length
    const fade = this.config.fade
    while (this.slots.length <= k) {
      const i = this.slots.length
      const prev = this.slots[i - 1]
      let index = 0
      if (prev && n > 1) {
        // 前の枠と違う物を選ぶ（n - 1 本から）
        const r = Math.floor(hash01(this.config.seed, i) * (n - 1))
        index = r >= prev.index ? r + 1 : r
      }
      const begin = prev ? prev.end - fade : 0
      this.slots.push({ index, begin, end: begin + (prev ? fade : 0) + this.slotLength(index) })
    }
    return this.slots[k]
  }

  /**
   * 時刻 t（シーンの秒）の待機の強さと再生する所（1〜2 本。強さの合計は 1）。out に入れて返す（コマごとに作らない）
   */
  at(t: number, out: IdleMixEntry[] = []): IdleMixEntry[] {
    out.length = 0
    const time = Math.max(0, t)
    const fade = this.config.fade
    // 今の枠 = 次の枠との入れ替えが終わっていない枠（入れ替えの間は 2 本）。前のコマの枠から前後へ探す
    let k = this.last
    while (k > 0 && this.slot(k).begin + fade > time) k--
    while (this.slot(k + 1).begin + fade <= time) k++
    this.last = k
    const cur = this.slot(k)
    const next = this.slot(k + 1)
    const into = fade > 0 ? (time - next.begin) / fade : -1
    if (into > 0 && into < 1) {
      const w = into * into * (3 - 2 * into)
      out.push({ index: cur.index, weight: 1 - w, time: time - cur.begin })
      out.push({ index: next.index, weight: w, time: time - next.begin })
    } else out.push({ index: cur.index, weight: 1, time: time - cur.begin })
    return out
  }
}
