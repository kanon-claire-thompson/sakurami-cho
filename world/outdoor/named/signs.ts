import * as THREE from 'three'
import type { V3 } from './frame'

/**
 * 看板・表札・時計の文字盤の絵（canvas に描いた 1 枚のアトラス）と、それを貼る面。
 *
 * - 看板の絵は、使うときに描く（細かい形を作る建物の分だけ）。同じ文字と見た目の看板は 1 つの絵を共有する
 * - 字は system の Noto Serif CJK JP（明朝。古い店の看板・駅名）と Noto Sans CJK JP（ゴシック）。無ければブラウザのセリフ・サンセリフ
 * - 面の値: aUv（アトラスの中の位置）、aSign.x = 光り方（namedMaterial.ts の createNamedSignMaterial）
 * - canvas は CPU で描く物（willReadFrequently。GPU の canvas は描いた物が消えることがあった）
 */

export const SIGN_FONTS = {
  serif: '"Noto Serif CJK JP", "Noto Serif JP", "Yu Mincho", "Hiragino Mincho ProN", serif',
  sans: '"Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", "Hiragino Sans", sans-serif',
  latin: '"Noto Serif", "Georgia", "Times New Roman", serif',
} as const

export interface SignStyle {
  /** 字（\n で行を分ける） */
  text: string
  /** 小さな 2 行目（英字・店の種類など） */
  sub?: string
  font?: keyof typeof SIGN_FONTS
  bold?: boolean
  /** 字の色・地の色（null なら地なし = 字だけ。抜いた所は描かない）・縁取りの色 */
  fg: string
  bg: string | null
  border?: string
  /** 縦書き */
  vertical?: boolean
  /** 形（rect・round = 丸い吊り看板・oval） */
  shape?: 'rect' | 'round' | 'oval'
  /** 絵（星・歯車・カップ・湯・郵便マーク）を字の前に */
  icon?: 'star' | 'gear' | 'cup' | 'yu' | 'post' | 'clock' | 'bread' | 'leaf' | 'anchor' | 'flask' | null
  /** 地の模様（wood = 木目、enamel = ほうろうの縁、noren = 暖簾の割れ） */
  finish?: 'wood' | 'enamel' | 'noren' | 'plain'
  /** 横・縦の大きさ（m。絵の縦横の比に使う） */
  w: number
  h: number
}

interface Region {
  u0: number
  v0: number
  u1: number
  v1: number
}

const SIZE_W = 4096
const SIZE_H = 4096
const PAD = 4

class SignAtlas {
  canvas: HTMLCanvasElement | null = null
  ctx: CanvasRenderingContext2D | null = null
  texture: THREE.CanvasTexture | null = null
  private regions = new Map<string, Region>()
  /** 棚（高さのそろった横の列）: y・高さ・使った幅 */
  private shelves: { y: number; h: number; x: number }[] = []
  private nextY = 0
  private dirty = false

  private ensure() {
    if (this.canvas) return
    const c = document.createElement('canvas')
    c.width = SIZE_W
    c.height = SIZE_H
    this.canvas = c
    // CPU で描く canvas（willReadFrequently）にする: 町を組み立ててから作る 4096² の GPU の canvas は、Chrome で、描いた看板の絵が消えて
    // 透明のままになり、看板がどれも出ないことがあった（読み返すと全部 0）。消えるかは起動ごとに変わり、駅舎の正面の駅名などが撮るたびに
    // 出たり出なかったりした。GPU の canvas は 1 度読み返すと CPU に切り替わって残るので、調べる道具を足すと出るようにもなる。
    // CPU の canvas なら描いた物が残る（中の絵のアトラス interior/pictures.ts と同じ）
    this.ctx = c.getContext('2d', { willReadFrequently: true })!
    this.ctx.clearRect(0, 0, SIZE_W, SIZE_H)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.NoColorSpace
    t.flipY = false
    t.generateMipmaps = true
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.magFilter = THREE.LinearFilter
    t.anisotropy = 8
    this.texture = t
  }

