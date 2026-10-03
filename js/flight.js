// Free-flight camera. Speed scales with the distance to the nearest surface (like SpaceEngine),
// so the same keys cross a room-sized gap near a moon and a megaparsec between galaxies.
// When near a moving body the camera rides in that body's frame so orbits don't drift away.
import * as THREE from 'three/webgpu'
import { UPos } from './upos.js'

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4()
const ease = s => s * s * s * (s * (s * 6 - 15) + 10)

export class Flight {
  constructor(dom) {
    this.pos = new UPos()
    this.quat = new THREE.Quaternion()
    this.frame = null
    this.local = [0, 0, 0]
    this.speedMul = 1
    this.keys = new Set()
    this.look = { dx: 0, dy: 0 }
    this.orbit = { dx: 0, dy: 0 }
    this.wheel = 0
    this.auto = null
    this.speed = 0
    this.bind(dom)
  }

  bind(dom) {
    let drag = null
    dom.addEventListener('contextmenu', e => e.preventDefault())
    dom.addEventListener('pointerdown', e => {
      drag = { b: e.button, x: e.clientX, y: e.clientY, moved: 0 }
      dom.setPointerCapture(e.pointerId)
    })
    dom.addEventListener('pointermove', e => {
      if (!drag) return
      const dx = e.movementX, dy = e.movementY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      const t = drag.b === 2 || (drag.b === 0 && e.shiftKey) ? this.orbit : this.look
      t.dx += dx; t.dy += dy
    })
    dom.addEventListener('pointerup', e => {
      if (drag && drag.moved < 4 && drag.b === 0) this.onClick?.(e.clientX, e.clientY)
      drag = null
    })
    dom.addEventListener('dblclick', e => this.onDoubleClick?.(e.clientX, e.clientY))
    dom.addEventListener('wheel', e => { e.preventDefault(); this.wheel += Math.sign(e.deltaY) }, { passive: false })
    addEventListener('keydown', e => { if (e.target.tagName !== 'INPUT') this.keys.add(e.code) })
    addEventListener('keyup', e => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())
  }

  // world: { surfaceDistance(pos), pickFrame(pos), bodies near for collision, selected target }
  update(dt, world, fovRad) {
    world.corotate?.(this)                             // near the ground, turn with the body's spin
    if (this.frame) this.pos.copy(this.frame.p).addv(this.local)
    const k = this.keys
    const surf = Math.max(world.surfaceDistance(this.pos), 0.5)
    const sel = world.selected

    if (this.auto) this.runAuto(dt)
    else {
      // look / roll
      const s = (fovRad / innerHeight) * 1.0
      if (this.look.dx || this.look.dy) {
        this.quat.multiply(_q.setFromEuler(new THREE.Euler(-this.look.dy * s, -this.look.dx * s, 0, 'YXZ')))
      }
      const roll = (k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0)
      if (roll) this.quat.multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), roll * dt * 1.2))
      this.quat.normalize()

      // orbit around the selection
      if (sel && (this.orbit.dx || this.orbit.dy)) {
        const tp = sel.getPos(), off = this.pos.sub(tp)
        const up = _v.set(0, 1, 0).applyQuaternion(this.quat).clone(), right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat)
        const r = new THREE.Quaternion().setFromAxisAngle(up, -this.orbit.dx * 0.005).multiply(new THREE.Quaternion().setFromAxisAngle(right, -this.orbit.dy * 0.005))
        const o = new THREE.Vector3(...off).applyQuaternion(r)
        this.moveTo(tp.clone().add(o.x, o.y, o.z))
        this.quat.premultiply(r).normalize()
      }

      // translation
      const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 10 : k.has('KeyZ') ? 0.1 : 1
      const v = surf * 0.9 * this.speedMul * boost
      const mx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
      const my = (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0)
      const mz = (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0)
      this.speed = (mx || my || mz) ? v : 0
      if (mx || my || mz) {
        _v.set(mx, my, mz).normalize().applyQuaternion(this.quat).multiplyScalar(v * dt)
        this.nudge(_v.x, _v.y, _v.z)
      }
      // wheel: dolly toward the selection (exponential), or forward
      if (this.wheel) {
        if (sel) {
          const tp = sel.getPos(), off = this.pos.sub(tp), d = Math.hypot(...off)
          const R = sel.dollyR ?? sel.radius                 // galaxies zoom toward the centre, bodies toward the surface
          const nd = R + (d - R) * Math.pow(1.18, this.wheel)
          this.moveTo(tp.clone().add(off[0] / d * nd, off[1] / d * nd, off[2] / d * nd))
        } else {
          _v.set(0, 0, -1).applyQuaternion(this.quat).multiplyScalar(-this.wheel * surf * 0.2)
          this.nudge(_v.x, _v.y, _v.z)
        }
      }
    }
    this.look.dx = this.look.dy = this.orbit.dx = this.orbit.dy = this.wheel = 0

    world.collide(this)
    const f = world.pickFrame(this.pos)
    if (f !== this.frame) { this.frame = f; if (f) this.local = this.pos.sub(f.p) }
    if (this.frame) this.local = this.pos.sub(this.frame.p)
  }

  nudge(x, y, z) { this.pos.add(x, y, z) }
  moveTo(p) { this.pos.copy(p) }

  // ---- autopilot: travel in log-distance so every scale takes about the same time ----
  goTo(target, standoff) {
    const tp = target.getPos(), off = this.pos.sub(tp)
    const d0 = Math.max(Math.hypot(...off), standoff * 1.0001)
    const u0 = new THREE.Vector3(...off).divideScalar(d0)
    if (!isFinite(u0.x)) u0.set(0, 0, 1)
    const u1 = target.arrival ? target.arrival(u0.clone()) : u0.clone()
    const T = Math.min(9, 2.2 + 0.28 * Math.abs(Math.log(d0 / standoff)))
    this.auto = { target, d0, d1: standoff, u0, u1, T, t: 0, q0: this.quat.clone() }
    this.frame = null
  }
  cancelAuto() { this.auto = null }

  runAuto(dt) {
    const a = this.auto
    a.t += dt
    const s = Math.min(a.t / a.T, 1), e = ease(s)
    const d = Math.exp(Math.log(a.d0) + (Math.log(a.d1) - Math.log(a.d0)) * e)
    const u = a.u0.clone().lerp(a.u1, e).normalize()
    const tp = a.target.getPos()
    this.moveTo(tp.clone().add(u.x * d, u.y * d, u.z * d))
    // turn toward the target early in the trip
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(a.q0)
    if (Math.abs(up.dot(u)) > 0.999) up.set(1, 0, 0).applyQuaternion(a.q0)
    _m.lookAt(new THREE.Vector3(0, 0, 0), u.clone().negate(), up)
    const qLook = new THREE.Quaternion().setFromRotationMatrix(_m)
    this.quat.slerpQuaternions(a.q0, qLook, ease(Math.min(1, s * 3)))
    if (s >= 1) { this.auto = null; this.onArrive?.(a.target) }
  }
}