  /** テクスチャ（まだ看板が無くても作る） */
  get tex() {
    this.ensure()
    return this.texture!
  }

  /** 新しく描いた看板があれば、テクスチャを上げ直す */
  flush() {
    if (this.dirty && this.texture) {
      this.texture.needsUpdate = true
      this.dirty = false
    }
  }

  private alloc(pw: number, ph: number): Region | null {
    // 高さの近い棚（無駄の少ない棚）に入れる。無ければ新しい棚（高さは 16px ごとに丸める）
    const h = Math.ceil(ph / 16) * 16
    let best: (typeof this.shelves)[number] | null = null
    for (const sh of this.shelves) if (sh.h >= ph && sh.h <= h * 1.5 && sh.x + pw + PAD <= SIZE_W && (!best || sh.h < best.h)) best = sh
    if (!best) {
      if (this.nextY + h + PAD > SIZE_H) return null
      best = { y: this.nextY, h, x: 0 }
      this.shelves.push(best)
      this.nextY += h + PAD
    }
    const r = { u0: best.x, v0: best.y, u1: best.x + pw, v1: best.y + ph }
    best.x += pw + PAD
    return r
  }

  /** 看板の絵の場所（UV。無ければ描く）。アトラスがいっぱいなら null */
  region(style: SignStyle): Region | null {
    this.ensure()
    const key = JSON.stringify(style)
    const hit = this.regions.get(key)
    if (hit) return hit
    // 1m あたりの画素（大きな看板ほど粗く、絵の大きさは 512×512 まで）
    const ppm = Math.min(170, 512 / Math.max(style.w, 0.1), 512 / Math.max(style.h, 0.1))
    const pw = Math.max(16, Math.round(style.w * ppm))
    const ph = Math.max(16, Math.round(style.h * ppm))
    const r = this.alloc(pw, ph)
    if (!r) {
      console.warn('[named] 看板のアトラスがいっぱいです', style.text)
      return null
    }
    drawSign(this.ctx!, r.u0, r.v0, pw, ph, style)
    const uv = { u0: (r.u0 + 0.5) / SIZE_W, v0: (r.v0 + 0.5) / SIZE_H, u1: (r.u1 - 0.5) / SIZE_W, v1: (r.v1 - 0.5) / SIZE_H }
    this.regions.set(key, uv)
    this.dirty = true
    return uv
  }

  /** 時計の文字盤（白地に黒のローマ数字） */
  clockRegion(px = 384): Region | null {
    this.ensure()
    const key = `clock:${px}`
    const hit = this.regions.get(key)
    if (hit) return hit
    const r = this.alloc(px, px)
    if (!r) return null
    drawClock(this.ctx!, r.u0, r.v0, px)
    const uv = { u0: (r.u0 + 0.5) / SIZE_W, v0: (r.v0 + 0.5) / SIZE_H, u1: (r.u1 - 0.5) / SIZE_W, v1: (r.v1 - 0.5) / SIZE_H }
    this.regions.set(key, uv)
    this.dirty = true
    return uv
  }
}

export const signAtlas = new SignAtlas()

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawIcon(ctx: CanvasRenderingContext2D, icon: NonNullable<SignStyle['icon']>, cx: number, cy: number, s: number, color: string) {
  ctx.save()
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, s * 0.08)
  if (icon === 'star') {
    ctx.beginPath()
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? s * 0.5 : s * 0.2
      const a = -Math.PI / 2 + (i * Math.PI) / 5
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    }
    ctx.closePath()
    ctx.fill()
  } else if (icon === 'gear') {
    ctx.beginPath()
    const teeth = 10
    for (let i = 0; i < teeth * 2; i++) {
      const r = i % 2 === 0 ? s * 0.5 : s * 0.38
      const a0 = (i / (teeth * 2)) * Math.PI * 2
      const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2
      ctx.lineTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r)
      ctx.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r)
    }
    ctx.closePath()
    ctx.fill()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(cx, cy, s * 0.16, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  } else if (icon === 'cup') {
    ctx.beginPath()
    ctx.moveTo(cx - s * 0.32, cy - s * 0.1)
    ctx.lineTo(cx + s * 0.22, cy - s * 0.1)
    ctx.lineTo(cx + s * 0.16, cy + s * 0.3)
    ctx.lineTo(cx - s * 0.26, cy + s * 0.3)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx + s * 0.26, cy + s * 0.06, s * 0.1, -Math.PI / 2, Math.PI / 2)
    ctx.stroke()
    for (const dx of [-0.14, 0, 0.14]) {
      ctx.beginPath()
      ctx.moveTo(cx + dx * s, cy - s * 0.18)
      ctx.quadraticCurveTo(cx + (dx + 0.06) * s, cy - s * 0.3, cx + dx * s, cy - s * 0.44)
      ctx.stroke()
    }
  } else if (icon === 'yu') {
    ctx.font = `bold ${Math.round(s)}px ${SIGN_FONTS.serif}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('ゆ', cx, cy)
  } else if (icon === 'post') {
    ctx.font = `bold ${Math.round(s)}px ${SIGN_FONTS.sans}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('〒', cx, cy)
  } else if (icon === 'clock') {
    ctx.beginPath()
    ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx, cy - s * 0.3)
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + s * 0.2, cy + s * 0.05)
    ctx.stroke()
  } else if (icon === 'bread') {
    ctx.beginPath()
    ctx.ellipse(cx, cy, s * 0.45, s * 0.26, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineWidth = s * 0.06
    for (const dx of [-0.18, 0, 0.18]) {
      ctx.beginPath()
      ctx.moveTo(cx + (dx - 0.08) * s, cy + s * 0.12)
      ctx.lineTo(cx + (dx + 0.08) * s, cy - s * 0.12)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  } else if (icon === 'leaf') {
    ctx.beginPath()
    ctx.ellipse(cx, cy, s * 0.22, s * 0.44, Math.PI / 5, 0, Math.PI * 2)
    ctx.fill()
  } else if (icon === 'anchor') {
    ctx.beginPath()
    ctx.arc(cx, cy - s * 0.34, s * 0.09, 0, Math.PI * 2)
    ctx.moveTo(cx, cy - s * 0.25)
    ctx.lineTo(cx, cy + s * 0.4)
    ctx.moveTo(cx - s * 0.2, cy - s * 0.12)
    ctx.lineTo(cx + s * 0.2, cy - s * 0.12)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cx, cy + s * 0.1, s * 0.32, Math.PI * 0.15, Math.PI * 0.85)
    ctx.stroke()
  } else if (icon === 'flask') {
    ctx.beginPath()
    ctx.moveTo(cx - s * 0.08, cy - s * 0.42)
    ctx.lineTo(cx + s * 0.08, cy - s * 0.42)
    ctx.lineTo(cx + s * 0.08, cy - s * 0.1)
    ctx.lineTo(cx + s * 0.34, cy + s * 0.38)
    ctx.lineTo(cx - s * 0.34, cy + s * 0.38)
    ctx.lineTo(cx - s * 0.08, cy - s * 0.1)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

/** 字の大きさを、幅 w・高さ h に収まるように決める */
function fitFont(ctx: CanvasRenderingContext2D, text: string, family: string, bold: boolean, w: number, h: number) {
  let size = h
  ctx.font = `${bold ? 'bold ' : ''}${Math.round(size)}px ${family}`
  const m = ctx.measureText(text).width
  if (m > w) size *= w / m
  return Math.max(6, Math.floor(size))
}

function drawSign(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: SignStyle) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.clearRect(x, y, w, h)
  const family = SIGN_FONTS[s.font ?? 'serif']
  const shape = s.shape ?? 'rect'
  const m = Math.min(w, h)
  // 地
  if (s.bg) {
    ctx.fillStyle = s.bg
    if (shape === 'round') {
      ctx.beginPath()
      ctx.arc(x + w / 2, y + h / 2, m / 2 - 1, 0, Math.PI * 2)
      ctx.fill()
    } else if (shape === 'oval') {
      ctx.beginPath()
      ctx.ellipse(x + w / 2, y + h / 2, w / 2 - 1, h / 2 - 1, 0, 0, Math.PI * 2)
      ctx.fill()
    } else if (s.finish === 'noren') {
      // 暖簾: 上の棒の下に、縦に割れた布
      const n = Math.max(2, Math.round(w / h * 1.6))
      for (let i = 0; i < n; i++) {
        const x0 = x + (i * w) / n + 2
        ctx.fillRect(x0, y, w / n - 4, h)
      }
    } else {
      roundRect(ctx, x + 1, y + 1, w - 2, h - 2, m * 0.06)
      ctx.fill()
    }
    // 木目は描かない（平らな地の色）
    if (s.border) {
      ctx.strokeStyle = s.border
      ctx.lineWidth = Math.max(2, m * 0.05)
      if (shape === 'round') {
        ctx.beginPath()
        ctx.arc(x + w / 2, y + h / 2, m / 2 - m * 0.06, 0, Math.PI * 2)
        ctx.stroke()
      } else if (shape === 'oval') {
        ctx.beginPath()
        ctx.ellipse(x + w / 2, y + h / 2, w / 2 - m * 0.06, h / 2 - m * 0.06, 0, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        roundRect(ctx, x + m * 0.05, y + m * 0.05, w - m * 0.1, h - m * 0.1, m * 0.04)
        ctx.stroke()
      }
    }
  }
  ctx.fillStyle = s.fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lines = s.text.split('\n')
  if (s.vertical) {
    // 縦書き: 1 字ずつ上から
    const chars = [...lines[0]]
    const cw = w * 0.78
    const ch = Math.min(cw, (h * 0.9) / chars.length)
    ctx.font = `${s.bold ? 'bold ' : ''}${Math.round(ch * 0.92)}px ${family}`
    const total = ch * chars.length
    chars.forEach((c, i) => {
      const cy = y + (h - total) / 2 + ch * (i + 0.5)
      if (c === 'ー' || c === '－' || c === '〜') {
        ctx.save()
        ctx.translate(x + w / 2, cy)
        ctx.rotate(Math.PI / 2)
        ctx.fillText(c, 0, 0)
        ctx.restore()
      } else ctx.fillText(c, x + w / 2, cy)
    })
  } else {
    const iconW = s.icon ? Math.min(h * 0.8, w * 0.3) : 0
    const sub = s.sub ?? ''
    const mainH = sub ? h * 0.52 : h * 0.66
    const inner = (shape === 'round' ? m * 0.62 : w * 0.86) - iconW
    if (shape === 'round' || shape === 'oval') {
      // 丸い吊り看板: 絵を上、字を下
      if (s.icon) drawIcon(ctx, s.icon, x + w / 2, y + h * (lines[0] ? 0.4 : 0.5), m * (lines[0] ? 0.42 : 0.6), s.fg)
      if (lines[0]) {
        const fs = fitFont(ctx, lines[0], family, !!s.bold, m * 0.62, m * 0.16)
        ctx.font = `${s.bold ? 'bold ' : ''}${fs}px ${family}`
        ctx.fillText(lines[0], x + w / 2, y + h * 0.74)
      }
    } else {
      const lh = mainH / lines.length
      let tw = 0
      const sizes = lines.map((l) => {
        const fs = fitFont(ctx, l, family, !!s.bold, inner, lh * 0.9)
        ctx.font = `${s.bold ? 'bold ' : ''}${fs}px ${family}`
        tw = Math.max(tw, ctx.measureText(l).width)
        return fs
      })
      const cx = x + w / 2 + iconW / 2
      if (s.icon) drawIcon(ctx, s.icon, cx - tw / 2 - iconW * 0.62, y + (sub ? h * 0.36 : h / 2), iconW * 0.9, s.fg)
      lines.forEach((l, i) => {
        ctx.font = `${s.bold ? 'bold ' : ''}${sizes[i]}px ${family}`
        const cy = y + (sub ? h * 0.08 : (h - mainH) / 2) + lh * (i + 0.5) + (sub ? h * 0.04 : 0)
        ctx.fillText(l, cx, cy)
      })
      if (sub) {
        const fs = fitFont(ctx, sub, SIGN_FONTS.latin, false, w * 0.8, h * 0.2)
        ctx.font = `${fs}px ${s.font === 'sans' ? SIGN_FONTS.sans : SIGN_FONTS.latin}`
        ctx.globalAlpha = 0.9
        ctx.fillText(sub, x + w / 2, y + h * 0.8)
        ctx.globalAlpha = 1
      }
    }
  }
  ctx.restore()
}

function drawClock(ctx: CanvasRenderingContext2D, x: number, y: number, px: number) {
  ctx.save()
  const cx = x + px / 2
  const cy = y + px / 2
  const r = px / 2 - 2
  ctx.clearRect(x, y, px, px)
  ctx.fillStyle = '#f4f0e4'
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#1d1d1b'
  ctx.lineWidth = px * 0.025
  ctx.beginPath()
  ctx.arc(cx, cy, r - px * 0.02, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = px * 0.006
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2)
  ctx.stroke()
  // 分の目盛り
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2
    const r0 = r * (i % 5 === 0 ? 0.86 : 0.9)
    ctx.lineWidth = px * (i % 5 === 0 ? 0.012 : 0.005)
    ctx.beginPath()
    ctx.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0)
    ctx.lineTo(cx + Math.sin(a) * r * 0.94, cy - Math.cos(a) * r * 0.94)
    ctx.stroke()
  }
  const roman = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
  ctx.fillStyle = '#1d1d1b'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  roman.forEach((t, i) => {
    const a = (i / 12) * Math.PI * 2
    ctx.save()
    ctx.translate(cx + Math.sin(a) * r * 0.66, cy - Math.cos(a) * r * 0.66)
    ctx.rotate(a)
    ctx.font = `${Math.round(px * 0.1)}px ${SIGN_FONTS.latin}`
    ctx.fillText(t, 0, 0)
    ctx.restore()
  })
  ctx.restore()
}

/** 看板を貼る面（頂点: 位置・法線・aUv・aSign） */
export class SignBuilder {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  sign: number[] = []
  idx: number[] = []

  get count() {
    return this.pos.length / 3
  }

  /** 四角（a 左下・b 右下・c 右上・d 左上。表から見て反時計回り）に、絵の場所 r を貼る */
  quad(a: V3, b: V3, c: V3, d: V3, r: Region | null, mode = 0) {
    if (!r) return
    const e1 = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const e2 = new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2])
    const n = e1.cross(e2).normalize()
    const i0 = this.count
    const uvs = [
      [r.u0, r.v1],
      [r.u1, r.v1],
      [r.u1, r.v0],
      [r.u0, r.v0],
    ]
    ;[a, b, c, d].forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2])
      this.nrm.push(n.x, n.y, n.z)
      this.uv.push(uvs[i][0], uvs[i][1])
      this.sign.push(mode, 0)
    })
    this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3)
  }

  merge(o: SignBuilder) {
    const base = this.count
    this.pos.push(...o.pos)
    this.nrm.push(...o.nrm)
    this.uv.push(...o.uv)
    this.sign.push(...o.sign)
    for (const i of o.idx) this.idx.push(i + base)
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('aSign', new THREE.Float32BufferAttribute(this.sign, 2))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}
